import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, createMemoryBacking } from './storage/index.js';
import { ensureKeys, ensureKey, KEY_LABELS } from './keys.js';
import { createIdentity, unb58 } from './core/index.js';

test('keys: first boot creates every key, saves it and its backup', async () => {
  const store = await createMemoryStore();
  const k = await ensureKeys({ store });
  assert.deepEqual([...k.created].sort(), Object.values(KEY_LABELS).sort());
  assert.equal(k.ephemeral, true);
  for (const label of Object.values(KEY_LABELS)) {
    const row = await store.collection('keys').get(label);
    assert.ok(row && row.secret && row.publicKey);
    const backup = await store.collection('keys_backup').get(`${label}:${row.publicKey}`);
    assert.equal(backup.secret, row.secret);
    assert.equal(createIdentity(unb58(row.secret)).id, row.publicKey);
  }
  assert.equal(k.coordinator.id, (await store.collection('keys').get('coordinator')).publicKey);
  assert.equal(k.rings.seed.length, 32);
});

test('keys: a restart loads the same keys and never rewrites them', async () => {
  const backing = createMemoryBacking();
  const s1 = await createMemoryStore({ backing });
  const a = await ensureKeys({ store: s1 });
  const before = await s1.collection('keys').find({});
  const s2 = await createMemoryStore({ backing });
  const b = await ensureKeys({ store: s2 });
  assert.deepEqual([...b.created], []);
  assert.equal(b.coordinator.id, a.coordinator.id);
  assert.equal(b.tip.address, a.tip.address);
  assert.equal(b.rings.address, a.rings.address);
  assert.deepEqual(await s2.collection('keys').find({}), before);
});

test('keys: the store refuses to overwrite or delete a saved key', async () => {
  const store = await createMemoryStore();
  await ensureKeys({ store });
  const keys = store.collection('keys');
  const row = await keys.get('coordinator');
  await assert.rejects(keys.upsert('coordinator', { secret: 'x' }));
  await assert.rejects(keys.update('coordinator', { set: { secret: 'x' } }));
  await assert.rejects(keys.delete('coordinator'));
  assert.equal(await keys.insert({ ...row, secret: 'other' }), false);
  assert.deepEqual(await keys.get('coordinator'), row);
});

test('keys: a missing backup row is restored on boot, never replaced', async () => {
  const backing = createMemoryBacking();
  const s1 = await createMemoryStore({ backing });
  await ensureKeys({ store: s1 });
  const row = await s1.collection('keys').get('tip');
  // simulate a key saved by an older build without a backup row
  backing.get('tangent_keys_backup').docs.delete(`tip:${row.publicKey}`);
  const s2 = await createMemoryStore({ backing });
  await ensureKeys({ store: s2 });
  assert.equal((await s2.collection('keys_backup').get(`tip:${row.publicKey}`)).secret, row.secret);
});

test('keys: a corrupt saved key stops the boot instead of being replaced', async () => {
  const store = await createMemoryStore();
  await store.collection('keys').insert({ _id: 'coordinator', kind: 'ed25519', publicKey: createIdentity().id, secret: 'not-a-seed', createdAt: 'x' });
  await assert.rejects(ensureKeys({ store }), /refusing to replace/);
  assert.equal((await store.collection('keys').get('coordinator')).secret, 'not-a-seed');
});

test('keys: two instances racing on an empty database end up with the same key, both backed up', async () => {
  const store = await createMemoryStore();
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureKey(store, 'race')));
  const ids = new Set(results.map((r) => r.publicKey));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  const saved = await store.collection('keys').get('race');
  assert.ok(await store.collection('keys_backup').get(`race:${saved.publicKey}`));
  // every candidate that was generated has its backup row (insert only, losers unused)
  assert.equal(await store.collection('keys_backup').count({ label: 'race' }), 8);
});

test('keys: ensureKey with a custom generator (for other modules)', async () => {
  const store = await createMemoryStore();
  const gen = () => ({ kind: 'rsa', publicKey: 'pub-1', secret: 'sec-1' });
  const k = await ensureKey(store, 'blind', { generate: gen, check: (r) => r.publicKey === 'pub-1' });
  assert.equal(k.created, true);
  const again = await ensureKey(store, 'blind', { generate: () => ({ kind: 'rsa', publicKey: 'pub-2', secret: 'sec-2' }), check: () => true });
  assert.equal(again.publicKey, 'pub-1');
  await assert.rejects(ensureKey(store, 'Bad Label'));
});
