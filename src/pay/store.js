// The store interface the pay module needs, and an in-memory implementation for tests and empty-env boots.
//
// INTERFACE (the coordinator's MongoDB storage implements the same; see docs/pay.md)
//
//   store.kind                                  'memory' | 'mongo'
//   store.get(coll, id)              -> doc | null          plain read, outside any transaction
//   store.find(coll, filter, opts)   -> doc[]               filter = equality on top level fields ({} = all),
//                                                            opts = { limit, sort: { field: 1 | -1 } }
//   store.tx(async (t) => ..., opts) -> fn's result         one atomic unit, all writes or none
//       t.get(coll, id)              -> doc | null          read inside the unit
//       t.insert(coll, id, doc)                             conditional insert: throws { code: 'DUPLICATE' } when id exists
//       t.put(coll, id, doc)                                upsert the whole document
//   store.keys.insert({ label, kind, publicKey, secret, meta }) -> { inserted }   INSERT ONLY, also writes the backup
//   store.keys.get(label)            -> row | null
//   store.keys.list(prefix)          -> row[] sorted by label
//
// Documents are plain JSON (strings, numbers, booleans, null, arrays, objects). BigInt values are stored as
// decimal strings by the caller. `_id` is the document id inside its collection.
//
// ATOMICITY CONTRACT for store.tx: the unit is serializable. If any document the unit read (with t.get, or
// probed with t.insert) was changed by another unit that committed first, the unit is retried from the start
// (opts.retries, default 50). The pay module relies on this for every money move: a unit that decides
// something from a document always reads that document inside the unit, and every document whose value
// decided a write is itself written in the same unit (or guarded by a conditional insert), so a MongoDB
// implementation with multi document transactions (snapshot isolation + write conflicts, retried on
// TransientTransactionError) gives the same guarantees.
//
// The memory implementation below is optimistic: each document has a version; a unit records the version of
// every document it reads, buffers its writes, and commits in one synchronous step only when none of those
// versions moved. It yields to the event loop on every read, so concurrent units really do interleave in tests.
import { randomBytes } from 'node:crypto';

export const COLLECTIONS = Object.freeze({
  wallets: 'tangent_pay_wallets',
  deposits: 'tangent_pay_deposits',
  meta: 'tangent_pay_meta',
  challenges: 'tangent_pay_challenges',
  issuances: 'tangent_pay_issuances',
  keystats: 'tangent_pay_keystats',
  spent: 'tangent_pay_spent',
  accounts: 'tangent_pay_accounts',
  vouchers: 'tangent_pay_vouchers',
  earnings: 'tangent_pay_earnings',
  payouts: 'tangent_pay_payouts',
  withdrawals: 'tangent_pay_withdrawals',
  fees: 'tangent_pay_fees',
  tips: 'tangent_pay_tips',
  ringsKv: 'tangent_pay_rings_kv',
});

export const KEY_COLLECTIONS = Object.freeze({ keys: 'tangent_pay_keys', backups: 'tangent_pay_keys_backup' });

export class StoreError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StoreError';
    this.code = code;
  }
}

class Conflict extends Error {}

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));
const tick = () => new Promise((r) => setImmediate(r));

function matches(doc, filter) {
  for (const [k, v] of Object.entries(filter || {})) if (doc[k] !== v) return false;
  return true;
}

function sortRows(rows, sort) {
  if (!sort) return rows;
  const order = Object.entries(sort);
  return rows.sort((a, b) => {
    for (const [f, dir] of order) {
      const x = a[f];
      const y = b[f];
      if (x === y) continue;
      if (x === undefined || x === null) return -dir;
      if (y === undefined || y === null) return dir;
      return (x < y ? -1 : 1) * dir;
    }
    return 0;
  });
}

