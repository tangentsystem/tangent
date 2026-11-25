// Payment voucher: an off-chain, signed, cumulative IOU from a payer to one node
// for one session. The node keeps only the newest voucher and redeems it at the
// coordinator, which settles through Privacy Rings (src/pay). Amounts are lamports
// as decimal strings. kind: 'relay' (per MB) | 'offgrid' (per tx) | 'compute' (per second).
import { verifyObject } from './identity.js';

export const VOUCHER_KINDS = Object.freeze(['relay', 'offgrid', 'compute']);

export function voucherBody({ session, payer, node, kind, cumulative, seq, expires }) {
  if (!VOUCHER_KINDS.includes(kind)) throw new Error('voucher: bad kind');
  const c = BigInt(cumulative);
  if (c < 0n) throw new Error('voucher: negative amount');
  if (!Number.isInteger(seq) || seq < 0) throw new Error('voucher: bad seq');
  if (!Number.isInteger(expires)) throw new Error('voucher: bad expires');
  return { v: 1, session: String(session), payer: String(payer), node: String(node), kind, cumulative: c.toString(), seq, expires };
}

// payerIdentity is the (usually anonymous, per-session) identity that owns the credit account.
export function signVoucher(payerIdentity, fields) {
  const body = voucherBody({ ...fields, payer: payerIdentity.id });
  return { ...body, sig: payerIdentity.signObject(body) };
}

// Returns { ok, reason }. prev is the last accepted voucher for the session, or null.
export function checkVoucher(voucher, { node, prev = null, now = Date.now() } = {}) {
  let body;
  try { body = voucherBody(voucher); } catch (e) { return { ok: false, reason: e.message }; }
  if (voucher.v !== 1) return { ok: false, reason: 'version' };
  if (node && body.node !== node) return { ok: false, reason: 'wrong node' };
  if (body.expires < now) return { ok: false, reason: 'expired' };
  if (!verifyObject(body.payer, body, voucher.sig)) return { ok: false, reason: 'signature' };
  if (prev) {
    if (prev.session !== body.session || prev.payer !== body.payer) return { ok: false, reason: 'session mismatch' };
    if (body.seq <= prev.seq) return { ok: false, reason: 'stale seq' };
    if (BigInt(body.cumulative) < BigInt(prev.cumulative)) return { ok: false, reason: 'amount went down' };
  }
  return { ok: true };
}
