import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makePay, fund, buyTokens, redeemInto, keyFor, createIdentity, newAccount, clock } from './testkit.js';
import { prepareTokens, finalizeTokens, issueRequest, redeemRequest } from './client.js';
import { suite } from './blind.js';
import { createMemoryStore, COLLECTIONS as C } from './store.js';

const D1 = '10000000'; // 0.01 SOL

const rejects = (p, code) => assert.rejects(p, (e) => {
  assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
  return true;
});

test('blind issue, unblind, redeem round trip credits an anonymous account', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  await fund(ctx, alice, 50_000_000n);
  assert.equal((await ctx.pay.balance(alice.id)).balance, '50000000');
  const { tokens, res } = await buyTokens(ctx.pay, alice, D1, 3);
  assert.equal(tokens.length, 3);
  assert.equal(res.balance, '20000000');
  assert.equal((await ctx.pay.balance(alice.id)).balance, '20000000');

  const acct = newAccount();
  for (const t of tokens) await ctx.pay.redeemToken(redeemRequest(t, acct));
  assert.deepEqual(await ctx.pay.account(acct.id), { accountId: acct.id, balance: '30000000', funded: '30000000', spent: '0' });
  assert.equal(await ctx.pay.account(newAccount().id), null);
  assert.equal((await ctx.pay.totals()).balanced, true);
});

