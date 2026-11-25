// In-memory fixed window rate limiter keyed by client address. One instance per
// bucket (general api, registration, heartbeat, redeem, claim) so the limits
// are independent. Memory is bounded: expired entries are swept every window and
// the map is cleared if an address flood pushes it past maxKeys.
export function createRateLimiter({ windowMs = 60_000, max = 300, maxKeys = 50_000, now = Date.now, code = 'RATE_LIMITED' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = now();

  function sweep(t) {
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    lastSweep = t;
  }

  // -> { ok, remaining, retryAfterSec }
  function take(key) {
    const t = now();
    if (t - lastSweep >= windowMs || hits.size > maxKeys) sweep(t);
    if (hits.size > maxKeys) hits.clear();
    let e = hits.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + windowMs };
      hits.set(key, e);
    }
    e.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((e.resetAt - t) / 1000));
    if (e.count > max) return { ok: false, remaining: 0, retryAfterSec };
    return { ok: true, remaining: max - e.count, retryAfterSec };
  }

  function middleware(req, res, next) {
    const r = take(req.ip || 'unknown');
    res.setHeader('RateLimit-Remaining', String(r.remaining));
    if (r.ok) return next();
    res.setHeader('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: code, message: 'too many requests, slow down' });
  }

  return { take, middleware, size: () => hits.size, reset: () => hits.clear() };
}
