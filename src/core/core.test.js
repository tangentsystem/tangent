import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { canonical, createIdentity, verifyObject, solanaSecretKey, createKxKeypair, kxShared, signVoucher, checkVoucher, signDescriptor, checkDescriptor, createMeter } from './index.js';

test('canonical sorts keys and encodes bigint', () => {
  assert.equal(canonical({ b: 1, a: 2n, c: [true, null] }), '{"a":"2","b":1,"c":[true,null]}');
});
test('identity signs, verifies and matches solana keypair', () => {
  const id = createIdentity();
  const sig = id.signObject({ hello: 'x' });
  assert.ok(verifyObject(id.id, { hello: 'x' }, sig));
  assert.ok(!verifyObject(id.id, { hello: 'y' }, sig));
  assert.equal(Keypair.fromSecretKey(solanaSecretKey(id)).publicKey.toBase58(), id.id);
});
test('x25519 shared secret agrees', () => {
  const a = createKxKeypair(), b = createKxKeypair();
  assert.deepEqual(kxShared(a.secret, b.publicKey), kxShared(b.secret, a.publicKey));
});
test('voucher rules', () => {
  const payer = createIdentity(), node = createIdentity();
  const base = { session: 's1', node: node.id, kind: 'relay', expires: Date.now() + 60000 };
  const v1 = signVoucher(payer, { ...base, cumulative: 100n, seq: 1 });
  assert.ok(checkVoucher(v1, { node: node.id }).ok);
  const v2 = signVoucher(payer, { ...base, cumulative: 250n, seq: 2 });
  assert.ok(checkVoucher(v2, { node: node.id, prev: v1 }).ok);
  assert.equal(checkVoucher(v1, { node: node.id, prev: v2 }).reason, 'stale seq');
  assert.equal(checkVoucher({ ...v2, cumulative: '999' }, { node: node.id }).reason, 'signature');
  assert.equal(checkVoucher(v2, { node: payer.id }).reason, 'wrong node');
});
test('descriptor sign and check', () => {
  const node = createIdentity(), kx = createKxKeypair();
  const d = signDescriptor(node, { roles: ['exit', 'relay'], host: '127.0.0.1', port: 9001, kx: kx.pub, prices: { perMbLamports: 5000n } });
  assert.ok(checkDescriptor(d).ok);
  assert.equal(checkDescriptor({ ...d, port: 1 }).reason, 'signature');
});
test('meter owes per MB, rounded up', () => {
  const m = createMeter();
  m.open('s', { kind: 'relay', priceLamports: 5000n, payer: 'p' });
  assert.equal(m.add('s', 1), 1n);
  assert.equal(m.add('s', 1_999_999), 10000n);
  m.setPaid('s', 4000n);
  assert.equal(m.unpaid('s'), 6000n);
});
