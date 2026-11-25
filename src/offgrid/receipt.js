// Receipts (gateway -> back through the mesh to the sender), claims (gateway and carriers ->
// coordinator, POST /api/offgrid/claim) and the tip split the coordinator reuses.
import { verifyObject } from '../core/index.js';
import { verifyTrail, MAX_TRAIL } from './bundle.js';

export const RECEIPT_VERSION = 1;
export const RECEIPT_STATUS = Object.freeze(['landed', 'failed']);

export function receiptBody(r) {
  const body = {
    v: RECEIPT_VERSION, t: 'tangent-offgrid-receipt', bundleId: String(r.bundleId), status: r.status,
    signature: String(r.signature), slot: r.slot == null ? null : Number(r.slot),
    gateway: String(r.gateway), origin: String(r.origin),
    trail: (r.trail || []).map((e) => ({ node: String(e.node), sig: String(e.sig) })), ts: Number(r.ts),
  };
  if (r.reason) body.reason = String(r.reason).slice(0, 120);
  return body;
}

// Gateway signs. status 'landed' (with slot) or 'failed' (with reason, e.g. 'nonce used').
export function signReceipt(gatewayIdentity, fields) {
  const body = receiptBody({ ...fields, gateway: gatewayIdentity.id, ts: fields.ts ?? Date.now() });
  return { ...body, sig: gatewayIdentity.signObject(body) };
}

// Structural + signature + trail check. When the checker holds the bundle it should also pass
// `txSignature` (first signature of the transaction) so a landed receipt must name it.
export function checkReceipt(r, { txSignature = null, origin = null } = {}) {
  if (!r || typeof r !== 'object') return { ok: false, reason: 'receipt' };
  if (r.v !== RECEIPT_VERSION || r.t !== 'tangent-offgrid-receipt') return { ok: false, reason: 'version' };
  if (!RECEIPT_STATUS.includes(r.status)) return { ok: false, reason: 'status' };
  if (!/^[0-9a-f]{64}$/.test(String(r.bundleId))) return { ok: false, reason: 'bundle id' };
  if (r.status === 'landed' && !(Number.isInteger(r.slot) && r.slot >= 0)) return { ok: false, reason: 'slot' };
  let body;
  try { body = receiptBody(r); } catch { return { ok: false, reason: 'receipt' }; }
  if (!verifyObject(body.gateway, body, r.sig)) return { ok: false, reason: 'signature' };
  if (txSignature && r.status === 'landed' && r.signature !== txSignature) return { ok: false, reason: 'tx signature mismatch' };
  if (origin && r.origin !== origin) return { ok: false, reason: 'origin mismatch' };
  const tr = verifyTrail(body.bundleId, body.trail, { origin: body.origin, gateway: body.gateway });
  if (!tr.ok) return { ok: false, reason: tr.reason };
  return { ok: true };
}

// Claim sent to the coordinator by the gateway or by a carrier on the trail.
// { v, t, role, claimant, bundleId, signature, slot, gateway, trail, receipt, ts, sig }
export function buildClaim(identity, receipt, { ts = Date.now() } = {}) {
  if (receipt.status !== 'landed') throw new Error('claim: receipt not landed');
  let role;
  if (identity.id === receipt.gateway) role = 'gateway';
  else if (receipt.trail.some((e) => e.node === identity.id)) role = 'carrier';
  else throw new Error('claim: not on this receipt');
  const body = {
    v: 1, t: 'tangent-offgrid-claim', role, claimant: identity.id, bundleId: receipt.bundleId, signature: receipt.signature,
    slot: receipt.slot, gateway: receipt.gateway, trail: receipt.trail, receipt, ts,
  };
  return { ...body, sig: identity.signObject(body) };
}

// What the coordinator runs on POST /api/offgrid/claim before it looks the transaction up on chain.
export function checkClaim(c) {
  if (!c || c.v !== 1 || c.t !== 'tangent-offgrid-claim') return { ok: false, reason: 'claim' };
  const { sig, ...body } = c;
  if (!verifyObject(c.claimant, body, sig)) return { ok: false, reason: 'claimant signature' };
  const r = checkReceipt(c.receipt);
  if (!r.ok) return { ok: false, reason: 'receipt ' + r.reason };
  if (c.receipt.status !== 'landed') return { ok: false, reason: 'not landed' };
  if (c.bundleId !== c.receipt.bundleId || c.signature !== c.receipt.signature || c.gateway !== c.receipt.gateway
    || c.slot !== c.receipt.slot || JSON.stringify(c.trail) !== JSON.stringify(c.receipt.trail)) return { ok: false, reason: 'claim does not match receipt' };
  const isGateway = c.claimant === c.receipt.gateway;
  const isCarrier = c.receipt.trail.some((e) => e.node === c.claimant);
  if (c.role === 'gateway' ? !isGateway : (c.role !== 'carrier' || !isCarrier)) return { ok: false, reason: 'role' };
  return { ok: true };
}

// Pure tip split, BigInt lamports. Default: half (gatewayBps 5000) to the gateway, the rest split
// evenly among the first `maxCarriers` distinct carriers on the trail (gateway excluded).
// Integer remainders go to the gateway so the parts always sum exactly to the tip.
// With no carriers the gateway gets everything.
export function splitTip(tipLamports, trail, gateway, { gatewayBps = 5000, maxCarriers = MAX_TRAIL } = {}) {
  const tip = BigInt(tipLamports);
  if (tip < 0n) throw new Error('splitTip: negative tip');
  if (!Number.isInteger(gatewayBps) || gatewayBps < 0 || gatewayBps > 10000) throw new Error('splitTip: bad bps');
  const carriers = [];
  for (const e of trail || []) {
    const id = typeof e === 'string' ? e : e.node;
    if (id && id !== gateway && !carriers.includes(id)) carriers.push(id);
    if (carriers.length >= maxCarriers) break;
  }
  if (carriers.length === 0) return { gateway: { id: gateway, lamports: tip }, carriers: [] };
  const gwBase = (tip * BigInt(gatewayBps)) / 10000n;
  const pool = tip - gwBase;
  const each = pool / BigInt(carriers.length);
  const remainder = pool - each * BigInt(carriers.length);
  return {
    gateway: { id: gateway, lamports: gwBase + remainder },
    carriers: carriers.map((id) => ({ id, lamports: each })),
  };
}
