// Small helpers shared by the pay module. Money is BigInt lamports in code, decimal strings on the wire.
import bs58 from 'bs58';
import { randomBytes, createHash } from 'node:crypto';

export class PayError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message || code);
    this.name = 'PayError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function fail(code, message, opts) {
  throw new PayError(code, message, opts);
}

export function isPubkey(str) {
  if (typeof str !== 'string' || str.length < 32 || str.length > 44) return false;
  try {
    return bs58.decode(str).length === 32;
  } catch {
    return false;
  }
}

const AMOUNT_RE = /^(0|[1-9][0-9]{0,30})$/;

// Accepts BigInt, safe integer or decimal string. Never negative.
export function toLamports(x, code = 'BAD_AMOUNT') {
  let v;
  if (typeof x === 'bigint') v = x;
  else if (typeof x === 'number' && Number.isSafeInteger(x)) v = BigInt(x);
  else if (typeof x === 'string' && AMOUNT_RE.test(x)) v = BigInt(x);
  else fail(code, 'amount must be a whole number of lamports');
  if (v < 0n) fail(code, 'amount is negative');
  return v;
}

export const big = (x) => (x === undefined || x === null || x === '' ? 0n : BigInt(x));
export const str = (x) => BigInt(x).toString();
export const minBig = (a, b) => (a < b ? a : b);

export function randomId(bytes = 16) {
  return bs58.encode(randomBytes(bytes));
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function b64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function unb64u(s, code = 'BAD_ENCODING') {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) fail(code, 'expected base64url');
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function solscanAccount(address) {
  return 'https://solscan.io/account/' + address;
}

export function solscanTx(signature) {
  return 'https://solscan.io/tx/' + signature;
}

// The address with its explorer link, the shape every API answer uses.
export function addr(address) {
  return address ? { address, explorer: solscanAccount(address) } : null;
}
