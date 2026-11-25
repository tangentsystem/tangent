// Rented machine wallet key backups (on by default on every node).
//
// When a rented machine gets its in-machine Solana wallet, the node keeps a copy of that
// wallet's 64 byte secret key in <data>/backups/machine-wallets/, so the renter can get it
// back. The copy is kept for 30 days after the machine ends, then deleted.
//
//   <machineId>.json          the backup: machine id, wallet address, the renter's payer
//                             identity, created time, the secret key encrypted at rest
//   <machineId>.ended.json    written once when the machine ends: ended time, reason
//   <machineId>.deleted.json  written once by the purge, before the backup is removed
//                             (no key material; lets recovery answer "expired, deleted")
//
// Rules:
//   - every file here is written insert only (open flag 'wx'); nothing is ever overwritten
//   - the secret key is encrypted with XChaCha20-Poly1305 under a key derived (HKDF-SHA256)
//     from the node's own identity key, which already lives in the node's data folder. So
//     a copy of this folder alone does not reveal wallet keys; the whole data folder does
//   - the purge is the ONE place in this codebase allowed to delete key material. It only
//     looks inside this one folder, only at file names of the exact form m_<24 hex>.json,
//     only at regular files whose content says kind "rented-machine-wallet" for that same
//     machine id, and only when an ended record exists whose ended time is at least
//     30 days before now. Anything else is left alone
//   - secret keys are never logged
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { canonicalBytes, b58, unb58 } from '../core/index.js';

export const MACHINE_WALLET_RETENTION_MS = 30 * 24 * 3600_000;
export const MACHINE_WALLET_KIND = 'rented-machine-wallet';
export const MACHINE_WALLET_ENDED_KIND = 'rented-machine-wallet-ended';
export const MACHINE_WALLET_DELETED_KIND = 'rented-machine-wallet-deleted';
export const MACHINE_WALLET_DIR = path.join('backups', 'machine-wallets');
const MACHINE_ID_RE = /^m_[0-9a-f]{24}$/;
const BACKUP_NAME_RE = /^(m_[0-9a-f]{24})\.json$/;

export const isMachineId = (id) => typeof id === 'string' && MACHINE_ID_RE.test(id);

async function writeOnce(file, data) {
  try { await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 }); return true; } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}
async function readJson(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
  try { return JSON.parse(raw); } catch { return { unreadable: true }; }
}

