// Randomized property test: many mixed operations, some concurrent, with injected Rings faults and restarts.
// After every step: deposits + tips == wallet balances + unredeemed issued tokens + anonymous accounts
//   + unpaid node earnings + payouts (pending and sent) + withdrawals (pending and sent) + fees,
// nothing is negative, and the simulated Rings vault holds exactly deposits + tips - everything sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { signVoucher } from '../core/voucher.js';
import { makePay, keyFor, createIdentity, newAccount, fakeNodes, clock } from './testkit.js';
import { prepareTokens, finalizeTokens, issueRequest, redeemRequest, withdrawRequest } from './client.js';
import { createMemoryStore, COLLECTIONS as C } from './store.js';
import { createSimRings } from './rings/sim.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// PAY_PROPERTY_MONGO_URI=<replica set uri> runs the same property test on the service's MongoDB
// store (src/storage/pay-store.js) with real transactions, in database tangent_test under a random
// collection prefix that is dropped at the end.
const MONGO = (process.env.PAY_PROPERTY_MONGO_URI || '').trim();
async function propertyStore() {
  if (!MONGO) return { store: createMemoryStore(), done: async () => {} };
  const { createStore } = await import('../storage/index.js');
  const { createPayStore } = await import('../storage/pay-store.js');
  const { MongoClient } = await import('mongodb');
  const prefix = 'q' + Math.random().toString(36).slice(2, 10) + '_';
  const base = await createStore({ mongoUri: MONGO, mongoDb: 'tangent_test', storePrefix: prefix, mongoSelectTimeoutMs: 8000 });
  return {
    store: createPayStore(base),
    async done() {
      const client = new MongoClient(MONGO);
      try {
        const db = client.db('tangent_test');
        for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) if (c.name.startsWith(prefix)) await db.collection(c.name).drop();
      } finally { await client.close(); await base.close(); }
    },
  };
}

const SEED = Number(process.env.PAY_PROPERTY_SEED || 20261125);
const STEPS = Number(process.env.PAY_PROPERTY_STEPS || 300);

