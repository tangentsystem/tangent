import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createIdentity } from '../core/index.js';
import { signReceipt, buildClaim, appendTrail, checkClaim, splitTip as offgridSplit } from '../offgrid/index.js';
import { splitTip, lamportsReceived, accountKeysOf } from './offgrid-claim.js';
import { startApp, makeNode, fakePay, fakeConnection, txSignature, T0 } from './testkit.js';

const offgrid = { checkClaim, splitTip: offgridSplit };

// A landed transaction: origin -> c1 -> c2 -> c3 -> gateway.
async function scenario({ carriers = 3, registerCarriers = carriers, tip = 1_000_000n, pay = fakePay(), withConnection = true } = {}) {
  const connection = fakeConnection();
  const h = await startApp({ pay, connection: withConnection ? connection : null, offgrid });
  const gw = makeNode({ roles: ['gateway'] });
  await h.post('/api/nodes/register', gw.descriptor(T0));
  const carrierNodes = Array.from({ length: carriers }, () => makeNode({ roles: ['relay'] }));
  for (const c of carrierNodes.slice(0, registerCarriers)) await h.post('/api/nodes/register', c.descriptor(T0));
  const origin = createIdentity();
  const bundleId = randomBytes(32).toString('hex');
  let trail = [];
  for (const c of carrierNodes) trail = appendTrail(bundleId, trail, c.identity);
  const signature = txSignature();
  connection.add(signature, { payer: origin.id, tipAccount: h.keys.tip.address, tip });
  const receipt = signReceipt(gw.identity, { bundleId, status: 'landed', signature, slot: 123, origin: origin.id, trail, ts: T0 });
  const claimBy = (identity, ts = T0) => buildClaim(identity, receipt, { ts });
  return { h, pay, connection, gw, carrierNodes, origin, bundleId, trail, signature, receipt, claimBy };
}

test('splitTip fallback: half to the gateway, rest evenly to up to 8 carriers, dust to the gateway', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ node: 'c' + i }));
  const s = splitTip(1001n, nodes, 'gw');
  assert.equal(s.carriers.length, 8);
  const sum = s.gateway.lamports + s.carriers.reduce((a, c) => a + c.lamports, 0n);
  assert.equal(sum, 1001n);
  assert.equal(s.carriers[0].lamports, 62n);
  assert.deepEqual(splitTip(10n, [], 'gw'), { gateway: { id: 'gw', lamports: 10n }, carriers: [] });
  assert.deepEqual(splitTip(10n, [{ node: 'gw' }], 'gw').carriers, []);
  // same answers as src/offgrid's splitTip
  assert.deepEqual(splitTip(1001n, nodes, 'gw'), offgridSplit(1001n, nodes, 'gw'));
  assert.deepEqual(splitTip(7n, nodes.slice(0, 3), 'gw'), offgridSplit(7n, nodes.slice(0, 3), 'gw'));
});

test('lamportsReceived reads legacy and v0 account keys', () => {
  const tx = {
    transaction: { message: { accountKeys: ['A', 'B'] } },
    meta: { err: null, preBalances: [10, 5, 1], postBalances: [3, 12, 1], loadedAddresses: { writable: ['C'], readonly: [] } },
  };
  assert.deepEqual(accountKeysOf(tx), ['A', 'B', 'C']);
  assert.equal(lamportsReceived(tx, 'B'), 7n);
  assert.equal(lamportsReceived(tx, 'A'), 0n);
  assert.equal(lamportsReceived(tx, 'Z'), 0n);
});

test('claim: the gateway claims, everyone on the trail is credited once, with links', async () => {
  const s = await scenario();
  try {
    const r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tipLamports, '1000000');
    assert.equal(r.json.link, `https://solscan.io/tx/${s.signature}`);
    const byNode = Object.fromEntries(r.json.credits.map((c) => [c.node, c]));
    assert.equal(byNode[s.gw.id].lamports, '500002');
    for (const c of s.carrierNodes) {
      assert.equal(byNode[c.id].lamports, '166666');
      assert.equal(byNode[c.id].link, `https://solscan.io/account/${c.id}`);
    }
    assert.equal(s.pay.credits.length, 1);
    assert.deepEqual(s.pay.credits[0], { id: s.signature, lamports: '1000000', gateway: s.gw.id, carriers: s.carrierNodes.map((c) => c.id) });
    assert.equal(r.json.credits.reduce((a, c) => a + BigInt(c.lamports), 0n), 1_000_000n);
    const stats = (await s.h.get('/api/stats')).json;
    assert.equal(stats.offgridClaims, '1');
    assert.equal(stats.offgridTipLamports, '1000000');
  } finally { await s.h.close(); }
});

