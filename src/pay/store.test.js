import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, kvFromStore } from './store.js';

test('store: conditional insert refuses an existing id and aborts the whole unit', async () => {
  const s = createMemoryStore();
  await s.tx(async (t) => t.insert('c', 'a', { n: 1 }));
  await assert.rejects(s.tx(async (t) => {
    await t.put('c', 'b', { n: 2 });
    await t.insert('c', 'a', { n: 3 });
  }), (e) => e.code === 'DUPLICATE');
  assert.equal(await s.get('c', 'b'), null);
  assert.deepEqual(await s.get('c', 'a'), { n: 1, _id: 'a' });
});

test('store: concurrent read-modify-write units are serializable (no lost updates)', async () => {
  const s = createMemoryStore();
  await Promise.all(Array.from({ length: 40 }, () => s.tx(async (t) => {
    const d = (await t.get('c', 'x')) || { n: 0 };
    await t.put('c', 'x', { n: d.n + 1 });
  })));
  assert.equal((await s.get('c', 'x')).n, 40);
});

test('store: concurrent conditional inserts of one id, exactly one wins', async () => {
  const s = createMemoryStore();
  const res = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => s.tx(async (t) => {
    if (await t.get('c', 'once')) throw Object.assign(new Error('taken'), { code: 'TAKEN' });
    await t.insert('c', 'once', { by: i });
    const k = (await t.get('c', 'count')) || { n: 0 };
    await t.put('c', 'count', { n: k.n + 1 });
  })));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await s.get('c', 'count')).n, 1);
});

test('store: an error thrown inside a unit writes nothing; a fault before commit writes nothing', async () => {
  const s = createMemoryStore();
  await assert.rejects(s.tx(async (t) => {
    await t.put('c', 'y', { n: 1 });
    throw new Error('boom');
  }), /boom/);
  assert.equal(await s.get('c', 'y'), null);
  s._failNextCommit();
  await assert.rejects(s.tx(async (t) => t.put('c', 'y', { n: 1 })), (e) => e.code === 'INJECTED_FAULT');
  assert.equal(await s.get('c', 'y'), null);
});

test('store: find with equality filter, sort and limit; keys are insert only with a backup copy', async () => {
  const s = createMemoryStore();
  await s.tx(async (t) => {
    await t.put('c', '1', { k: 'a', v: 3 });
    await t.put('c', '2', { k: 'b', v: 1 });
    await t.put('c', '3', { k: 'a', v: 2 });
  });
  assert.deepEqual((await s.find('c', { k: 'a' }, { sort: { v: 1 } })).map((d) => d._id), ['3', '1']);
  assert.equal((await s.find('c', {}, { limit: 2 })).length, 2);
  assert.deepEqual(await s.keys.insert({ label: 'k1', publicKey: 'p', secret: 's' }), { inserted: true });
  assert.deepEqual(await s.keys.insert({ label: 'k1', publicKey: 'p', secret: 's' }), { inserted: false });
  await assert.rejects(s.keys.insert({ label: 'k1', publicKey: 'p', secret: 'other' }), (e) => e.code === 'KEY_EXISTS');
  assert.equal((await s.keys.get('k1')).secret, 's');
  assert.equal(s._backups().length, 1);
});

test('store: kv shim for the real Rings adapter', async () => {
  const kv = kvFromStore(createMemoryStore());
  assert.equal(await kv.kvGet('rings_send', 'a'), null);
  await kv.kvSet('rings_send', 'a', { status: 'submitted', signature: 's' });
  await kv.kvSet('rings_send', 'a', { status: 'confirmed', signature: 's', slot: 5 });
  assert.deepEqual(await kv.kvGet('rings_send', 'a'), { status: 'confirmed', signature: 's', slot: 5 });
});
