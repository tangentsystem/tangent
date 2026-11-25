// Electron's Node uses BoringSSL, which has no chacha20-poly1305 in node:crypto. The relay's
// onion layers (src/relay/crypto.js) use it, so the app bundle points that file's node:crypto
// import here (scripts/bundle.mjs). Everything is node:crypto except chacha20-poly1305, which
// falls back to @noble/ciphers when the runtime lacks it. Same bytes either way
// (test/unit/crypto-shim.test.js checks this against Node's own implementation).
import * as nodeCrypto from 'node:crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

export * from 'node:crypto';

const ALG = 'chacha20-poly1305';
const TAG = 16;

export const nativeChacha = (() => {
  try { nodeCrypto.createCipheriv(ALG, Buffer.alloc(32), Buffer.alloc(12), { authTagLength: TAG }); return true; } catch { return false; }
})();

class NobleCipher {
  constructor(key, iv, decrypt) { this.key = Buffer.from(key); this.iv = Buffer.from(iv); this.decrypt = decrypt; this.aad = undefined; this.tag = null; this.used = false; }
  setAAD(aad) { this.aad = Buffer.from(aad); return this; }
  setAuthTag(tag) { this.tag = Buffer.from(tag); return this; }
  getAuthTag() { if (!this.tag) throw new Error('getAuthTag before final'); return Buffer.from(this.tag); }
  update(data) {
    if (this.used) throw new Error('crypto shim: one update per cipher');
    this.used = true;
    const aead = chacha20poly1305(this.key, this.iv, this.aad);
    if (this.decrypt) {
      if (!this.tag || this.tag.length !== TAG) throw new Error('Unsupported state or unable to authenticate data');
      return Buffer.from(aead.decrypt(Buffer.concat([Buffer.from(data), this.tag])));
    }
    const out = aead.encrypt(Buffer.from(data));
    this.tag = Buffer.from(out.subarray(out.length - TAG));
    return Buffer.from(out.subarray(0, out.length - TAG));
  }
  final() {
    if (!this.used) this.update(Buffer.alloc(0));
    return Buffer.alloc(0);
  }
}

function check(alg, opts) {
  return String(alg).toLowerCase() === ALG && (!opts || opts.authTagLength === undefined || opts.authTagLength === TAG);
}

export function createCipheriv(alg, key, iv, opts) {
  if (!nativeChacha && check(alg, opts)) return new NobleCipher(key, iv, false);
  return nodeCrypto.createCipheriv(alg, key, iv, opts);
}
export function createDecipheriv(alg, key, iv, opts) {
  if (!nativeChacha && check(alg, opts)) return new NobleCipher(key, iv, true);
  return nodeCrypto.createDecipheriv(alg, key, iv, opts);
}
export function _nobleForTests(decrypt, key, iv) { return new NobleCipher(key, iv, decrypt); }
export default { ...nodeCrypto, createCipheriv, createDecipheriv };
