#!/bin/sh
# Started by playwright-core in place of a local Chrome binary (docker driver only).
# It does NOT run a browser on the host. It runs Chromium INSIDE the machine's
# container with `docker exec` (same uid, cgroup limits, namespaces and network as
# the machine) and joins playwright's debugging pipe to the exec's stdio:
#   playwright fd 3 (commands)  -> docker exec stdin  -> Chromium fd 3
#   Chromium fd 4 (replies)     -> docker exec stdout -> playwright fd 4
# No port is opened anywhere. Chromium's own stdout is discarded; its stderr comes
# back here for playwright's launch log.
set -eu
: "${TANGENT_CONTAINER:?}" "${TANGENT_CHROMIUM:?}" "${TANGENT_PROFILE:?}" "${TANGENT_MARK:?}"
DOCKER="${TANGENT_DOCKER:-docker}"
USER_ID="${TANGENT_USER:-1000:1000}"
# playwright passes --user-data-dir with a path on the node; the profile lives in
# the machine's /tmp instead, so it dies with the machine.
n=$#
for a in "$@"; do
  case "$a" in
    --user-data-dir=*) a="--user-data-dir=$TANGENT_PROFILE" ;;
  esac
  set -- "$@" "$a"
done
shift "$n"
exec "$DOCKER" exec -i -u "$USER_ID" -w /work -e HOME=/work -e "TANGENT_BROWSER=$TANGENT_MARK" "$TANGENT_CONTAINER" \
  sh -c 'exec "$0" "$@" 3<&0 4>&1 >/dev/null' "$TANGENT_CHROMIUM" "$@" <&3 >&4 3<&- 4>&-
