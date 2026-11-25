// Test helper: records the RPC answers a real @solana/web3.js Connection gives (record mode) and
// plays them back with no network (replay mode). Used to turn real mainnet accounts into offline
// test fixtures (src/token/fixtures/mainnet/*.json) so detection, decoding and pricing are tested
// against the bytes the live programs really hold. Tests only; not part of the service.
import { PublicKey } from '@solana/web3.js';

const METHODS = new Set([
  'getAccountInfo', 'getMultipleAccountsInfo', 'getProgramAccounts', 'getAccountInfoAndContext',
  'getMultipleAccountsInfoAndContext', 'getTokenAccountBalance', 'getTokenSupply', 'getParsedAccountInfo',
  'getMinimumBalanceForRentExemption', 'getBalance',
]);

function enc(v) {
  if (v === undefined) return { $u: 1 };
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return { $big: v.toString() };
  if (v instanceof PublicKey || (v && typeof v.toBase58 === 'function' && v._bn !== undefined)) return { $pk: v.toBase58() };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(enc);
  if (typeof v === 'object') {
    if (v.constructor && v.constructor.name === 'BN') return { $bn: v.toString() };
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = enc(x);
    return out;
  }
  return String(v);
}

function dec(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dec);
  if (v.$u) return undefined;
  if (v.$big !== undefined) return BigInt(v.$big);
  if (v.$pk !== undefined) return new PublicKey(v.$pk);
  if (v.$b64 !== undefined) return Buffer.from(v.$b64, 'base64');
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = dec(x);
  return out;
}

// The key of one call: method name plus its arguments, with commitment settings left out (they do
// not change which accounts are asked for).
function keyOf(method, args) {
  const strip = (a) => {
    if (typeof a === 'string' && /^(processed|confirmed|finalized)$/.test(a)) return undefined;
    if (a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof PublicKey) && !Buffer.isBuffer(a) && !(a instanceof Uint8Array)) {
      const { commitment: _c, minContextSlot: _m, ...rest } = a;
      return Object.keys(rest).length ? rest : undefined;
    }
    return a;
  };
  const kept = args.map(strip);
  while (kept.length && kept[kept.length - 1] === undefined) kept.pop();
  return method + ' ' + JSON.stringify(enc(kept));
}

export function recordingConnection(real) {
  const calls = {};
  const proxy = new Proxy(real, {
    get(target, prop) {
      const v = target[prop];
      if (typeof prop === 'string' && METHODS.has(prop) && typeof v === 'function') {
        return async (...args) => {
          const r = await v.apply(target, args);
          calls[keyOf(prop, args)] = enc(r);
          return r;
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { connection: proxy, calls: () => ({ ...calls }) };
}

/**
 * Every account a fixture recorded, by address: Map<base58, AccountInfo | null>. From the
 * getAccountInfo and getMultipleAccountsInfo answers. For tests that need to edit or move real
 * accounts (accountMapConnection below).
 */
export function accountsOf(calls) {
  const out = new Map();
  for (const [k, v] of Object.entries(calls)) {
    const sp = k.indexOf(' ');
    const method = k.slice(0, sp);
    const args = dec(JSON.parse(k.slice(sp + 1)));
    const val = dec(v);
    if (method === 'getAccountInfo') out.set(args[0].toBase58(), val);
    if (method === 'getMultipleAccountsInfo') args[0].forEach((key, i) => out.set(key.toBase58(), val[i]));
  }
  return out;
}

/**
 * A connection over a Map of accounts: unknown addresses read as missing accounts. Sends are
 * captured in `sent` (decoded later by the test), nothing reaches a network.
 */
export function accountMapConnection(accounts) {
  const sent = [];
  const get = (k) => {
    const v = accounts.get(typeof k === 'string' ? k : k.toBase58());
    return v === undefined ? null : v;
  };
  return {
    sent,
    rpcEndpoint: 'map://accounts',
    commitment: 'confirmed',
    getAccountInfo: async (k) => get(k),
    getMultipleAccountsInfo: async (ks) => ks.map(get),
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
    sendRawTransaction: async (bytes) => { sent.push(Buffer.from(bytes)); return 'sig' + sent.length; },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
}

export function replayConnection(calls) {
  const missing = [];
  const handler = {
    get(_t, prop) {
      if (prop === 'rpcEndpoint') return 'replay://fixtures';
      if (prop === 'commitment') return 'confirmed';
      if (typeof prop === 'string' && METHODS.has(prop)) {
        return async (...args) => {
          const k = keyOf(prop, args);
          if (!(k in calls)) { missing.push(k); throw new Error(`replay: no recorded answer for ${k.slice(0, 160)}`); }
          return dec(calls[k]);
        };
      }
      return undefined;
    },
  };
  const conn = new Proxy({}, handler);
  return { connection: conn, missing };
}
