// Identity = ed25519 keypair, Solana compatible. id = base58(publicKey).
// Used by nodes, clients (payers) and the coordinator. Signatures are base58.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { canonicalBytes } from './canonical.js';

export function b58(bytes) { return bs58.encode(bytes); }
export function unb58(str) { return bs58.decode(str); }

export function createIdentity(seed32) {
  const secret = seed32 ? Uint8Array.from(seed32) : Uint8Array.from(randomBytes(32));
  if (secret.length !== 32) throw new Error('identity: seed must be 32 bytes');
  const publicKey = ed25519.getPublicKey(secret);
  return Object.freeze({
    id: b58(publicKey),
    publicKey,
    secret, // 32 byte seed. Solana secretKey (64 bytes) = seed || publicKey
    sign(bytes) { return ed25519.sign(bytes, secret); },
    signObject(body) { return b58(ed25519.sign(canonicalBytes(body), secret)); },
  });
}

export function verify(idB58, bytes, sigBytes) {
  try { return ed25519.verify(sigBytes, bytes, unb58(idB58)); } catch { return false; }
}

// Verify a signature made with identity.signObject(body).
export function verifyObject(idB58, body, sigB58) {
  try { return ed25519.verify(unb58(sigB58), canonicalBytes(body), unb58(idB58)); } catch { return false; }
}

// Solana 64 byte secretKey for @solana/web3.js Keypair.fromSecretKey.
export function solanaSecretKey(identity) {
  const out = new Uint8Array(64);
  out.set(identity.secret, 0); out.set(identity.publicKey, 32);
  return out;
}

// X25519 keypair for key exchange (relay circuits). Separate from the identity key.
export function createKxKeypair(seed32) {
  const secret = seed32 ? Uint8Array.from(seed32) : Uint8Array.from(randomBytes(32));
  return Object.freeze({ secret, publicKey: x25519.getPublicKey(secret), pub: b58(x25519.getPublicKey(secret)) });
}
export function kxShared(secret, peerPublicKey) { return x25519.getSharedSecret(secret, peerPublicKey); }
