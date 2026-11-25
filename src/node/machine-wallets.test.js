import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { createIdentity, b58 } from '../core/index.js';
import { createKeystore, ed25519Key } from './keystore.js';
import { createMachineWalletVault, MACHINE_WALLET_RETENTION_MS as KEEP } from './machine-wallets.js';
import { createMemoryStore } from '../storage/index.js';
import { ensureKeys, ensureKey } from '../keys.js';

const DAY = 24 * 3600_000;
const mid = () => 'm_' + randomBytes(12).toString('hex');
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'tangent-mw-'));
const clock = (t) => { const c = () => c.t; c.t = t; return c; };

async function snapshot(dir) {
  const out = {};
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isSymbolicLink()) out[path.relative(dir, p)] = 'link:' + await fs.readlink(p);
      else out[path.relative(dir, p)] = createHash('sha256').update(await fs.readFile(p)).digest('hex');
    }
  }
  await walk(dir);
  return out;
}

test('machine wallet backup: insert only, encrypted at rest, tagged, ended time kept once', async () => {
  const dir = await tmp();
  const identity = createIdentity();
  const now = clock(1_000_000);
  const vault = await createMachineWalletVault({ dataDir: dir, identity, now });
  const kp = Keypair.generate();
  const payer = createIdentity().id;
  const id = mid();
  await vault.backup({ machineId: id, address: kp.publicKey.toBase58(), payer, secretKey: kp.secretKey });
  const file = path.join(dir, 'backups', 'machine-wallets', `${id}.json`);
  const raw = await fs.readFile(file, 'utf8');
  const row = JSON.parse(raw);
  assert.equal(row.kind, 'rented-machine-wallet');
  assert.equal(row.machineId, id);
  assert.equal(row.payer, payer);
  assert.equal(row.createdAt, 1_000_000);
  assert.equal(row.node, identity.id);
  assert.ok(!raw.includes(b58(kp.secretKey)) && !raw.includes(b58(kp.secretKey.subarray(0, 32))), 'no plaintext key on disk');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  // a second backup under the same machine id is refused and the file is unchanged
  const other = Keypair.generate();
  await assert.rejects(vault.backup({ machineId: id, address: other.publicKey.toBase58(), payer, secretKey: other.secretKey }), /never replaced/);
  assert.equal(await fs.readFile(file, 'utf8'), raw);

  // the key opens back to the same wallet
  const back = await vault.reveal(id);
  assert.deepEqual(Buffer.from(back), Buffer.from(kp.secretKey));

  // the ended time is written once; a later call keeps the first
  now.t = 2_000_000;
  const e1 = await vault.ended({ machineId: id, reason: 'stopped by renter' });
  now.t = 3_000_000;
  const e2 = await vault.ended({ machineId: id, reason: 'again' });
  assert.equal(e1.endedAt, 2_000_000);
  assert.equal(e2.endedAt, 2_000_000);
  assert.equal(e1.deleteAfter, 2_000_000 + KEEP);
  const st = await vault.lookup(id);
  assert.equal(st.state, 'kept');
  assert.equal(st.createdAt, 1_000_000);
  assert.equal(st.endedAt, 2_000_000);

  // another node identity cannot open it (key derived from this node's identity)
  const stranger = await createMachineWalletVault({ dataDir: dir, identity: createIdentity(), now });
  await assert.rejects(stranger.reveal(id));
});

