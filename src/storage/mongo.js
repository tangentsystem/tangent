// MongoDB adapter. Same interface and results as the memory adapter.
//
// The MongoDB cluster can be shared with other apps, so this adapter only
// ever opens collections named <prefix><name> (default prefix "tangent_") in
// its own database (default "tangent"). It never lists, drops or clears a
// database, and never touches a collection without its prefix.
//
// BigInt values are stored as 64 bit integers and read back as BigInt
// (useBigInt64), so lamport counters keep full precision.
//
// transaction(fn):
//   - On a replica set or sharded cluster (Atlas, Railway's MongoDB template,
//     any `mongod --replSet`) it is a real MongoDB transaction
//     (session.withTransaction). fn may be run more than once when MongoDB
//     asks for a retry, so fn must only touch the store.
//   - On a standalone mongod (no transactions) it falls back to a process
//     local lock plus an undo journal: operations from this process never see
//     half of a unit, and a unit that throws is rolled back. This fallback is
//     NOT crash safe and NOT safe with two service instances on one database.
//     capabilities.transactions is false in that case and the boot log says
//     so; set requireTransactions to refuse to start instead.
import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient } from 'mongodb';
import {
  INSERT_ONLY, StoreError, checkFields, checkFilter, checkId, checkLimit, checkName, checkPrefix,
  checkSort, createMutex, isDuplicate, toBig,
} from './common.js';

