// The same end to end flow over real sockets on localhost (TCP, UDP) and over a serial port pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createIdentity } from '../core/index.js';
import { createOffgrid } from './node.js';
import { createMemoryStore, createFileStore } from './store.js';
import { createTcpTransport } from './transports/tcp.js';
import { createUdpTransport } from './transports/udp.js';
import { createSerialTransport, createPortPair } from './transports/serial.js';
import { buildDurableTransfer } from './nonce.js';
import { encodeHello, decodeFrame } from './codec.js';
import { makeChain, waitFor, FAST } from './test-support/fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function transfer(chain, version = 'legacy') {
  const nn = chain.createNonce();
  const to = Keypair.generate().publicKey;
  return { to, bytes: buildDurableTransfer({ from: chain.payer, to, lamports: 2_000_000, nonceAccount: nn.nonce.publicKey, nonceValue: nn.value, version }) };
}

async function runLine(chain, transports) {
  const n = transports.length;
  const nodes = transports.map((t, i) => createOffgrid({
    identity: createIdentity(), transports: [t].flat(), store: createMemoryStore(),
    gateway: i === n - 1 ? { connection: chain.conn } : null, ...FAST,
  }));
  return nodes;
}

test('A -> B -> C -> gateway D over real TCP links on localhost, with a link drop and reconnect', async () => {
  const chain = makeChain();
  // D listens; C listens and dials D; B listens and dials C; A dials B.
  const tD = createTcpTransport({ host: '127.0.0.1', port: 0 });
  await tD.start(() => {}); const pD = tD.port; await tD.stop();
  const D = createTcpTransport({ host: '127.0.0.1', port: pD, reconnectMs: 100 });
  const C = createTcpTransport({ host: '127.0.0.1', port: 0, peers: [{ host: '127.0.0.1', port: pD }], reconnectMs: 100 });
  const nodes = [];
  const gw = createOffgrid({ identity: createIdentity(), transports: [D], store: createMemoryStore(), gateway: { connection: chain.conn }, ...FAST });
  const nc = createOffgrid({ identity: createIdentity(), transports: [C], store: createMemoryStore(), ...FAST });
  await gw.start(); await nc.start();
  const B = createTcpTransport({ host: '127.0.0.1', port: 0, peers: [{ host: '127.0.0.1', port: C.port }], reconnectMs: 100 });
  const nb = createOffgrid({ identity: createIdentity(), transports: [B], store: createMemoryStore(), ...FAST });
  await nb.start();
  const A = createTcpTransport({ peers: [{ host: '127.0.0.1', port: B.port }], reconnectMs: 100 });
  const na = createOffgrid({ identity: createIdentity(), transports: [A], store: createMemoryStore(), ...FAST });
  await na.start();
  nodes.push(na, nb, nc, gw);
  await waitFor(() => A.links().length >= 1 && C.links().length >= 2 && B.links().length >= 2, { what: 'tcp links up' });
  const got = []; na.onReceipt((r) => got.push(r));
  const t1 = transfer(chain);
  await na.submit(t1.bytes);
  await waitFor(() => got.length === 1, { what: 'receipt over tcp' });
  assert.equal(got[0].status, 'landed');
  assert.equal(chain.balance(t1.to), 2_000_000n);
  assert.deepEqual(got[0].trail.map((e) => e.node), [nb.id, nc.id]);
  // drop the gateway link: restart the gateway's listener on the same port, C redials
  await gw.stop();
  const D2 = createTcpTransport({ host: '127.0.0.1', port: pD });
  const gw2 = createOffgrid({ identity: createIdentity(), transports: [D2], store: createMemoryStore(), gateway: { connection: chain.conn }, ...FAST });
  await gw2.start();
  await waitFor(() => D2.links().length === 1, { what: 'C redialled the gateway' });
  const t2 = transfer(chain, 0);
  await na.submit(t2.bytes);
  await waitFor(() => got.length === 2, { what: 'second receipt after reconnect' });
  assert.equal(chain.balance(t2.to), 2_000_000n);
  await Promise.all([na.stop(), nb.stop(), nc.stop(), gw2.stop()]);
});

