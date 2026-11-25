// Client side helpers for credit tokens, used by the CLI and apps. Nothing here talks to the network: callers
// send the bodies these build to the pay routes (/api/pay/...).
//
// Flow:
//   1. keys = GET /api/pay/keys; pick the key that `issues` for the denomination you want
//   2. { pending, blinded } = await prepareTokens(key, count)          keep `pending` secret and local
//   3. { challenge } = POST /api/pay/challenge { wallet }
//   4. POST /api/pay/issue  issueRequest(wallet, { challenge, denomination, blinded })   -> { blindSigs }
//   5. tokens = await finalizeTokens(key, pending, blindSigs)          verified locally before use
//   6. account = newAccount(); POST /api/pay/redeem redeemRequest(token, account)  (one request per token,
//      ideally at a different time and over a private circuit, so timing does not link them)
//   7. sign vouchers from `account` (src/core signVoucher)
import { randomBytes } from 'node:crypto';
import { createIdentity } from '../core/identity.js';
import { suite } from './blind.js';
import { issueBody, redeemBody, withdrawBody, balanceBody, tokenInnerMessage } from './messages.js';
import { b64u, unb64u } from './util.js';

const IMPORT_ALG = { name: 'RSA-PSS', hash: 'SHA-384' };

export async function importIssuerKey(keyInfo) {
  return crypto.subtle.importKey('spki', Buffer.from(keyInfo.spki, 'base64url'), IMPORT_ALG, true, ['verify']);
}

// -> { pending: [{ msg, inv, blinded }] (secret, keep local), blinded: string[] (send to the issuer) }
export async function prepareTokens(keyInfo, count = 1) {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const S = suite();
  const pub = await importIssuerKey(keyInfo);
  const pending = [];
  for (let i = 0; i < count; i += 1) {
    const serial = randomBytes(32).toString('hex');
    const msg = S.prepare(new TextEncoder().encode(tokenInnerMessage(keyInfo.keyId, serial)));
    const { blindedMsg, inv } = await S.blind(pub, msg);
    pending.push({ msg: b64u(msg), inv: b64u(inv), blinded: b64u(blindedMsg) });
  }
  return { pending, blinded: pending.map((p) => p.blinded) };
}

// Unblinds and verifies. -> tokens [{ keyId, denomination, msg, sig }]. Throws if any signature is bad.
export async function finalizeTokens(keyInfo, pending, blindSigs) {
  if (!Array.isArray(blindSigs) || blindSigs.length !== pending.length) throw new Error('blind signature count mismatch');
  const S = suite();
  const pub = await importIssuerKey(keyInfo);
  const out = [];
  for (let i = 0; i < pending.length; i += 1) {
    const msg = unb64u(pending[i].msg);
    const sig = await S.finalize(pub, msg, unb64u(blindSigs[i]), unb64u(pending[i].inv)); // finalize verifies too
    out.push({ keyId: keyInfo.keyId, denomination: String(keyInfo.denomination), msg: b64u(msg), sig: b64u(sig) });
  }
  return out;
}

export function newAccount(seed32) {
  return createIdentity(seed32);
}

// wallet: an identity with signObject (src/core createIdentity), or { id, signObject } wrapping a wallet adapter.
export function issueRequest(wallet, { challenge, denomination, blinded }) {
  const body = issueBody({ wallet: wallet.id, challenge, denomination, blinded });
  return { wallet: wallet.id, challenge: body.challenge, denomination: body.denomination, blinded: body.blinded, sig: wallet.signObject(body) };
}

export function redeemRequest(token, account) {
  const t = { keyId: token.keyId, msg: token.msg, sig: token.sig };
  return { token: t, accountId: account.id, sig: account.signObject(redeemBody({ token: t, accountId: account.id })) };
}

export function withdrawRequest(wallet, { challenge, to, amount, public: isPublic = false }) {
  const body = withdrawBody({ wallet: wallet.id, challenge, to, amount, public: isPublic });
  return { wallet: wallet.id, challenge: body.challenge, to: body.to, amount: body.amount, public: body.public, sig: wallet.signObject(body) };
}

export function balanceRequest(wallet, ts = Date.now()) {
  return { wallet: wallet.id, ts, sig: wallet.signObject(balanceBody({ wallet: wallet.id, ts })) };
}

// Splits a lamport amount into the fewest tokens of the given denominations (largest first).
// -> [{ denomination, count }]; any remainder smaller than the smallest denomination stays in the wallet.
export function planTokens(amount, denominations) {
  let left = BigInt(amount);
  const out = [];
  for (const d of [...denominations].map(BigInt).sort((a, b) => (a < b ? 1 : -1))) {
    const n = left / d;
    if (n > 0n) {
      out.push({ denomination: d.toString(), count: Number(n) });
      left -= n * d;
    }
  }
  return out;
}
