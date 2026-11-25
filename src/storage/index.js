// Storage entry point: memory when config.mongoUri is empty, MongoDB otherwise.
// Both adapters expose the same interface, documented in docs/coordinator.md:
//   store.kind, store.prefix, store.capabilities { transactions, fallback }
//   store.collection(name) -> { name, get, insert, upsert, update, cas, incr, delete, deleteMany, find, count, ensureIndex }
//   store.transaction(fn), store.inTransaction(), store.ping(), store.close()
import { createMemoryStore, createMemoryBacking } from './memory.js';

export async function createStore(config = {}) {
  const prefix = config.storePrefix || 'tangent_';
  if (!config.mongoUri) return createMemoryStore({ prefix });
  const { createMongoStore } = await import('./mongo.js');
  return createMongoStore({
    mongoUri: config.mongoUri,
    mongoDb: config.mongoDb || 'tangent',
    prefix,
    requireTransactions: Boolean(config.requireTransactions),
    selectTimeoutMs: config.mongoSelectTimeoutMs || 15000,
  });
}

export { createMemoryStore, createMemoryBacking };
export { StoreError, INSERT_ONLY } from './common.js';