test('A -> B -> C -> gateway D over UDP on loopback', async (t) => {
  const chain = makeChain();
  const mk = () => createUdpTransport({ bindAddress: '127.0.0.1', broadcast: false, discoveryIntervalMs: 100 });
  const us = [mk(), mk(), mk(), mk()];
  // bind first to learn ports
  for (const u of us) { try { await u.start(() => {}); } catch (e) { t.skip('udp not available here: ' + e.message); return; } }
  const ports = us.map((u) => u.port);
  await Promise.all(us.map((u) => u.stop()));
  // line: each knows only its neighbours as static peers
  const ts = ports.map((p, i) => createUdpTransport({
    port: p, bindAddress: '127.0.0.1', broadcast: false, discoveryIntervalMs: 100,
    peers: [ports[i - 1], ports[i + 1]].filter(Boolean).map((port) => ({ host: '127.0.0.1', port })),
  }));
  const nodes = await runLine(chain, ts);
  for (const n of nodes) await n.start();
  const got = []; nodes[0].onReceipt((r) => got.push(r));
  const tx = transfer(chain);
  await nodes[0].submit(tx.bytes);
  await waitFor(() => got.length === 1, { what: 'receipt over udp' });
  assert.equal(got[0].status, 'landed');
  assert.equal(chain.balance(tx.to), 2_000_000n);
  assert.equal(got[0].trail.length, 2);
  await Promise.all(nodes.map((n) => n.stop()));
});

test('UDP broadcast discovery on loopback (skipped if the sandbox blocks broadcast)', async (t) => {
  const a = createUdpTransport({ bindAddress: '0.0.0.0', broadcastAddress: '127.255.255.255', discoveryIntervalMs: 50 });
  await a.start(() => {});
  const b = createUdpTransport({ bindAddress: '0.0.0.0', broadcastAddress: '127.255.255.255', broadcastPort: a.port, discoveryIntervalMs: 50 });
  await b.start(() => {});
  try {
    await waitFor(() => a.peers().length >= 1, { timeout: 1500, what: 'broadcast beacon' });
  } catch {
    await a.stop(); await b.stop();
    t.skip('broadcast to 127.255.255.255 not delivered in this sandbox');
    return;
  }
  // a learned b from its broadcast beacon; b learns a when a answers with its own beacon/frames
  await waitFor(() => b.peers().length >= 1, { timeout: 1500, what: 'b learns a' });
  const seen = [];
  await a.stop(); await b.stop();
  const a2 = createUdpTransport({ port: a.port, bindAddress: '0.0.0.0', broadcastAddress: '127.255.255.255', discoveryIntervalMs: 50 });
  await a2.start((bytes) => seen.push(decodeFrame(bytes)));
  const b2 = createUdpTransport({ bindAddress: '0.0.0.0', broadcastAddress: '127.255.255.255', broadcastPort: a.port, discoveryIntervalMs: 50 });
  await b2.start(() => {});
  await waitFor(() => a2.peers().length >= 1, { timeout: 1500, what: 'rediscovery' });
  await waitFor(() => b2.peers().length >= 1, { timeout: 1500, what: 'b2 learns a2' });
  b2.send(encodeHello(createIdentity().publicKey, 0));
  await waitFor(() => seen.length >= 1, { timeout: 1500, what: 'frame after discovery' });
  assert.equal(seen[0].type, 5);
  await a2.stop(); await b2.stop();
});

test('serial transport: COBS framing over a chunked port pair, noise resync, mesh end to end (no real radio)', async () => {
  const chain = makeChain();
  const [pa, pb] = createPortPair({ chunk: 5 });
  // inject line noise before the real frames on one side
  const origWrite = pa.write.bind(pa);
  let noisy = true;
  pa.write = (bytes) => { if (noisy) { noisy = false; origWrite(Uint8Array.from([9, 9, 9, 1, 2])); } origWrite(bytes); };
  const dir = await mkdtemp(join(tmpdir(), 'offgrid-serial-'));
  const A = createOffgrid({ identity: createIdentity(), transports: [createSerialTransport({ port: pa })], store: await createFileStore({ dir }), ...FAST });
  const D = createOffgrid({ identity: createIdentity(), transports: [createSerialTransport({ port: pb })], store: createMemoryStore(), gateway: { connection: chain.conn }, ...FAST });
  await A.start(); await D.start();
  const got = []; A.onReceipt((r) => got.push(r));
  const tx = transfer(chain);
  await A.submit(tx.bytes);
  await waitFor(() => got.length === 1, { what: 'receipt over serial' });
  assert.equal(got[0].status, 'landed');
  assert.equal(chain.balance(tx.to), 2_000_000n);
  assert.ok(A.stats().badFrames <= 1);
  await A.stop(); await D.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a node restarted on a file store keeps carrying its bundles', async () => {
  const chain = makeChain();
  const dir = await mkdtemp(join(tmpdir(), 'offgrid-restart-'));
  const identity = createIdentity();
  const n1 = createOffgrid({ identity, transports: [], store: await createFileStore({ dir }), ...FAST });
  await n1.start();
  const id = await n1.submit(transfer(chain).bytes);
  await n1.stop();
  const n2 = createOffgrid({ identity, transports: [], store: await createFileStore({ dir }), ...FAST });
  await n2.start();
  assert.ok(n2.has(id));
  await n2.stop();
  await rm(dir, { recursive: true, force: true });
});
