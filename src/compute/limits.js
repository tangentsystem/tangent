// Small in memory helpers: fixed window rate limiter and the machine inbox.
import { randomBytes } from 'node:crypto';

export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    take(key, now = Date.now()) {
      let h = hits.get(key);
      if (!h || now - h.start >= windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
      if (hits.size > 50_000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      if (h.n >= limit) return { ok: false, retryAfterMs: windowMs - (now - h.start) };
      h.n++; return { ok: true };
    },
  };
}

// Inbox: newest messages kept up to maxMessages; reading uses an increasing cursor.
export function createInbox({ maxMessages = 200 } = {}) {
  const items = [];
  let seq = 0;
  return {
    push({ from, subject, body, contentType }) {
      seq++;
      items.push({ id: seq, ref: randomBytes(6).toString('hex'), receivedAt: Date.now(), from: from ?? null, subject: subject ?? null, contentType, body });
      while (items.length > maxMessages) items.shift();
      return seq;
    },
    read({ after = 0, limit = 50 } = {}) {
      const out = items.filter((m) => m.id > after).slice(0, limit);
      return { messages: out, cursor: out.length ? out[out.length - 1].id : after, total: items.length };
    },
    size() { return items.length; },
    clear() { items.length = 0; },
  };
}
