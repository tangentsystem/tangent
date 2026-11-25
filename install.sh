#!/usr/bin/env bash
# Tangent Systems node installer.
#
#   curl -fsSL https://tangentsystems.net/install.sh | sudo bash
#
# Sets up one node on this server and keeps it running: private internet, off grid payments and
# sealed computers for AI agents. Safe to run again: it updates the code and restarts the node,
# and never touches the node's keys.
#
# Settings (put them before "bash", for example: ... | sudo TANGENT_EXIT=0 bash)
#   TANGENT_HOST=<address>   public address of this server (found by itself when left out)
#   TANGENT_EXIT=0           do not be the last hop that opens connections to the open web
#   TANGENT_COMPUTE=0        do not rent out sealed computers (no Docker needed)
#   TANGENT_GATEWAY=0        do not put off grid payments on chain
#   TANGENT_RPC_URL=<url>    Solana RPC for the gateway
set -euo pipefail

REPO="${TANGENT_REPO:-https://github.com/tangentsystem/tangent.git}"
DIR="${TANGENT_DIR:-/opt/tangent}"
DATA="${TANGENT_DATA:-/var/lib/tangent/node}"
COORD="${TANGENT_COORDINATOR:-https://tangentsystems.net}"
RPC="${TANGENT_RPC_URL:-https://api.mainnet-beta.solana.com}"
HOST="${TANGENT_HOST:-}"
WANT_EXIT="${TANGENT_EXIT:-1}"
WANT_COMPUTE="${TANGENT_COMPUTE:-1}"
WANT_GATEWAY="${TANGENT_GATEWAY:-1}"
EXTRA="${TANGENT_EXTRA_ARGS:-}"
SERVICE="tangent-node"
LOG="$(dirname "$DATA")/node.log"

say() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux servers"
[ "$(id -u)" = "0" ] || die "run it as root: put sudo before bash"

APT_READY=0
apt_install() {
  have apt-get || die "this server is missing: $*. Install it and run this again"
  export DEBIAN_FRONTEND=noninteractive
  if [ "$APT_READY" = 0 ]; then apt-get update -y >/dev/null 2>&1 || true; APT_READY=1; fi
  apt-get install -y --no-install-recommends "$@" >/dev/null
}
SYSTEMD=0
[ -d /run/systemd/system ] && have systemctl && SYSTEMD=1

say "Getting this server ready"
need=()
have curl || need+=(curl)
have git || need+=(git)
[ -e /etc/ssl/certs/ca-certificates.crt ] || need+=(ca-certificates)
if [ "${#need[@]}" -gt 0 ]; then note "installing ${need[*]}"; apt_install "${need[@]}"; fi

# A small server needs swap to install the code and build the browser image.
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
swap_kb="$(awk '/SwapTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$mem_kb" -gt 0 ] && [ "$mem_kb" -lt 2000000 ] && [ "$swap_kb" -lt 500000 ] && [ ! -e /swapfile ]; then
  note "adding 2 GB of swap (this server has little memory)"
  if (fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none) && chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; then
    grep -q '^/swapfile ' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    rm -f /swapfile; note "could not add swap, carrying on"
  fi
fi

node_ok() { have node && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }
if ! node_ok; then
  note "installing Node.js 22"
  have apt-get || die "Node.js 22 or newer is needed. Install it and run this again"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || die "could not add the Node.js package source"
  apt_install nodejs
  node_ok || die "Node.js 22 did not install"
fi
note "Node.js $(node -v)"

COMPUTE=0
if [ "$WANT_COMPUTE" = "1" ]; then
  if ! have docker; then note "installing Docker"; apt_install docker.io || true; fi
  if have docker; then
    # The browser image is built with BuildKit, which newer Docker packages ship separately.
    if ! docker buildx version >/dev/null 2>&1 && have apt-get; then apt_install docker-buildx 2>/dev/null || true; fi
    [ "$SYSTEMD" = 1 ] && systemctl enable --now docker >/dev/null 2>&1 || true
    if docker info >/dev/null 2>&1; then COMPUTE=1; note "Docker is running"; else note "Docker does not run here, so this node will not rent out computers"; fi
  else
    note "Docker could not be installed, so this node will not rent out computers"
  fi
fi

say "Getting the Tangent code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only --quiet || die "could not update the code in $DIR"
  note "updated $DIR"
else
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --quiet "$REPO" "$DIR" || die "could not download the code"
  note "downloaded to $DIR"
fi
cd "$DIR"
note "installing what the code needs (a few minutes)"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund || die "npm install failed"

if [ "$COMPUTE" = 1 ]; then
  say "Getting the sealed computer images (several minutes the first time)"
  if ! node bin/node.js setup; then COMPUTE=0; note "the images could not be prepared, so this node will not rent out computers"; fi
fi