test('machine wallet purge: deletes only expired rented machine wallet backups, nothing else, ever', async () => {
  const dir = await tmp();
  const t0 = Date.UTC(2026, 0, 1);
  const now = clock(t0);
  // every other kind of key the codebase keeps: node keystore keys and their backups ...
  const ks = await createKeystore({ dir, now });
  const { identity } = await ks.identity('identity');
  await ks.kx('kx');
  await ks.ensure('payout');
  await ks.ensure('wallet');
  await ks.insert('acct-abc', { ...ed25519Key(), meta: { node: 'x' } });
  await ks.insert('onion', { kind: 'tor-onion', publicKey: 'abcdefabcdef.onion', secret: 'ED25519-V3:' + randomBytes(64).toString('base64') });
  // ... and the coordinator's keys (coordinator, tip, rings, selftest) in its store
  const store = await createMemoryStore();
  await ensureKeys({ store });
  await ensureKey(store, 'selftest');
  const storeBefore = {};
  for (const c of ['keys', 'keys_backup']) storeBefore[c] = JSON.stringify(await store.collection(c).find({}));
  assert.deepEqual(JSON.parse(storeBefore.keys).map((r) => r._id).sort(), ['coordinator', 'rings', 'selftest', 'tip']);

  const vault = await createMachineWalletVault({ dataDir: dir, identity, now });
  const mwDir = vault.dir;
  const make = async (payer = createIdentity().id) => {
    const kp = Keypair.generate(); const id = mid();
    await vault.backup({ machineId: id, address: kp.publicKey.toBase58(), payer, secretKey: kp.secretKey });
    return id;
  };
  const A = await make(); const B = await make(); const C = await make();

  // decoys inside the machine wallet folder that must never be removed
  const identityRow = await fs.readFile(path.join(dir, 'keys', 'identity.json'));
  await fs.writeFile(path.join(mwDir, 'identity.json'), identityRow);
  for (const label of ['kx', 'onion', 'coordinator', 'tip', 'rings', 'selftest']) await fs.writeFile(path.join(mwDir, `${label}.json`), JSON.stringify({ label, kind: 'ed25519', secret: 'x', publicKey: 'y' }));
  const wrongKind = mid(); // right file name, but another kind of key, with an old ended record
  await fs.writeFile(path.join(mwDir, `${wrongKind}.json`), JSON.stringify({ kind: 'ed25519', machineId: wrongKind, secret: 'x', enc: {} }));
  await fs.writeFile(path.join(mwDir, `${wrongKind}.ended.json`), JSON.stringify({ kind: 'rented-machine-wallet-ended', machineId: wrongKind, endedAt: 0 }));
  const linked = mid(); // a symlink to the node identity key, with an old ended record
  await fs.symlink(path.join(dir, 'keys', 'identity.json'), path.join(mwDir, `${linked}.json`));
  await fs.writeFile(path.join(mwDir, `${linked}.ended.json`), JSON.stringify({ kind: 'rented-machine-wallet-ended', machineId: linked, endedAt: 0 }));
  const swapped = mid(); // a copy of backup A under another machine id
  await fs.copyFile(path.join(mwDir, `${A}.json`), path.join(mwDir, `${swapped}.json`));
  await fs.writeFile(path.join(mwDir, `${swapped}.ended.json`), JSON.stringify({ kind: 'rented-machine-wallet-ended', machineId: swapped, endedAt: 0 }));
  const legacy = `${mid()}-${Keypair.generate().publicKey.toBase58()}.json`; // older --backup-machine-wallets file
  await fs.writeFile(path.join(mwDir, legacy), JSON.stringify({ machineId: 'x', secretKey: 'plain' }));

  await vault.ended({ machineId: A, endedAt: t0 });
  await vault.ended({ machineId: B, endedAt: t0 + DAY });
  // C never ends

  const protectedFiles = async () => {
    const all = await snapshot(dir);
    for (const k of Object.keys(all)) if ([A, B, C].some((id) => k.includes(id))) delete all[k];
    return all;
  };
  const before = await protectedFiles();
  const exists = (id) => fs.access(path.join(mwDir, `${id}.json`)).then(() => true, () => false);

  now.t = t0 + KEEP - 1; // one millisecond short of 30 days
  assert.deepEqual((await vault.purge()).deleted, []);
  assert.ok(await exists(A) && await exists(B) && await exists(C));

  now.t = t0 + KEEP; // exactly 30 days after A ended
  assert.deepEqual((await vault.purge()).deleted, [A]);
  assert.equal(await exists(A), false);
  assert.equal((await vault.lookup(A)).state, 'deleted');
  assert.ok(await exists(B) && await exists(C));

  now.t = t0 + DAY + KEEP - 1;
  assert.deepEqual((await vault.purge()).deleted, []);
  now.t = t0 + DAY + KEEP;
  assert.deepEqual((await vault.purge()).deleted, [B]);

  // a machine that never ended keeps its backup, however much time passes
  now.t = t0 + 10 * 365 * DAY;
  assert.deepEqual((await vault.purge()).deleted, []);
  assert.ok(await exists(C));
  assert.equal((await vault.lookup(C)).state, 'kept');

  // every other key and file is byte for byte the same, in the folder and in the store
  assert.deepEqual(await protectedFiles(), before);
  for (const c of ['keys', 'keys_backup']) assert.equal(JSON.stringify(await store.collection(c).find({})), storeBefore[c]);
  assert.ok((await fs.readFile(path.join(dir, 'keys', 'identity.json'))).equals(identityRow));
});

test('machine wallet purge: a backup left without an end at restart gets one, then expires 30 days later', async () => {
  const dir = await tmp();
  const identity = createIdentity();
  const now = clock(Date.UTC(2026, 5, 1));
  const v1 = await createMachineWalletVault({ dataDir: dir, identity, now });
  const kp = Keypair.generate(); const id = mid();
  await v1.backup({ machineId: id, address: kp.publicKey.toBase58(), payer: createIdentity().id, secretKey: kp.secretKey });
  // the node stops without the machine's end being written; it restarts a day later
  now.t += DAY;
  const v2 = await createMachineWalletVault({ dataDir: dir, identity, now });
  await v2.start({ intervalMs: 3600_000 });
  v2.stop();
  const st = await v2.lookup(id);
  assert.equal(st.state, 'kept');
  assert.equal(st.endedAt, now.t);
  now.t += KEEP - 1;
  assert.deepEqual((await v2.purge()).deleted, []);
  now.t += 1;
  assert.deepEqual((await v2.purge()).deleted, [id]);
  assert.equal((await v2.lookup(id)).state, 'deleted');
});
