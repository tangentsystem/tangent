// Bundle: the unit the mesh carries. It wraps one fully signed Solana transaction (legacy or
// v0) that uses a durable nonce, plus routing limits, the origin node's signature over the
// header, optional tip info, and the carried-by trail.
//
// Binary layout (version 1), big endian:
//   [0]       version = 1
//   [1..5)    created (unix seconds, u32)
//   [5]       maxHops (u8)
//   [6..10)   maxAge seconds (u32)
//   [10]      hops so far (u8, not signed: dedup and age bound loops anyway)
//   [11]      flags (bit0 = tip present)
//   [12..44)  origin node id (ed25519 public key)
//   [44..108) origin signature over the canonical header (see headerBody)
//   tip?      [account 32][lamports u64]
//   [txLen u16][tx bytes]
//   [trailCount u8] { [nodeId 32][sig 64] } * trailCount
//
// id = sha256(transaction wire bytes), hex. The same transaction always has the same id, so a
// replayed copy is recognised whatever trail or header it carries.
import { VersionedTransaction, SystemProgram, SYSVAR_RECENT_BLOCKHASHES_PUBKEY } from '@solana/web3.js';
import { verify, verifyObject, b58, unb58 } from '../core/index.js';
import { sha256, hex, unhex, concat, equalBytes } from './codec.js';

export const BUNDLE_VERSION = 1;
export const MAX_TX_BYTES = 1232;          // Solana packet limit
export const MAX_TRAIL = 8;                // carriers that sign (and can be paid)
export const MAX_HOPS_CAP = 32;
export const MAX_AGE_CAP_SEC = 7 * 24 * 3600;
export const CLOCK_SKEW_SEC = 300;
export const TRAIL_ENTRY = 96;
export const MAX_BUNDLE_BYTES = 108 + 40 + 2 + MAX_TX_BYTES + 1 + MAX_TRAIL * TRAIL_ENTRY; // 2151
const SYSTEM = SystemProgram.programId.toBase58();
const RECENT_BH = SYSVAR_RECENT_BLOCKHASHES_PUBKEY.toBase58();
const TRAIL_DOMAIN = new TextEncoder().encode('tangent-offgrid-trail-v1');

export function bundleIdOfTx(txBytes) { return hex(sha256(txBytes)); }

// ---------------------------------------------------------------- transaction inspection

// Parses and checks a signed transaction. Returns { ok, reason, info }.
// info: { version, signatures (base58), feePayer, nonce: { account, authority, value }, transfers }
export function inspectTx(txBytes, { requireDurable = true } = {}) {
  if (!(txBytes instanceof Uint8Array)) return { ok: false, reason: 'tx not bytes' };
  if (txBytes.length > MAX_TX_BYTES) return { ok: false, reason: 'tx too large' };
  let tx;
  try { tx = VersionedTransaction.deserialize(txBytes); } catch { return { ok: false, reason: 'tx parse' }; }
  let reser;
  try { reser = tx.serialize(); } catch { return { ok: false, reason: 'tx parse' }; }
  if (!equalBytes(reser, txBytes)) return { ok: false, reason: 'tx not canonical' };
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const nSig = msg.header.numRequiredSignatures;
  if (nSig < 1 || tx.signatures.length !== nSig || keys.length < nSig) return { ok: false, reason: 'signature count' };
  const msgBytes = msg.serialize();
  for (let i = 0; i < nSig; i++) {
    const s = tx.signatures[i];
    if (!s || s.every((b) => b === 0)) return { ok: false, reason: 'missing signature' };
    if (!verify(keys[i], msgBytes, s)) return { ok: false, reason: 'bad signature' };
  }
  const ixs = msg.compiledInstructions;
  let nonce = null;
  const first = ixs[0];
  if (first && keys[first.programIdIndex] === SYSTEM) {
    const d = first.data;
    const idx = first.accountKeyIndexes;
    if (d.length === 4 && Buffer.from(d).readUInt32LE(0) === 4 && idx.length >= 3
      && idx[0] < keys.length && idx[1] < keys.length && idx[2] < keys.length && keys[idx[1]] === RECENT_BH && idx[2] < nSig) {
      nonce = { account: keys[idx[0]], authority: keys[idx[2]], value: msg.recentBlockhash };
    }
  }
  if (requireDurable && !nonce) return { ok: false, reason: 'not durable nonce' };
  const transfers = [];
  for (const ix of ixs) {
    if (keys[ix.programIdIndex] !== SYSTEM) continue;
    const d = Buffer.from(ix.data);
    if (d.length === 12 && d.readUInt32LE(0) === 2 && ix.accountKeyIndexes.length >= 2) {
      const [from, to] = ix.accountKeyIndexes;
      transfers.push({ from: keys[from] ?? null, to: keys[to] ?? null, lamports: d.readBigUInt64LE(4) });
    }
  }
  return {
    ok: true,
    info: {
      version: msg.version, signatures: tx.signatures.map((s) => b58(s)), feePayer: keys[0], nonce, transfers,
    },
  };
}