export function createMemoryStore({ interleave = true } = {}) {
  const colls = new Map(); // coll -> Map(id -> { ver, doc })
  const keyRows = new Map();
  const backupRows = [];
  let faultBeforeCommit = null;

  function coll(name) {
    if (typeof name !== 'string' || !name) throw new StoreError('BAD_COLLECTION', 'collection name required');
    let c = colls.get(name);
    if (!c) colls.set(name, (c = new Map()));
    return c;
  }
  function checkId(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 512) throw new StoreError('BAD_ID', 'document id must be a non empty string');
  }

  async function tx(fn, { retries = 50 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const reads = new Map(); // "coll\0id" -> version seen (0 = absent)
      const writes = new Map(); // "coll\0id" -> { coll, id, doc, insert }
      let open = true;
      const keyOf = (c, id) => c + '\u0000' + id;
      const current = (c, id) => coll(c).get(id);
      const isStaleNow = () => {
        for (const [k, ver] of reads) {
          const i = k.indexOf('\u0000');
          const row = current(k.slice(0, i), k.slice(i + 1));
          if ((row ? row.ver : 0) !== ver) return true;
        }
        return false;
      };
      const assertOpen = () => {
        if (!open) throw new StoreError('TX_CLOSED', 'transaction already finished');
      };
      const t = {
        async get(c, id) {
          assertOpen();
          checkId(id);
          if (interleave) await tick();
          if (isStaleNow()) throw new Conflict();
          const k = keyOf(c, id);
          if (writes.has(k)) return clone(writes.get(k).doc);
          const row = current(c, id);
          if (!reads.has(k)) reads.set(k, row ? row.ver : 0);
          else if ((row ? row.ver : 0) !== reads.get(k)) throw new Conflict();
          return row ? clone(row.doc) : null;
        },
        insert(c, id, doc) {
          assertOpen();
          checkId(id);
          const k = keyOf(c, id);
          const row = current(c, id);
          if (!reads.has(k)) reads.set(k, row ? row.ver : 0);
          if (row || (writes.has(k) && writes.get(k).doc)) throw new StoreError('DUPLICATE', `${c}/${id} already exists`);
          writes.set(k, { coll: c, id, doc: { ...clone(doc), _id: id }, insert: true });
        },
        put(c, id, doc) {
          assertOpen();
          checkId(id);
          writes.set(keyOf(c, id), { coll: c, id, doc: { ...clone(doc), _id: id }, insert: false });
        },
      };
      let result;
      try {
        result = await fn(t);
      } catch (err) {
        open = false;
        // An error decided on a view that another unit has since changed is not trusted: retry on fresh data
        // (a snapshot database would never have shown that mixed view).
        if (err instanceof Conflict || isStaleNow()) continue;
        throw err;
      }
      open = false;
      // commit: one synchronous step, nothing else can run in between
      if (isStaleNow()) continue;
      if (faultBeforeCommit) {
        const f = faultBeforeCommit;
        faultBeforeCommit = null;
        throw new StoreError('INJECTED_FAULT', 'injected fault before commit: ' + f);
      }
      for (const w of writes.values()) {
        const map = coll(w.coll);
        const row = map.get(w.id);
        map.set(w.id, { ver: (row ? row.ver : 0) + 1, doc: w.doc });
      }
      return result;
    }
    throw new StoreError('CONTENTION', 'transaction retried too often');
  }

  const keys = {
    // Insert only. The same label with the same content is a no-op; different content is refused, never replaced.
    async insert({ label, kind, publicKey, secret, meta } = {}) {
      if (typeof label !== 'string' || !label) throw new StoreError('BAD_KEY', 'key label required');
      if (typeof publicKey !== 'string' || !publicKey) throw new StoreError('BAD_KEY', 'publicKey required');
      if (typeof secret !== 'string' || !secret) throw new StoreError('BAD_KEY', 'secret required');
      const existing = keyRows.get(label);
      if (existing) {
        if (existing.publicKey === publicKey && existing.secret === secret) return { inserted: false };
        throw new StoreError('KEY_EXISTS', `a different key is already saved under "${label}"; keys are never overwritten`);
      }
      const row = { label, kind: kind || null, publicKey, secret, meta: clone(meta || {}), createdAt: new Date().toISOString() };
      keyRows.set(label, row);
      backupRows.push(clone(row)); // second copy, written at creation
      return { inserted: true };
    },
    async get(label) {
      return clone(keyRows.get(label) || null);
    },
    async list(prefix = '') {
      return [...keyRows.values()].filter((r) => r.label.startsWith(prefix)).sort((a, b) => (a.label < b.label ? -1 : 1)).map(clone);
    },
  };

  return {
    kind: 'memory',
    async get(c, id) {
      checkId(id);
      const row = coll(c).get(id);
      return row ? clone(row.doc) : null;
    },
    async find(c, filter = {}, { limit, sort } = {}) {
      let rows = [...coll(c).values()].map((r) => r.doc).filter((d) => matches(d, filter));
      rows = sortRows(rows, sort);
      if (limit) rows = rows.slice(0, limit);
      return rows.map(clone);
    },
    tx,
    keys,
    // test helpers
    _backups: () => backupRows.map(clone),
    _dump: () => Object.fromEntries([...colls].map(([n, m]) => [n, [...m.values()].map((r) => clone(r.doc))])),
    _failNextCommit(label = 'test') {
      faultBeforeCommit = label;
    },
    _id: () => randomBytes(4).toString('hex'),
  };
}

// The real Rings adapter's exactly-once send records ({ kvGet, kvSet }) on top of the pay store.
export function kvFromStore(store) {
  const id = (ns, key) => JSON.stringify([String(ns), String(key)]);
  return {
    async kvGet(ns, key) {
      const doc = await store.get(COLLECTIONS.ringsKv, id(ns, key));
      return doc ? doc.v : null;
    },
    async kvSet(ns, key, value) {
      await store.tx(async (t) => {
        t.put(COLLECTIONS.ringsKv, id(ns, key), { ns: String(ns), k: String(key), v: value });
      });
    },
  };
}
