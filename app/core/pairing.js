// Pairing for the control API (app/CONTROL-API.md). A browser extension asks to pair, the
// person allows or denies it inside the app, and an allowed extension gets a random token.
// Only a hash of each token is kept on disk (<data>/control-tokens.json), so the file alone
// cannot be used to control the app.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const REQUEST_TTL_MS = 2 * 60_000;
const MAX_WAITING = 8;
const hash = (t) => createHash('sha256').update(String(t)).digest();

export function createPairing({ dataDir, now = Date.now, emit = () => {} }) {
  const file = path.join(dataDir, 'control-tokens.json');
  const requests = new Map(); // id -> { id, client, state, createdAt, token }
  let tokens = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j.tokens)) tokens = j.tokens.filter((t) => t && typeof t.id === 'string' && typeof t.hash === 'string');
  } catch { tokens = []; }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function sweep() {
    const t = now();
    for (const [id, r] of requests) {
      if (r.state === 'waiting' && t - r.createdAt > REQUEST_TTL_MS) { r.state = 'expired'; emit('pairing', pending()); }
      if (t - r.createdAt > REQUEST_TTL_MS * 3) requests.delete(id); // forget old answers
    }
  }

  function pending() {
    return [...requests.values()].filter((r) => r.state === 'waiting').map((r) => ({ id: r.id, client: r.client, createdAt: r.createdAt }));
  }

  const api = {
    // -> id, or null when too many requests are waiting
    request(client) {
      sweep();
      if (pending().length >= MAX_WAITING) return null;
      const name = String(client || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'An app';
      const id = randomBytes(16).toString('base64url');
      requests.set(id, { id, client: name, state: 'waiting', createdAt: now(), token: null });
      emit('pairing', pending());
      return id;
    },
    // -> { state, token? } or null for an unknown request
    read(id) {
      sweep();
      const r = requests.get(String(id));
      if (!r) return null;
      if (r.state === 'approved') {
        const token = r.token;
        requests.delete(r.id); // the token is handed out once
        return { state: 'approved', token };
      }
      return { state: r.state };
    },
    approve(id) {
      sweep();
      const r = requests.get(String(id));
      if (!r || r.state !== 'waiting') return false;
      const token = randomBytes(32).toString('base64url');
      const entry = { id: randomBytes(8).toString('hex'), client: r.client, hash: hash(token).toString('hex'), createdAt: now(), lastUsedAt: null };
      tokens.push(entry);
      save();
      r.state = 'approved';
      r.token = token;
      emit('pairing', pending());
      emit('apps', api.list());
      return true;
    },
    deny(id) {
      sweep();
      const r = requests.get(String(id));
      if (!r || r.state !== 'waiting') return false;
      r.state = 'denied';
      emit('pairing', pending());
      return true;
    },
    pending,
    // true when this bearer token belongs to a paired app
    check(token) {
      if (typeof token !== 'string' || !token || token.length > 200) return false;
      const h = hash(token);
      for (const t of tokens) {
        const b = Buffer.from(t.hash, 'hex');
        if (b.length === h.length && timingSafeEqual(b, h)) {
          if (!t.lastUsedAt || now() - t.lastUsedAt > 60_000) { t.lastUsedAt = now(); try { save(); } catch { /* not important */ } }
          return true;
        }
      }
      return false;
    },
    list() { return tokens.map((t) => ({ id: t.id, client: t.client, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })); },
    remove(id) {
      const before = tokens.length;
      tokens = tokens.filter((t) => t.id !== id);
      if (tokens.length === before) return false;
      save();
      emit('apps', api.list());
      return true;
    },
  };
  return api;
}
