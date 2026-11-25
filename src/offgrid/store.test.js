import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, createFileStore } from './store.js';

async function suite(name, make) {
  test(name + ': put, get, list, delete, ttl', async () => {
    let t = 1_000_000;
    const { store, cleanup } = await make(() => t);
    await store.put('b/1', { bytes: 'AAA', own: true });
    await store.put('b/2', { bytes: 'BBB' }, { ttlMs: 1000 });
    await store.put('r/1', { json: '{}' });
    assert.deepEqual(await store.get('b/1'), { bytes: 'AAA', own: true });
    assert.equal(await store.get('missing'), null);
    assert.deepEqual((await store.list('b/')).map((e) => e.key), ['b/1', 'b/2']);
    t += 1001;
    assert.equal(await store.get('b/2'), null);
    assert.deepEqual((await store.list('b/')).map((e) => e.key), ['b/1']);
    await store.put('b/1', { bytes: 'CCC' });
    assert.equal((await store.get('b/1')).bytes, 'CCC');
    assert.equal(await store.delete('b/1'), true);
    assert.equal(await store.delete('b/1'), false);
    assert.deepEqual(await store.list('b/'), []);
    assert.equal((await store.list('')).length, 1);
    await cleanup();
  });
}

suite('memory store', async (now) => ({ store: createMemoryStore({ now }), cleanup: async () => {} }));
suite('file store', async (now) => {
  const dir = await mkdtemp(join(tmpdir(), 'offgrid-store-'));
  return { store: await createFileStore({ dir, now }), cleanup: () => rm(dir, { recursive: true, force: true }) };
});

test('file store survives a reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offgrid-store-'));
  const a = await createFileStore({ dir });
  await a.put('d/x', { until: 5 }, { ttlMs: 60_000 });
  const b = await createFileStore({ dir });
  assert.deepEqual(await b.get('d/x'), { until: 5 });
  await rm(dir, { recursive: true, force: true });
});
