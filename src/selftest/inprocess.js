// In-process network for the self test: a private coordinator (its own memory store, pay on the
// simulated Rings adapter, so no real balance and nothing in the service's MongoDB), relay hops,
// a client with throwaway credit, and an off grid mesh over the in memory loopback hub.
//
// It runs the real code paths (createApp, createPay, createRelay, createClient, the node's voucher
// book and credit, createOffgrid). It never registers anything in the service's real registry,
// so nothing from the self test ever shows on /api/directory, /api/map or /api/stats.
//
// Uses only runtime dependencies (no devDependencies such as litesvm or socks), because it runs
// inside the deployed service.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createMemoryStore } from '../storage/index.js';
import { ensureKeys } from '../keys.js';
import { createApp } from '../coord/app.js';
import { loadModules } from '../coord/modules.js';
import { createIdentity, createKxKeypair, createMeter, signDescriptor } from '../core/index.js';
import { createRelay, createClient } from '../relay/index.js';
import { createKeystore } from '../node/keystore.js';
import { createCoordinatorClient } from '../node/coord-client.js';
import { createVoucherBook } from '../node/vouchers.js';
import { createCredit } from '../node/credit.js';

const quiet = { info() {}, warn() {}, error() {}, line() {} };
export const FAST_MESH = Object.freeze({ tickMs: 20, gossipIntervalMs: 100, helloIntervalMs: 200, wantRetryMs: 250, nackAfterMs: 80 });