test('server blind signature equals the library blindSign and verifies after unblinding', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  await fund(ctx, alice, 10_000_000n);
  const key = await keyFor(ctx.pay, D1);
  const { pending, blinded } = await prepareTokens(key, 1);
  const { challenge } = await ctx.pay.challenge(alice.id);
  const res = await ctx.pay.issueBlindTokens(issueRequest(alice, { challenge, denomination: D1, blinded }));
  // library path on the same private key
  const row = (await ctx.store.keys.list('blind:')).find((r) => r.meta.keyId === key.keyId);
  const priv = await crypto.subtle.importKey('pkcs8', Buffer.from(row.secret, 'base64'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
  const lib = await suite().blindSign(priv, Buffer.from(blinded[0], 'base64url'));
  assert.equal(Buffer.from(lib).toString('base64url'), res.blindSigs[0]);
  const [token] = await finalizeTokens(key, pending, res.blindSigs);
  const pub = await crypto.subtle.importKey('spki', Buffer.from(key.spki, 'base64url'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  assert.equal(await suite().verify(pub, Buffer.from(token.sig, 'base64url'), Buffer.from(token.msg, 'base64url')), true);
});

// Modular helpers for the unlinkability demonstration.
const toBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
function modInv(a, m) {
  let [g, x, y0, x1] = [m, 0n, a % m, 1n];
  while (y0 !== 0n) {
    const q = g / y0;
    [g, y0] = [y0, g - q * y0];
    [x, x1] = [x1, x - q * x1];
  }
  if (g !== 1n) throw new Error('not invertible');
  return ((x % m) + m) % m;
}

test('unlinkability: the issuer view shares nothing with a redeemed token, and every issuance fits every token equally', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  const bob = createIdentity();
  await fund(ctx, alice, 10_000_000n);
  await fund(ctx, bob, 10_000_000n);
  const a = await buyTokens(ctx.pay, alice, D1, 1);
  const b = await buyTokens(ctx.pay, bob, D1, 1);
  const issuerTranscripts = [
    { wallet: alice.id, blinded: a.blinded[0], blindSig: a.res.blindSigs[0] },
    { wallet: bob.id, blinded: b.blinded[0], blindSig: b.res.blindSigs[0] },
  ];

  // Redeem one token (we do not tell the "issuer" whose).
  const token = Math.random() < 0.5 ? a.tokens[0] : b.tokens[0];
  await redeemInto(ctx.pay, token);

  // 1. Nothing the issuer stored or saw at issuance appears in the redeemed token, and vice versa.
  const dump = JSON.stringify(ctx.store._dump());
  const issuances = ctx.store._dump()[C.issuances];
  assert.equal(issuances.length, 2);
  for (const rec of issuances) assert.deepEqual(Object.keys(rec).sort(), ['_id', 'amount', 'at', 'count', 'denomination', 'keyId', 'wallet']);
  const tokenMsgHex = Buffer.from(token.msg, 'base64url').toString('hex');
  const tokenSigHex = Buffer.from(token.sig, 'base64url').toString('hex');
  for (const tr of issuerTranscripts) {
    const bHex = Buffer.from(tr.blinded, 'base64url').toString('hex');
    const sHex = Buffer.from(tr.blindSig, 'base64url').toString('hex');
    assert.equal(bHex === tokenMsgHex || sHex === tokenSigHex, false);
    for (let i = 0; i + 16 <= tokenSigHex.length; i += 16) assert.equal(bHex.includes(tokenSigHex.slice(i, i + 16)) || sHex.includes(tokenSigHex.slice(i, i + 16)), false);
  }
  assert.equal(dump.includes(a.blinded[0]) || dump.includes(b.blinded[0]), false, 'blinded messages are not stored');
  assert.equal(dump.includes(a.res.blindSigs[0]) || dump.includes(b.res.blindSigs[0]), false, 'blind signatures are not stored');

  // 2. Even with the private key and both transcripts, the issuer finds a valid blinding factor that maps EACH
  //    transcript onto the redeemed token: r = blindSig * sig^-1 mod n satisfies blinded == EM * r^e mod n, where
  //    EM = sig^e mod n is the encoded message. RSA blinding is perfect, so the transcripts carry no information
  //    about which one produced the token.
  const key = await keyFor(ctx.pay, D1);
  const jwk = crypto.createPublicKey({ key: Buffer.from(key.spki, 'base64url'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
  const n = toBig(Buffer.from(jwk.n, 'base64url'));
  const e = toBig(Buffer.from(jwk.e, 'base64url'));
  const s = toBig(Buffer.from(token.sig, 'base64url'));
  const em = modPow(s, e, n);
  for (const tr of issuerTranscripts) {
    const bs = toBig(Buffer.from(tr.blindSig, 'base64url'));
    const blinded = toBig(Buffer.from(tr.blinded, 'base64url'));
    const r = (bs * modInv(s, n)) % n;
    assert.equal((em * modPow(r, e, n)) % n, blinded, 'transcript of ' + (tr.wallet === alice.id ? 'alice' : 'bob') + ' is consistent with the token');
  }
});

test('double spend: sequential and concurrent redemption credit exactly once', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  await fund(ctx, alice, 20_000_000n);
  const { tokens } = await buyTokens(ctx.pay, alice, D1, 2);

  const acct = newAccount();
  await ctx.pay.redeemToken(redeemRequest(tokens[0], acct));
  await rejects(ctx.pay.redeemToken(redeemRequest(tokens[0], acct)), 'TOKEN_SPENT');
  await rejects(ctx.pay.redeemToken(redeemRequest(tokens[0], newAccount())), 'TOKEN_SPENT');

  const accounts = Array.from({ length: 8 }, () => newAccount());
  const results = await Promise.allSettled(accounts.map((x) => ctx.pay.redeemToken(redeemRequest(tokens[1], x))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'TOKEN_SPENT', r.reason.stack);
  let total = 0n;
  for (const x of [acct, ...accounts]) total += BigInt((await ctx.pay.account(x.id))?.balance || 0);
  assert.equal(total, 20_000_000n);
  assert.equal((await ctx.pay.totals()).balanced, true);
});

test('rejections: wrong denomination key, tampered token, bad account signature, replayed challenge, unfunded wallet', async () => {
  const ctx = makePay();
  const alice = createIdentity();
  await fund(ctx, alice, 100_000_000n);
  const { tokens } = await buyTokens(ctx.pay, alice, D1, 1);
  const tok = tokens[0];
  const k001 = await keyFor(ctx.pay, '1000000');

  // token presented under another denomination's key id
  await rejects(ctx.pay.redeemToken(redeemRequest({ ...tok, keyId: k001.keyId }, newAccount())), 'BAD_TOKEN');
  // unknown key id
  await rejects(ctx.pay.redeemToken(redeemRequest({ ...tok, keyId: 'ab'.repeat(32) }, newAccount())), 'UNKNOWN_KEY');
  // tampered signature and tampered message
  const sig = Buffer.from(tok.sig, 'base64url');
  sig[10] ^= 1;
  await rejects(ctx.pay.redeemToken(redeemRequest({ ...tok, sig: sig.toString('base64url') }, newAccount())), 'BAD_TOKEN');
  const msg = Buffer.from(tok.msg, 'base64url');
  msg[msg.length - 1] = msg[msg.length - 1] === 0x61 ? 0x62 : 0x61;
  await rejects(ctx.pay.redeemToken(redeemRequest({ ...tok, msg: msg.toString('base64url') }, newAccount())), 'BAD_TOKEN');
  // blind signature from the 0.001 key does not make a 0.01 token: sign with key A, claim key B
  const kA = k001;
  const { pending, blinded } = await prepareTokens(kA, 1);
  const { challenge: c0 } = await ctx.pay.challenge(alice.id);
  const r0 = await ctx.pay.issueBlindTokens(issueRequest(alice, { challenge: c0, denomination: '1000000', blinded }));
  const [small] = await finalizeTokens(kA, pending, r0.blindSigs);
  const k01 = await keyFor(ctx.pay, D1);
  await rejects(ctx.pay.redeemToken(redeemRequest({ ...small, keyId: k01.keyId }, newAccount())), 'BAD_TOKEN');
  // blinded messages made for one key but sent under another denomination are signed by that denomination's key,
  // so the client's unblinding fails to verify
  // (when the other key's modulus is smaller than the blinded value, the issuer refuses it up front
  // as BAD_BLINDED instead; both outcomes mean no usable token, so either is accepted)
  const pk = await prepareTokens(kA, 1);
  const { challenge: c1 } = await ctx.pay.challenge(alice.id);
  let wrong = null;
  try {
    wrong = await ctx.pay.issueBlindTokens(issueRequest(alice, { challenge: c1, denomination: D1, blinded: pk.blinded }));
  } catch (err) {
    assert.equal(err.code, 'BAD_BLINDED');
  }
  if (wrong) await assert.rejects(finalizeTokens(kA, pk.pending, wrong.blindSigs));

  // account signature from a different identity
  const acct = newAccount();
  const req = redeemRequest(tok, acct);
  await rejects(ctx.pay.redeemToken({ ...req, accountId: newAccount().id }), 'BAD_SIGNATURE');

  // replayed challenge: the same signed issue request twice
  const p2 = await prepareTokens(k01, 1);
  const { challenge } = await ctx.pay.challenge(alice.id);
  const issueReq = issueRequest(alice, { challenge, denomination: D1, blinded: p2.blinded });
  await ctx.pay.issueBlindTokens(issueReq);
  await rejects(ctx.pay.issueBlindTokens(issueReq), 'CHALLENGE_USED');
  // a challenge issued to another wallet
  const bob = createIdentity();
  const { challenge: bobs } = await ctx.pay.challenge(bob.id);
  await rejects(ctx.pay.issueBlindTokens(issueRequest(alice, { challenge: bobs, denomination: D1, blinded: (await prepareTokens(k01, 1)).blinded })), 'BAD_CHALLENGE');
  // expired challenge
  const { challenge: old } = await ctx.pay.challenge(alice.id);
  ctx.now.advance(10 * 60000);
  await rejects(ctx.pay.issueBlindTokens(issueRequest(alice, { challenge: old, denomination: D1, blinded: (await prepareTokens(await keyFor(ctx.pay, D1), 1)).blinded })), 'CHALLENGE_EXPIRED');
  // signature over a different body
  const { challenge: c3 } = await ctx.pay.challenge(alice.id);
  const bad = issueRequest(alice, { challenge: c3, denomination: D1, blinded: (await prepareTokens(k01, 1)).blinded });
  await rejects(ctx.pay.issueBlindTokens({ ...bad, denomination: '1000000' }), 'BAD_SIGNATURE');
  // unknown denomination
  const { challenge: c4 } = await ctx.pay.challenge(alice.id);
  await rejects(ctx.pay.issueBlindTokens(issueRequest(alice, { challenge: c4, denomination: '5', blinded: pk.blinded })), 'BAD_DENOMINATION');
  // not enough balance: nothing is signed and the challenge is not burnt
  const poor = createIdentity();
  const { challenge: c5 } = await ctx.pay.challenge(poor.id);
  const poorReq = issueRequest(poor, { challenge: c5, denomination: D1, blinded: (await prepareTokens(k01, 1)).blinded });
  await rejects(ctx.pay.issueBlindTokens(poorReq), 'INSUFFICIENT_BALANCE');
  await fund(ctx, poor, 10_000_000n);
  const ok = await ctx.pay.issueBlindTokens(poorReq);
  assert.equal(ok.blindSigs.length, 1);
  // garbage blinded message
  const { challenge: c6 } = await ctx.pay.challenge(alice.id);
  await rejects(ctx.pay.issueBlindTokens(issueRequest(alice, { challenge: c6, denomination: D1, blinded: ['AAAA'] })), 'BAD_BLINDED');
  assert.equal((await ctx.pay.totals()).balanced, true);
});

test('key rotation: overlapping validity, old tokens redeem for one more period then expire', async () => {
  const PERIOD = 1000 * 60 * 60;
  const now = clock(PERIOD * 1000 + 10);
  const ctx = makePay({ now, config: { blindKeyPeriodMs: PERIOD } });
  const alice = createIdentity();
  await fund(ctx, alice, 100_000_000n);
  const first = await buyTokens(ctx.pay, alice, D1, 3);
  const k0 = first.key;

  now.advance(PERIOD); // next epoch
  const k1 = await keyFor(ctx.pay, D1);
  assert.notEqual(k1.keyId, k0.keyId);
  const listed = (await ctx.pay.issuerPublicKeys()).filter((k) => k.denomination === D1);
  assert.deepEqual(listed.map((k) => [k.keyId, k.issues]), [[k0.keyId, false], [k1.keyId, true]]);
  await redeemInto(ctx.pay, first.tokens[0]); // old key still redeems during the overlap
  const second = await buyTokens(ctx.pay, alice, D1, 1);
  assert.equal(second.key.keyId, k1.keyId);
  await redeemInto(ctx.pay, second.tokens[0]);

  now.advance(PERIOD); // the old key's redeem window is over
  await rejects(redeemInto(ctx.pay, first.tokens[1]), 'KEY_EXPIRED');
  const listed2 = (await ctx.pay.issuerPublicKeys()).filter((k) => k.denomination === D1).map((k) => k.keyId);
  assert.equal(listed2.includes(k0.keyId), false);
  assert.equal(listed2.includes(k1.keyId), true);
  // unredeemed expired tokens stay counted as outstanding, the invariant still holds
  assert.equal((await ctx.pay.totals()).balanced, true);
});

test('issuer keys: created once, insert only with a backup copy, reused after a restart', async () => {
  const store = createMemoryStore();
  const now = clock();
  const a = makePay({ store, now });
  const before = await a.pay.issuerPublicKeys();
  assert.equal(before.length, 4);
  assert.equal(store._backups().length, 4);
  for (const b of store._backups()) assert.ok(b.secret && b.publicKey && b.label.startsWith('blind:'));
  // a second instance on the same store sees the same keys, creates nothing
  const b = makePay({ store, now });
  assert.deepEqual((await b.pay.issuerPublicKeys()).map((k) => k.keyId), before.map((k) => k.keyId));
  assert.equal(store._backups().length, 4);
  // two instances racing on an empty store end up with one key per label
  const fresh = createMemoryStore();
  const [x, y] = [makePay({ store: fresh, now }), makePay({ store: fresh, now })];
  const [kx, ky] = await Promise.all([x.pay.issuerPublicKeys(), y.pay.issuerPublicKeys()]);
  assert.deepEqual(kx.map((k) => k.keyId), ky.map((k) => k.keyId));
  assert.equal((await fresh.keys.list('blind:')).length, 4);
  // the store never overwrites a key
  const row = (await store.keys.list('blind:'))[0];
  await assert.rejects(store.keys.insert({ ...row, secret: 'AAAA' }), /never overwritten/);
  assert.deepEqual(await store.keys.insert(row), { inserted: false });
});
