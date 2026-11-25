// The pay module's real money flow, run on this service's store through createPayStore.
import test, { after } from 'node:test';
import { MongoClient } from 'mongodb';
import assert from 'node:assert/strict';
import { createMemoryStore, createStore } from './index.js';
import { createPayStore } from './pay-store.js';
import { kvFromStore } from '../pay/index.js';
import { makePay, fund, buyTokens, redeemInto, createIdentity } from '../pay/testkit.js';
import { signVoucher, b58 } from '../core/index.js';
import { randomBytes } from 'node:crypto';

// Every test runs on the memory store, and again on a real MongoDB when MONGO_URI is set in the
// test environment (a replica set, so real transactions are used). The Mongo runs use the
// database "tangent_test" with a random collection prefix and drop only those collections.
const MONGO_URI = (process.env.MONGO_URI || '').trim();
const opened = [];
async function openBase(kind) {
  if (kind === 'memory') return createMemoryStore();
  const prefix = 'p' + randomBytes(4).toString('hex') + '_';
  const s = await createStore({ mongoUri: MONGO_URI, mongoDb: 'tangent_test', storePrefix: prefix, mongoSelectTimeoutMs: 8000 });
  opened.push(s);
  return s;
}
after(async () => {
  if (!opened.length) return;
  const client = new MongoClient(MONGO_URI);
  try {
    const db = client.db('tangent_test');
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    for (const s of opened) {
      for (const n of names) if (n.startsWith(s.prefix)) await db.collection(n).drop().catch(() => {});
      await s.close().catch(() => {});
    }
  } finally { await client.close(); }
});

let KIND = 'memory';
async function setup() {
  const base = await openBase(KIND);
  const store = createPayStore(base);
  return { base, store, ...makePay({ store }) };
}

const cases = [];
const t = (name, fn) => cases.push([name, fn]);

t('pay store: collection names map into the prefix, anything else is refused', async () => {
  const { base, store } = await setup();
  await store.tx(async (t) => { await t.put('tangent_pay_wallets', 'w1', { balance: '5' }); });
  assert.deepEqual(await store.get('tangent_pay_wallets', 'w1'), { _id: 'w1', balance: '5' });
  assert.deepEqual(await base.collection('pay_wallets').get('w1'), { _id: 'w1', balance: '5' });
  assert.throws(() => store.get('other_project_users', 'x'));
  assert.throws(() => store.get('tangent_nodes', 'x'));
  await assert.rejects(store.tx(async (t) => { await t.get('users', 'x'); }));
});

t('pay store: t.insert throws DUPLICATE, a failed unit writes nothing, unawaited puts still land', async () => {
  const { store } = await setup();
  await store.tx(async (t) => { await t.insert('tangent_pay_tips', 'a', { n: 1 }); });
  await assert.rejects(store.tx(async (t) => { await t.put('tangent_pay_tips', 'b', { n: 2 }); await t.insert('tangent_pay_tips', 'a', { n: 3 }); }), (e) => e.code === 'DUPLICATE');
  assert.equal(await store.get('tangent_pay_tips', 'b'), null);
  assert.equal((await store.get('tangent_pay_tips', 'a')).n, 1);
  const kv = kvFromStore(store); // calls t.put without await
  await kv.kvSet('ns', 'k', { sent: true });
  assert.deepEqual(await kv.kvGet('ns', 'k'), { sent: true });
});

t('pay store: keys are insert only with a backup row', async () => {
  const { base, store } = await setup();
  assert.deepEqual(await store.keys.insert({ label: 'blind:1:0', kind: 'rsa', publicKey: 'P', secret: 'S', meta: { e: 1 } }), { inserted: true });
  assert.deepEqual(await store.keys.insert({ label: 'blind:1:0', kind: 'rsa', publicKey: 'P', secret: 'S' }), { inserted: false });
  await assert.rejects(store.keys.insert({ label: 'blind:1:0', kind: 'rsa', publicKey: 'P2', secret: 'S2' }), (e) => e.code === 'KEY_EXISTS');
  assert.equal((await store.keys.get('blind:1:0')).secret, 'S');
  assert.equal((await base.collection('pay_keys_backup').get('blind:1:0:P')).secret, 'S');
  await store.keys.insert({ label: 'blind:2:0', publicKey: 'Q', secret: 'T' });
  assert.deepEqual((await store.keys.list('blind:')).map((r) => r.label), ['blind:1:0', 'blind:2:0']);
  await assert.rejects(base.collection('pay_keys').put('blind:1:0', { secret: 'x' }), (e) => e.code === 'INSERT_ONLY');
});

t('pay store: the real pay flow (deposit, blind tokens, voucher, tip) balances on this store', async () => {
  const ctx = await setup();
  const wallet = createIdentity();
  await fund(ctx, wallet, 50_000_000n);
  const { tokens } = await buyTokens(ctx.pay, wallet, '10000000', 2);
  const { account } = await redeemInto(ctx.pay, tokens[0]);
  const node = createIdentity();
  const gw = createIdentity();
  ctx.nodes.add(node.id);
  ctx.nodes.add(gw.id);
  const v = signVoucher(account, { session: 's1', node: node.id, kind: 'relay', cumulative: 4_000_000, seq: 1, expires: ctx.now() + 60_000 });
  const r = await ctx.pay.redeemVoucher(v, { node: node.id });
  assert.equal(r.ok, true);
  const again = await ctx.pay.redeemVoucher(v, { node: node.id });
  assert.ok(!again.credited || again.credited === '0');
  const sig = b58(randomBytes(64));
  const tips = await Promise.all([1, 2, 3].map(() => ctx.pay.creditTip({ id: sig, lamports: '30000', gateway: gw.id, carriers: [node.id] })));
  assert.equal(tips.filter((x) => x.duplicate === false).length, 1);
  assert.equal((await ctx.pay.earnings(gw.id)).earned, '15000');
  const totals = await ctx.pay.totals();
  assert.equal(totals.balanced, true, JSON.stringify(totals));
});

for (const kind of ['memory', 'mongo']) {
  for (const [name, fn] of cases) {
    const skip = kind === 'mongo' && !MONGO_URI ? 'MONGO_URI is not set in the test environment' : false;
    test(`${kind}: ${name}`, { skip }, async () => { KIND = kind; await fn(); });
  }
}
