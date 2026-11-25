// End to end over the in memory loopback hub with LiteSVM as the chain behind the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createIdentity, createMeter } from '../core/index.js';
import { createOffgrid } from './node.js';
import { createMemoryStore } from './store.js';
import { createLoopbackHub } from './transports/loopback.js';
import { buildDurableTransfer } from './nonce.js';
import { createBundle, encodeBundle, appendTrail, decodeBundle, headerBody } from './bundle.js';
import { fragment, KIND, encodeInv, unhex } from './codec.js';
import { checkClaim, splitTip } from './receipt.js';
import { makeChain, waitFor, FAST } from './test-support/fixtures.js';

// Line topology: only neighbours hear each other, so the bundle must be relayed hop by hop.
function line(hub, names, { chain, gateways = [names[names.length - 1]], opts = {}, meter = null } = {}) {
  for (let i = 0; i + 1 < names.length; i++) hub.link(names[i], names[i + 1]);
  const nodes = {};
  for (const n of names) {
    nodes[n] = createOffgrid({
      identity: createIdentity(), transports: [hub.endpoint(n)], store: createMemoryStore(),
      gateway: gateways.includes(n) ? { connection: chain.conn } : null, meter, ...FAST, ...opts,
    });
  }
  return nodes;
}
const startAll = (nodes) => Promise.all(Object.values(nodes).map((n) => n.start()));
const stopAll = (nodes) => Promise.all(Object.values(nodes).map((n) => n.stop()));

function transfer(chain, { lamports = 2_000_000, tip = null, version = 'legacy', nonce = null } = {}) {
  const nn = nonce ?? chain.createNonce();
  const to = Keypair.generate().publicKey;
  const bytes = buildDurableTransfer({ from: chain.payer, to, lamports, nonceAccount: nn.nonce.publicKey, nonceValue: nn.value, tip, version });
  return { bytes, to, nonce: nn };
}

test('offline durable transfer hops A -> B -> C -> gateway D, lands in LiteSVM, receipt returns to A', async () => {
  const chain = makeChain();
  const hub = createLoopbackHub();
  const meter = createMeter();
  const tipAccount = Keypair.generate().publicKey.toBase58();
  chain.svm.airdrop(tipAccount, 1_000_000_000n); // the network tip account exists (rent exempt) on chain
  const nodes = line(hub, ['A', 'B', 'C', 'D'], { chain, meter, opts: { tipAccount } });
  await startAll(nodes);
  const { A, B, C, D } = nodes;
  const receipts = [];
  A.onReceipt((r) => receipts.push(r));
  const { bytes, to } = transfer(chain, { tip: { account: tipAccount, lamports: 100_000n } });
  const id = await A.submit(bytes);
  await waitFor(() => receipts.length === 1, { what: 'receipt at A' });
  const r = receipts[0];
  assert.equal(r.bundleId, id);
  assert.equal(r.status, 'landed');
  assert.equal(r.gateway, D.id);
  assert.equal(chain.balance(to), 2_000_000n, 'transfer landed on chain');
  assert.equal(chain.balance(tipAccount), 1_000_100_000n, 'tip landed on chain');
  assert.deepEqual(r.trail.map((e) => e.node), [B.id, C.id]);
  assert.equal(chain.conn.calls.sendRawTransaction, 1);
  assert.equal(meter.get('offgrid:' + D.id).units, 1n);
  // claims: gateway and both carriers, all valid for the coordinator; the sender has none
  await waitFor(() => B.claims().length && C.claims().length && D.claims().length, { what: 'claims' });
  for (const n of [B, C, D]) assert.ok(checkClaim(n.claims()[0]).ok);
  assert.equal(D.claims()[0].role, 'gateway'); assert.equal(B.claims()[0].role, 'carrier');
  assert.equal(A.claims().length, 0);
  const split = splitTip(100_000n, r.trail, r.gateway);
  assert.equal(split.gateway.lamports, 50_000n);
  assert.deepEqual(split.carriers.map((c) => [c.id, c.lamports]), [[B.id, 25_000n], [C.id, 25_000n]]);
  // receipts stop forwarding: nobody carries the bundle any more
  await waitFor(() => [A, B, C, D].every((n) => !n.has(id)), { what: 'bundle dropped everywhere' });
  for (const n of [A, B, C, D]) assert.ok(n.peers().length >= 1);
  await stopAll(nodes); hub.close();
});