export function tipFromTx(info, tipAccount) {
  if (!tipAccount) return 0n;
  return info.transfers.filter((t) => t.to === tipAccount).reduce((n, t) => n + t.lamports, 0n);
}

// ---------------------------------------------------------------- trail

export function trailHash(entries) {
  let h = new Uint8Array(32);
  for (const e of entries) h = sha256(concat(h, unb58(e.node), unb58(e.sig)));
  return h;
}
function trailMessage(idHex, prevHash) { return concat(TRAIL_DOMAIN, unhex(idHex), prevHash); }

export function appendTrail(idHex, trail, identity) {
  const msg = trailMessage(idHex, trailHash(trail));
  return [...trail, { node: identity.id, sig: b58(identity.sign(msg)) }];
}

// Verifies every entry signs bundleId + hash of the entries before it. No repeats, bounded.
export function verifyTrail(idHex, trail, { origin = null, gateway = null } = {}) {
  if (!Array.isArray(trail)) return { ok: false, reason: 'trail not array' };
  if (trail.length > MAX_TRAIL) return { ok: false, reason: 'trail too long' };
  const seen = new Set();
  for (let i = 0; i < trail.length; i++) {
    const e = trail[i];
    if (!e || typeof e.node !== 'string' || typeof e.sig !== 'string') return { ok: false, reason: 'trail entry' };
    if (seen.has(e.node)) return { ok: false, reason: 'trail repeat' };
    if (origin && e.node === origin) return { ok: false, reason: 'origin in trail' };
    if (gateway && e.node === gateway) return { ok: false, reason: 'gateway in trail' };
    seen.add(e.node);
    let sig;
    try { sig = unb58(e.sig); } catch { return { ok: false, reason: 'trail entry' }; }
    if (!verify(e.node, trailMessage(idHex, trailHash(trail.slice(0, i))), sig)) return { ok: false, reason: 'trail signature' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- bundle

export function headerBody(b) {
  return {
    v: BUNDLE_VERSION, t: 'tangent-offgrid-bundle', id: b.id, created: b.created, maxHops: b.maxHops, maxAge: b.maxAge,
    origin: b.origin, tip: b.tip ? { account: b.tip.account, lamports: BigInt(b.tip.lamports).toString() } : null,
  };
}

// Builds a bundle at the origin node. txBytes must already be fully signed.
export function createBundle({ identity, txBytes, maxHops = 8, maxAge = 3 * 24 * 3600, created = Math.floor(Date.now() / 1000), tip = null }) {
  const b = {
    v: BUNDLE_VERSION, id: bundleIdOfTx(txBytes), created, maxHops, maxAge, hops: 0, origin: identity.id,
    tip: tip && BigInt(tip.lamports) > 0n ? { account: tip.account, lamports: BigInt(tip.lamports) } : null,
    tx: Uint8Array.from(txBytes), trail: [],
  };
  b.originSig = identity.signObject(headerBody(b));
  return b;
}

export function encodeBundle(b) {
  const head = new Uint8Array(108);
  const dv = new DataView(head.buffer);
  head[0] = BUNDLE_VERSION; dv.setUint32(1, b.created); head[5] = b.maxHops; dv.setUint32(6, b.maxAge);
  head[10] = b.hops; head[11] = b.tip ? 1 : 0;
  head.set(unb58(b.origin), 12); head.set(unb58(b.originSig), 44);
  const parts = [head];
  if (b.tip) {
    const t = new Uint8Array(40); t.set(unb58(b.tip.account), 0);
    new DataView(t.buffer).setBigUint64(32, BigInt(b.tip.lamports)); parts.push(t);
  }
  const tl = new Uint8Array(2); tl[0] = b.tx.length >> 8; tl[1] = b.tx.length & 0xff;
  parts.push(tl, b.tx, Uint8Array.of(b.trail.length));
  for (const e of b.trail) parts.push(unb58(e.node), unb58(e.sig));
  return concat(...parts);
}

// Structural decode only (no signature checks). Throws on malformed input.
export function decodeBundle(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('bundle: not bytes');
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error('bundle: too large');
  if (bytes.length < 108 + 3) throw new Error('bundle: too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (bytes[0] !== BUNDLE_VERSION) throw new Error('bundle: version');
  const b = { v: bytes[0], created: dv.getUint32(1), maxHops: bytes[5], maxAge: dv.getUint32(6), hops: bytes[10] };
  const flags = bytes[11];
  if (flags & ~1) throw new Error('bundle: flags');
  if (bytes.subarray(12, 44).length !== 32) throw new Error('bundle: origin');
  b.origin = b58(bytes.subarray(12, 44)); b.originSig = b58(bytes.subarray(44, 108));
  let o = 108;
  b.tip = null;
  if (flags & 1) {
    if (bytes.length < o + 40) throw new Error('bundle: truncated');
    b.tip = { account: b58(bytes.subarray(o, o + 32)), lamports: dv.getBigUint64(o + 32) }; o += 40;
  }
  if (bytes.length < o + 2) throw new Error('bundle: truncated');
  const txLen = dv.getUint16(o); o += 2;
  if (txLen > MAX_TX_BYTES) throw new Error('bundle: tx too large');
  if (bytes.length < o + txLen + 1) throw new Error('bundle: truncated');
  b.tx = bytes.slice(o, o + txLen); o += txLen;
  const n = bytes[o]; o += 1;
  if (n > MAX_TRAIL) throw new Error('bundle: trail too long');
  if (bytes.length !== o + n * TRAIL_ENTRY) throw new Error('bundle: length');
  b.trail = [];
  for (let i = 0; i < n; i++, o += TRAIL_ENTRY) b.trail.push({ node: b58(bytes.subarray(o, o + 32)), sig: b58(bytes.subarray(o + 32, o + 96)) });
  b.id = bundleIdOfTx(b.tx);
  return b;
}

// Everything a node checks before it carries a bundle. Returns { ok, reason, info }.
export function validateBundle(b, { now = Date.now(), maxAgeCapSec = MAX_AGE_CAP_SEC } = {}) {
  const nowSec = Math.floor(now / 1000);
  if (b.v !== BUNDLE_VERSION) return { ok: false, reason: 'version' };
  if (b.id !== bundleIdOfTx(b.tx)) return { ok: false, reason: 'id mismatch' };
  if (!Number.isInteger(b.maxHops) || b.maxHops < 1 || b.maxHops > MAX_HOPS_CAP) return { ok: false, reason: 'max hops' };
  if (b.hops > b.maxHops) return { ok: false, reason: 'hop limit' };
  if (!Number.isInteger(b.maxAge) || b.maxAge < 1 || b.maxAge > maxAgeCapSec) return { ok: false, reason: 'max age' };
  if (b.created > nowSec + CLOCK_SKEW_SEC) return { ok: false, reason: 'created in future' };
  if (nowSec - b.created > b.maxAge) return { ok: false, reason: 'expired' };
  if (!verifyObject(b.origin, headerBody(b), b.originSig)) return { ok: false, reason: 'origin signature' };
  const t = inspectTx(b.tx);
  if (!t.ok) return { ok: false, reason: t.reason };
  if (b.tip) {
    if (BigInt(b.tip.lamports) <= 0n) return { ok: false, reason: 'tip amount' };
    if (tipFromTx(t.info, b.tip.account) !== BigInt(b.tip.lamports)) return { ok: false, reason: 'tip not in tx' };
  }
  const tr = verifyTrail(b.id, b.trail, { origin: b.origin });
  if (!tr.ok) return { ok: false, reason: tr.reason };
  return { ok: true, info: t.info };
}

export function expiresAtMs(b) { return (b.created + b.maxAge) * 1000; }
