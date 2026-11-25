// Shared rules for both store adapters: name and field validation, the small
// filter language (a subset of MongoDB query syntax that both adapters run the
// same way), value comparison, and BigInt range checks.
//
// Filters: { field: value } equality, and per field operators
//   $eq $ne $gt $gte $lt $lte $in $nin $exists
// Field paths may be dotted ("a.b") in filters and sorts. Field names in writes
// (set / inc / unset / insert) must be plain top level names: no "." and no
// leading "$". Ids are non empty strings (max 512 chars) or safe integers.

export const INT64_MAX = 9223372036854775807n;
export const INT64_MIN = -9223372036854775808n;

const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const PREFIX_RE = /^[a-z][a-z0-9_]{0,23}$/;
const OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists']);

// Collections whose documents can be inserted and read, never changed or removed.
export const INSERT_ONLY = Object.freeze(new Set(['keys', 'keys_backup', 'pay_keys', 'pay_keys_backup']));

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function checkPrefix(prefix) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) throw new StoreError('BAD_PREFIX', 'store: prefix must be 1 to 24 chars of a-z, 0-9 and "_", starting with a letter');
  return prefix;
}

export function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new StoreError('BAD_NAME', `store: bad collection name ${JSON.stringify(String(name)).slice(0, 60)}`);
  return name;
}

export function checkId(id) {
  if (typeof id === 'string' && id.length > 0 && id.length <= 512) return id;
  if (Number.isSafeInteger(id)) return id;
  throw new StoreError('BAD_ID', 'store: id must be a non empty string or a safe integer');
}

export function checkField(field) {
  if (typeof field !== 'string' || field.length === 0 || field.length > 128 || field.includes('.') || field.startsWith('$') || field === '_id') {
    throw new StoreError('BAD_FIELD', `store: bad field name ${JSON.stringify(String(field)).slice(0, 60)}`);
  }
  return field;
}

export function checkFields(obj, what) {
  if (obj === undefined || obj === null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new StoreError('BAD_FIELD', `store: ${what} must be an object`);
  for (const k of Object.keys(obj)) checkField(k);
  for (const v of Object.values(obj)) checkValue(v);
  return obj;
}

// Values must be storable the same way in both adapters.
export function checkValue(v, depth = 0) {
  if (depth > 32) throw new StoreError('BAD_VALUE', 'store: value nested too deeply');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new StoreError('BAD_VALUE', 'store: numbers must be finite');
    return;
  }
  if (typeof v === 'bigint') {
    if (v > INT64_MAX || v < INT64_MIN) throw new StoreError('OVERFLOW', 'store: bigint outside the 64 bit range');
    return;
  }
  if (v === undefined) throw new StoreError('BAD_VALUE', 'store: undefined is not storable, use unset');
  if (Array.isArray(v)) { for (const x of v) checkValue(x, depth + 1); return; }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new StoreError('BAD_VALUE', 'store: only plain objects, arrays, strings, numbers, bigints, booleans and null are storable');
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('$') || k.includes('.')) throw new StoreError('BAD_FIELD', 'store: nested keys may not start with "$" or contain "."');
      checkValue(x, depth + 1);
    }
    return;
  }
  throw new StoreError('BAD_VALUE', `store: ${typeof v} is not storable`);
}

// Integers outside the signed 64 bit range are refused here: the MongoDB driver would
// otherwise wrap them silently when it writes an int64 (found against a real server: an
// increment by 2^63 was stored as an increment by -2^63).
export function toBig(delta, what = 'delta') {
  let v;
  if (typeof delta === 'bigint') v = delta;
  else if (Number.isSafeInteger(delta)) v = BigInt(delta);
  else if (typeof delta === 'string' && /^-?[0-9]{1,19}$/.test(delta)) v = BigInt(delta);
  else throw new StoreError('BAD_VALUE', `store: ${what} must be an integer`);
  if (v > INT64_MAX || v < INT64_MIN) throw new StoreError('OVERFLOW', `store: ${what} is outside the 64 bit range`);
  return v;
}

export function checkFilter(filter) {
  if (filter === undefined || filter === null) return {};
  if (typeof filter !== 'object' || Array.isArray(filter)) throw new StoreError('BAD_FILTER', 'store: filter must be an object');
  for (const [field, cond] of Object.entries(filter)) {
    if (field.startsWith('$') || field.length === 0) throw new StoreError('BAD_FILTER', `store: unsupported filter key ${field}`);
    if (isOpObject(cond)) {
      for (const [op, want] of Object.entries(cond)) {
        if (!OPS.has(op)) throw new StoreError('BAD_FILTER', `store: unsupported operator ${op}`);
        if ((op === '$in' || op === '$nin') && !Array.isArray(want)) throw new StoreError('BAD_FILTER', `store: ${op} needs an array`);
        if (op === '$exists' && typeof want !== 'boolean') throw new StoreError('BAD_FILTER', 'store: $exists needs true or false');
      }
    }
  }
  return filter;
}

