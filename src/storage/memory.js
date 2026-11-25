// Memory adapter. Same interface and same results as the MongoDB adapter, on
// in-process maps. Nothing survives a process exit. `backing` is the adapter's
// "disk": tests pass the same backing to a second store to simulate a restart.
//
// Atomicity: every operation is applied in one synchronous step, so a single
// operation is atomic. transaction(fn) takes the store lock, so operations
// started outside the transaction wait until it ends (they never see half of
// it), records the previous version of every document it touches, and puts
// them all back if fn throws.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  INSERT_ONLY, INT64_MAX, StoreError, checkFields, checkFilter, checkId, checkLimit, checkName, checkPrefix,
  checkSort, compare, createMutex, deepEqual, getPath, matches, toBig,
} from './common.js';

const clone = (v) => structuredClone(v);

export function createMemoryBacking() {
  const collections = new Map(); // full name -> { docs: Map, unique: Map(field -> Map(valueKey -> id)) }
  return {
    get(name) {
      if (!collections.has(name)) collections.set(name, { docs: new Map(), unique: new Map() });
      return collections.get(name);
    },
    names() { return [...collections.keys()]; },
  };
}

function uniqueKey(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return 'n:' + v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? 'n:' + BigInt(v).toString() : 'n:' + String(v);
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

export async function createMemoryStore({ prefix = 'tangent_', backing = createMemoryBacking() } = {}) {
  checkPrefix(prefix);
  const als = new AsyncLocalStorage();
  const lock = createMutex();
  let closed = false;

  // Runs one operation: inside a transaction directly, otherwise after any running transaction.
  function op(fn) {
    if (closed) return Promise.reject(new StoreError('CLOSED', 'store: closed'));
    const ctx = als.getStore();
    if (ctx) return Promise.resolve().then(() => fn(ctx));
    return lock.run(() => fn(null));
  }

  function remember(ctx, coll, fullName, id) {
    if (!ctx) return;
    const key = fullName + '\u0000' + JSON.stringify(id);
    if (ctx.journal.has(key)) return;
    const prev = coll.docs.get(id);
    ctx.journal.set(key, { coll, id, prev: prev === undefined ? undefined : clone(prev) });
  }

  function checkUnique(coll, doc, selfId) {
    for (const [field, index] of coll.unique) {
      const k = uniqueKey(getPath(doc, field));
      if (k === null) continue;
      const owner = index.get(k);
      if (owner !== undefined && owner !== selfId) {
        const err = new StoreError('DUPLICATE', `store: duplicate value for unique field ${field}`);
        err.duplicate = true;
        throw err;
      }
    }
  }

  function unindex(coll, doc) {
    for (const [field, index] of coll.unique) {
      const k = uniqueKey(getPath(doc, field));
      if (k !== null && index.get(k) === doc._id) index.delete(k);
    }
  }

  function write(coll, doc) {
    const prev = coll.docs.get(doc._id);
    checkUnique(coll, doc, doc._id);
    if (prev) unindex(coll, prev);
    coll.docs.set(doc._id, doc);
    for (const [field, index] of coll.unique) {
      const k = uniqueKey(getPath(doc, field));
      if (k !== null) index.set(k, doc._id);
    }
  }

  function remove(coll, id) {
    const prev = coll.docs.get(id);
    if (!prev) return false;
    unindex(coll, prev);
    coll.docs.delete(id);
    return true;
  }

  function applyUpdate(doc, { set, unset, inc }) {
    const next = { ...doc };
    for (const [k, v] of Object.entries(set || {})) next[k] = clone(v);
    for (const k of unset || []) delete next[k];
    for (const [k, d] of Object.entries(inc || {})) {
      const cur = next[k] === undefined ? 0n : next[k];
      if (typeof cur !== 'bigint' && !Number.isInteger(cur)) throw new StoreError('BAD_VALUE', `store: cannot increment non integer field ${k}`);
      const v = BigInt(cur) + d;
      if (v > INT64_MAX || v < -INT64_MAX - 1n) throw new StoreError('OVERFLOW', 'store: increment overflows 64 bits');
      next[k] = v;
    }
    return next;
  }

  function normalizeUpdate(u = {}) {
    const set = checkFields(u.set, 'set');
    const unset = u.unset === undefined ? [] : u.unset;
    if (!Array.isArray(unset)) throw new StoreError('BAD_FIELD', 'store: unset must be an array of field names');
    for (const f of unset) checkFields({ [f]: null }, 'unset');
    const inc = {};
    for (const [k, d] of Object.entries(checkFieldsOnly(u.inc))) inc[k] = toBig(d, 'inc.' + k);
    return { set, unset, inc };
  }

  function checkFieldsOnly(obj) {
    if (obj === undefined || obj === null) return {};
    checkFields(Object.fromEntries(Object.keys(obj).map((k) => [k, null])), 'inc');
    return obj;
  }

  function collection(name) {
    checkName(name);
    const fullName = prefix + name;
    const insertOnly = INSERT_ONLY.has(name);
    const coll = backing.get(fullName);
    const guard = (what) => { if (insertOnly) throw new StoreError('INSERT_ONLY', `store: ${name} is insert only, ${what} is refused`); };

    return {
      name: fullName,

      get: (id) => op(() => { checkId(id); const d = coll.docs.get(id); return d ? clone(d) : null; }),

      // Conditional insert: true when inserted, false when the id (or a unique field) already exists.
      insert: (doc) => op((ctx) => {
        if (!doc || typeof doc !== 'object') throw new StoreError('BAD_VALUE', 'store: insert needs a document');
        checkId(doc._id);
        const { _id, ...rest } = doc;
        checkFields(rest, 'document');
        if (coll.docs.has(_id)) return false;
        const copy = clone(doc);
        // Outside a transaction a unique field clash is a plain "not inserted". Inside one it
        // throws, because MongoDB aborts a transaction on any duplicate key error.
        try { checkUnique(coll, copy, _id); } catch (e) { if (e.duplicate && !ctx) return false; throw e; }
        remember(ctx, coll, fullName, _id);
        write(coll, copy);
        return true;
      }),

      // Sets fields, creating the document when missing. Returns the new document.
      upsert: (id, fields) => op((ctx) => {
        guard('upsert');
        checkId(id); checkFields(fields, 'fields');
        const cur = coll.docs.get(id) || { _id: id };
        const next = applyUpdate(cur, { set: fields });
        remember(ctx, coll, fullName, id);
        write(coll, next);
        return clone(next);
      }),

      // Replaces the whole document (creating it when missing). Returns the new document.
      put: (id, doc) => op((ctx) => {
        guard('put');
        checkId(id);
        const { _id: _ignored, ...rest } = doc || {};
        checkFields(rest, 'document');
        const next = { ...clone(rest), _id: id };
        remember(ctx, coll, fullName, id);
        write(coll, next);
        return clone(next);
      }),

      // Compare and set: applies { set, unset, inc } only when the document exists
      // and matches `where`. Returns the new document, or null when nothing matched.
      update: (id, u = {}) => op((ctx) => {
        guard('update');
        checkId(id);
        const where = checkFilter(u.where);
        const nu = normalizeUpdate(u);
        const cur = coll.docs.get(id);
        if (!cur || !matches(cur, where)) return null;
        const next = applyUpdate(cur, nu);
        remember(ctx, coll, fullName, id);
        write(coll, next);
        return clone(next);
      }),

      cas: (id, field, expected, value) => op((ctx) => {
        guard('cas');
        checkId(id); checkFields({ [field]: value }, 'cas');
        const cur = coll.docs.get(id);
        if (!cur) return false;
        if (!deepEqual(cur[field] === undefined ? null : cur[field], expected === undefined ? null : expected)) return false;
        const next = applyUpdate(cur, { set: { [field]: value } });
        remember(ctx, coll, fullName, id);
        write(coll, next);
        return true;
      }),

      // Atomic add. A change that would take the value below `floor` (default 0n)
      // is refused and nothing changes; floor: null disables the check. A missing
      // document is created for a non negative delta when upsert is true (default).
      incr: (id, field, delta, opts = {}) => op((ctx) => {
        guard('incr');
        checkId(id); checkFields({ [field]: null }, 'incr');
        const d = toBig(delta);
        const floor = opts.floor === undefined ? 0n : opts.floor === null ? null : toBig(opts.floor, 'floor');
        const where = checkFilter(opts.where);
        const set = checkFields(opts.set, 'set');
        const upsert = opts.upsert !== false;
        const cur = coll.docs.get(id);
        if (!cur) {
          if (!upsert || Object.keys(where).length > 0) return { ok: false, value: null };
          if (floor !== null && d < 0n) return { ok: false, value: null };
          const next = applyUpdate({ _id: id }, { set, inc: { [field]: d } });
          remember(ctx, coll, fullName, id);
          write(coll, next);
          return { ok: true, value: next[field] };
        }
        if (!matches(cur, where)) return { ok: false, value: null };
        const before = cur[field] === undefined ? 0n : cur[field];
        if (typeof before !== 'bigint' && !Number.isInteger(before)) throw new StoreError('BAD_VALUE', `store: cannot increment non integer field ${field}`);
        const after = BigInt(before) + d;
        if (floor !== null && d < 0n && after < floor) return { ok: false, value: null };
        const next = applyUpdate(cur, { set, inc: { [field]: d } });
        remember(ctx, coll, fullName, id);
        write(coll, next);
        return { ok: true, value: next[field] };
      }),

      delete: (id, where) => op((ctx) => {
        guard('delete');
        checkId(id);
        const w = checkFilter(where);
        const cur = coll.docs.get(id);
        if (!cur || !matches(cur, w)) return false;
        remember(ctx, coll, fullName, id);
        return remove(coll, id);
      }),

      deleteMany: (filter) => op((ctx) => {
        guard('deleteMany');
        const f = checkFilter(filter);
        let n = 0;
        for (const doc of [...coll.docs.values()]) {
          if (!matches(doc, f)) continue;
          remember(ctx, coll, fullName, doc._id);
          remove(coll, doc._id);
          n += 1;
        }
        return n;
      }),

      find: (filter, opts = {}) => op(() => {
        const f = checkFilter(filter);
        const sort = checkSort(opts.sort);
        const limit = checkLimit(opts.limit, 'limit');
        const skip = checkLimit(opts.skip, 'skip');
        let rows = [...coll.docs.values()].filter((d) => matches(d, f));
        if (sort) {
          const order = Object.entries(sort);
          rows.sort((a, b) => {
            for (const [field, dir] of order) {
              const c = compare(getPath(a, field), getPath(b, field));
              if (c !== 0) return dir < 0 ? -c : c;
            }
            return 0;
          });
        }
        if (skip) rows = rows.slice(skip);
        if (limit) rows = rows.slice(0, limit);
        return rows.map(clone);
      }),

      count: (filter) => op(() => {
        const f = checkFilter(filter);
        let n = 0;
        for (const d of coll.docs.values()) if (matches(d, f)) n += 1;
        return n;
      }),

      // Single field unique (or plain) index. Plain indexes are accepted and ignored here.
      ensureIndex: (field, { unique = false } = {}) => op((ctx) => {
        if (ctx) throw new StoreError('IN_TRANSACTION', 'store: ensureIndex cannot run inside a transaction');
        if (typeof field !== 'string' || field.length === 0 || field.startsWith('$')) throw new StoreError('BAD_FIELD', 'store: bad index field');
        if (!unique || coll.unique.has(field)) return true;
        const index = new Map();
        for (const d of coll.docs.values()) {
          const k = uniqueKey(getPath(d, field));
          if (k === null) continue;
          if (index.has(k)) throw new StoreError('DUPLICATE', `store: existing duplicates for unique field ${field}`);
          index.set(k, d._id);
        }
        coll.unique.set(field, index);
        return true;
      }),
    };
  }

  const store = {
    kind: 'memory',
    prefix,
    capabilities: Object.freeze({ transactions: true, fallback: null }),
    collection,

    // Runs fn as one atomic unit. Inside fn, use the store (or the argument) as
    // normal; every operation is part of the unit. Nested calls join the outer unit.
    async transaction(fn) {
      if (closed) throw new StoreError('CLOSED', 'store: closed');
      if (als.getStore()) return fn(store);
      return lock.run(async () => {
        const ctx = { journal: new Map() };
        try {
          return await als.run(ctx, () => fn(store));
        } catch (err) {
          const entries = [...ctx.journal.values()];
          for (const { coll, id } of entries) remove(coll, id);
          for (const { coll, prev } of entries) if (prev !== undefined) write(coll, prev);
          throw err;
        }
      });
    },

    inTransaction: () => Boolean(als.getStore()),
    async ping() { if (closed) throw new StoreError('CLOSED', 'store: closed'); return true; },
    async close() { closed = true; await lock.run(() => {}); },
    _backing: backing,
  };
  return store;
}