// dataDir: the node's data folder. identity: the node identity (its 32 byte seed encrypts backups).
export async function createMachineWalletVault({ dataDir, identity, now = Date.now, retentionMs = MACHINE_WALLET_RETENTION_MS, log = () => {} } = {}) {
  if (!dataDir) throw new Error('machine wallets: dataDir is required');
  if (!identity || !(identity.secret instanceof Uint8Array) || identity.secret.length !== 32) throw new Error('machine wallets: the node identity is required');
  const dir = path.join(dataDir, MACHINE_WALLET_DIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const encKey = hkdf(sha256, identity.secret, new TextEncoder().encode('tangent machine wallet backup'), new TextEncoder().encode('v1:' + identity.id), 32);
  const file = (id, suffix = '') => {
    if (!isMachineId(id)) throw new Error('machine wallets: bad machine id');
    return path.join(dir, `${id}${suffix}.json`);
  };
  const aad = (row) => canonicalBytes({ kind: MACHINE_WALLET_KIND, machineId: row.machineId, address: row.address, payer: row.payer, node: row.node });
  let timer = null;

  function decrypt(row) {
    const nonce = unb58(row.enc.nonce);
    const secretKey = xchacha20poly1305(encKey, nonce, aad(row)).decrypt(unb58(row.enc.ct));
    if (secretKey.length !== 64 || b58(secretKey.subarray(32)) !== row.address || b58(ed25519.getPublicKey(secretKey.subarray(0, 32))) !== row.address) {
      secretKey.fill(0);
      throw new Error('machine wallets: the backup does not match its address');
    }
    return secretKey;
  }

  // Insert only. Called once per machine, before the rent answers. Throws if it cannot be kept.
  async function backup({ machineId, address, payer, secretKey }) {
    if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) throw new Error('machine wallets: a 64 byte secret key is required');
    if (typeof payer !== 'string' || !payer) throw new Error('machine wallets: the payer is required');
    const row = { kind: MACHINE_WALLET_KIND, v: 1, machineId, address, payer, node: identity.id, createdAt: now() };
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(encKey, nonce, aad(row)).encrypt(secretKey);
    row.enc = { alg: 'xchacha20poly1305', kdf: 'hkdf-sha256(node identity)', nonce: b58(nonce), ct: b58(ct) };
    const f = file(machineId);
    if (!(await writeOnce(f, JSON.stringify(row, null, 2) + '\n'))) throw new Error('machine wallets: a backup for this machine already exists; it is never replaced');
    const saved = await readJson(f);
    const check = decrypt(saved); // read back: the backup must open to the same key
    const same = Buffer.compare(Buffer.from(check), Buffer.from(secretKey)) === 0;
    check.fill(0);
    if (!same) throw new Error('machine wallets: the saved backup does not match the wallet');
    return { machineId, address, createdAt: row.createdAt };
  }

  // Insert only. The first ended time is the one kept.
  async function ended({ machineId, reason = 'ended', endedAt = now() }) {
    const f = file(machineId);
    const row = await readJson(f);
    if (!row || row.kind !== MACHINE_WALLET_KIND) return null;
    await writeOnce(file(machineId, '.ended'), JSON.stringify({ kind: MACHINE_WALLET_ENDED_KIND, machineId, endedAt, reason: String(reason).slice(0, 120) }) + '\n');
    const e = await readJson(file(machineId, '.ended'));
    return { machineId, endedAt: e.endedAt, deleteAfter: e.endedAt + retentionMs };
  }

  // -> { state: 'none' | 'kept' | 'expired' | 'deleted', ... } (never the key)
  async function lookup(machineId) {
    if (!isMachineId(machineId)) return { state: 'none', machineId };
    const row = await readJson(file(machineId));
    const e = await readJson(file(machineId, '.ended'));
    const d = await readJson(file(machineId, '.deleted'));
    const endedAt = e && e.kind === MACHINE_WALLET_ENDED_KIND && Number.isFinite(e.endedAt) ? e.endedAt : null;
    const deleteAfter = endedAt !== null ? endedAt + retentionMs : null;
    const base = { machineId, endedAt, deleteAfter };
    if (!row || row.kind !== MACHINE_WALLET_KIND) {
      if (d && d.kind === MACHINE_WALLET_DELETED_KIND) return { ...base, state: 'deleted', address: d.address, payer: d.payer, deletedAt: d.deletedAt };
      return { state: 'none', machineId };
    }
    const info = { ...base, address: row.address, payer: row.payer, createdAt: row.createdAt };
    if (deleteAfter !== null && now() >= deleteAfter) return { ...info, state: 'expired' };
    return { ...info, state: 'kept' };
  }

  // The secret key, only while it is kept. Caller zeroes it after use.
  async function reveal(machineId) {
    const st = await lookup(machineId);
    if (st.state !== 'kept') throw Object.assign(new Error('machine wallets: no key kept for this machine'), { state: st.state });
    return decrypt(await readJson(file(machineId)));
  }

  async function backupNames() {
    const names = await fs.readdir(dir).catch(() => []);
    return names.map((n) => BACKUP_NAME_RE.exec(n)).filter(Boolean).map((m) => m[1]);
  }

  // At start no machine of an earlier run is alive (the driver removes leftovers), so a backup
  // with no ended record belongs to a machine that ended when the node stopped. Mark it now,
  // so its 30 days start counting instead of the key being kept forever.
  async function endOrphans(liveIds = []) {
    const live = new Set(liveIds);
    let n = 0;
    for (const id of await backupNames()) {
      if (live.has(id)) continue;
      if (await readJson(file(id, '.ended'))) continue;
      if (await ended({ machineId: id, reason: 'node restarted; the machine ended with the earlier run' })) n++;
    }
    if (n) log('info', 'machine_wallets.ended_at_restart', { count: n });
    return n;
  }

  // The only removal of key material in this codebase. Every check is made again right before
  // the unlink, on the file itself.
  async function removeIfExpired(id) {
    if (!isMachineId(id)) return false;
    const target = path.join(dir, `${id}.json`);
    if (path.dirname(target) !== dir || path.basename(target) !== `${id}.json`) return false;
    let st;
    try { st = await fs.lstat(target); } catch { return false; }
    if (!st.isFile()) return false; // never a symlink, folder or anything else
    const row = await readJson(target);
    if (!row || row.kind !== MACHINE_WALLET_KIND || row.machineId !== id || !row.enc) return false;
    const e = await readJson(file(id, '.ended'));
    if (!e || e.kind !== MACHINE_WALLET_ENDED_KIND || e.machineId !== id || !Number.isFinite(e.endedAt)) return false;
    const t = now();
    if (t < e.endedAt + retentionMs) return false;
    await writeOnce(file(id, '.deleted'), JSON.stringify({ kind: MACHINE_WALLET_DELETED_KIND, machineId: id, address: row.address, payer: row.payer, endedAt: e.endedAt, deletedAt: t }) + '\n');
    await fs.unlink(target);
    return true;
  }

  async function purge() {
    const deleted = [];
    for (const id of await backupNames()) {
      try { if (await removeIfExpired(id)) deleted.push(id); } catch (err) { log('warn', 'machine_wallets.purge_failed', { machineId: id, reason: String(err.message).slice(0, 120) }); }
    }
    if (deleted.length) log('info', 'machine_wallets.purged', { count: deleted.length, machineIds: deleted, note: 'rented machine wallet keys deleted 30 days after their machine ended' });
    return { deleted };
  }

  return {
    dir,
    retentionMs,
    retentionDays: Math.round(retentionMs / (24 * 3600_000)),
    backup, ended, lookup, reveal, endOrphans, purge,
    // purge at start, then on an interval
    async start({ intervalMs = 3600_000, liveIds = [] } = {}) {
      await endOrphans(liveIds);
      await purge();
      if (timer) clearInterval(timer);
      timer = setInterval(() => { purge().catch((err) => log('warn', 'machine_wallets.purge_failed', { reason: String(err.message).slice(0, 120) })); }, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
