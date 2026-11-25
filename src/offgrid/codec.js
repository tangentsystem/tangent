// Wire codec for the off grid mesh: small frames designed for 200 byte radio links.
//
// Every frame: [magic 0xA7][type] ... [crc32 BE over everything before it]
//   DATA  (1): [kind][digest 8][total][index][objLen u16] payload
//   INV   (2): [count] { [kind][idPrefix 8] } * count      "I hold these"
//   WANT  (3): [count] { [kind][idPrefix 8] } * count      "send me these"
//   NACK  (4): [kind][digest 8][total][bitmap ceil(total/8)]  "these fragment indexes are missing"
//   HELLO (5): [nodeId 32][flags]                             discovery, flags bit0 = gateway
//
// DATA frames are keyed by `digest` = first 8 bytes of sha256(serialized object). A bundle keeps
// its id (sha256 of the transaction) while its carried-by trail grows, so two copies of the same
// bundle with different trails are different objects; keying fragments by the object digest
// means fragments of different copies never get mixed, and fragments of the same copy can be
// merged from any peer. The bundle id travels inside the object and in INV/WANT.
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

export const MAGIC = 0xa7;
export const T = Object.freeze({ DATA: 1, INV: 2, WANT: 3, NACK: 4, HELLO: 5 });
export const KIND = Object.freeze({ BUNDLE: 1, RECEIPT: 2 });
export const DEFAULT_MTU = 200;
export const DATA_HEADER = 15; // magic,type,kind,digest8,total,index,len2
export const CRC_LEN = 4;
export const MAX_FRAGMENTS = 32;
export const INV_ENTRY = 9;

export function sha256(bytes) { return new Uint8Array(createHash('sha256').update(bytes).digest()); }
export function hex(bytes) { return Buffer.from(bytes).toString('hex'); }
export function unhex(str) { return new Uint8Array(Buffer.from(str, 'hex')); }
export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function withCrc(body) {
  const out = new Uint8Array(body.length + CRC_LEN);
  out.set(body, 0);
  new DataView(out.buffer).setUint32(body.length, crc32(body) >>> 0);
  return out;
}

export function checkCrc(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < 2 + CRC_LEN) return false;
  const body = frame.subarray(0, frame.length - CRC_LEN);
  const got = new DataView(frame.buffer, frame.byteOffset, frame.length).getUint32(frame.length - CRC_LEN);
  return (crc32(body) >>> 0) === got;
}

export function payloadPerFrame(mtu = DEFAULT_MTU) {
  const p = mtu - DATA_HEADER - CRC_LEN;
  if (p < 16) throw new Error('codec: mtu too small');
  return p;
}

export function objectDigest(objBytes) { return sha256(objBytes).subarray(0, 8); }

// Split one object into DATA frames.
export function fragment(kind, objBytes, mtu = DEFAULT_MTU) {
  const per = payloadPerFrame(mtu);
  const total = Math.ceil(objBytes.length / per);
  if (total < 1 || total > MAX_FRAGMENTS) throw new Error('codec: object too large to fragment');
  if (objBytes.length > 0xffff) throw new Error('codec: object too large');
  const digest = objectDigest(objBytes);
  const frames = [];
  for (let i = 0; i < total; i++) {
    const chunk = objBytes.subarray(i * per, Math.min(objBytes.length, (i + 1) * per));
    const h = new Uint8Array(DATA_HEADER);
    h[0] = MAGIC; h[1] = T.DATA; h[2] = kind; h.set(digest, 3); h[11] = total; h[12] = i;
    h[13] = objBytes.length >> 8; h[14] = objBytes.length & 0xff;
    frames.push(withCrc(concat(h, chunk)));
  }
  return { digest, frames };
}

function idList(type, entries) {
  const body = new Uint8Array(3 + entries.length * INV_ENTRY);
  body[0] = MAGIC; body[1] = type; body[2] = entries.length;
  entries.forEach((e, i) => { body[3 + i * INV_ENTRY] = e.kind; body.set(e.prefix.subarray(0, 8), 4 + i * INV_ENTRY); });
  return withCrc(body);
}
export function maxIdsPerFrame(mtu = DEFAULT_MTU) { return Math.min(255, Math.floor((mtu - 3 - CRC_LEN) / INV_ENTRY)); }
export function encodeInv(entries) { return idList(T.INV, entries); }
export function encodeWant(entries) { return idList(T.WANT, entries); }

export function encodeNack(kind, digest, total, missing) {
  const bm = new Uint8Array(Math.ceil(total / 8));
  for (const i of missing) bm[i >> 3] |= 1 << (i & 7);
  const h = new Uint8Array(12); h[0] = MAGIC; h[1] = T.NACK; h[2] = kind; h.set(digest, 3); h[11] = total;
  return withCrc(concat(h, bm));
}

export function encodeHello(nodeIdBytes, flags = 0) {
  const b = new Uint8Array(35); b[0] = MAGIC; b[1] = T.HELLO; b.set(nodeIdBytes, 2); b[34] = flags;
  return withCrc(b);
}

