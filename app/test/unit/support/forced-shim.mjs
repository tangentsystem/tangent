import * as real from 'node:crypto';
import { _nobleForTests } from '../../../core/crypto-shim.js';
export * from 'node:crypto';
globalThis.__tgShimUsed = 0;
export function createCipheriv(alg, key, iv, opts) { if (alg === 'chacha20-poly1305') { globalThis.__tgShimUsed++; return _nobleForTests(false, key, iv); } return real.createCipheriv(alg, key, iv, opts); }
export function createDecipheriv(alg, key, iv, opts) { if (alg === 'chacha20-poly1305') { globalThis.__tgShimUsed++; return _nobleForTests(true, key, iv); } return real.createDecipheriv(alg, key, iv, opts); }