export async function waitFor(fn, { timeoutMs = 30_000, every = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// A private coordinator on 127.0.0.1. tip: use another tip account (the service's real one in
// the funded off grid check). connection: a Solana connection for claim checks, or null.
export async function startPrivateCoordinator({ connection = null, tip = null } = {}) {
  const config = loadConfig({
    PORT: '0', ALLOW_PRIVATE_HOSTS: 'true', PAY_DEV_SIM: 'true', TRUST_PROXY: 'false',
    RATE_LIMIT_PER_MIN: '100000', HEARTBEAT_LIMIT_PER_MIN: '100000', REDEEM_LIMIT_PER_MIN: '100000',
    CLAIM_LIMIT_PER_MIN: '10000', REGISTER_LIMIT_PER_HOUR: '10000',
  });
  const store = await createMemoryStore({ prefix: 'tangent_' });
  const base = await ensureKeys({ store });
  const keys = tip ? { ...base, tip: { address: tip } } : base;
  const modules = await loadModules({ config, store, keys, log: quiet, connection });
  if (!modules.pay || !modules.rings || !modules.rings.sim) throw new Error('private coordinator: simulated pay did not start');
  const app = createApp({ store, pay: modules.pay, token: null, offgrid: modules.offgrid, config, connection, log: quiet, keys });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, config, store, keys, modules, pay: modules.pay, rings: modules.rings,
    async close() {
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
      await store.close().catch(() => {});
    },
  };
}

// Register a node identity with the private coordinator (a signed descriptor).
export async function registerNode(coordUrl, identity, { roles, port = 1, kx = createKxKeypair() } = {}) {
  const coord = createCoordinatorClient({ url: coordUrl, identity });
  const d = signDescriptor(identity, { roles, host: '127.0.0.1', port, apiPort: 0, kx: kx.pub, payout: identity.id, prices: { perMbLamports: 10_000n }, version: '0.1.0', ts: Date.now() });
  await coord.register(d);
  return { coord, descriptor: d };
}

// Minimal SOCKS5 CONNECT + HTTP/1.0 GET (no dependency). -> { status, body: Buffer }
export function socksHttpGet({ socksPort, host, port, pathName = '/', timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socksPort, '127.0.0.1');
    const timer = setTimeout(() => { s.destroy(); reject(new Error('socks request timed out')); }, timeoutMs);
    let stage = 0;
    let buf = Buffer.alloc(0);
    const chunks = [];
    const fail = (m) => { clearTimeout(timer); s.destroy(); reject(new Error(m)); };
    s.on('error', (e) => fail('socks: ' + e.message));
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      if (stage === 2) { chunks.push(d); return; }
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail('socks: no acceptable auth');
        buf = buf.subarray(2);
        const h = Buffer.from(host);
        const p = Buffer.alloc(2); p.writeUInt16BE(port);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p]));
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 10) return;
        if (buf[1] !== 0) return fail('socks: connect refused, code ' + buf[1]);
        const atyp = buf[3];
        const len = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buf[4];
        if (buf.length < len) return;
        const rest = buf.subarray(len);
        stage = 2;
        if (rest.length) chunks.push(rest);
        s.write(`GET ${pathName} HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
      }
    });
    s.on('close', () => {
      if (stage !== 2) return;
      clearTimeout(timer);
      const all = Buffer.concat(chunks);
      const i = all.indexOf('\r\n\r\n');
      if (i < 0) return reject(new Error('no HTTP response through the circuit'));
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(all.subarray(0, i).toString())?.[1] || 0);
      resolve({ status, body: all.subarray(i + 4) });
    });
  });
}

// Private internet end to end: private coordinator, `hops` relays (the last one an exit), a
// client paying each hop from a different throwaway credit account, HTTP through the SOCKS port
// to a local web server, every hop's vouchers redeemed and credited. -> facts for the report.
export async function runRelayNetwork({ hops = 3, bytes = 2 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
  const cleanup = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tangent-selftest-'));
  cleanup.push(() => fs.rm(tmp, { recursive: true, force: true }));
  try {
    const coord = await startPrivateCoordinator();
    cleanup.push(() => coord.close());

    const payload = randomBytes(bytes);
    const dest = http.createServer((_req, res) => { res.writeHead(200, { 'content-length': payload.length }); res.end(payload); });
    await new Promise((r) => dest.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => { dest.close(() => r()); dest.closeAllConnections(); }));

    const relays = [];
    for (let i = 0; i < hops; i++) {
      const identity = createIdentity();
      const kx = createKxKeypair();
      const meter = createMeter();
      const client = createCoordinatorClient({ url: coord.url, identity });
      const book = createVoucherBook({ coord: client, maxUnsettledLamports: 0n });
      const exit = i === hops - 1;
      const relay = createRelay({
        identity, kx, port: 0, host: '127.0.0.1', exit, meter, onVoucher: book.onVoucher,
        perMbLamports: 10_000n, creditLimitLamports: 10_000n, allowPrivateTargets: true, allowPrivateRelays: true, log: () => {},
      });
      await relay.start();
      cleanup.push(() => relay.stop().catch(() => {}));
      const d = signDescriptor(identity, { roles: exit ? ['relay', 'exit'] : ['relay'], host: '127.0.0.1', port: relay.port, apiPort: 0, kx: kx.pub, payout: identity.id, prices: { perMbLamports: 10_000n }, version: '0.1.0', ts: Date.now() });
      relay.setDescriptor(d);
      await client.register(d);
      relays.push({ identity, relay, book, exit });
    }

    // the client: a wallet funded through (simulated) Rings, credit bought as blind tokens
    const keystore = await createKeystore({ dir: tmp });
    const cc = createCoordinatorClient({ url: coord.url });
    const credit = await createCredit({ coord: cc, keystore, dir: tmp });
    coord.rings.sim.fund(credit.wallet.id, 'SOL', 50_000_000n);
    coord.rings.sim.userSendToVault(credit.wallet.id, 'SOL', 50_000_000n);
    await coord.pay.syncDeposits();
    const directory = await cc.directory();
    if (directory.length !== hops) throw new Error(`directory lists ${directory.length} relays, expected ${hops}`);
    await credit.fund(directory.map((x) => x.id));
    const accounts = new Set(credit.accounts().map((a) => a.account));
    if (accounts.size !== hops) throw new Error('each hop must have its own throwaway account');

    const client = createClient({ directory, hops, credit, socksPort: 0, socksHost: '127.0.0.1', log: () => {} });
    await client.start();
    cleanup.push(() => client.stop().catch(() => {}));
    const got = await socksHttpGet({ socksPort: client.socksPort, host: '127.0.0.1', port: dest.address().port, timeoutMs });
    const same = createHash('sha256').update(got.body).digest('hex') === createHash('sha256').update(payload).digest('hex');
    if (got.status !== 200 || !same) throw new Error(`the response did not arrive intact (status ${got.status}, ${got.body.length} bytes)`);
    const circuits = client.circuits();

    await waitFor(async () => {
      for (const r of relays) if (BigInt(r.book.stats().creditedByKind.relay) <= 0n) return false;
      return true;
    }, { timeoutMs, what: 'every hop to redeem a voucher' });
    const hopsOut = [];
    for (const r of relays) {
      const e = await coord.pay.earnings(r.identity.id);
      const st = r.book.stats();
      if (st.refused > 0) throw new Error('a hop had a voucher refused');
      if (!e || BigInt(e.earned) <= 0n) throw new Error('a hop earned nothing at the coordinator');
      hopsOut.push({ exit: r.exit, redeemed: st.redeemed, creditedLamports: st.creditedByKind.relay, earnedLamports: String(e.earned) });
    }
    return { bytes: got.body.length, hops: hopsOut, circuits: Array.isArray(circuits) ? circuits.length : null, throwawayAccounts: accounts.size };
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
  }
}

// ---- off grid ---------------------------------------------------------------------------

async function offgridLine(names, { gatewayConnection = null, tipAccount, gatewayOptions = {} }) {
  const { createOffgrid, createMemoryStore: createMeshStore, createLoopbackHub } = await import('../offgrid/index.js');
  const hub = createLoopbackHub();
  for (let i = 0; i + 1 < names.length; i++) hub.link(names[i], names[i + 1]);
  const nodes = {};
  const identities = {};
  const meter = createMeter();
  names.forEach((n, i) => {
    const isGateway = Boolean(gatewayConnection) && i === names.length - 1;
    identities[n] = createIdentity();
    nodes[n] = createOffgrid({
      identity: identities[n], transports: [hub.endpoint(n)], store: createMeshStore(),
      gateway: isGateway ? { connection: gatewayConnection } : null, meter, tipAccount, log: () => {},
      ...FAST_MESH, ...(isGateway ? gatewayOptions : {}),
    });
  });
  await Promise.all(Object.values(nodes).map((x) => x.start()));
  return {
    hub, nodes, identities, meter,
    async stop() { await Promise.all(Object.values(nodes).map((x) => x.stop().catch(() => {}))); hub.close(); },
  };
}

// Stage 1, no chain: a durable nonce transaction signed offline (a throwaway key, never funded,
// never sent), wrapped in a bundle, fragmented into 200 byte frames, gossiped O -> C1 -> C2 -> C3
// over the loopback hub; frame codec round trip with shuffled and duplicated frames; a tampered
// bundle is refused.
export async function runOffgridMesh({ tipAccount, timeoutMs = 20_000 } = {}) {
  const { Keypair, PublicKey } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const { buildDurableTx, createBundle, encodeBundle, decodeBundle, validateBundle, codec } = await import('../offgrid/index.js');
  const payer = Keypair.generate();
  const tx = buildDurableTx({
    feePayer: payer.publicKey, nonceAccount: Keypair.generate().publicKey, nonceAuthority: payer.publicKey,
    nonceValue: bs58.encode(randomBytes(32)), instructions: [], tip: { account: new PublicKey(tipAccount), lamports: 10_000n }, signers: [payer],
  });

  // codec: bundle -> 200 byte frames -> shuffled with a duplicate -> reassembled byte for byte
  const origin = createIdentity();
  const bundle = createBundle({ identity: origin, txBytes: tx, tip: { account: tipAccount, lamports: 10_000n } });
  const encoded = encodeBundle(bundle);
  const { frames } = codec.fragment(codec.KIND.BUNDLE, encoded, codec.DEFAULT_MTU);
  if (frames.some((f) => f.length > codec.DEFAULT_MTU)) throw new Error('a frame is larger than 200 bytes');
  const mixed = [...frames, frames[0]].reverse();
  let rebuilt = null;
  const r = codec.createReassembler({ onComplete: (_k, obj) => { rebuilt = obj; } });
  for (const f of mixed) { const d = codec.decodeFrame(f); if (!d) throw new Error('a frame did not decode'); r.push(d); }
  if (!rebuilt || Buffer.compare(Buffer.from(rebuilt), Buffer.from(encoded)) !== 0) throw new Error('frames did not reassemble to the same bundle');
  const v = validateBundle(decodeBundle(rebuilt));
  if (!v.ok) throw new Error('the reassembled bundle did not validate: ' + v.reason);
  const tampered = Uint8Array.from(encoded);
  tampered[tampered.length - 20] ^= 0xff; // inside the signed transaction
  let refused = false;
  try { refused = !validateBundle(decodeBundle(tampered)).ok; } catch { refused = true; }
  if (!refused) throw new Error('a tampered bundle was accepted');

  // gossip across in-process nodes, no gateway: the bundle must reach the far end, hop by hop
  const mesh = await offgridLine(['O', 'C1', 'C2', 'C3'], { tipAccount });
  try {
    const id = await mesh.nodes.O.submit(tx, { tipAccount });
    await waitFor(() => mesh.nodes.C3.has(id), { timeoutMs, every: 50, what: 'the bundle to reach the fourth node' });
    return { bundleId: id, frames: frames.length, frameBytesMax: Math.max(...frames.map((f) => f.length)), nodes: 4 };
  } finally { await mesh.stop(); }
}

// Stage 2, real chain: the durable nonce transaction (built and signed by the caller, moving
// SOL only between the service's own wallets) travels O -> C1 -> C2 -> G, G submits it to Solana
// through `connection`, the signed receipt comes back to O, and G's claim is posted to a private
// coordinator that reads the transaction on chain and splits the tip between G, C1 and C2.
// -> { bundleId, receipt, claim, gateway, carriers }
export async function runOffgridOnChain({ txBytes, tipAccount, connection, receiptTimeoutMs = 150_000, claimTimeoutMs = 120_000 }) {
  const { buildClaim } = await import('../offgrid/index.js');
  const coord = await startPrivateCoordinator({ connection, tip: tipAccount });
  const mesh = await offgridLine(['O', 'C1', 'C2', 'G'], {
    tipAccount, gatewayConnection: connection,
    gatewayOptions: { pollMs: 1000, retryMs: 5000, confirmTimeoutMs: 90_000, maxAttempts: 10 },
  });
  const out = { bundleId: null, receipt: null, claim: null, claimError: null };
  try {
    const { O, G } = mesh.nodes;
    const ids = mesh.identities;
    // registry entries of the private coordinator only (one host:port per node); nothing listens there
    await registerNode(coord.url, ids.C1, { roles: ['relay'], port: 20001 });
    await registerNode(coord.url, ids.C2, { roles: ['relay'], port: 20002 });
    const gw = await registerNode(coord.url, ids.G, { roles: ['relay', 'gateway'], port: 20003 });
    out.gateway = ids.G.id;
    out.carriers = [ids.C1.id, ids.C2.id];
    const receipts = [];
    O.onReceipt((x) => receipts.push(x));
    out.bundleId = await O.submit(txBytes, { tipAccount });
    out.receipt = await waitFor(() => receipts[0], { timeoutMs: receiptTimeoutMs, every: 250, what: 'the receipt to come back to the sender' });
    if (out.receipt.status !== 'landed') return out;
    // the gateway claims; the coordinator reads the transaction on chain (retry while the RPC
    // does not show it yet), checks the tip and splits it
    const end = Date.now() + claimTimeoutMs;
    for (;;) {
      try {
        out.claim = await gw.coord.claim(buildClaim(ids.G, out.receipt, { ts: Date.now() }));
        break;
      } catch (err) {
        const retry = err && (err.transient || err.status === 404 || err.status === 502);
        if (!retry || Date.now() > end) { out.claimError = `${err.code || err.status || ''} ${err.message}`.trim(); break; }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (out.claim) out.earnings = Object.fromEntries(await Promise.all([ids.G.id, ids.C1.id, ids.C2.id].map(async (id) => [id, String((await coord.pay.earnings(id))?.earned ?? 0)])));
    return out;
  } finally {
    await mesh.stop();
    await coord.close();
  }
}
