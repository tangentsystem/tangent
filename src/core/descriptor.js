// Node descriptor: what a node tells the coordinator and what clients read from the
// directory. Signed by the node identity. roles: 'relay' (carries private traffic),
// 'exit' (relay that also connects out to the internet), 'gateway' (submits off-grid
// transactions to Solana), 'compute' (rents machines to AI agents).
import { verifyObject } from './identity.js';

export const ROLES = Object.freeze(['relay', 'exit', 'gateway', 'compute']);

export function descriptorBody(d) {
  const roles = [...new Set(d.roles || [])].sort();
  if (!roles.length || roles.some((r) => !ROLES.includes(r))) throw new Error('descriptor: bad roles');
  const prices = d.prices || {};
  return {
    v: 1,
    id: String(d.id),
    roles,
    host: String(d.host || ''),          // public hostname or ip, '' when onion only
    port: Number(d.port || 0),           // relay/peer port
    apiPort: Number(d.apiPort || 0),     // node http api (compute, gateway), 0 if none
    onion: d.onion ? String(d.onion) : undefined, // xxxxx.onion when published
    kx: String(d.kx),                    // base58 x25519 public key for circuits
    payout: String(d.payout || d.id),    // solana address that receives earnings
    prices: {
      perMbLamports: String(BigInt(prices.perMbLamports ?? 0)),
      perTxLamports: String(BigInt(prices.perTxLamports ?? 0)),
      perSecondLamports: String(BigInt(prices.perSecondLamports ?? 0)),
    },
    region: d.region ? String(d.region) : undefined, // coarse, e.g. 'eu-west', never precise location
    version: String(d.version || '0.1.0'),
    ts: Number(d.ts || Date.now()),
  };
}

export function signDescriptor(identity, fields) {
  const body = descriptorBody({ ...fields, id: identity.id });
  return { ...body, sig: identity.signObject(body) };
}

export function checkDescriptor(desc, { maxAgeMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  let body;
  try { body = descriptorBody(desc); } catch (e) { return { ok: false, reason: e.message }; }
  if (!verifyObject(body.id, body, desc.sig)) return { ok: false, reason: 'signature' };
  if (Math.abs(now - body.ts) > maxAgeMs) return { ok: false, reason: 'stale' };
  return { ok: true };
}