test(`conservation of money over ${STEPS} random operations (seed ${SEED})${MONGO ? ' on MongoDB' : ''}`, async (testCtx) => {
  const rand = rng(SEED);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const ps = await propertyStore();
  testCtx.after(() => ps.done());
  const store = ps.store;
  const rings = createSimRings({});
  const nodes = fakeNodes();
  const now = clock(Date.UTC(2026, 5, 1));
  const config = { payDenominations: ['1000', '10000', '100000'], networkFeeBps: 300, payoutMinLamports: '5000', payoutMaxPerRun: 3, payoutMaxLamportsPerRun: '400000', withdrawMinLamports: '1000', payoutRetryMs: 1000 };
  let ctx = makePay({ store, rings, nodes, now, config });
  const restart = () => {
    ctx = makePay({ store, rings, nodes, now, config });
  };

  const wallets = Array.from({ length: 5 }, () => createIdentity());
  const nodeIds = Array.from({ length: 4 }, () => createIdentity());
  const payoutAddr = new Map();
  nodeIds.forEach((n, i) => {
    const to = createIdentity().id;
    payoutAddr.set(n.id, to);
    nodes.add(n.id, to);
    if (i === 3) rings.sim.setRegistered(to, false); // one node whose payout wallet is not registered (permanent failures)
  });
  const unspent = []; // tokens held by clients
  const spentTokens = [];
  const accounts = []; // identities with funded accounts
  const sessions = []; // { payer, node, cumulative, seq, id, history: [voucher] }
  let tips = 0n;
  let tipN = 0;
  const counts = {};

  const ops = {
    async deposit() {
      const w = pick(wallets);
      const amount = BigInt(int(1, 400_000));
      rings.sim.fund(w.id, 'SOL', amount);
      rings.sim.userSendToVault(w.id, 'SOL', amount);
      if (rand() < 0.7) await ctx.pay.syncDeposits();
    },
    async sync() {
      await Promise.all([ctx.pay.syncDeposits(), ctx.pay.syncDeposits()]);
    },
    async issue() {
      const w = pick(wallets);
      const denom = pick(config.payDenominations);
      const count = int(1, 3);
      const key = await keyFor(ctx.pay, denom);
      const { pending, blinded } = await prepareTokens(key, count);
      const { challenge } = await ctx.pay.challenge(w.id);
      const req = issueRequest(w, { challenge, denomination: denom, blinded });
      try {
        const res = await ctx.pay.issueBlindTokens(req);
        unspent.push(...(await finalizeTokens(key, pending, res.blindSigs)));
        if (rand() < 0.2) await assert.rejects(ctx.pay.issueBlindTokens(req), (e) => e.code === 'CHALLENGE_USED');
      } catch (e) {
        assert.equal(e.code, 'INSUFFICIENT_BALANCE');
      }
    },
    async redeem() {
      if (!unspent.length) return;
      const token = unspent.splice(Math.floor(rand() * unspent.length), 1)[0];
      const into = accounts.length && rand() < 0.5 ? pick(accounts) : newAccount();
      const tries = rand() < 0.3 ? 3 : 1; // sometimes several racing redemptions of the same token
      const res = await Promise.allSettled(Array.from({ length: tries }, (_, i) => ctx.pay.redeemToken(redeemRequest(token, i === 0 ? into : newAccount()))));
      assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
      for (const r of res) if (r.status === 'rejected') assert.equal(r.reason.code, 'TOKEN_SPENT');
      if (!accounts.includes(into) && res[0].status === 'fulfilled') accounts.push(into);
      spentTokens.push(token);
    },
    async replaySpent() {
      if (!spentTokens.length) return;
      await assert.rejects(ctx.pay.redeemToken(redeemRequest(pick(spentTokens), newAccount())), (e) => e.code === 'TOKEN_SPENT');
    },
    async voucher() {
      const live = accounts.filter(Boolean);
      if (!live.length) return;
      let s = sessions.length && rand() < 0.6 ? pick(sessions) : null;
      if (!s) {
        s = { payer: pick(live), node: pick(nodeIds), cumulative: 0n, seq: 0, id: 's' + sessions.length, history: [] };
        sessions.push(s);
      }
      s.cumulative += BigInt(int(0, 60_000));
      s.seq += 1;
      const v = signVoucher(s.payer, { session: s.id, node: s.node.id, kind: 'relay', cumulative: s.cumulative, seq: s.seq, expires: now() + 3600_000 });
      s.history.push(v);
      // the newest plus some older ones, at the same time
      const batch = [v, ...Array.from({ length: int(0, 3) }, () => pick(s.history))];
      const results = await Promise.all(batch.map((x) => ctx.pay.redeemVoucher(x)));
      for (const r of results) assert.ok(BigInt(r.credited) >= 0n);
      const doc = await store.get(C.vouchers, (await import('./util.js')).sha256Hex(JSON.stringify([s.id, s.payer.id, s.node.id])));
      if (doc) assert.ok(BigInt(doc.paid) <= s.cumulative, 'never more than the newest signed amount');
    },
    async tip() {
      const gw = pick(nodeIds);
      const lamports = BigInt(int(1, 50_000));
      const id = 'tip'.padEnd(20, String(tipN++)) + tipN;
      const r = await ctx.pay.creditTip({ id, lamports, gateway: gw.id, carriers: nodeIds.filter(() => rand() < 0.5).map((n) => n.id) });
      if (!r.duplicate) {
        tips += lamports;
        rings.sim.fund(rings.vaultAddress(), 'SOL', lamports); // the tip money reaches the vault
      }
      await ctx.pay.creditTip({ id, lamports, gateway: gw.id }); // duplicate, no effect
    },
    async payouts() {
      const f = rand();
      if (f < 0.15) rings.sim.crashAfterNextSend();
      else if (f < 0.25) rings.sim.failNextSend();
      await ctx.pay.runPayouts();
    },
    async withdraw() {
      const w = pick(wallets);
      const bal = BigInt((await ctx.pay.balance(w.id)).balance);
      if (bal < 1000n) return;
      const amount = BigInt(int(1000, Number(bal < 300_000n ? bal : 300_000n)));
      const { challenge } = await ctx.pay.challenge(w.id);
      const to = rand() < 0.1 ? payoutAddr.get(nodeIds[3].id) : createIdentity().id; // sometimes an unregistered wallet
      await ctx.pay.withdraw(withdrawRequest(w, { challenge, to, amount: amount.toString(), public: rand() < 0.3 }));
      const f = rand();
      if (f < 0.15) rings.sim.crashAfterNextSend();
      if (rand() < 0.6) await ctx.pay.processWithdrawals();
    },
    async restart() {
      restart();
    },
    async time() {
      now.advance(int(1, 5000));
    },
  };
  const weights = [['deposit', 14], ['sync', 3], ['issue', 12], ['redeem', 12], ['replaySpent', 2], ['voucher', 20], ['tip', 5], ['payouts', 8], ['withdraw', 7], ['restart', 2], ['time', 5]];
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const choose = () => {
    let x = rand() * total;
    for (const [name, w] of weights) {
      if ((x -= w) < 0) return name;
    }
    return 'time';
  };

  async function check(step, name) {
    const t = await ctx.pay.totals();
    for (const [k, v] of Object.entries(t)) if (k !== 'balanced') assert.ok(BigInt(v) >= 0n, `${k} negative at step ${step} (${name})`);
    assert.equal(BigInt(t.tips), tips);
    assert.equal(t.balanced, true, `money not conserved at step ${step} (${name}): ${JSON.stringify(t)}`);
    for (const coll of [C.wallets, C.accounts]) for (const d of await store.find(coll, {})) assert.ok(BigInt(d.balance) >= 0n);
    for (const e of await store.find(C.earnings, {})) assert.ok(BigInt(e.balance) >= 0n && BigInt(e.pending) >= 0n);
    // what Rings actually paid matches what the store says was sent, and nothing was paid twice
    const sent = BigInt(t.payoutsSent) + BigInt(t.withdrawalsSent);
    const outPrivate = rings.sim.outgoing().reduce((a, o) => a + o.amount, 0n);
    const outPublic = rings.sim.publicWithdrawals().reduce((a, o) => a + o.amount, 0n);
    const pendingSent = outPrivate + outPublic - sent; // landed but not yet recorded (crash after send)
    assert.ok(pendingSent >= 0n, 'store says more was sent than Rings paid');
    assert.ok(pendingSent <= BigInt(t.payoutsPending) + BigInt(t.withdrawalsPending), 'Rings paid something the store does not know about');
    // the vault holds exactly what came in minus what went out
    assert.equal(await rings.vaultBalance('SOL'), BigInt(t.deposits) + tips - outPrivate - outPublic + unsyncedDeposits());
  }
  let synced = 0n;
  const unsyncedDeposits = () => rings.sim.incoming().reduce((a, i) => a + i.amount, 0n) - synced;

  for (let step = 0; step < STEPS; step += 1) {
    const name = choose();
    counts[name] = (counts[name] || 0) + 1;
    await ops[name]();
    synced = BigInt((await ctx.pay.totals()).deposits);
    await check(step, name);
  }
  // drain: sync everything, settle every pending send, and the books still close
  await ctx.pay.syncDeposits();
  synced = BigInt((await ctx.pay.totals()).deposits);
  for (let i = 0; i < 5; i += 1) {
    await ctx.pay.processWithdrawals();
    await ctx.pay.runPayouts();
    now.advance(2000);
  }
  await check(STEPS, 'drain');
  const t = await ctx.pay.totals();
  assert.equal(t.payoutsPending, '0');
  assert.equal(t.withdrawalsPending, '0');
  assert.ok(BigInt(t.payoutsSent) > 0n && BigInt(t.accounts) >= 0n && Number(counts.voucher) > 10, JSON.stringify({ t, counts }));
});
