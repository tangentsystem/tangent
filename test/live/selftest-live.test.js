// The self test's free checks against the REAL outside world. Skipped unless the environment
// names it (nothing here runs in a plain `npm test`):
//
//   LIVE_MONGO_URI   a MongoDB replica set (for example a throwaway mongo:7 container started
//                    with --replSet). Uses database tangent_test under a random collection prefix;
//                    its data collections are dropped at the end, its keys and keys_backup
//                    collections are left in place (keys are never deleted).
//   LIVE_RPC_URL     a Solana mainnet RPC (read only; nothing is ever sent).
//
// Outbound HTTPS from a proxied shell: run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
//
//   LIVE_MONGO_URI='mongodb://127.0.0.1:27477/?replicaSet=rs0&directConnection=true' \
//   LIVE_RPC_URL=https://api.mainnet-beta.solana.com NODE_USE_ENV_PROXY=1 \
//   node --test "test/live/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { Connection } from '@solana/web3.js';
import { createStore } from '../../src/storage/index.js';
import { ensureKeys, ensureKey } from '../../src/keys.js';
import { loadConfig } from '../../src/config.js';
import { createRealWorld } from '../../src/selftest/world.js';
import { STATUS } from '../../src/selftest/report.js';

const MONGO = (process.env.LIVE_MONGO_URI || '').trim();
const RPC = (process.env.LIVE_RPC_URL || '').trim();
const DB = 'tangent_test';

async function dropData(prefix) {
  const client = new MongoClient(MONGO);
  try {
    const db = client.db(DB);
    for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (!c.name.startsWith(prefix)) continue;
      if (c.name === `${prefix}keys` || c.name === `${prefix}keys_backup`) continue; // keys are never deleted
      await db.collection(c.name).drop();
    }
  } finally { await client.close(); }
}

test('live MongoDB: self test storage checks and the insert only key guard on a real replica set', { skip: MONGO ? false : 'LIVE_MONGO_URI is not set', timeout: 120_000 }, async (t) => {
  const prefix = 'tangent_l' + randomBytes(3).toString('hex') + '_'; // storage.prefix requires tangent_
  const store = await createStore({ mongoUri: MONGO, mongoDb: DB, storePrefix: prefix, mongoSelectTimeoutMs: 8000 });
  t.after(async () => { await dropData(prefix); await store.close(); });
  assert.equal(store.kind, 'mongo');
  assert.equal(store.capabilities.transactions, true, 'a replica set gives real transactions');
  const keys = await ensureKeys({ store });
  // a second boot on the same database keeps every key (insert only, nothing regenerated)
  const again = await ensureKeys({ store });
  assert.equal(again.tip.address, keys.tip.address);
  assert.equal(again.rings.address, keys.rings.address);
  assert.deepEqual([...again.created], []);
  const config = { ...loadConfig({}), storePrefix: prefix };
  const world = await createRealWorld({ config, store, keys, connection: null, log: null, deps: { ringsOps: async () => ({}) } });
  const results = {};
  for (const c of world.freeChecks.filter((x) => x.id.startsWith('storage.') || x.id === 'keys.insert_only')) results[c.id] = await c.run();
  for (const id of ['storage.mongo', 'storage.transactions', 'storage.prefix', 'keys.insert_only']) {
    assert.equal(results[id].status, STATUS.PASS, `${id}: ${results[id].reason || ''}`);
  }
  // the raw collections hold exactly one key row per label and its backup, unchanged
  const row = await store.collection('keys').get('selftest');
  const k = await ensureKey(store, 'selftest');
  assert.equal(k.secret, row.secret);
  assert.equal(k.created, false);
  t.diagnostic(Object.entries(results).map(([id, r]) => `${id} ${r.status} ${r.detail || r.reason || ''}`).join(' | '));
});

test('live Solana mainnet: solana.rpc, prices and the token fixtures through the self test checks', { skip: RPC ? false : 'LIVE_RPC_URL is not set', timeout: 240_000 }, async (t) => {
  const { createMemoryStore } = await import('../../src/storage/index.js');
  const store = await createMemoryStore();
  const keys = await ensureKeys({ store });
  const connection = new Connection(RPC, 'confirmed');
  const world = await createRealWorld({ config: loadConfig({}), store, keys, connection, log: null, deps: { ringsOps: async () => ({}) } });
  const want = ['solana.rpc', 'price.coingecko', 'price.pyth', 'token.meteora_fixture', 'token.pumpfun_fixture', 'token.raydium_fixture'];
  const out = {};
  for (const c of world.freeChecks.filter((x) => want.includes(x.id))) {
    try { out[c.id] = await c.run(); } catch (err) { out[c.id] = { status: STATUS.FAIL, reason: err.message }; }
    await new Promise((r) => setTimeout(r, 1500)); // the public RPC is rate limited
  }
  t.diagnostic(Object.entries(out).map(([id, r]) => `${id} ${r.status} ${r.detail || r.reason || ''}`).join(' | '));
  for (const id of want) assert.equal(out[id].status, STATUS.PASS, `${id}: ${out[id].reason || ''}`);
});
