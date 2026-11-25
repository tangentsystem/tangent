// Runs the shared store suite against a real MongoDB when MONGO_URI is set in
// the test environment, for example
//   MONGO_URI=mongodb://127.0.0.1:27017 node --test src/storage/
// Without it these tests are skipped (memory.test.js still runs the same suite).
// Each run uses the database "tangent_test" and a random collection prefix, and
// at the end drops only the collections carrying that run's prefix. Nothing
// else in the cluster is read, written or cleared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createStore } from './index.js';
import { runStoreSuite } from './suite.js';

const uri = (process.env.MONGO_URI || '').trim();
const DB = 'tangent_test';

if (!uri) {
  test('mongo: suite skipped, MONGO_URI is not set in the test environment', { skip: true }, () => {});
} else {
  const runPrefix = 't' + randomBytes(4).toString('hex') + '_';
  let n = 0;
  const config = (prefix) => ({ mongoUri: uri, mongoDb: DB, storePrefix: prefix, mongoSelectTimeoutMs: 8000 });
  const dropOwn = async (prefix) => {
    const client = new MongoClient(uri);
    try {
      const db = client.db(DB);
      const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
      for (const name of names) if (name.startsWith(prefix)) await db.collection(name).drop();
    } finally { await client.close(); }
  };

  runStoreSuite({
    name: 'mongo',
    open: () => createStore(config(runPrefix + (n++) + '_')),
    reopen: (s) => createStore(config(s.prefix)),
    cleanup: (s) => dropOwn(s.prefix),
  });

  test('mongo: only prefixed collections are created and BigInt round trips as int64', async () => {
    const prefix = runPrefix + 'chk_';
    const s = await createStore(config(prefix));
    try {
      assert.equal(s.kind, 'mongo');
      await s.collection('a').insert({ _id: 'x', v: 2n ** 60n });
      await s.collection('b').incr('y', 'n', 5n);
      const client = new MongoClient(uri);
      try {
        const names = (await client.db(DB).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((x) => x.startsWith(runPrefix + 'chk_'));
        assert.deepEqual(names.sort(), [prefix + 'a', prefix + 'b']);
      } finally { await client.close(); }
      assert.equal((await s.collection('a').get('x')).v, 2n ** 60n);
    } finally { await dropOwn(prefix); await s.close(); }
  });
}
