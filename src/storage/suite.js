// One test suite for every store adapter. memory.test.js runs it on the memory
// adapter; mongo.test.js runs it on a real MongoDB when MONGO_URI is set.
// open() -> fresh empty store. reopen(store) -> a second store on the same data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

export function runStoreSuite({ name, open, reopen, cleanup = async () => {} }) {
  const t = (title, fn) => test(`${name}: ${title}`, async () => {
    const store = await open();
    try { await fn(store); } finally { await cleanup(store); await store.close(); }
  });

  t('conditional insert, get, and returned documents are copies', async (s) => {
    const c = s.collection('things');
    assert.equal(c.name, s.prefix + 'things');
    assert.equal(await c.insert({ _id: 'a', n: 1, tags: ['x'] }), true);
    assert.equal(await c.insert({ _id: 'a', n: 2 }), false);
    const doc = await c.get('a');
    assert.deepEqual(doc, { _id: 'a', n: 1, tags: ['x'] });
    doc.n = 99; doc.tags.push('y');
    assert.deepEqual(await c.get('a'), { _id: 'a', n: 1, tags: ['x'] });
    assert.equal(await c.get('missing'), null);
  });

  t('upsert, update with where (compare and set), unset and inc', async (s) => {
    const c = s.collection('things');
    assert.deepEqual(await c.upsert('u', { state: 'new', n: 1 }), { _id: 'u', state: 'new', n: 1 });
    assert.deepEqual(await c.upsert('u', { n: 2 }), { _id: 'u', state: 'new', n: 2 });
    assert.equal(await c.update('u', { where: { state: 'old' }, set: { state: 'done' } }), null);
    const done = await c.update('u', { where: { state: 'new' }, set: { state: 'done' }, unset: ['n'], inc: { count: 5n } });
    assert.deepEqual(done, { _id: 'u', state: 'done', count: 5n });
    assert.equal(await c.update('nope', { set: { a: 1 } }), null);
    assert.equal(await c.cas('u', 'state', 'new', 'x'), false);
    assert.equal(await c.cas('u', 'state', 'done', 'x'), true);
    assert.equal(await c.cas('u', 'other', null, 'set-from-missing'), true);
    assert.equal((await c.get('u')).other, 'set-from-missing');
  });

  t('put replaces the whole document', async (s) => {
    const c = s.collection('things');
    assert.deepEqual(await c.put('p', { a: 1, b: 2 }), { _id: 'p', a: 1, b: 2 });
    assert.deepEqual(await c.put('p', { _id: 'ignored', c: 3 }), { _id: 'p', c: 3 });
    assert.deepEqual(await c.get('p'), { _id: 'p', c: 3 });
    await assert.rejects(c.put('p', { 'x.y': 1 }));
  });

  t('incr keeps BigInt precision and refuses to go below the floor', async (s) => {
    const c = s.collection('balances');
    let r = await c.incr('a', 'v', 10n);
    assert.deepEqual(r, { ok: true, value: 10n });
    r = await c.incr('a', 'v', -11n);
    assert.equal(r.ok, false);
    assert.equal((await c.get('a')).v, 10n);
    r = await c.incr('a', 'v', -10);
    assert.deepEqual(r, { ok: true, value: 0n });
    assert.equal((await c.incr('missing', 'v', -1n)).ok, false);
    assert.equal(await c.get('missing'), null);
    assert.equal((await c.incr('a', 'v', -3n, { floor: null })).value, -3n);
    assert.equal((await c.incr('new', 'v', 1n, { upsert: false })).ok, false);
    const big = 2n ** 62n;
    assert.equal((await c.incr('big', 'v', big)).value, big);
    assert.equal((await c.get('big')).v, big);
    await assert.rejects(c.incr('big', 'v', big * 2n), (e) => e.code === 'OVERFLOW');
    r = await c.incr('a', 'v', 5n, { where: { locked: { $ne: true } }, set: { touched: true } });
    assert.equal(r.ok, true);
    await c.update('a', { set: { locked: true } });
    assert.equal((await c.incr('a', 'v', 5n, { where: { locked: { $ne: true } } })).ok, false);
  });

  t('find with operators, sort, skip and limit; count; delete; deleteMany', async (s) => {
    const c = s.collection('rows');
    for (let i = 0; i < 6; i++) await c.insert({ _id: 'r' + i, i, big: BigInt(i) * 10n, role: i % 2 ? 'odd' : 'even', roles: i % 3 === 0 ? ['relay', 'exit'] : ['gateway'], meta: { lvl: i } });
    assert.deepEqual((await c.find({ role: 'odd' }, { sort: { i: -1 } })).map((d) => d.i), [5, 3, 1]);
    assert.deepEqual((await c.find({ i: { $gte: 2, $lt: 5 } }, { sort: { i: 1 } })).map((d) => d.i), [2, 3, 4]);
    assert.deepEqual((await c.find({ big: { $gt: 25 } }, { sort: { i: 1 } })).map((d) => d.i), [3, 4, 5]);
    assert.deepEqual((await c.find({ roles: 'exit' }, { sort: { i: 1 } })).map((d) => d.i), [0, 3]);
    assert.deepEqual((await c.find({ i: { $in: [1, 4, 9] } }, { sort: { i: 1 } })).map((d) => d.i), [1, 4]);
    assert.deepEqual((await c.find({ i: { $nin: [0, 1, 2] } }, { sort: { i: 1 } })).map((d) => d.i), [3, 4, 5]);
    assert.deepEqual((await c.find({ 'meta.lvl': 2 })).map((d) => d.i), [2]);
    assert.deepEqual((await c.find({}, { sort: { i: 1 }, skip: 1, limit: 2 })).map((d) => d.i), [1, 2]);
    assert.equal(await c.count({ role: 'even' }), 3);
    assert.equal(await c.count({ nothere: { $exists: true } }), 0);
    assert.equal(await c.delete('r0', { role: 'odd' }), false);
    assert.equal(await c.delete('r0'), true);
    assert.equal(await c.delete('r0'), false);
    assert.equal(await c.deleteMany({ role: 'odd' }), 3);
    assert.equal(await c.count({}), 2);
  });

  t('unique index refuses a second document with the same value', async (s) => {
    const c = s.collection('hosts');
    await c.ensureIndex('hostport', { unique: true });
    assert.equal(await c.insert({ _id: 'a', hostport: 'h:1' }), true);
    assert.equal(await c.insert({ _id: 'b', hostport: 'h:1' }), false);
    assert.equal(await c.insert({ _id: 'c' }), true);
    assert.equal(await c.insert({ _id: 'd' }), true);
  });

  t('bad names, fields, values and filters are refused', async (s) => {
    assert.throws(() => s.collection('Bad-Name'));
    assert.throws(() => s.collection('../x'));
    const c = s.collection('things');
    await assert.rejects(c.insert({ _id: 'x', $where: 1 }));
    await assert.rejects(c.insert({ _id: 'x', 'a.b': 1 }));
    await assert.rejects(c.insert({ _id: 'x', a: { $gt: 1 } }));
    await assert.rejects(c.insert({ _id: '', a: 1 }));
    await assert.rejects(c.upsert('x', { a: undefined }));
    await assert.rejects(c.find({ $where: 'sleep(1)' }));
    await assert.rejects(c.find({ a: { $regex: '.*' } }));
    await assert.rejects(c.update('x', { set: { _id: 'y' } }));
  });

  t('keys and keys_backup (and pay_keys) are insert only', async (s) => {
    for (const n of ['keys', 'keys_backup', 'pay_keys', 'pay_keys_backup']) {
      const c = s.collection(n);
      assert.equal(await c.insert({ _id: 'k', secret: 's1' }), true);
      assert.equal(await c.insert({ _id: 'k', secret: 's2' }), false);
      await assert.rejects(c.upsert('k', { secret: 's2' }), (e) => e.code === 'INSERT_ONLY');
      await assert.rejects(c.put('k', { secret: 's2' }), (e) => e.code === 'INSERT_ONLY');
      await assert.rejects(c.update('k', { set: { secret: 's2' } }), (e) => e.code === 'INSERT_ONLY');
      await assert.rejects(c.cas('k', 'secret', 's1', 's2'), (e) => e.code === 'INSERT_ONLY');
      await assert.rejects(c.incr('k', 'n', 1n), (e) => e.code === 'INSERT_ONLY');
      await assert.rejects(c.delete('k'), (e) => e.code === 'INSERT_ONLY');
      await assert.rejects(c.deleteMany({}), (e) => e.code === 'INSERT_ONLY');
      assert.equal((await c.get('k')).secret, 's1');
    }
  });

  t('transaction commits every write together', async (s) => {
    const c = s.collection('acct');
    await c.incr('a', 'bal', 100n);
    const out = await s.transaction(async (tx) => {
      assert.equal(s.inTransaction(), true);
      const r = await tx.collection('acct').incr('a', 'bal', -40n);
      assert.equal(r.ok, true);
      await tx.collection('acct').incr('b', 'bal', 40n);
      await tx.collection('log').insert({ _id: 't1', amount: 40n });
      return 'done';
    });
    assert.equal(out, 'done');
    assert.equal(s.inTransaction(), false);
    assert.equal((await c.get('a')).bal, 60n);
    assert.equal((await c.get('b')).bal, 40n);
    assert.ok(await s.collection('log').get('t1'));
  });

  t('transaction that throws leaves nothing behind', async (s) => {
    const c = s.collection('acct');
    await c.incr('a', 'bal', 100n);
    await c.insert({ _id: 'gone', x: 1 });
    await assert.rejects(s.transaction(async () => {
      await c.incr('a', 'bal', -30n);
      await c.incr('b', 'bal', 30n);
      await c.insert({ _id: 'new', x: 1 });
      await c.update('a', { set: { note: 'changed' } });
      await c.delete('gone');
      await s.transaction(async () => { await c.incr('a', 'bal', -1n); }); // nested joins the outer unit
      throw new Error('boom');
    }), /boom/);
    assert.deepEqual(await c.get('a'), { _id: 'a', bal: 100n });
    assert.equal(await c.get('b'), null);
    assert.equal(await c.get('new'), null);
    assert.deepEqual(await c.get('gone'), { _id: 'gone', x: 1 });
  });

  t('a reader outside a transaction never sees a write that is rolled back', async (s) => {
    const c = s.collection('acct');
    let release;
    const gate = new Promise((r) => { release = r; });
    let wrote;
    const written = new Promise((r) => { wrote = r; });
    const tx = s.transaction(async () => {
      await c.upsert('x', { v: 'uncommitted' });
      wrote();
      await gate;
      throw new Error('abort');
    }).catch(() => 'aborted');
    await written;
    const read = c.get('x');
    release();
    assert.equal(await tx, 'aborted');
    assert.equal(await read, null);
    assert.equal(await c.get('x'), null);
  });

  t('concurrent increments are never lost', async (s) => {
    const c = s.collection('ctr');
    await Promise.all(Array.from({ length: 200 }, () => c.incr('n', 'v', 1n)));
    assert.equal((await c.get('n')).v, 200n);
  });

  t('concurrent decrements with a floor spend exactly the balance', async (s) => {
    const c = s.collection('ctr');
    await c.incr('bal', 'v', 50n);
    const results = await Promise.all(Array.from({ length: 120 }, () => c.incr('bal', 'v', -1n)));
    assert.equal(results.filter((r) => r.ok).length, 50);
    assert.equal((await c.get('bal')).v, 0n);
  });

  t('concurrent conditional inserts: exactly one wins', async (s) => {
    const c = s.collection('once');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => c.insert({ _id: 'tx-sig', by: i })));
    assert.equal(results.filter(Boolean).length, 1);
  });

  t('concurrent compare and set: exactly one wins', async (s) => {
    const c = s.collection('once');
    await c.insert({ _id: 'claim', state: 'open' });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => c.update('claim', { where: { state: 'open' }, set: { state: 'taken', by: i } })));
    assert.equal(results.filter(Boolean).length, 1);
  });

  t('concurrent transfer transactions conserve money and never overdraw', async (s) => {
    const c = s.collection('acct');
    await c.incr('a', 'bal', 60n);
    const transfer = () => s.transaction(async () => {
      const r = await c.incr('a', 'bal', -1n);
      if (!r.ok) throw new Error('insufficient');
      await c.incr('b', 'bal', 1n);
      return true;
    }).catch((e) => { if (e.message === 'insufficient') return false; throw e; });
    const results = await Promise.all(Array.from({ length: 80 }, transfer));
    assert.equal(results.filter(Boolean).length, 60);
    assert.equal((await c.get('a')).bal, 0n);
    assert.equal((await c.get('b')).bal, 60n);
  });

  if (reopen) {
    t('data is still there after a restart', async (s) => {
      await s.collection('things').insert({ _id: 'p', v: 7n });
      const again = await reopen(s);
      try { assert.deepEqual(await again.collection('things').get('p'), { _id: 'p', v: 7n }); } finally { if (again !== s) await again.close(); }
    });
  }

  t('a closed store refuses work', async (s) => {
    const c = s.collection('things');
    await s.close();
    await assert.rejects(c.get('a'), (e) => e.code === 'CLOSED');
    await assert.rejects(s.transaction(async () => {}), (e) => e.code === 'CLOSED');
  });
}
