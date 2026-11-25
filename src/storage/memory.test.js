import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createMemoryStore, createMemoryBacking } from './index.js';
import { runStoreSuite } from './suite.js';

runStoreSuite({
  name: 'memory',
  open: () => createStore({}),
  reopen: (s) => createMemoryStore({ prefix: s.prefix, backing: s._backing }),
});

test('memory: createStore picks memory without a mongoUri and only creates prefixed collections', async () => {
  const s = await createStore({ storePrefix: 'abc_' });
  assert.equal(s.kind, 'memory');
  assert.equal(s.capabilities.transactions, true);
  await s.collection('one').insert({ _id: 'a' });
  await s.collection('two').incr('b', 'n', 1n);
  for (const n of s._backing.names()) assert.ok(n.startsWith('abc_'), n);
  assert.deepEqual(s._backing.names().sort(), ['abc_one', 'abc_two']);
  await s.close();
});

test('memory: a bad prefix is refused', async () => {
  await assert.rejects(createMemoryStore({ prefix: 'Bad Prefix' }));
  await assert.rejects(createMemoryStore({ prefix: '' }));
});

test('memory: two stores do not share data unless they share a backing', async () => {
  const backing = createMemoryBacking();
  const a = await createMemoryStore({ backing });
  const b = await createMemoryStore({ backing });
  const c = await createMemoryStore({});
  await a.collection('x').insert({ _id: 'k', v: 1 });
  assert.equal((await b.collection('x').get('k')).v, 1);
  assert.equal(await c.collection('x').get('k'), null);
});
