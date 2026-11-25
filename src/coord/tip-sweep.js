// Off grid tip sweep: the service moves the tips that land in
// the network tip account into the Privacy Rings vault by itself, so node earnings from tips are paid out of
// the vault like every other payout. No setting is needed.
//
// Rules:
//   - Only between wallets this service created: from the tip account (key "tip") into the private balance of
//     the vault (key "rings"), as a Rings deposit signed by the tip key. Both addresses are checked against the
//     service's own keys before anything is built, and the Rings adapter checks the built message before it
//     signs (tip account = fee payer and only signer, only the Rings pool and System programs).
//   - Nothing happens until Rings is configured and ready AND the self test gate is open.
//   - The tip account keeps its rent exempt minimum plus a fee reserve; only what is above that moves, and
//     only once it reaches minLamports (batching). At most one sweep is in flight.
//   - Exactly once: each sweep is recorded (tangent_offgrid_sweeps, status pending) BEFORE anything is built
//     or broadcast, under an id that is also the Rings adapter's idempotency key, and the adapter records the
//     signature before its broadcast. A crash anywhere is settled on the next pass with the same id: a sweep
//     that landed is marked sent, one that is still in flight is waited for, and only one that provably did
//     not land is sent again (for exactly the recorded amount). Two passes at once cannot both start a sweep:
//     the in flight marker is claimed inside a store transaction.
//   - In pay, a deposit from the tip account with the sweep memo is recorded and never credited to a wallet
//     (the tips it carries were credited to node earnings when each tip was claimed).
import { tipSweepMemo } from '../pay/rings/memo.js';
import { createIdentity } from '../core/index.js';

export const SWEEP_DEFAULTS = Object.freeze({
  intervalMs: 10 * 60_000,
  minLamports: 10_000_000n, // 0.01 SOL: about a thousand small tips per sweep, so fees stay a rounding error
  feeReserveLamports: 10_000n, // the deposit fee the tip account pays (5,000 lamports, one signature) with room
});

const STATE = 'state';