test('v0 transaction through the mesh under heavy loss, duplication and reordering', async () => {
  const chain = makeChain();
  const hub = createLoopbackHub({ loss: 0.3, duplicate: 0.3, reorder: 0.5, delayMs: [0, 15], seed: 7 });
  const nodes = line(hub, ['A', 'B', 'C', 'D'], { chain });
  await startAll(nodes);
  const got = [];
  nodes.A.onReceipt((r) => got.push(r));
  const txs = [transfer(chain, { version: 0 }), transfer(chain), transfer(chain, { version: 0 })];
  const ids = [];
  for (const t of txs) ids.push(await nodes.A.submit(t.bytes));
  await waitFor(() => got.length === 3, { timeout: 30_000, what: 'three receipts through a lossy mesh' });
  assert.deepEqual(new Set(got.map((r) => r.bundleId)), new Set(ids));
  for (const t of txs) assert.equal(chain.balance(t.to), 2_000_000n);
  assert.equal(chain.conn.calls.sendRawTransaction, 3, 'each transaction submitted exactly once');
  const s = Object.values(nodes).map((n) => n.stats());
  assert.ok(hub.stats.lost > 0 && hub.stats.duplicated > 0);
  assert.ok(s.reduce((a, x) => a + x.dupFrames, 0) > 0, 'duplicate frames were seen and ignored');
  assert.equal(hub.stats.oversize, 0, 'every frame fit in 200 bytes');
  await stopAll(nodes); hub.close();
});

test('replay of a landed bundle does not double submit', async () => {
  const chain = makeChain();
  const hub = createLoopbackHub();
  const nodes = line(hub, ['A', 'B', 'D'], { chain });
  await startAll(nodes);
  const got = [];
  nodes.A.onReceipt((r) => got.push(r));
  const { bytes } = transfer(chain);
  const id = await nodes.A.submit(bytes);
  await waitFor(() => got.length === 1, { what: 'first receipt' });
  // same transaction again from the same sender: recognised by id
  assert.equal(await nodes.A.submit(bytes), id);
  // a different sender node re-injects it (new origin, new header) straight next to the gateway
  const E = createOffgrid({ identity: createIdentity(), transports: [hub.endpoint('E')], store: createMemoryStore(), ...FAST });
  hub.link('E', 'D');
  await E.start();
  const eGot = [];
  E.onReceipt((r) => eGot.push(r));
  assert.equal(await E.submit(bytes), id);
  // a fresh gateway with no memory sees it already landed on chain and sends nothing
  const F = createOffgrid({ identity: createIdentity(), transports: [hub.endpoint('F')], store: createMemoryStore(), gateway: { connection: chain.conn }, ...FAST });
  const G = createOffgrid({ identity: createIdentity(), transports: [hub.endpoint('G')], store: createMemoryStore(), ...FAST });
  hub.link('G', 'F');
  await F.start(); await G.start();
  const gGot = [];
  G.onReceipt((r) => gGot.push(r));
  await G.submit(bytes);
  await waitFor(() => gGot.length === 1, { what: 'receipt from fresh gateway' });
  assert.equal(gGot[0].status, 'landed');
  assert.equal(chain.conn.calls.sendRawTransaction, 1, 'only ever sent once');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(chain.conn.calls.sendRawTransaction, 1);
  await Promise.all([E.stop(), F.stop(), G.stop()]); await stopAll(nodes); hub.close();
});

test('a used nonce comes back as a failed receipt and stops forwarding', async () => {
  const chain = makeChain();
  const hub = createLoopbackHub();
  const nodes = line(hub, ['A', 'B', 'D'], { chain });
  await startAll(nodes);
  const got = [];
  nodes.A.onReceipt((r) => got.push(r));
  const nonce = chain.createNonce();
  const first = transfer(chain, { nonce });
  const second = transfer(chain, { nonce, lamports: 3_000_000 }); // same nonce value, different transaction
  await nodes.A.submit(first.bytes);
  await waitFor(() => got.length === 1, { what: 'first receipt' });
  const id2 = await nodes.A.submit(second.bytes);
  await waitFor(() => got.length === 2, { what: 'second receipt' });
  const r2 = got.find((r) => r.bundleId === id2);
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, 'nonce used');
  assert.equal(chain.balance(second.to), 0n);
  assert.equal(nodes.D.claims().length, 1, 'no claim for a failed transaction');
  await waitFor(() => !nodes.B.has(id2), { what: 'failed bundle dropped' });
  await stopAll(nodes); hub.close();
});