test('claim: each transaction can be claimed once, also under concurrent claims', async () => {
  const s = await scenario();
  try {
    const parties = [s.gw.identity, ...s.carrierNodes.map((c) => c.identity)];
    const res = await Promise.all(parties.map((p) => s.h.post('/api/offgrid/claim', s.claimBy(p))));
    assert.equal(res.filter((r) => r.status === 200).length, 1);
    assert.equal(res.filter((r) => r.status === 409).length, parties.length - 1);
    for (const r of res.filter((x) => x.status === 409)) assert.equal(r.json.error, 'ALREADY_CLAIMED');
    assert.equal(s.pay.credits.length, 1);
    const again = await s.h.post('/api/offgrid/claim', s.claimBy(s.carrierNodes[0].identity, T0 + 5));
    assert.equal(again.status, 409);
  } finally { await s.h.close(); }
});

test('claim: a carrier on the trail may claim; an outsider may not', async () => {
  const s = await scenario();
  try {
    const outsider = createIdentity();
    assert.throws(() => s.claimBy(outsider));
    // hand built claim from an outsider pretending to be a carrier
    const c = s.claimBy(s.carrierNodes[1].identity);
    const { sig, ...body } = { ...c, claimant: outsider.id };
    const forged = { ...body, sig: outsider.signObject(body) };
    const r = await s.h.post('/api/offgrid/claim', forged);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'BAD_CLAIM');
    const ok = await s.h.post('/api/offgrid/claim', s.claimBy(s.carrierNodes[1].identity));
    assert.equal(ok.status, 200);
  } finally { await s.h.close(); }
});

test('claim: forged trails, receipts and claim signatures are refused before any chain lookup', async () => {
  const s = await scenario();
  try {
    const intruder = makeNode();
    await s.h.post('/api/nodes/register', intruder.descriptor(T0));
    // 1. an extra carrier appended to the trail without a valid chain signature
    const fakeEntry = { node: intruder.id, sig: intruder.identity.signObject({ hello: 1 }) };
    const r1 = signReceipt(s.gw.identity, { ...s.receipt, trail: [...s.trail, fakeEntry] });
    const c1 = buildClaim(s.gw.identity, r1, { ts: T0 });
    assert.equal((await s.h.post('/api/offgrid/claim', c1)).status, 400);
    // 2. a carrier dropped from the middle of the trail (hash chain breaks)
    const r2 = signReceipt(s.gw.identity, { ...s.receipt, trail: [s.trail[0], s.trail[2]] });
    assert.equal((await s.h.post('/api/offgrid/claim', buildClaim(s.gw.identity, r2, { ts: T0 }))).status, 400);
    // 3. receipt not signed by the gateway it names
    const r3 = { ...s.receipt, slot: 999 };
    const c3 = buildClaim(s.carrierNodes[0].identity, r3, { ts: T0 });
    assert.equal((await s.h.post('/api/offgrid/claim', c3)).status, 401);
    // 4. claim body changed after signing
    const c4 = { ...s.claimBy(s.gw.identity), ts: T0 + 1 };
    assert.equal((await s.h.post('/api/offgrid/claim', c4)).status, 401);
    // 5. an unknown extra field
    const c5 = { ...s.claimBy(s.gw.identity), bonus: 1 };
    assert.equal((await s.h.post('/api/offgrid/claim', c5)).status, 400);
    assert.equal(s.connection.calls, 0);
    assert.equal(s.pay.credits.length, 0);
  } finally { await s.h.close(); }
});

