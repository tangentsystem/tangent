// The store shape src/pay asks for (docs/pay.md, "Store interface"), on top of
// this service's store, so pay runs on the memory adapter and on MongoDB alike.
//
//   kind
//   get(coll, id) / find(coll, filter, { limit, sort })
//   tx(async (t) => ...)            t.get, t.insert (throws { code: 'DUPLICATE' }), t.put (whole document)
//   keys.insert({ label, kind, publicKey, secret, meta }) -> { inserted }   insert only, backup row first
//   keys.get(label) / keys.list(prefix)
//
// Pay names its collections "tangent_pay_<x>". Only names of that form are
// accepted; they map to "<prefix>pay_<x>" in the store, so a STORE_PREFIX
// override moves pay's data with everything else. Any other name is refused.
//
// tx() is store.transaction(): on memory and on MongoDB without transactions it
// is serialized (one unit at a time), so pay's serializable contract holds; on
// MongoDB with transactions it is a snapshot transaction that MongoDB retries on
// write conflicts, the model pay's docs say it is written for. Calls on `t`
// that the unit forgets to await are still awaited before the unit commits.
import { StoreError } from './common.js';

const PAY_NAME = /^tangent_(pay_[a-z0-9_]{1,40})$/;

function logical(coll) {
  const m = typeof coll === 'string' ? coll.match(PAY_NAME) : null;
  if (!m) throw new StoreError('BAD_NAME', 'pay store: collection must be named tangent_pay_<name>');
  return m[1];
}

function checkPayId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) throw new StoreError('BAD_ID', 'document id must be a non empty string');
}

export function createPayStore(store) {
  if (!store || typeof store.collection !== 'function') throw new Error('pay store: store is required');
  const c = (coll) => store.collection(logical(coll));
  const keysColl = store.collection('pay_keys');
  const backupColl = store.collection('pay_keys_backup');
  const row = (d) => (d ? { label: d._id, kind: d.kind ?? null, publicKey: d.publicKey, secret: d.secret, meta: d.meta || {}, createdAt: d.createdAt } : null);

  async function tx(fn) {
    return store.transaction(async () => {
      const pending = [];
      const track = (p) => { pending.push(p); p.catch(() => {}); return p; };
      const t = {
        get: (coll, id) => { checkPayId(id); return track(c(coll).get(id)); },
        insert: (coll, id, doc) => {
          checkPayId(id);
          return track(c(coll).insert({ ...doc, _id: id }).then((ok) => {
            if (!ok) throw new StoreError('DUPLICATE', `${coll}/${id} already exists`);
          }));
        },
        put: (coll, id, doc) => { checkPayId(id); return track(c(coll).put(id, doc).then(() => undefined)); },
      };
      const result = await fn(t);
      for (const r of await Promise.allSettled(pending)) if (r.status === 'rejected') throw r.reason;
      return result;
    });
  }

  const keys = {
    async insert({ label, kind, publicKey, secret, meta } = {}) {
      if (typeof label !== 'string' || !label || label.length > 256) throw new StoreError('BAD_KEY', 'key label required');
      if (typeof publicKey !== 'string' || !publicKey) throw new StoreError('BAD_KEY', 'publicKey required');
      if (typeof secret !== 'string' || !secret) throw new StoreError('BAD_KEY', 'secret required');
      const existing = await keysColl.get(label);
      if (existing) {
        if (existing.publicKey === publicKey && existing.secret === secret) return { inserted: false };
        throw new StoreError('KEY_EXISTS', `a different key is already saved under "${label}"; keys are never overwritten`);
      }
      const doc = { kind: kind || null, publicKey, secret, meta: meta || {}, createdAt: new Date().toISOString() };
      // Backup first, so a saved key never exists without its backup row.
      await backupColl.insert({ _id: `${label}:${publicKey}`, label, ...doc });
      if (await keysColl.insert({ _id: label, ...doc })) return { inserted: true };
      const winner = await keysColl.get(label);
      if (winner && winner.publicKey === publicKey && winner.secret === secret) return { inserted: false };
      throw new StoreError('KEY_EXISTS', `a different key is already saved under "${label}"; keys are never overwritten`);
    },
    async get(label) { return row(await keysColl.get(label)); },
    async list(prefix = '') {
      const all = await keysColl.find({}, { sort: { _id: 1 } });
      return all.filter((d) => String(d._id).startsWith(prefix)).map(row);
    },
  };

  return {
    kind: store.kind,
    get: (coll, id) => { checkPayId(id); return c(coll).get(id); },
    find: (coll, filter = {}, { limit, sort } = {}) => c(coll).find(filter, { limit: limit || 0, sort: sort || undefined }),
    tx,
    keys,
  };
}