test('tampered, non durable, oversized and forged trail bundles are rejected by a carrier', async () => {
  const chain = makeChain();
  const hub = createLoopbackHub();
  hub.link('X', 'B');
  const B = createOffgrid({ identity: createIdentity(), transports: [hub.endpoint('B')], store: createMemoryStore(), ...FAST });
  const raw = hub.endpoint('X');
  raw.start(() => {});
  await B.start();
  const origin = createIdentity();
  const inject = (bytes) => { for (const f of fragment(KIND.BUNDLE, bytes).frames) raw.send(f, { id: 'loop:B' }); };

  // tampered transaction bytes (signature no longer matches)
  const good = createBundle({ identity: origin, txBytes: transfer(chain).bytes });
  const tam = { ...good, tx: Uint8Array.from(good.tx) }; tam.tx[tam.tx.length - 2] ^= 1;
  tam.id = decodeBundle(encodeBundle(tam)).id;
  tam.originSig = origin.signObject(headerBody(tam));
  inject(encodeBundle(tam));
  // non durable
  const { Transaction, SystemProgram } = await import('@solana/web3.js');
  const nd = new Transaction().add(SystemProgram.transfer({ fromPubkey: chain.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 }));
  nd.recentBlockhash = chain.svm.latestBlockhash(); nd.feePayer = chain.payer.publicKey; nd.sign(chain.payer);
  inject(encodeBundle(createBundle({ identity: origin, txBytes: new Uint8Array(nd.serialize()) })));
  // oversized
  inject(encodeBundle({ ...good, tx: new Uint8Array(1300) }));          // transaction over 1232 bytes
  const huge = new Uint8Array(2400); huge.set(encodeBundle(good)); inject(huge); // whole bundle over the cap
  // forged trail entry
  const forger = createIdentity(), honest = createIdentity();
  const real = appendTrail(good.id, [], honest);
  inject(encodeBundle({ ...good, trail: [{ node: forger.id, sig: real[0].sig }] }));
  await waitFor(() => B.stats().bundlesRejected >= 5, { what: 'five rejections' });
  const rr = B.stats().rejectReasons;
  assert.equal(rr['bad signature'], 1);
  assert.equal(rr['not durable nonce'], 1);
  assert.equal(rr['tx too large'], 1);
  assert.equal(rr['too large'], 1);
  assert.equal(rr['trail signature'], 1);
  assert.equal(B.stats().bundles, 0);
  // the honest copy is still accepted afterwards (a rejected forged copy does not poison the id)
  // (forged copy marks the id as rejected for a minute, so use a fresh honest bundle)
  const fresh = createBundle({ identity: origin, txBytes: transfer(chain).bytes });
  inject(encodeBundle({ ...fresh, trail: appendTrail(fresh.id, [], honest) }));
  await waitFor(() => B.has(fresh.id), { what: 'honest bundle carried' });
  await B.stop(); hub.close();
});

test('bounded storage evicts other people\'s oldest bundles first', async () => {
  const chain = makeChain();
  const hub = createLoopbackHub();
  hub.link('X', 'B');
  const B = createOffgrid({ identity: createIdentity(), transports: [hub.endpoint('B')], store: createMemoryStore(), maxBundles: 3, ...FAST });
  const raw = hub.endpoint('X'); raw.start(() => {});
  await B.start();
  const ownId = await B.submit(transfer(chain).bytes);
  const origin = createIdentity();
  const now = Math.floor(Date.now() / 1000);
  const made = [];
  for (let i = 0; i < 4; i++) {
    const b = createBundle({ identity: origin, txBytes: transfer(chain).bytes, created: now - 100 + i, maxAge: 3600 });
    made.push(b.id);
    for (const f of fragment(KIND.BUNDLE, encodeBundle(b)).frames) raw.send(f, { id: 'loop:B' });
    await waitFor(() => B.stats().bundlesAccepted === i + 1, { what: 'accepted ' + i });
  }
  assert.equal(B.stats().bundles, 3);
  assert.equal(B.stats().evicted, 2);
  assert.ok(B.has(ownId), 'own bundle kept');
  assert.ok(!B.has(made[0]) && !B.has(made[1]) && B.has(made[2]) && B.has(made[3]), 'oldest two evicted');
  await B.stop(); hub.close();
});

test('per peer rate limit stops one peer flooding the node', async () => {
  const hub = createLoopbackHub();
  hub.link('X', 'B');
  const B = createOffgrid({ identity: createIdentity(), transports: [hub.endpoint('B')], store: createMemoryStore(), ...FAST, frameBurst: 50, frameRatePerSec: 10 });
  const raw = hub.endpoint('X'); raw.start(() => {});
  await B.start();
  for (let i = 0; i < 500; i++) raw.send(encodeInv([{ kind: KIND.BUNDLE, prefix: unhex(i.toString(16).padStart(16, '0')) }]), { id: 'loop:B' });
  await waitFor(() => B.stats().framesIn >= 500, { what: 'frames in' });
  assert.ok(B.stats().rateLimited >= 400, 'rate limited ' + B.stats().rateLimited);
  assert.ok(B.peers()[0].dropped >= 400);
  await B.stop(); hub.close();
});

test('hop limit: a bundle with maxHops 2 reaches the second carrier but no further', async () => {
  const chain = makeChain();
  const hub = createLoopbackHub();
  const nodes = line(hub, ['A', 'B', 'C', 'D'], { chain });
  await startAll(nodes);
  const id = await nodes.A.submit(transfer(chain).bytes, { maxHops: 2 });
  await waitFor(() => nodes.C.has(id), { what: 'C carries' });
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!nodes.D.has(id) && nodes.D.stats().landed === 0);
  assert.equal(chain.conn.calls.sendRawTransaction, 0);
  await stopAll(nodes); hub.close();
});
