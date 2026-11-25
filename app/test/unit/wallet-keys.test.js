// The owner's rule: nothing may ever overwrite or rewrite a private key, and every key the app
// creates is backed up (insert only) in <data>/backups.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWallet } from '../../core/wallet.js';

const coord = { pay: {} };

test('the wallet key is created once, backed up, and never replaced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-wk-'));
  const logged = [];
  const w1 = createWallet({ coord, dataDir: dir, log: (...a) => logged.push(JSON.stringify(a)) });
  const a1 = (await w1.info()).address;
  const keyFile = path.join(dir, 'keys', 'wallet.json');
  const row = JSON.parse(await fs.readFile(keyFile, 'utf8'));
  assert.equal(row.publicKey, a1);
  const backups = await fs.readdir(path.join(dir, 'backups'));
  assert.ok(backups.includes(`wallet-${a1}.json`), 'backup written');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'backups', `wallet-${a1}.json`), 'utf8')).secret, row.secret);
  if (process.platform !== 'win32') assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
  // a second run loads the same key
  const a2 = (await createWallet({ coord, dataDir: dir }).info()).address;
  assert.equal(a2, a1);
  // a deleted backup is put back from the key
  await fs.rm(path.join(dir, 'backups', `wallet-${a1}.json`));
  await createWallet({ coord, dataDir: dir }).info();
  assert.ok((await fs.readdir(path.join(dir, 'backups'))).includes(`wallet-${a1}.json`));
  // a damaged key stops the app instead of being replaced
  await fs.chmod(keyFile, 0o600);
  const before = await fs.readFile(keyFile, 'utf8');
  await fs.writeFile(keyFile, JSON.stringify({ ...row, secret: '1111' }));
  await assert.rejects(createWallet({ coord, dataDir: dir }).info(), /does not check out|refusing/);
  assert.notEqual(await fs.readFile(keyFile, 'utf8'), before);
  assert.ok(!(await fs.readFile(keyFile, 'utf8')).includes(row.secret), 'the damaged file was left as it was, not rewritten by the app');
  assert.ok(!logged.join('\n').includes(row.secret), 'the secret is never logged');
  await fs.rm(dir, { recursive: true, force: true });
});
