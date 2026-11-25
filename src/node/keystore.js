// Local key store for programs that run on a person's own machine (the node
// daemon and the client CLI). Same rules as src/keys.js, on files instead of
// MongoDB:
//   - every key is created once and written insert only (open flag 'wx'):
//     an existing file is never overwritten, rewritten or deleted
//   - the backup copy goes to <dir>/backups/ first, then the key to <dir>/keys/
//   - a saved key that does not check out stops the program instead of being replaced
//   - on every load the backup is checked and re-created if it is missing
//   - files are mode 0600, folders 0700; secrets are never logged
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createIdentity, createKxKeypair, b58, unb58 } from '../core/index.js';

const LABEL_RE = /^[a-z][a-z0-9_-]{0,47}$/;

export function ed25519Key() {
  const seed = randomBytes(32);
  return { kind: 'ed25519', publicKey: createIdentity(seed).id, secret: b58(seed) };
}
export function x25519Key() {
  const seed = randomBytes(32);
  return { kind: 'x25519', publicKey: createKxKeypair(seed).pub, secret: b58(seed) };
}
export function checkEd25519(row) {
  try { const s = unb58(row.secret); return s.length === 32 && createIdentity(s).id === row.publicKey; } catch { return false; }
}
export function checkX25519(row) {
  try { const s = unb58(row.secret); return s.length === 32 && createKxKeypair(s).pub === row.publicKey; } catch { return false; }
}

async function writeOnce(file, data) {
  try {
    await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`keystore: ${path.basename(file)} is unreadable; refusing to continue`);
  }
}

export async function createKeystore({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error('keystore: dir is required');
  const keysDir = path.join(dir, 'keys');
  const backupsDir = path.join(dir, 'backups');
  await fs.mkdir(keysDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(backupsDir, { recursive: true, mode: 0o700 });

  const keyFile = (label) => path.join(keysDir, `${label}.json`);
  const backupFile = (label, pub) => path.join(backupsDir, `${label}-${String(pub).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.json`);

  async function ensureBackup(row) {
    const file = backupFile(row.label, row.publicKey);
    await writeOnce(file, JSON.stringify(row, null, 2) + '\n');
    const saved = await readJson(file);
    if (!saved || saved.secret !== row.secret) throw new Error(`keystore: the backup of "${row.label}" does not match the saved key; refusing to continue`);
  }

  async function get(label) {
    if (!LABEL_RE.test(label)) throw new Error('keystore: bad label');
    return readJson(keyFile(label));
  }

  // Insert a key made elsewhere (for example a Tor onion key). Refuses a different
  // secret under an existing label. -> { row, created }
  async function insert(label, { kind, publicKey, secret, meta } = {}, { check = () => true, acceptWinner = false } = {}) {
    if (!LABEL_RE.test(label)) throw new Error('keystore: bad label');
    if (typeof publicKey !== 'string' || typeof secret !== 'string' || !publicKey || !secret) throw new Error('keystore: publicKey and secret are required');
    const existing = await get(label);
    if (existing) {
      if (existing.secret !== secret) throw new Error(`keystore: "${label}" already holds another key; it is never replaced`);
      await ensureBackup(existing);
      return { row: existing, created: false };
    }
    const row = { label, kind: kind || 'custom', publicKey, secret, ...(meta ? { meta } : {}), createdAt: new Date(now()).toISOString() };
    if (!check(row)) throw new Error(`keystore: "${label}" does not check out`);
    await ensureBackup(row); // backup first: a key never exists without its backup
    const created = await writeOnce(keyFile(label), JSON.stringify(row, null, 2) + '\n');
    if (created) return { row, created: true };
    // another process wrote it first: what is on disk is what is used
    const winner = await get(label);
    if (!winner) throw new Error(`keystore: "${label}" could not be written`);
    await ensureBackup(winner);
    if (winner.secret !== secret && !(acceptWinner && check(winner))) throw new Error(`keystore: "${label}" already holds another key; it is never replaced`);
    return { row: winner, created: false };
  }

  // Load a key, or create it once. -> { row, created }
  async function ensure(label, { generate = ed25519Key, check = checkEd25519, meta } = {}) {
    const saved = await get(label);
    if (saved) {
      if (typeof saved.secret !== 'string' || typeof saved.publicKey !== 'string' || !check(saved)) {
        throw new Error(`keystore: the saved "${label}" key does not check out; refusing to replace it`);
      }
      await ensureBackup(saved);
      return { row: saved, created: false };
    }
    const k = generate();
    return insert(label, { ...k, meta }, { check, acceptWinner: true });
  }

  async function list(prefix = '') {
    const names = await fs.readdir(keysDir).catch(() => []);
    const out = [];
    for (const n of names.sort()) {
      if (!n.endsWith('.json') || !n.startsWith(prefix)) continue;
      const row = await readJson(path.join(keysDir, n));
      if (row) out.push(row);
    }
    return out;
  }

  return {
    dir, keysDir, backupsDir, get, insert, ensure, list,
    async identity(label = 'identity') {
      const { row, created } = await ensure(label);
      return { identity: createIdentity(unb58(row.secret)), created };
    },
    async kx(label = 'kx') {
      const { row, created } = await ensure(label, { generate: x25519Key, check: checkX25519 });
      return { kx: createKxKeypair(unb58(row.secret)), created };
    },
  };
}