// Returns a parsed frame or null if it is malformed or fails its checksum.
export function decodeFrame(frame) {
  if (!checkCrc(frame) || frame[0] !== MAGIC) return null;
  const body = frame.subarray(0, frame.length - CRC_LEN);
  const type = body[1];
  if (type === T.DATA) {
    if (body.length < DATA_HEADER + 1) return null;
    const total = body[11], index = body[12], len = (body[13] << 8) | body[14];
    if (total < 1 || total > MAX_FRAGMENTS || index >= total || len < 1) return null;
    return { type, kind: body[2], digest: body.slice(3, 11), total, index, len, payload: body.slice(DATA_HEADER) };
  }
  if (type === T.INV || type === T.WANT) {
    const count = body[2];
    if (body.length !== 3 + count * INV_ENTRY) return null;
    const entries = [];
    for (let i = 0; i < count; i++) entries.push({ kind: body[3 + i * INV_ENTRY], prefix: body.slice(4 + i * INV_ENTRY, 12 + i * INV_ENTRY) });
    return { type, entries };
  }
  if (type === T.NACK) {
    if (body.length < 13) return null;
    const total = body[11];
    if (total < 1 || total > MAX_FRAGMENTS || body.length !== 12 + Math.ceil(total / 8)) return null;
    const missing = [];
    for (let i = 0; i < total; i++) if (body[12 + (i >> 3)] & (1 << (i & 7))) missing.push(i);
    return { type, kind: body[2], digest: body.slice(3, 11), total, missing };
  }
  if (type === T.HELLO) {
    if (body.length !== 35) return null;
    return { type, nodeId: body.slice(2, 34), flags: body[34] };
  }
  return null;
}

// Reassembler: tolerant of loss, duplication and reordering. Content addressed by digest, so
// fragments of one object may arrive from several peers. Completed objects are checked against
// their digest (whole object integrity) on top of the per frame crc.
export function createReassembler({ maxPartials = 64, partialTtlMs = 30_000, onComplete, now = () => Date.now() } = {}) {
  const partials = new Map(); // digestHex -> state
  function drop(key) { partials.delete(key); }
  return {
    push(f, peerKey) {
      const key = hex(f.digest);
      let st = partials.get(key);
      if (!st) {
        if (partials.size >= maxPartials) {
          // evict the stalest partial
          let oldest = null;
          for (const [k, v] of partials) if (!oldest || v.lastAt < oldest[1].lastAt) oldest = [k, v];
          if (oldest) partials.delete(oldest[0]);
        }
        st = { kind: f.kind, digest: f.digest, total: f.total, len: f.len, parts: new Array(f.total), got: 0, peers: new Set(), firstAt: now(), lastAt: now(), nacks: 0 };
        partials.set(key, st);
      }
      if (st.total !== f.total || st.len !== f.len || st.kind !== f.kind) return { status: 'mismatch' };
      st.lastAt = now();
      if (peerKey) st.peers.add(peerKey);
      if (st.parts[f.index]) return { status: 'duplicate' };
      st.parts[f.index] = f.payload; st.got++;
      if (st.got < st.total) return { status: 'partial' };
      drop(key);
      const obj = concat(...st.parts);
      if (obj.length !== st.len || !equalBytes(objectDigest(obj), st.digest)) return { status: 'corrupt' };
      onComplete?.(st.kind, obj, [...st.peers]);
      return { status: 'complete', kind: st.kind, bytes: obj, peers: [...st.peers] };
    },
    // partials idle for at least idleMs: caller sends NACKs for them
    idle(idleMs) {
      const t = now(), out = [];
      for (const [key, st] of partials) {
        if (t - st.firstAt > partialTtlMs) { partials.delete(key); continue; }
        if (t - st.lastAt >= idleMs) {
          const missing = []; for (let i = 0; i < st.total; i++) if (!st.parts[i]) missing.push(i);
          out.push({ key, st, missing });
        }
      }
      return out;
    },
    has(digest) { return partials.has(hex(digest)); },
    size() { return partials.size; },
    drop,
  };
}

// COBS byte stuffing for serial/radio links: frames are delimited by 0x00.
export function cobsEncode(input) {
  const out = []; let codeIdx = 0, code = 1; out.push(0);
  for (const byte of input) {
    if (byte === 0) { out[codeIdx] = code; codeIdx = out.length; out.push(0); code = 1; }
    else { out.push(byte); code++; if (code === 0xff) { out[codeIdx] = code; codeIdx = out.length; out.push(0); code = 1; } }
  }
  out[codeIdx] = code;
  return Uint8Array.from(out);
}
export function cobsDecode(input) {
  const out = []; let i = 0;
  while (i < input.length) {
    const code = input[i];
    if (code === 0 || i + code > input.length) return null;
    i++;
    for (let j = 1; j < code; j++) { if (i >= input.length) return null; out.push(input[i++]); }
    if (code < 0xff && i < input.length) out.push(0);
  }
  return Uint8Array.from(out);
}
