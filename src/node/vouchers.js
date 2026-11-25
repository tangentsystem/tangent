// Voucher book of a node: keeps the newest voucher per session and redeems it at
// the coordinator (POST /api/vouchers/redeem). This is the onVoucher handler that
// relay and compute call after their own checks.
//
//   coordinator accepted in full   -> { ok: true }
//   coordinator refused, or the payer's account covered only part of it
//                                  -> { ok: false, reason } (the service keeps the
//                                     session stalled or paused until a good voucher)
//   coordinator unreachable or busy -> the voucher is kept and retried in the
//                                     background; it is accepted while the total
//                                     not yet settled stays under maxUnsettledLamports,
//                                     refused above that
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

export function createVoucherBook({ coord, log = () => {}, maxUnsettledLamports = 10_000_000n, retryMs = 5000, maxSessions = 20_000 } = {}) {
  if (!coord) throw new Error('vouchers: coord is required');
  const cap = BigInt(maxUnsettledLamports);
  const sessions = new Map(); // key -> { newest, settled: BigInt, chain: Promise, queued: boolean, kind }
  const st = { received: 0, redeemed: 0, refused: 0, queued: 0, creditedLamports: 0n, byKind: { relay: 0n, offgrid: 0n, compute: 0n } };
  let timer = null;

  const keyOf = (v) => `${v.kind}:${v.session}:${v.payer}`;
  function unsettled() {
    let total = 0n;
    for (const s of sessions.values()) if (s.queued) total += big(s.newest.cumulative) - s.settled;
    return total;
  }

  async function redeemNow(s) {
    const v = s.newest;
    const r = await coord.redeem(v);
    const credited = big(r.credited);
    st.creditedLamports += credited;
    if (st.byKind[v.kind] !== undefined) st.byKind[v.kind] += credited;
    if (credited > 0n) st.redeemed++;
    s.settled = s.settled + credited;
    if (r.partial) return { ok: false, reason: 'insufficient funds' };
    s.settled = big(v.cumulative) > s.settled ? big(v.cumulative) : s.settled;
    return { ok: true };
  }

  function onVoucher(v) {
    st.received++;
    const key = keyOf(v);
    let s = sessions.get(key);
    if (!s) {
      if (sessions.size >= maxSessions) {
        for (const [k, x] of sessions) { if (!x.queued) { sessions.delete(k); break; } }
      }
      s = { newest: v, settled: 0n, chain: Promise.resolve(), queued: false, kind: v.kind };
      sessions.set(key, s);
    }
    const run = s.chain.then(async () => {
      if (big(v.cumulative) < big(s.newest.cumulative) || v.seq < s.newest.seq) return { ok: false, reason: 'older than the newest voucher' };
      s.newest = v;
      try {
        const r = await redeemNow(s);
        s.queued = false;
        if (!r.ok) st.refused++;
        return r;
      } catch (err) {
        if (err && err.transient) {
          s.queued = true;
          st.queued++;
          if (unsettled() > cap) { st.refused++; return { ok: false, reason: 'coordinator unreachable' }; }
          log('warn', 'vouchers.queued', { kind: v.kind, reason: String(err.message).slice(0, 120) });
          return { ok: true };
        }
        st.refused++;
        return { ok: false, reason: String((err && err.message) || 'refused').slice(0, 120) };
      }
    });
    s.chain = run.catch(() => {});
    return run;
  }

  async function retryQueued() {
    for (const s of sessions.values()) {
      if (!s.queued) continue;
      s.chain = s.chain.then(async () => {
        if (!s.queued) return;
        try { await redeemNow(s); s.queued = false; } catch (err) {
          if (!(err && err.transient)) { s.queued = false; log('warn', 'vouchers.dropped', { kind: s.kind, reason: String(err && err.message).slice(0, 120) }); }
        }
      }).catch(() => {});
      await s.chain;
    }
  }

  return {
    onVoucher,
    start() { if (!timer) { timer = setInterval(() => { retryQueued().catch(() => {}); }, retryMs); timer.unref?.(); } },
    async stop() { if (timer) clearInterval(timer); timer = null; await retryQueued().catch(() => {}); },
    flush: retryQueued,
    unsettled,
    stats: () => ({
      received: st.received, redeemed: st.redeemed, refused: st.refused, queued: st.queued, sessions: sessions.size,
      creditedLamports: st.creditedLamports.toString(),
      creditedByKind: Object.fromEntries(Object.entries(st.byKind).map(([k, v]) => [k, v.toString()])),
    }),
  };
}