say "Finding this server's public address"
if [ -z "$HOST" ]; then
  HOST="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true)"
fi
printf '%s' "$HOST" | grep -Eq '^[A-Za-z0-9.-]{3,253}$' || die "could not find the public address. Run again with TANGENT_HOST=<your address> before bash"
note "$HOST"

if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 9101:9103/tcp >/dev/null 2>&1 && note "opened ports 9101 to 9103 in the firewall"
fi

ARGS=(--coordinator "$COORD" --host "$HOST" --data "$DATA")
[ "$WANT_EXIT" = "1" ] && ARGS+=(--exit)
[ "$WANT_GATEWAY" = "1" ] && ARGS+=(--gateway --rpc-url "$RPC")
[ "$COMPUTE" = 1 ] && ARGS+=(--compute)
# shellcheck disable=SC2206
[ -n "$EXTRA" ] && ARGS+=($EXTRA)
mkdir -p "$DATA"
chmod 700 "$DATA"
NODE_BIN="$(command -v node)"

say "Starting the node"
if [ "$SYSTEMD" = 1 ]; then
  {
    echo '[Unit]'
    echo 'Description=Tangent Systems node'
    echo 'After=network-online.target docker.service'
    echo 'Wants=network-online.target'
    echo
    echo '[Service]'
    echo "WorkingDirectory=$DIR"
    echo 'Environment=HOME=/root'
    printf 'ExecStart=%s bin/node.js' "$NODE_BIN"
    printf ' %q' "${ARGS[@]}"
    echo
    echo 'Restart=always'
    echo 'RestartSec=5'
    echo
    echo '[Install]'
    echo 'WantedBy=multi-user.target'
  } > "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl restart "$SERVICE"
  read_log() { journalctl -u "$SERVICE" --since "$SINCE" --no-pager -o cat 2>/dev/null; }
else
  # No systemd here (a container, for example): run it in the background.
  if [ -f "$LOG.pid" ] && kill -0 "$(cat "$LOG.pid")" 2>/dev/null; then kill "$(cat "$LOG.pid")" 2>/dev/null || true; sleep 2; fi
  : > "$LOG"
  nohup "$NODE_BIN" bin/node.js "${ARGS[@]}" >> "$LOG" 2>&1 &
  echo $! > "$LOG.pid"
  read_log() { cat "$LOG" 2>/dev/null; }
fi

READY=0
for _ in $(seq 1 45); do
  if read_log | grep -q 'node.ready'; then READY=1; break; fi
  sleep 2
done
OUT="$(read_log || true)"
NODE_ID="$(printf '%s\n' "$OUT" | grep 'node.identity' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"

if [ "$READY" != 1 ]; then
  printf '\nThe node did not come up yet. Its last lines:\n'
  printf '%s\n' "$OUT" | tail -15
  if [ "$SYSTEMD" = 1 ]; then printf '\nFollow it with: journalctl -u %s -f\n' "$SERVICE"; else printf '\nFollow it with: tail -f %s\n' "$LOG"; fi
  exit 1
fi

jobs="private internet"
[ "$WANT_EXIT" = "1" ] && jobs="$jobs (and the last hop to the open web)"
[ "$WANT_GATEWAY" = "1" ] && jobs="$jobs, off grid payments"
[ "$COMPUTE" = 1 ] && jobs="$jobs, sealed computers"

printf '\nYour node is part of the network.\n\n'
[ -n "$NODE_ID" ] && printf '  node id    %s\n' "$NODE_ID"
printf '  address    %s (ports 9101, 9102 and 9103 must be reachable from outside)\n' "$HOST"
printf '  jobs       %s\n' "$jobs"
[ -n "$NODE_ID" ] && printf '  earnings   curl %s/api/nodes/%s/earnings\n' "$COORD" "$NODE_ID"
printf '  keys       %s  (copy this folder somewhere safe: it holds the node and its earnings)\n' "$DATA"
if [ "$SYSTEMD" = 1 ]; then
  printf '  logs       journalctl -u %s -f\n' "$SERVICE"
  printf '  stop       systemctl stop %s\n' "$SERVICE"
else
  printf '  logs       tail -f %s\n' "$LOG"
  printf '  stop       kill %s\n' "$(cat "$LOG.pid")"
fi
PAYOUT="$(printf '%s\n' "$OUT" | grep 'payout.fund_this_wallet' | tail -1 || true)"
[ -n "$PAYOUT" ] && printf '\n  payouts    %s\n' "$PAYOUT"
if [ "$WANT_EXIT" = "1" ]; then
  printf '\nThis node is a last hop: it opens connections to the open web for users of the network.\n'
  printf 'To run without that, run the installer again with TANGENT_EXIT=0 before bash.\n'
fi
printf '\nGuide: %s/docs/run-a-node\n' "$COORD"