test('claim: on chain checks (missing, failed, no tip, wrong signature) and stale claims', async () => {
  const s = await scenario();
  try {
    s.connection.txs.delete(s.signature);
    let r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity));
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'TX_NOT_FOUND');
    s.connection.add(s.signature, { payer: s.origin.id, tipAccount: s.h.keys.tip.address, tip: 1000n, err: { InstructionError: [0, 'Custom'] } });
    r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity, T0 + 1));
    assert.equal(r.json.error, 'TX_FAILED');
    s.connection.add(s.signature, { payer: s.origin.id, tipAccount: null });
    r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity, T0 + 2));
    assert.equal(r.json.error, 'NO_TIP');
    s.connection.add(s.signature, { payer: s.origin.id, tipAccount: createIdentity().id, tip: 5000n });
    r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity, T0 + 3));
    assert.equal(r.json.error, 'NO_TIP');
    r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity, T0 - 10 * 60 * 1000));
    assert.equal(r.json.error, 'STALE');
    assert.equal(s.pay.credits.length, 0);
    // nothing was burned: a good transaction can still be claimed
    s.connection.add(s.signature, { payer: s.origin.id, tipAccount: s.h.keys.tip.address, tip: 2000n });
    r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity, T0 + 4));
    assert.equal(r.status, 200);
  } finally { await s.h.close(); }
});

test('claim: the bundle id must be the sha256 of the transaction wire bytes when they are available', async () => {
  const s = await scenario();
  try {
    s.connection.raw.set(s.signature, randomBytes(200));
    const bad = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'BUNDLE_MISMATCH');
    assert.equal(s.pay.credits.length, 0);
    const bytes = randomBytes(200);
    s.connection.raw.set(s.signature, bytes);
    const r2 = signReceipt(s.gw.identity, { ...s.receipt, bundleId: createHash('sha256').update(bytes).digest('hex'), trail: [] });
    const ok = await s.h.post('/api/offgrid/claim', buildClaim(s.gw.identity, r2, { ts: T0 }));
    assert.equal(ok.status, 200, ok.text);
  } finally { await s.h.close(); }
});

test('claim: gateway must be a registered gateway; unregistered carriers are listed, not paid', async () => {
  const s = await scenario({ carriers: 3, registerCarriers: 1 });
  try {
    const r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity));
    assert.equal(r.status, 200);
    assert.equal(r.json.credits.length, 2);
    assert.equal(r.json.unpaidCarriers.length, 2);
    assert.equal(r.json.credits.reduce((a, c) => a + BigInt(c.lamports), 0n), 1_000_000n);
  } finally { await s.h.close(); }
  const t = await scenario();
  try {
    await t.h.store.collection('nodes').delete(t.gw.id);
    const r = await t.h.post('/api/offgrid/claim', t.claimBy(t.carrierNodes[0].identity));
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'NOT_GATEWAY');
  } finally { await t.h.close(); }
});

test('claim: if pay fails the claim is released and can be retried', async () => {
  const pay = fakePay();
  const s = await scenario({ pay });
  try {
    pay.failCredit = true;
    const r = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity));
    assert.equal(r.status, 500);
    assert.equal(await s.h.store.collection('offgrid_claims').get(s.signature), null);
    pay.failCredit = false;
    const ok = await s.h.post('/api/offgrid/claim', s.claimBy(s.gw.identity, T0 + 1));
    assert.equal(ok.status, 200);
    assert.equal((await s.h.store.collection('offgrid_claims').get(s.signature)).status, 'credited');
  } finally { await s.h.close(); }
});

test('claim: not configured without pay, without a connection, or without the offgrid module', async () => {
  const noConn = await scenario({ withConnection: false });
  try {
    const r = await noConn.h.post('/api/offgrid/claim', noConn.claimBy(noConn.gw.identity));
    assert.equal(r.status, 503);
  } finally { await noConn.h.close(); }
  const h = await startApp({ pay: fakePay(), connection: fakeConnection() });
  try {
    const s = await scenario();
    await s.h.close();
    const r = await h.post('/api/offgrid/claim', s.claimBy(s.gw.identity));
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'NOT_CONFIGURED');
  } finally { await h.close(); }
});
