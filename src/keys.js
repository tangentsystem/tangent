// The keys the coordinator service runs on. It creates every one itself.
//
//   label         what it is
//   coordinator   signs the node directory, so clients can check a list came from us
//   tip           the network tip account: off grid transactions pay their tip here
//   rings         the Privacy Rings wallet: user deposits arrive here, node payouts leave from here
//
// Rules:
//   - A key is created once from crypto.randomBytes(32). It is first written to
//     the backup collection (keys_backup), then to the keys collection, both
//     insert only. The store refuses any update or delete on these collections.
//   - What the database holds is what is used: if two instances boot together on
//     an empty database, both end up with the key whose insert won. The losing
//     candidate stays only in keys_backup, never used and never funded.
//   - A saved key is never overwritten, regenerated or rewritten. A saved key
//     that does not decode or does not match its address stops the boot.
//   - On every boot each saved key is checked to have its backup row, and the
//     row is inserted if it is missing (never replaced).
//   - A secret is never logged and never returned by the API.
//   - With memory storage the keys live only in memory for this run (ephemeral):
//     the provisioner tells the owner not to send funds to them.
//
// ensureKey() is exported so other modules (for example a blind signing key in
// src/pay) can keep their own keys under the same rules.
import { randomBytes } from 'node:crypto';
import { createIdentity, b58, unb58 } from './core/index.js';

export const KEY_LABELS = Object.freeze({ coordinator: 'coordinator', tip: 'tip', rings: 'rings' });

const LABEL_RE = /^[a-z][a-z0-9_-]{0,47}$/;

export function ed25519Generator() {
  const seed = randomBytes(32);
  const id = createIdentity(seed);
  return { kind: 'ed25519', publicKey: id.id, secret: b58(seed) };
}

export function checkEd25519Row(row) {
  let seed;
  try { seed = unb58(row.secret); } catch { seed = null; }
  if (!seed || seed.length !== 32) return false;
  return createIdentity(seed).id === row.publicKey;
}

function backupId(label, publicKey) {
  return `${label}:${publicKey}`;
}

async function ensureBackup(backups, row) {
  await backups.insert({ _id: backupId(row._id, row.publicKey), label: row._id, kind: row.kind, publicKey: row.publicKey, secret: row.secret, createdAt: row.createdAt });
  const saved = await backups.get(backupId(row._id, row.publicKey));
  if (!saved || saved.secret !== row.secret) throw new Error(`keys: the backup of "${row._id}" does not match the saved key; refusing to continue`);
}

// -> { label, kind, publicKey, secret (string), created: boolean }
export async function ensureKey(store, label, { generate = ed25519Generator, check = checkEd25519Row, now = Date.now } = {}) {
  if (!store || typeof store.collection !== 'function') throw new Error('keys: store is required');
  if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new Error('keys: bad label');
  const keys = store.collection('keys');
  const backups = store.collection('keys_backup');

  const verify = (row) => {
    if (!row || typeof row.secret !== 'string' || typeof row.publicKey !== 'string' || !check(row)) {
      throw new Error(`keys: the saved "${label}" key does not check out; refusing to replace it`);
    }
    return row;
  };

  const saved = await keys.get(label);
  if (saved) {
    verify(saved);
    await ensureBackup(backups, saved);
    return { label, kind: saved.kind, publicKey: saved.publicKey, secret: saved.secret, created: false };
  }

  const candidate = generate();
  if (!candidate || typeof candidate.publicKey !== 'string' || typeof candidate.secret !== 'string') throw new Error('keys: generator returned a bad key');
  const row = { _id: label, kind: candidate.kind || 'custom', publicKey: candidate.publicKey, secret: candidate.secret, createdAt: new Date(now()).toISOString() };
  verify(row);
  // Backup first: a key never exists in "keys" without its backup row.
  await ensureBackup(backups, row);
  const inserted = await keys.insert(row);
  const winner = inserted ? row : verify(await keys.get(label));
  if (!inserted) await ensureBackup(backups, winner);
  return { label, kind: winner.kind, publicKey: winner.publicKey, secret: winner.secret, created: inserted };
}

// -> { coordinator: Identity, tip: { address }, rings: { address, seed }, created: [labels], ephemeral }
export async function ensureKeys({ store } = {}) {
  if (!store || typeof store.collection !== 'function') throw new Error('keys: store is required');
  const created = [];
  const out = {};
  for (const label of Object.values(KEY_LABELS)) {
    const k = await ensureKey(store, label);
    if (k.created) created.push(label);
    out[label] = k;
  }
  const coordinator = createIdentity(unb58(out.coordinator.secret));
  return Object.freeze({
    coordinator,
    tip: Object.freeze({ address: out.tip.publicKey }),
    rings: Object.freeze({ address: out.rings.publicKey, seed: unb58(out.rings.secret) }),
    created: Object.freeze(created),
    ephemeral: store.kind === 'memory',
  });
}
