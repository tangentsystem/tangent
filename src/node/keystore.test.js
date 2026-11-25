// Local insert only keystore of the node daemon and client CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createKeystore, ed25519Key } from './keystore.js';

test('keys are created once with a backup, never replaced, and a bad saved key stops the program', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tangent-ks-'));
  try {
    const ks = await createKeystore({ dir });
    const a = await ks.identity('identity');
    assert.equal(a.created, true);
    const b = await ks.identity('identity');
    assert.equal(b.created, false);
    assert.equal(b.identity.id, a.identity.id, 'same key on the next start');
    const kx1 = await ks.kx('kx');
    assert.equal((await ks.kx('kx')).kx.pub, kx1.kx.pub);

    const keyFile = path.join(dir, 'keys', 'identity.json');
    const backups = await fs.readdir(path.join(dir, 'backups'));
    assert.ok(backups.includes(`identity-${a.identity.id}.json`));
    assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);

    // another key under the same label is refused, the saved one is untouched
    const before = await fs.readFile(keyFile, 'utf8');
    await assert.rejects(ks.insert('identity', ed25519Key()), /never replaced/);
    assert.equal(await fs.readFile(keyFile, 'utf8'), before);

    // a missing backup is written again on load (never overwritten when present)
    await fs.rm(path.join(dir, 'backups', `identity-${a.identity.id}.json`));
    await ks.identity('identity');
    assert.ok((await fs.readdir(path.join(dir, 'backups'))).includes(`identity-${a.identity.id}.json`));

    // a saved key that does not check out stops everything instead of being regenerated
    const row = JSON.parse(before);
    await fs.chmod(keyFile, 0o600);
    await fs.rm(keyFile);
    await fs.writeFile(keyFile, JSON.stringify({ ...row, publicKey: ed25519Key().publicKey }), { mode: 0o600 });
    await assert.rejects(ks.identity('identity'), /does not check out/);
    const after = JSON.parse(await fs.readFile(keyFile, 'utf8'));
    assert.equal(after.secret, row.secret, 'the program did not rewrite the key');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
