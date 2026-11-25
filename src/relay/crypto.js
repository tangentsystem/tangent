// Circuit crypto.
//
// Handshake (one per hop): the client knows the hop's ed25519 identity and static
// x25519 key B from its signed descriptor. Client sends ephemeral X. Hop answers with
// ephemeral Y, an ed25519 signature over the transcript and a key confirmation MAC.
//   keys = HKDF-SHA256(DH(x,Y) || DH(x,B), salt=label, info=label|idPub|B|X|Y)
// Only the holder of B can derive the keys and only the holder of the identity key can
// sign the transcript, so a hop is authenticated twice.
//
// Layers: ChaCha20-Poly1305 per hop, separate keys per direction, 64 bit nonce counters
// that must advance by exactly one per cell (replayed, dropped or reordered cells fail
// the tag and kill the circuit). Tags are detached and carried in a fixed tag stack so
// the body length never changes from hop to hop.
import { createCipheriv, createDecipheriv, hkdfSync, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { kxShared, createKxKeypair, verify, unb58 } from '../core/index.js';
import { STACK, TAG, RECOG } from './cells.js';

const LABEL = Buffer.from('tangent-relay-handshake-v1');
export const HS_TYPE = 1;
export const HS_REPLY_LEN = 32 + 64 + 32;

function nonce(ctr) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(ctr, 4);
  return n;
}

export function seal(key, ctr, plaintext) {
  const c = createCipheriv('chacha20-poly1305', key, nonce(ctr), { authTagLength: TAG });
  const ct = c.update(plaintext);
  c.final();
  return { ct, tag: c.getAuthTag() };
}

export function open(key, ctr, ct, tag) {
  try {
    const d = createDecipheriv('chacha20-poly1305', key, nonce(ctr), { authTagLength: TAG });
    d.setAuthTag(tag);
    const pt = d.update(ct);
    d.final();
    return pt;
  } catch { return null; }
}

function transcript(idPub, B, X, Y) {
  return Buffer.concat([LABEL, Buffer.from(idPub), Buffer.from(B), Buffer.from(X), Buffer.from(Y)]);
}

function derive(dh1, dh2, tr) {
  const okm = Buffer.from(hkdfSync('sha256', Buffer.concat([Buffer.from(dh1), Buffer.from(dh2)]), LABEL, tr, 160));
  return {
    kf: okm.subarray(0, 32),
    kb: okm.subarray(32, 64),
    rf: okm.subarray(64, 64 + RECOG),
    rb: okm.subarray(80, 80 + RECOG),
    auth: okm.subarray(96, 128),
    session: okm.subarray(128, 144).toString('hex'),
    ctrF: 0n,
    ctrB: 0n,
  };
}

function mac(key) { return createHmac('sha256', key).update('tangent-relay-created').digest(); }

// Hop side. Returns { reply, keys } or throws.
export function serverHandshake({ identity, kx }, X) {
  if (!X || X.length !== 32) throw new Error('handshake: bad key');
  const y = createKxKeypair();
  const dh1 = kxShared(y.secret, X);
  const dh2 = kxShared(kx.secret, X);
  const tr = transcript(identity.publicKey, kx.publicKey, X, y.publicKey);
  const keys = derive(dh1, dh2, tr);
  const sig = Buffer.from(identity.sign(tr));
  return { reply: Buffer.concat([Buffer.from(y.publicKey), sig, mac(keys.auth)]), keys };
}

// Client side, step 1.
export function clientHandshakeStart() {
  const x = createKxKeypair();
  return { x, X: Buffer.from(x.publicKey) };
}

// Client side, step 2. desc is the hop's checked descriptor. Throws on any mismatch.
export function clientHandshakeFinish(state, desc, reply) {
  if (!reply || reply.length < HS_REPLY_LEN) throw new Error('handshake: short reply');
  const Y = reply.subarray(0, 32), sig = reply.subarray(32, 96), conf = reply.subarray(96, 128);
  const idPub = unb58(desc.id), B = unb58(desc.kx);
  const tr = transcript(idPub, B, state.X, Y);
  if (!verify(desc.id, tr, sig)) throw new Error('handshake: identity signature invalid');
  let dh1, dh2;
  try { dh1 = kxShared(state.x.secret, Y); dh2 = kxShared(state.x.secret, B); } catch { throw new Error('handshake: bad key'); }
  const keys = derive(dh1, dh2, tr);
  if (!timingSafeEqual(mac(keys.auth), Buffer.from(conf))) throw new Error('handshake: key confirmation failed');
  return keys;
}

// ---- onion layers ----

// Client: wrap a plaintext body for hop t (0 based). hops[i] holds keys with counters.
export function wrapForward(hops, t, body) {
  let c = body;
  const stack = randomBytes(STACK);
  for (let i = t; i >= 0; i--) {
    const h = hops[i];
    const { ct, tag } = seal(h.kf, h.ctrF, c);
    h.ctrF++;
    tag.copy(stack, i * TAG);
    c = ct;
  }
  return Buffer.concat([stack, c]);
}

// Hop: remove own forward layer. Returns { payload (to forward), pt, mine } or null on failure.
export function peelForward(keys, payload) {
  const stack = payload.subarray(0, STACK), body = payload.subarray(STACK);
  const pt = open(keys.kf, keys.ctrF, body, stack.subarray(0, TAG));
  if (!pt) return null;
  keys.ctrF++;
  const mine = pt.subarray(0, RECOG).equals(keys.rf);
  if (mine) return { mine, pt };
  return { mine, payload: Buffer.concat([stack.subarray(TAG), randomBytes(TAG), pt]) };
}

// Hop: add own backward layer to a cell coming from the next hop.
export function addBackward(keys, payload) {
  const stack = payload.subarray(0, STACK), body = payload.subarray(STACK);
  const { ct, tag } = seal(keys.kb, keys.ctrB, body);
  keys.ctrB++;
  return Buffer.concat([tag, stack.subarray(0, STACK - TAG), ct]);
}

// Hop: originate a backward cell from a packed plaintext body.
export function originBackward(keys, body) {
  const { ct, tag } = seal(keys.kb, keys.ctrB, body);
  keys.ctrB++;
  return Buffer.concat([tag, randomBytes(STACK - TAG), ct]);
}

// Client: peel backward layers. Returns { hop, pt } or null (integrity failure).
export function unwrapBackward(hops, payload) {
  const stack = payload.subarray(0, STACK);
  let c = payload.subarray(STACK);
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    const pt = open(h.kb, h.ctrB, c, stack.subarray(i * TAG, (i + 1) * TAG));
    if (!pt) return null;
    h.ctrB++;
    if (pt.subarray(0, RECOG).equals(h.rb)) return { hop: i, pt };
    c = pt;
  }
  return null;
}