function isOpObject(cond) {
  return cond !== null && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).length > 0 && Object.keys(cond).every((k) => k.startsWith('$'));
}

export function getPath(doc, path) {
  if (!path.includes('.')) return doc[path];
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// BSON type order, used to sort mixed types the way MongoDB does.
function rank(v) {
  if (v === undefined || v === null) return 1;
  if (typeof v === 'number' || typeof v === 'bigint') return 2;
  if (typeof v === 'string') return 3;
  if (Array.isArray(v)) return 5;
  if (typeof v === 'object') return 4;
  if (typeof v === 'boolean') return 8;
  return 9;
}

function cmpNum(a, b) {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const ia = typeof a === 'bigint' || Number.isInteger(a);
    const ib = typeof b === 'bigint' || Number.isInteger(b);
    if (ia && ib) { const x = BigInt(a); const y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
    const x = Number(a); const y = Number(b); return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compare(a, b) {
  const ra = rank(a); const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 2) return cmpNum(a, b);
  if (ra === 3) return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  if (ra === 8) return a === b ? 0 : a ? 1 : -1;
  if (ra === 1) return 0;
  return deepEqual(a, b) ? 0 : JSON.stringify(a, big) < JSON.stringify(b, big) ? -1 : 1;
}

function big(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }

export function deepEqual(a, b) {
  if ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint')) return cmpNum(a, b) === 0;
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function eqMatch(actual, want) {
  if (Array.isArray(actual) && !Array.isArray(want)) return actual.some((x) => deepEqual(x, want));
  if (want === null) return actual === null || actual === undefined;
  return deepEqual(actual, want);
}

function rangeMatch(actual, want, test) {
  const list = Array.isArray(actual) ? actual : [actual];
  return list.some((x) => x !== undefined && x !== null && rank(x) === rank(want) && test(compare(x, want)));
}

function condMatch(actual, cond) {
  if (!isOpObject(cond)) return eqMatch(actual, cond);
  for (const [op, want] of Object.entries(cond)) {
    switch (op) {
      case '$eq': if (!eqMatch(actual, want)) return false; break;
      case '$ne': if (eqMatch(actual, want)) return false; break;
      case '$gt': if (!rangeMatch(actual, want, (c) => c > 0)) return false; break;
      case '$gte': if (!rangeMatch(actual, want, (c) => c >= 0)) return false; break;
      case '$lt': if (!rangeMatch(actual, want, (c) => c < 0)) return false; break;
      case '$lte': if (!rangeMatch(actual, want, (c) => c <= 0)) return false; break;
      case '$in': if (!want.some((w) => eqMatch(actual, w))) return false; break;
      case '$nin': if (want.some((w) => eqMatch(actual, w))) return false; break;
      case '$exists': if ((actual !== undefined) !== want) return false; break;
      default: throw new StoreError('BAD_FILTER', `store: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(doc, filter) {
  for (const [field, cond] of Object.entries(filter || {})) {
    if (!condMatch(getPath(doc, field), cond)) return false;
  }
  return true;
}

export function checkSort(sort) {
  if (sort === undefined || sort === null) return null;
  if (typeof sort !== 'object' || Array.isArray(sort)) throw new StoreError('BAD_SORT', 'store: sort must be an object');
  for (const [k, v] of Object.entries(sort)) {
    if (k.startsWith('$') || (v !== 1 && v !== -1)) throw new StoreError('BAD_SORT', 'store: sort values must be 1 or -1');
  }
  return sort;
}

export function checkLimit(n, what) {
  if (n === undefined || n === null) return 0;
  if (!Number.isSafeInteger(n) || n < 0) throw new StoreError('BAD_LIMIT', `store: ${what} must be a non negative integer`);
  return n;
}

export function isDuplicate(err) {
  return Boolean(err) && (err.code === 11000 || err.code === 'DUPLICATE' || (Array.isArray(err.writeErrors) && err.writeErrors.some((w) => w.code === 11000)));
}

// A promise chain mutex. run(fn) waits for every earlier run to finish.
export function createMutex() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const next = tail.then(() => fn());
      tail = next.catch(() => {});
      return next;
    },
  };
}