export async function createMongoStore({
  mongoUri, mongoDb = 'tangent', prefix = 'tangent_', requireTransactions = false, selectTimeoutMs = 15000, client: givenClient,
} = {}) {
  checkPrefix(prefix);
  if (!givenClient && (typeof mongoUri !== 'string' || !/^mongodb(\+srv)?:\/\//.test(mongoUri))) throw new StoreError('BAD_CONFIG', 'store: mongoUri is required for the mongo adapter');
  if (typeof mongoDb !== 'string' || !/^[A-Za-z0-9_-]{1,38}$/.test(mongoDb)) throw new StoreError('BAD_CONFIG', 'store: bad database name');
  const client = givenClient || new MongoClient(mongoUri, {
    appName: 'tangent-coordinator',
    useBigInt64: true,
    writeConcern: { w: 'majority', journal: true },
    serverSelectionTimeoutMS: selectTimeoutMs,
  });
  await client.connect();
  const db = client.db(mongoDb);
  let hello;
  try {
    hello = await db.command({ hello: 1 });
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  const txSupported = Boolean(hello && (hello.setName || hello.msg === 'isdbgrid'));
  if (requireTransactions && !txSupported) {
    await client.close().catch(() => {});
    throw new StoreError('NO_TRANSACTIONS', 'store: this MongoDB server does not support transactions (needs a replica set or sharded cluster)');
  }

  const als = new AsyncLocalStorage();
  const lock = createMutex(); // fallback mode only
  let closed = false;

  function op(fn) {
    if (closed) return Promise.reject(new StoreError('CLOSED', 'store: closed'));
    const ctx = als.getStore();
    if (ctx || txSupported) return Promise.resolve().then(() => fn(ctx || null));
    return lock.run(() => fn(null));
  }
  const sess = (ctx) => (ctx && ctx.session ? { session: ctx.session } : {});

  async function remember(ctx, raw, id) {
    if (!ctx || !ctx.journal) return;
    const key = raw.collectionName + '\u0000' + JSON.stringify(id);
    if (ctx.journal.has(key)) return;
    const prev = await raw.findOne({ _id: id });
    ctx.journal.set(key, { raw, id, prev: prev || undefined });
  }

  function updateDoc({ set, unset, inc }) {
    const u = {};
    if (set && Object.keys(set).length) u.$set = set;
    if (unset && unset.length) u.$unset = Object.fromEntries(unset.map((k) => [k, '']));
    if (inc && Object.keys(inc).length) u.$inc = inc;
    return u;
  }

  function collection(name) {
    checkName(name);
    const fullName = prefix + name;
    if (!fullName.startsWith(prefix)) throw new StoreError('BAD_NAME', 'store: refusing collection');
    const raw = db.collection(fullName);
    const insertOnly = INSERT_ONLY.has(name);
    const guard = (what) => { if (insertOnly) throw new StoreError('INSERT_ONLY', `store: ${name} is insert only, ${what} is refused`); };

    return {
      name: fullName,

      get: (id) => op(async (ctx) => { checkId(id); return raw.findOne({ _id: id }, sess(ctx)); }),

      insert: (doc) => op(async (ctx) => {
        if (!doc || typeof doc !== 'object') throw new StoreError('BAD_VALUE', 'store: insert needs a document');
        checkId(doc._id);
        const { _id, ...rest } = doc;
        checkFields(rest, 'document');
        if (ctx && ctx.session) {
          // A duplicate key error aborts a MongoDB transaction, so look first.
          if (await raw.findOne({ _id }, { session: ctx.session, projection: { _id: 1 } })) return false;
          try {
            await raw.insertOne({ ...doc }, { session: ctx.session });
          } catch (err) {
            if (isDuplicate(err)) throw new StoreError('DUPLICATE', 'store: duplicate value for a unique field');
            throw err;
          }
          return true;
        }
        if (ctx && ctx.journal) {
          if (await raw.findOne({ _id }, { projection: { _id: 1 } })) return false;
          await remember(ctx, raw, _id);
          try { await raw.insertOne({ ...doc }); } catch (err) {
            if (isDuplicate(err)) throw new StoreError('DUPLICATE', 'store: duplicate value for a unique field');
            throw err;
          }
          return true;
        }
        try {
          await raw.insertOne({ ...doc });
          return true;
        } catch (err) {
          if (isDuplicate(err)) return false;
          throw err;
        }
      }),

      upsert: (id, fields) => op(async (ctx) => {
        guard('upsert');
        checkId(id); checkFields(fields, 'fields');
        await remember(ctx, raw, id);
        if (!fields || Object.keys(fields).length === 0) {
          try { await raw.insertOne({ _id: id }, sess(ctx)); } catch (err) { if (!isDuplicate(err)) throw err; }
          return raw.findOne({ _id: id }, sess(ctx));
        }
        return raw.findOneAndUpdate({ _id: id }, { $set: fields }, { upsert: true, returnDocument: 'after', ...sess(ctx) });
      }),

      put: (id, doc) => op(async (ctx) => {
        guard('put');
        checkId(id);
        const { _id: _ignored, ...rest } = doc || {};
        checkFields(rest, 'document');
        await remember(ctx, raw, id);
        await raw.replaceOne({ _id: id }, rest, { upsert: true, ...sess(ctx) });
        return { ...rest, _id: id };
      }),

      update: (id, u = {}) => op(async (ctx) => {
        guard('update');
        checkId(id);
        const where = checkFilter(u.where);
        const set = checkFields(u.set, 'set');
        const unset = u.unset === undefined ? [] : u.unset;
        if (!Array.isArray(unset)) throw new StoreError('BAD_FIELD', 'store: unset must be an array of field names');
        for (const f of unset) checkFields({ [f]: null }, 'unset');
        const inc = {};
        for (const k of Object.keys(u.inc || {})) { checkFields({ [k]: null }, 'inc'); inc[k] = toBig(u.inc[k], 'inc.' + k); }
        const filter = { ...where, _id: id };
        const doc = updateDoc({ set, unset, inc });
        if (Object.keys(doc).length === 0) return raw.findOne(filter, sess(ctx));
        await remember(ctx, raw, id);
        return raw.findOneAndUpdate(filter, doc, { returnDocument: 'after', ...sess(ctx) });
      }),

      cas: (id, field, expected, value) => op(async (ctx) => {
        guard('cas');
        checkId(id); checkFields({ [field]: value }, 'cas');
        await remember(ctx, raw, id);
        const r = await raw.updateOne({ _id: id, [field]: expected === undefined ? null : expected }, { $set: { [field]: value } }, sess(ctx));
        return r.matchedCount === 1;
      }),

      incr: (id, field, delta, opts = {}) => op(async (ctx) => {
        guard('incr');
        checkId(id); checkFields({ [field]: null }, 'incr');
        const d = toBig(delta);
        const floor = opts.floor === undefined ? 0n : opts.floor === null ? null : toBig(opts.floor, 'floor');
        const where = checkFilter(opts.where);
        const set = checkFields(opts.set, 'set');
        const filter = { ...where, _id: id };
        const floored = floor !== null && d < 0n;
        if (floored) filter[field] = { $gte: floor - d };
        const upsert = opts.upsert !== false && !floored && Object.keys(where).length === 0;
        await remember(ctx, raw, id);
        const update = { $inc: { [field]: d } };
        if (Object.keys(set).length) update.$set = set;
        let doc;
        try {
          doc = await raw.findOneAndUpdate(filter, update, { upsert, returnDocument: 'after', ...sess(ctx) });
        } catch (err) {
          if (err && (err.code === 2 || /overflow/i.test(String(err.message)))) throw new StoreError('OVERFLOW', 'store: increment overflows 64 bits');
          throw err;
        }
        if (!doc) return { ok: false, value: null };
        return { ok: true, value: BigInt(doc[field]) };
      }),

      delete: (id, where) => op(async (ctx) => {
        guard('delete');
        checkId(id);
        const w = checkFilter(where);
        await remember(ctx, raw, id);
        const r = await raw.deleteOne({ ...w, _id: id }, sess(ctx));
        return r.deletedCount === 1;
      }),

      deleteMany: (filter) => op(async (ctx) => {
        guard('deleteMany');
        const f = checkFilter(filter);
        if (ctx && ctx.journal) {
          const rows = await raw.find(f, { projection: { _id: 1 } }).toArray();
          for (const r of rows) await remember(ctx, raw, r._id);
        }
        const r = await raw.deleteMany(f, sess(ctx));
        return r.deletedCount;
      }),

      find: (filter, opts = {}) => op(async (ctx) => {
        const f = checkFilter(filter);
        const sort = checkSort(opts.sort);
        const limit = checkLimit(opts.limit, 'limit');
        const skip = checkLimit(opts.skip, 'skip');
        const o = { ...sess(ctx) };
        if (sort) o.sort = sort;
        if (limit) o.limit = limit;
        if (skip) o.skip = skip;
        return raw.find(f, o).toArray();
      }),

      count: (filter) => op(async (ctx) => raw.countDocuments(checkFilter(filter), sess(ctx))),

      // Unique indexes are sparse: documents without the field are not indexed.
      ensureIndex: (field, { unique = false } = {}) => op(async (ctx) => {
        if (ctx) throw new StoreError('IN_TRANSACTION', 'store: ensureIndex cannot run inside a transaction');
        if (typeof field !== 'string' || field.length === 0 || field.startsWith('$')) throw new StoreError('BAD_FIELD', 'store: bad index field');
        await raw.createIndex({ [field]: 1 }, unique ? { unique: true, sparse: true } : {});
        return true;
      }),
    };
  }

  const store = {
    kind: 'mongo',
    prefix,
    database: mongoDb,
    capabilities: Object.freeze({ transactions: txSupported, fallback: txSupported ? null : 'journal' }),
    collection,

    async transaction(fn) {
      if (closed) throw new StoreError('CLOSED', 'store: closed');
      if (als.getStore()) return fn(store);
      if (txSupported) {
        const session = client.startSession();
        try {
          let out;
          await session.withTransaction(async () => {
            out = await als.run({ session }, () => fn(store));
          }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
          return out;
        } finally {
          await session.endSession();
        }
      }
      return lock.run(async () => {
        const ctx = { journal: new Map() };
        try {
          return await als.run(ctx, () => fn(store));
        } catch (err) {
          for (const { raw, id, prev } of [...ctx.journal.values()].reverse()) {
            if (prev === undefined) await raw.deleteOne({ _id: id });
            else await raw.replaceOne({ _id: id }, prev, { upsert: true });
          }
          throw err;
        }
      });
    },

    inTransaction: () => Boolean(als.getStore()),
    async ping() { await db.command({ ping: 1 }); return true; },
    async close() {
      if (closed) return;
      closed = true;
      if (!txSupported) await lock.run(() => {});
      if (!givenClient) await client.close();
    },
  };
  return store;
}