export function createTipSweeper({
  store, rings, tipSeed, tipAddress, vaultAddress, connection, gateOpen = () => false,
  intervalMs = SWEEP_DEFAULTS.intervalMs, minLamports = SWEEP_DEFAULTS.minLamports, feeReserveLamports = SWEEP_DEFAULTS.feeReserveLamports,
  memoPrefix, log = null, now = Date.now,
} = {}) {
  if (!store || typeof store.collection !== 'function') throw new Error('tip sweep: store is required');
  const coll = store.collection('offgrid_sweeps');
  const memo = tipSweepMemo(memoPrefix || undefined);
  const say = (level, event, fields) => { try { log && log[level] && log[level](event, fields || {}); } catch { /* never stop on logging */ } };
  let busy = null;
  let timer = null;
  let last = null;

  const iso = () => new Date(now()).toISOString();

  // Every address is one of the service's own, or nothing happens.
  function ownWallets() {
    if (!tipSeed || tipSeed.length !== 32) return 'the tip key is not available';
    if (createIdentity(Uint8Array.from(tipSeed)).id !== tipAddress) return 'the tip key does not match the tip account';
    if (!rings || typeof rings.vaultAddress !== 'function' || rings.vaultAddress() !== vaultAddress) return 'the Rings vault is not the service\'s own Rings wallet';
    if (tipAddress === vaultAddress) return 'the tip account and the vault are the same';
    return null;
  }

  async function send(doc) {
    let r;
    try {
      r = await rings.depositFrom({ fromSeed: Uint8Array.from(tipSeed), amount: BigInt(doc.amount), memo, idempotencyKey: doc._id, connection });
    } catch (err) {
      const reason = String((err && (err.message || err.code)) || err).slice(0, 200);
      if (err && err.permanent) {
        // the adapter's contract: a permanent error means nothing was sent for this key
        await store.transaction(async (s) => {
          await s.collection('offgrid_sweeps').update(doc._id, { set: { status: 'failed', reason, endedAt: iso() } });
          await s.collection('offgrid_sweeps').update(STATE, { where: { inflight: doc._id }, set: { inflight: null } });
        });
        say('warn', 'offgrid.sweep_failed', { sweep: doc._id, reason });
        return { status: 'failed', sweep: doc._id, reason };
      }
      await coll.update(doc._id, { set: { lastError: reason, lastTryAt: iso() } });
      say('warn', 'offgrid.sweep_pending', { sweep: doc._id, reason });
      return { status: 'pending', sweep: doc._id, reason };
    }
    await store.transaction(async (s) => {
      await s.collection('offgrid_sweeps').update(doc._id, { set: { status: 'sent', signature: r.signature, slot: r.slot ?? null, endedAt: iso() } });
      await s.collection('offgrid_sweeps').update(STATE, { where: { inflight: doc._id }, set: { inflight: null } });
    });
    say('info', 'offgrid.swept', { sweep: doc._id, lamports: doc.amount, from: tipAddress, to: vaultAddress, signature: r.signature, explorer: `https://solscan.io/tx/${r.signature}` });
    return { status: 'sent', sweep: doc._id, lamports: doc.amount, signature: r.signature };
  }

  async function pass() {
    if (!rings || typeof rings.depositFrom !== 'function') return { status: 'skipped', reason: 'rings_not_configured' };
    if (!connection) return { status: 'skipped', reason: 'no_connection' };
    const notOwn = ownWallets();
    if (notOwn) return { status: 'refused', reason: notOwn };
    if (!gateOpen()) return { status: 'skipped', reason: 'selftest_gate_closed' };
    const ready = await rings.ensureReady();
    if (!ready || ready.status !== 'ready') return { status: 'skipped', reason: 'rings_not_ready' };

    // an earlier sweep that did not finish is settled first, with its own id and amount
    const state = (await coll.get(STATE)) || null;
    if (state && state.inflight) {
      const doc = await coll.get(state.inflight);
      if (doc && doc.status === 'pending') return send(doc);
    }

    // the sweep counter seen BEFORE the balance is read: if another sweep (another instance, for example
    // during a deploy) starts or finishes after this point, the balance below is stale and this pass stops
    const seq0 = (state && Number(state.seq)) || 0;
    const { PublicKey } = await import('@solana/web3.js');
    const balance = BigInt(await connection.getBalance(new PublicKey(tipAddress), 'confirmed'));
    const floor = BigInt(await connection.getMinimumBalanceForRentExemption(0));
    const amount = balance - floor - BigInt(feeReserveLamports);
    if (amount < BigInt(minLamports)) return { status: 'skipped', reason: 'below_threshold', balance: balance.toString(), sweepable: (amount > 0n ? amount : 0n).toString(), minLamports: String(minLamports) };

    // claim the in flight marker and record the sweep BEFORE anything is built or sent
    const doc = await store.transaction(async (s) => {
      const c = s.collection('offgrid_sweeps');
      const st = (await c.get(STATE)) || null;
      if (st && st.inflight) return null;
      const seq = (st && Number(st.seq)) || 0;
      if (seq !== seq0) return null; // found live against MongoDB: a balance read before another sweep ended
      const id = `sweep:${seq + 1}`;
      const d = { _id: id, status: 'pending', amount: amount.toString(), from: tipAddress, to: vaultAddress, tipBalance: balance.toString(), floor: floor.toString(), createdAt: iso() };
      if (!(await c.insert(d))) return null;
      await c.put(STATE, { seq: seq + 1, inflight: id });
      return d;
    });
    if (!doc) return { status: 'busy' };
    say('info', 'offgrid.sweep_recorded', { sweep: doc._id, lamports: doc.amount, from: tipAddress, to: vaultAddress });
    return send(doc);
  }

  async function tick() {
    if (busy) return busy;
    busy = pass().catch((err) => {
      const reason = String((err && err.message) || err).slice(0, 200);
      say('warn', 'offgrid.sweep_error', { reason });
      return { status: 'error', reason };
    }).finally(() => { busy = null; });
    last = await busy;
    return last;
  }

  return {
    tick,
    last: () => last,
    async history({ limit = 50 } = {}) {
      return (await coll.find({}, { sort: { createdAt: -1 }, limit })).filter((d) => d._id !== STATE);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      timer.unref?.();
    },
    async stop() { if (timer) clearInterval(timer); timer = null; if (busy) await busy.catch(() => {}); },
  };
}
