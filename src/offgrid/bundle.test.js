import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { createIdentity } from '../core/index.js';
import {
  inspectTx, createBundle, encodeBundle, decodeBundle, validateBundle, appendTrail, verifyTrail,
  bundleIdOfTx, MAX_TRAIL, MAX_BUNDLE_BYTES, headerBody,
} from './bundle.js';
import { buildDurableTransfer, buildDurableTx } from './nonce.js';
import { makeChain } from './test-support/fixtures.js';

const origin = createIdentity();
const tipAccount = Keypair.generate().publicKey.toBase58();

function durable(chain, { version = 'legacy', lamports = 1_000_000, tip = null } = {}) {
  const { nonce, value } = chain.createNonce();
  return buildDurableTransfer({ from: chain.payer, to: Keypair.generate().publicKey, lamports, nonceAccount: nonce.publicKey, nonceValue: value, version, tip });
}

test('durable nonce transfers (legacy and v0) pass inspection and bundle validation', () => {
  const chain = makeChain();
  for (const version of ['legacy', 0]) {
    const tx = durable(chain, { version });
    const t = inspectTx(tx);
    assert.ok(t.ok, t.reason);
    assert.equal(t.info.version, version);
    assert.ok(t.info.nonce && t.info.nonce.authority === chain.payer.publicKey.toBase58());
    const b = createBundle({ identity: origin, txBytes: tx });
    const back = decodeBundle(encodeBundle(b));
    assert.equal(back.id, bundleIdOfTx(tx));
    assert.ok(validateBundle(back).ok);
  }
});

test('tampered transaction is rejected', () => {
  const chain = makeChain();
  const tx = durable(chain);
  const bad = Uint8Array.from(tx); bad[bad.length - 3] ^= 1; // inside the transfer amount
  assert.equal(inspectTx(bad).reason, 'bad signature');
  const b = createBundle({ identity: origin, txBytes: tx });
  const enc = encodeBundle(b);
  const forged = Uint8Array.from(enc); forged[108 + 2 + tx.length - 3] ^= 1; // same byte, inside the bundle
  const fb = decodeBundle(forged);
  assert.notEqual(fb.id, b.id);
  assert.equal(validateBundle(fb).reason, 'origin signature'); // id changed, so the signed header no longer matches
  fb.originSig = origin.signObject(headerBody(fb));
  assert.equal(validateBundle(fb).reason, 'bad signature'); // even a re-signed header cannot fix the transaction
});

test('non durable transaction is rejected', () => {
  const chain = makeChain();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: chain.payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 }));
  tx.recentBlockhash = chain.svm.latestBlockhash(); tx.feePayer = chain.payer.publicKey; tx.sign(chain.payer);
  assert.equal(inspectTx(new Uint8Array(tx.serialize())).reason, 'not durable nonce');
});

test('missing signature is rejected', () => {
  const chain = makeChain();
  const { nonce, value } = chain.createNonce();
  const other = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.nonceAdvance({ noncePubkey: nonce.publicKey, authorizedPubkey: chain.payer.publicKey }),
    SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: chain.payer.publicKey, lamports: 5 }),
  );
  tx.recentBlockhash = value; tx.feePayer = chain.payer.publicKey; tx.partialSign(chain.payer);
  assert.equal(inspectTx(new Uint8Array(tx.serialize({ requireAllSignatures: false }))).reason, 'missing signature');
});

test('oversized bundles and transactions are rejected', () => {
  assert.equal(inspectTx(new Uint8Array(1233)).reason, 'tx too large');
  assert.throws(() => decodeBundle(new Uint8Array(MAX_BUNDLE_BYTES + 1)), /too large/);
  const chain = makeChain();
  const b = createBundle({ identity: origin, txBytes: durable(chain) });
  b.tx = new Uint8Array(1300);
  assert.throws(() => decodeBundle(encodeBundle(b)), /too large/);
});

test('header limits are signed by the origin', () => {
  const chain = makeChain();
  const b = createBundle({ identity: origin, txBytes: durable(chain), maxAge: 3600 });
  const back = decodeBundle(encodeBundle(b));
  back.maxAge = 7 * 24 * 3600;
  assert.equal(validateBundle(back).reason, 'origin signature');
  const old = createBundle({ identity: origin, txBytes: durable(chain), maxAge: 60, created: Math.floor(Date.now() / 1000) - 120 });
  assert.equal(validateBundle(old).reason, 'expired');
  const future = createBundle({ identity: origin, txBytes: durable(chain), created: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(validateBundle(future).reason, 'created in future');
});

test('tip must match a real transfer to the tip account', () => {
  const chain = makeChain();
  const tx = durable(chain, { tip: { account: tipAccount, lamports: 50_000n } });
  const ok = createBundle({ identity: origin, txBytes: tx, tip: { account: tipAccount, lamports: 50_000n } });
  assert.ok(validateBundle(decodeBundle(encodeBundle(ok))).ok);
  const lie = createBundle({ identity: origin, txBytes: tx, tip: { account: tipAccount, lamports: 90_000n } });
  assert.equal(validateBundle(lie).reason, 'tip not in tx');
});

test('carried-by trail chains signatures and rejects forgery', () => {
  const chain = makeChain();
  const b = createBundle({ identity: origin, txBytes: durable(chain) });
  const carriers = Array.from({ length: MAX_TRAIL }, () => createIdentity());
  let trail = [];
  for (const c of carriers) trail = appendTrail(b.id, trail, c);
  assert.ok(verifyTrail(b.id, trail, { origin: origin.id }).ok);
  b.trail = trail;
  assert.ok(validateBundle(decodeBundle(encodeBundle(b))).ok);
  // forged: carrier 3 replaced by an outsider who signs with its own key over the right data
  const outsider = createIdentity();
  const forged = trail.map((e) => ({ ...e }));
  forged[3] = { node: outsider.id, sig: trail[3].sig };
  assert.equal(verifyTrail(b.id, forged).reason, 'trail signature');
  // reordering breaks the hash chain
  const swapped = [trail[1], trail[0], ...trail.slice(2)];
  assert.equal(verifyTrail(b.id, swapped).reason, 'trail signature');
  // a signature for one bundle cannot be reused on another
  const b2 = createBundle({ identity: origin, txBytes: durable(chain) });
  assert.equal(verifyTrail(b2.id, trail.slice(0, 1)).reason, 'trail signature');
  // repeats, origin in trail, too long
  assert.equal(verifyTrail(b.id, [trail[0], trail[0]]).reason, 'trail repeat');
  assert.equal(verifyTrail(b.id, appendTrail(b.id, [], origin), { origin: origin.id }).reason, 'origin in trail');
  assert.equal(verifyTrail(b.id, [...trail, ...appendTrail(b.id, trail, createIdentity()).slice(-1)]).reason, 'trail too long');
});

test('v0 durable transaction with extra signer and tip validates', () => {
  const chain = makeChain();
  const { nonce, value } = chain.createNonce();
  const second = Keypair.generate();
  const tx = buildDurableTx({
    feePayer: chain.payer.publicKey, nonceAccount: nonce.publicKey, nonceValue: value, version: 0,
    instructions: [SystemProgram.transfer({ fromPubkey: second.publicKey, toPubkey: chain.payer.publicKey, lamports: 1n })],
    tip: { account: tipAccount, lamports: 7n }, signers: [chain.payer, second],
  });
  const t = inspectTx(tx);
  assert.ok(t.ok, t.reason);
  assert.equal(t.info.signatures.length, 2);
});
