#!/usr/bin/env node
// Tangent Systems node: relay + off grid + agent computers in one process.
//   node bin/node.js --coordinator https://... --host <public address> [options]
//   node bin/node.js setup            pull the Docker images agent computers need
// Run with --help for every option. Full guide: docs/node.md
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createNode, createNodeLogger } from '../src/node/daemon.js';

const HELP = `Tangent Systems node

Usage: node bin/node.js [setup] --coordinator <url> --host <public address> [options]

  --coordinator <url>       coordinator service url (required)
  --coordinator-id <id>     pin the coordinator identity (default: read from /api/health)
  --data <dir>              data folder for keys, backups and the off grid store (default ~/.tangent/node)
  --host <address>          public host name or ip other nodes and clients reach this node at
  --bind <address>          listen address (default 0.0.0.0)
  --relay-port <n>          relay port (default 9101, 0 picks a free one)
  --api-port <n>            http api port for agent computers (default 9102)
  --offgrid-port <n>        off grid tcp peer port (default 9103)
  --peer <host:port>        off grid peer to link with (repeat for more)
  --udp-port <n>            also run the UDP LAN transport on this port
  --exit                    act as an exit (opens outbound connections to the internet)
  --gateway                 submit off grid transactions on chain (needs HELIUS_API_KEY or --rpc-url)
  --rpc-url <url>           Solana RPC for the gateway (default from HELIUS_API_KEY)
  --cluster <name>          mainnet (default) or devnet
  --compute                 rent agent computers (Docker)
  --compute-dev             allow the process driver when Docker is missing (NOT sealed, development only)
  --no-egress               do not route rented machines' traffic through the network
  --mcp                     serve the MCP endpoint at /mcp for this machine only, paid from this node's wallet
  --payout <address>        your own registered Privacy Rings wallet for payouts (default: a payout key of this node)
  --region <name>           coarse region shown on the map, for example eu-west
  --price-mb <lamports>     price per MB relayed (default 10000)
  --price-tx <lamports>     price per off grid transaction (default 0, tips pay carriers)
  --price-second <lamports> price per second of a small machine (default 1000)
  --tor-control <host:port> publish the relay as a Tor onion service (password from TOR_CONTROL_PASSWORD)
  --dev-allow-private       development only: allow private and loopback targets and relays

Rented machine wallet keys: the node keeps each one, encrypted, in <data>/backups/machine-wallets/
for 30 days after its machine ends so the renter can recover it, then deletes it.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' },
    coordinator: { type: 'string' }, 'coordinator-id': { type: 'string' },
    data: { type: 'string' }, host: { type: 'string' }, bind: { type: 'string' },
    'relay-port': { type: 'string' }, 'api-port': { type: 'string' }, 'offgrid-port': { type: 'string' },
    peer: { type: 'string', multiple: true }, 'udp-port': { type: 'string' },
    exit: { type: 'boolean' }, gateway: { type: 'boolean' }, 'rpc-url': { type: 'string' }, cluster: { type: 'string' },
    compute: { type: 'boolean' }, 'compute-dev': { type: 'boolean' }, 'no-egress': { type: 'boolean' },
    // accepted for older scripts; machine wallet key backups are always on now
    'backup-machine-wallets': { type: 'boolean' }, mcp: { type: 'boolean' },
    payout: { type: 'string' }, region: { type: 'string' },
    'price-mb': { type: 'string' }, 'price-tx': { type: 'string' }, 'price-second': { type: 'string' },
    'tor-control': { type: 'string' }, 'dev-allow-private': { type: 'boolean' },
  },
});

if (values.help) { process.stdout.write(HELP); process.exit(0); }

const log = createNodeLogger();
const fail = (msg) => { log('error', 'node.bad_option', { reason: msg }); process.exit(2); };
const port = (v, d) => { if (v === undefined) return d; if (!/^[0-9]{1,5}$/.test(v) || Number(v) > 65535) fail(`bad port ${v}`); return Number(v); };
const lamports = (v, name) => { if (v === undefined) return undefined; if (!/^[0-9]{1,19}$/.test(v)) fail(`${name} must be whole lamports`); return BigInt(v); };
const hostPort = (v) => { const m = /^(.+):([0-9]{1,5})$/.exec(v || ''); if (!m) fail(`expected host:port, got ${v}`); return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) }; };

if (positionals[0] === 'setup') {
  const { createDockerDriver, DEFAULT_IMAGES } = await import('../src/compute/index.js');
  const d = createDockerDriver({});
  const c = await d.check();
  if (!c.ok) { log('error', 'setup.no_docker', { reason: c.reason }); process.exit(1); }
  const refs = [...new Set([...Object.values(DEFAULT_IMAGES), 'node:22-alpine', ...(d.browserImage ? [d.browserImage] : [])])];
  for (const ref of refs) {
    log('info', 'setup.pull', { image: ref });
    try { await d.pull(ref); } catch (err) { log('warn', 'setup.pull_failed', { image: ref, reason: String(err.message).slice(0, 200) }); }
  }
  log('info', 'setup.done', { images: await d.images() });
  process.exit(0);
}
if (positionals.length) fail(`unknown command ${positionals[0]}`);

const opts = {
  coordinator: values.coordinator,
  coordinatorId: values['coordinator-id'],
  dataDir: path.resolve(values.data || path.join(os.homedir(), '.tangent', 'node')),
  host: values.host,
  bind: values.bind,
  relayPort: port(values['relay-port'], 9101),
  apiPort: port(values['api-port'], 9102),
  offgridPort: port(values['offgrid-port'], 9103),
  peers: (values.peer || []).map(hostPort),
  udpPort: values['udp-port'] !== undefined ? port(values['udp-port']) : null,
  exit: Boolean(values.exit),
  gateway: Boolean(values.gateway),
  rpcUrl: values['rpc-url'] || '',
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  cluster: values.cluster === 'devnet' ? 'devnet' : 'mainnet',
  compute: Boolean(values.compute || values['compute-dev']),
  computeDev: Boolean(values['compute-dev']),
  egress: !values['no-egress'],
  mcp: Boolean(values.mcp),
  payout: values.payout,
  region: values.region,
  torControl: values['tor-control'] ? { ...hostPort(values['tor-control']), password: process.env.TOR_CONTROL_PASSWORD || undefined } : null,
  devAllowPrivate: Boolean(values['dev-allow-private']),
  log,
};
for (const [k, flag] of [['perMbLamports', 'price-mb'], ['perTxLamports', 'price-tx'], ['perSecondLamports', 'price-second']]) {
  const v = lamports(values[flag], flag);
  if (v !== undefined) opts[k] = v;
}
for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];

let node = null;
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('info', 'node.stopping', { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try { if (node) await node.stop(); process.exit(0); } catch { process.exit(1); }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  node = await createNode(opts);
} catch (err) {
  log('error', 'node.start_failed', { reason: String(err && err.message).slice(0, 300) });
  process.exit(1);
}
