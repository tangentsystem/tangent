// The off grid tip sweep's exactly once logic, with a fake Rings adapter and a fake chain.
// With MONGO_URI set in the test environment (a replica set) every test runs on MongoDB instead, in database
// tangent_test under a random prefix whose collections are dropped at the end.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createMemoryStore as memoryStore, createStore } from '../storage/index.js';
import { createIdentity } from '../core/index.js';
import { createTipSweeper, SWEEP_DEFAULTS } from './tip-sweep.js';

const MONGO = (process.env.MONGO_URI || '').trim();
const opened = [];
async function createMemoryStore() {
  if (!MONGO) return memoryStore();
  const s = await createStore({ mongoUri: MONGO, mongoDb: 'tangent_test', storePrefix: 'w' + randomBytes(4).toString('hex') + '_', mongoSelectTimeoutMs: 8000 });
  opened.push(s);
  return s;
}
after(async () => {
  if (!opened.length) return;
  const c = new MongoClient(MONGO);
  try {
    const db = c.db('tangent_test');
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name);
    for (const s of opened) { for (const n of names) if (n.startsWith(s.prefix)) await db.collection(n).drop().catch(() => {}); await s.close().catch(() => {}); }
  } finally { await c.close(); }
});

const TIP_SEED = Buffer.alloc(32, 4);
const TIP = createIdentity(TIP_SEED).id;
const VAULT = createIdentity(Buffer.alloc(32, 9)).id;
const RENT0 = 650_240n;
const RESERVE = SWEEP_DEFAULTS.feeReserveLamports;

// A chain that holds the tip account's lamports, and a Rings adapter whose deposits move them, with
// fault injection at each step (before anything is sent, after the broadcast, permanent refusal).
function world({ tipLamports = RENT0 } = {}) {
  const w = { tip: tipLamports, vault: 0n, deposits: [], ready: true, fault: null, records: new Map(), calls: 0 };
  w.connection = {
    async getBalance(pk) { assert.equal(pk.toBase58(), TIP); return Number(w.tip); },
    async getMinimumBalanceForRentExemption(n) { assert.equal(n, 0); return Number(RENT0); },
  };
  w.rings = {
    mode: 'sim',
    vaultAddress: () => VAULT,
    ensureReady: async () => (w.ready ? { status: 'ready' } : { status: 'needs_funding' }),
    // models the real adapter's contract: record before broadcast, settle by key, permanent = nothing sent
    async depositFrom({ fromSeed, amount, memo, idempotencyKey }) {
      w.calls += 1;
      assert.equal(createIdentity(Uint8Array.from(fromSeed)).id, TIP, 'only the tip key ever signs');
      assert.equal(memo, 'tangent:tipsweep');
      const rec = w.records.get(idempotencyKey);
      if (rec && rec.landed) return { signature: rec.signature, slot: 1 };
      const f = w.fault; w.fault = null;
      if (f === 'before') throw Object.assign(new Error('rpc down before build'), { code: 'X' });
      if (f === 'permanent') throw Object.assign(new Error('refused'), { code: 'DEPOSIT_REFUSED', permanent: true });
      const signature = `sig-${idempotencyKey}-${w.calls}`;
      w.records.set(idempotencyKey, { signature, landed: true });
      const v = BigInt(amount);
      w.tip -= v + 5_000n; w.vault += v;
      w.deposits.push({ key: idempotencyKey, amount: v, to: VAULT });
      if (f === 'after') throw Object.assign(new Error('broadcast but not confirmed'), { code: 'SEND_UNCONFIRMED' });
      return { signature, slot: 1 };
    },
  };
  return w;
}

async function sweeper(w, store, extra = {}) {
  return createTipSweeper({ store, rings: w.rings, tipSeed: TIP_SEED, tipAddress: TIP, vaultAddress: VAULT, connection: w.connection, gateOpen: () => true, minLamports: 1_000_000n, ...extra });
}

test('tip sweep: nothing happens without Rings, with the gate closed, while Rings is not ready, or below the threshold', async () => {
  const store = await createMemoryStore();
  const w = world({ tipLamports: RENT0 + 50_000_000n });
  assert.deepEqual(await (await sweeper(w, store, { rings: null })).tick(), { status: 'skipped', reason: 'rings_not_configured' });
  assert.equal((await (await sweeper(w, store, { gateOpen: () => false })).tick()).reason, 'selftest_gate_closed');
  w.ready = false;
  assert.equal((await (await sweeper(w, store)).tick()).reason, 'rings_not_ready');
  w.ready = true;
  const small = world({ tipLamports: RENT0 + RESERVE + 999_999n });
  const r = await (await sweeper(small, store)).tick();
  assert.equal(r.reason, 'below_threshold');
  assert.equal(r.sweepable, '999999');
  assert.equal(w.calls + small.calls, 0, 'no deposit attempted');
  assert.deepEqual(await (await sweeper(w, store)).history(), [], 'nothing recorded');
});

