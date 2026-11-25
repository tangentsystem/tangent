import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createIdentity } from '../core/index.js';
import { appendTrail } from './bundle.js';
import { signReceipt, checkReceipt, buildClaim, checkClaim, splitTip } from './receipt.js';

const bundleId = randomBytes(32).toString('hex');
const origin = createIdentity(), gw = createIdentity();
const carriers = [createIdentity(), createIdentity(), createIdentity()];
let trail = []; for (const c of carriers) trail = appendTrail(bundleId, trail, c);
const landed = () => signReceipt(gw, { bundleId, status: 'landed', signature: 'SIG', slot: 42, origin: origin.id, trail });

test('receipt signs and verifies; tampering fails', () => {
  const r = landed();
  assert.ok(checkReceipt(r).ok);
  assert.ok(checkReceipt(JSON.parse(JSON.stringify(r))).ok);
  assert.equal(checkReceipt({ ...r, slot: 43 }).reason, 'signature');
  assert.equal(checkReceipt(r, { txSignature: 'OTHER' }).reason, 'tx signature mismatch');
  assert.equal(checkReceipt(r, { origin: gw.id }).reason, 'origin mismatch');
  const f = signReceipt(gw, { bundleId, status: 'failed', signature: 'SIG', slot: null, reason: 'nonce used', origin: origin.id, trail: [] });
  assert.ok(checkReceipt(f).ok);
});

test('claims for gateway and carriers verify; outsiders and edits fail', () => {
  const r = landed();
  const g = buildClaim(gw, r); assert.equal(g.role, 'gateway'); assert.ok(checkClaim(g).ok);
  for (const c of carriers) { const cl = buildClaim(c, r); assert.equal(cl.role, 'carrier'); assert.ok(checkClaim(JSON.parse(JSON.stringify(cl))).ok); }
  assert.throws(() => buildClaim(createIdentity(), r), /not on this receipt/);
  const cl = buildClaim(carriers[0], r);
  assert.equal(checkClaim({ ...cl, role: 'gateway' }).ok, false);
  const outsider = createIdentity();
  const { sig, ...body } = cl;
  const stolen = { ...body, claimant: outsider.id }; stolen.sig = outsider.signObject(stolen);
  assert.equal(checkClaim(stolen).reason, 'role');
  // forged trail inside a re-signed receipt by a fake gateway still needs valid trail signatures
  const fakeTrail = trail.map((e, i) => (i === 1 ? { node: outsider.id, sig: e.sig } : e));
  const fake = signReceipt(gw, { bundleId, status: 'landed', signature: 'SIG', slot: 1, origin: origin.id, trail: fakeTrail });
  assert.equal(checkReceipt(fake).reason, 'trail signature');
  const failed = signReceipt(gw, { bundleId, status: 'failed', signature: 'SIG', slot: null, origin: origin.id, trail });
  assert.throws(() => buildClaim(gw, failed), /not landed/);
});

test('splitTip examples', () => {
  const t = (n) => trail.slice(0, n);
  let s = splitTip(1000n, t(3), gw.id);
  assert.equal(s.gateway.lamports, 500n + 2n); // 500 / 3 = 166 r 2 -> remainder to gateway
  assert.deepEqual(s.carriers.map((c) => c.lamports), [166n, 166n, 166n]);
  s = splitTip(1000n, [], gw.id);
  assert.equal(s.gateway.lamports, 1000n); assert.equal(s.carriers.length, 0);
  s = splitTip(0n, t(2), gw.id);
  assert.equal(s.gateway.lamports, 0n);
  // at most 8 carriers paid, gateway never paid as carrier, repeats ignored
  const ids = Array.from({ length: 12 }, () => createIdentity().id);
  s = splitTip(10_000n, [...ids, gw.id, ids[0]], gw.id);
  assert.equal(s.carriers.length, 8);
  assert.deepEqual(s.carriers.map((c) => c.id), ids.slice(0, 8));
  assert.throws(() => splitTip(-1n, [], gw.id));
});

test('splitTip property: parts always sum to the tip and are never negative', () => {
  for (let i = 0; i < 5000; i++) {
    const tip = BigInt(Math.floor(Math.random() * 1e9)) * (i % 7 === 0 ? 1_000_000_000n : 1n) + BigInt(i % 13);
    const n = Math.floor(Math.random() * 14);
    const tr = Array.from({ length: n }, (_, k) => ({ node: 'c' + (Math.random() < 0.1 ? 0 : k), sig: 'x' }));
    const bps = Math.floor(Math.random() * 10001);
    const gwId = Math.random() < 0.1 ? 'c1' : 'gw';
    const s = splitTip(tip, tr, gwId, { gatewayBps: bps });
    const sum = s.gateway.lamports + s.carriers.reduce((a, c) => a + c.lamports, 0n);
    assert.equal(sum, tip);
    assert.ok(s.gateway.lamports >= 0n && s.carriers.every((c) => c.lamports >= 0n));
    assert.ok(s.carriers.length <= 8);
    assert.ok(!s.carriers.some((c) => c.id === gwId));
    assert.equal(new Set(s.carriers.map((c) => c.id)).size, s.carriers.length);
    if (s.carriers.length > 1) assert.ok(s.carriers.every((c) => c.lamports === s.carriers[0].lamports));
  }
});
