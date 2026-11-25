// Posts this node's off grid tip claims to the coordinator (POST /api/offgrid/claim).
// src/offgrid builds a claim when a landed receipt reaches the gateway or a carrier
// on the trail. The coordinator pays every party on the first valid claim for a
// transaction, so 409 ALREADY_CLAIMED means "done, someone else claimed it".
// Each attempt is re-signed with a fresh timestamp (the coordinator allows 2 minutes).
import { buildClaim } from '../offgrid/index.js';

export function createClaimPoster({ coord, identity, log = () => {}, retryMs = 5000, maxAttempts = 20 } = {}) {
  const queue = new Map(); // bundleId -> { receipt, attempts, nextAt, done }
  const results = new Map(); // bundleId -> { status, body }
  let timer = null;
  let busy = false;

  async function attempt(id, item) {
    item.attempts++;
    try {
      const body = await coord.claim(buildClaim(identity, item.receipt, { ts: Date.now() }));
      results.set(id, { status: 'credited', body });
      queue.delete(id);
      log('info', 'offgrid.claimed', { bundleId: id, tipLamports: body && body.tipLamports });
    } catch (err) {
      const retry = err && (err.transient || err.status === 404 || err.status === 502 || err.code === 'STALE');
      if (err && err.status === 409) {
        results.set(id, { status: 'already claimed' });
        queue.delete(id);
      } else if (!retry || item.attempts >= maxAttempts) {
        results.set(id, { status: 'refused', reason: String(err && err.message).slice(0, 120) });
        queue.delete(id);
        log('warn', 'offgrid.claim_refused', { bundleId: id, reason: String(err && err.message).slice(0, 120) });
      } else {
        item.nextAt = Date.now() + retryMs * Math.min(8, item.attempts);
      }
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      for (const [id, item] of queue) if (item.nextAt <= Date.now()) await attempt(id, item);
    } finally { busy = false; }
  }

  return {
    add(claim) {
      if (!claim || !claim.receipt || !claim.bundleId || queue.has(claim.bundleId) || results.has(claim.bundleId)) return;
      queue.set(claim.bundleId, { receipt: claim.receipt, attempts: 0, nextAt: 0 });
      pump().catch(() => {});
    },
    start() { if (!timer) { timer = setInterval(() => { pump().catch(() => {}); }, 1000); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    pending: () => queue.size,
    results: () => Object.fromEntries(results),
  };
}