test('tip sweep: moves everything above rent + fee reserve, into the vault only, then waits for the next batch', async () => {
  const store = await createMemoryStore();
  const w = world({ tipLamports: RENT0 + RESERVE + 20_000_000n });
  const s = await sweeper(w, store);
  const r = await s.tick();
  assert.equal(r.status, 'sent');
  assert.equal(r.lamports, '20000000');
  assert.deepEqual(w.deposits, [{ key: 'sweep:1', amount: 20_000_000n, to: VAULT }]);
  assert.equal(w.tip, RENT0 + RESERVE - 5_000n, 'the tip account keeps its rent exempt minimum');
  assert.ok(w.tip >= RENT0);
  const h = await s.history();
  assert.equal(h[0].status, 'sent');
  assert.equal(h[0].from, TIP);
  assert.equal(h[0].to, VAULT);
  assert.equal((await s.tick()).reason, 'below_threshold');
  w.tip += 3_000_000n; // more tips land
  assert.equal((await s.tick()).status, 'sent');
  assert.deepEqual(w.deposits.map((d) => d.key), ['sweep:1', 'sweep:2']);
});

test('tip sweep: a failure before anything was sent is retried with the same id and the same amount', async () => {
  const store = await createMemoryStore();
  const w = world({ tipLamports: RENT0 + RESERVE + 4_000_000n });
  w.fault = 'before';
  const s = await sweeper(w, store);
  assert.equal((await s.tick()).status, 'pending');
  assert.equal(w.deposits.length, 0);
  w.tip += 9_000_000n; // the balance grew meanwhile: the recorded sweep still moves what it recorded
  const r = await (await sweeper(w, store)).tick(); // a restart
  assert.equal(r.status, 'sent');
  assert.equal(r.sweep, 'sweep:1');
  assert.deepEqual(w.deposits, [{ key: 'sweep:1', amount: 4_000_000n, to: VAULT }]);
});

test('tip sweep: sent but not confirmed, then a crash: the next pass settles it and never pays twice', async () => {
  const store = await createMemoryStore();
  const w = world({ tipLamports: RENT0 + RESERVE + 4_000_000n });
  w.fault = 'after';
  assert.equal((await (await sweeper(w, store)).tick()).status, 'pending');
  assert.equal(w.deposits.length, 1);
  const r = await (await sweeper(w, store)).tick();
  assert.equal(r.status, 'sent');
  assert.equal(w.deposits.length, 1, 'exactly once');
  assert.equal(w.vault, 4_000_000n);
});

test('tip sweep: two sweepers on one database at once start one sweep', async () => {
  const store = await createMemoryStore();
  const w = world({ tipLamports: RENT0 + RESERVE + 8_000_000n });
  const [a, b] = [await sweeper(w, store), await sweeper(w, store)];
  const rs = await Promise.all([a.tick(), b.tick(), a.tick()]);
  assert.equal(w.deposits.length, 1, JSON.stringify(rs));
  assert.equal(w.vault, 8_000_000n);
});

test('tip sweep: a permanent refusal marks the sweep failed (nothing was sent) and frees the next one', async () => {
  const store = await createMemoryStore();
  const w = world({ tipLamports: RENT0 + RESERVE + 2_000_000n });
  w.fault = 'permanent';
  const s = await sweeper(w, store);
  assert.equal((await s.tick()).status, 'failed');
  assert.equal(w.deposits.length, 0);
  assert.equal((await s.tick()).sweep, 'sweep:2');
  assert.equal(w.deposits.length, 1);
  const h = await s.history();
  assert.deepEqual(h.map((d) => [d._id, d.status]).sort(), [['sweep:1', 'failed'], ['sweep:2', 'sent']]);
});

test('tip sweep: refuses unless both ends are the service\'s own wallets', async () => {
  const store = await createMemoryStore();
  const w = world({ tipLamports: RENT0 + RESERVE + 2_000_000n });
  const other = createIdentity(Buffer.alloc(32, 1)).id;
  assert.equal((await (await sweeper(w, store, { tipAddress: other })).tick()).status, 'refused');
  assert.equal((await (await sweeper(w, store, { vaultAddress: other })).tick()).status, 'refused');
  assert.equal((await (await sweeper(w, store, { tipSeed: Buffer.alloc(32, 7) })).tick()).status, 'refused');
  assert.equal(w.calls, 0);
});
