// Small key value store the off grid node needs. Any object with these async methods works:
//   put(key, value, { ttlMs }?)  value is JSON serialisable (no BigInt, no Uint8Array)
//   get(key)                     -> value | null (null once expired)
//   list(prefix)                 -> [{ key, value, expiresAt }] for live entries whose key starts with prefix
//   delete(key)                  -> boolean
//   close()?                     optional
// Keys used by the node: 'b/<bundleId>' bundles, 'r/<bundleId>' receipts, 'd/<bundleId>' done
// tombstones, 'c/<bundleId>' claims. TTL comes from the bundle's own max age.
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const live = (e, now) => e && (e.expiresAt == null || e.expiresAt > now);

export function createMemoryStore({ now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    async put(key, value, { ttlMs } = {}) {
      m.set(key, { value: structuredClone(value), expiresAt: ttlMs ? now() + ttlMs : null });
    },
    async get(key) {
      const e = m.get(key);
      if (!live(e, now())) { if (e) m.delete(key); return null; }
      return structuredClone(e.value);
    },
    async list(prefix = '') {
      const t = now(), out = [];
      for (const [key, e] of m) {
        if (!key.startsWith(prefix)) continue;
        if (!live(e, t)) { m.delete(key); continue; }
        out.push({ key, value: structuredClone(e.value), expiresAt: e.expiresAt });
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : 1));
    },
    async delete(key) { return m.delete(key); },
    async close() {},
  };
}

// One JSON file per key in `dir`. Writes go to a temp file then rename, so a crash never leaves a
// half written entry. Key names are hex encoded into file names.
export async function createFileStore({ dir, now = () => Date.now() }) {
  if (!dir) throw new Error('file store: dir required');
  await mkdir(dir, { recursive: true });
  const fileOf = (key) => join(dir, Buffer.from(key).toString('hex') + '.json');
  const keyOf = (name) => Buffer.from(name.slice(0, -5), 'hex').toString();
  let seq = 0;
  async function readEntry(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  }
  return {
    async put(key, value, { ttlMs } = {}) {
      const path = fileOf(key);
      const tmp = path + '.' + process.pid + '.' + (seq++) + '.tmp';
      await writeFile(tmp, JSON.stringify({ key, value, expiresAt: ttlMs ? now() + ttlMs : null }));
      await rename(tmp, path);
    },
    async get(key) {
      const e = await readEntry(fileOf(key));
      if (!live(e, now())) { if (e) await unlink(fileOf(key)).catch(() => {}); return null; }
      return e.value;
    },
    async list(prefix = '') {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
      const t = now(), out = [];
      for (const n of names) {
        const key = keyOf(n);
        if (!key.startsWith(prefix)) continue;
        const e = await readEntry(join(dir, n));
        if (!e) continue;
        if (!live(e, t)) { await unlink(join(dir, n)).catch(() => {}); continue; }
        out.push({ key, value: e.value, expiresAt: e.expiresAt });
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : 1));
    },
    async delete(key) {
      try { await unlink(fileOf(key)); return true; } catch { return false; }
    },
    async close() {},
  };
}
