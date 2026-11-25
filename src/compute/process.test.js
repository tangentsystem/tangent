import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '../core/identity.js';
import { createProcessDriver } from './drivers/process.js';
import { createComputeClient } from './client.js';
import { startNode } from './test-helpers.js';
import { runApiSuite } from './api-suite.js';

const rootDir = path.join(os.tmpdir(), 'network-compute-test-' + process.pid);
runApiSuite('process driver', () => createProcessDriver({ dev: true, rootDir }));

test('process driver refuses to start without the dev flag and says it is not sealed', async () => {
  assert.throws(() => createProcessDriver(), /development only and is NOT sealed/);
  assert.throws(() => createProcessDriver({ dev: 'yes' }), /NOT sealed/);
  const d = createProcessDriver({ dev: true, rootDir });
  assert.equal(d.sealed, false);
  const node = await startNode({ driver: d });
  try {
    const info = await createComputeClient({ baseUrl: node.url }).info();
    assert.equal(info.sealed, false);
    assert.match(info.warning, /NOT sealed/);
  } finally { await node.close(); }
});

test('process driver: file size limit and SIGSTOP pause', { timeout: 60_000 }, async () => {
  const node = await startNode({ driver: createProcessDriver({ dev: true, rootDir, sizes: { small: { cpus: 1, memoryMb: 256, pids: 64, diskMb: 1, priceMultiplier: 1n } } }), tickMs: 50, creditLimitSeconds: 1, graceMs: 60_000 });
  try {
    const client = createComputeClient({ baseUrl: node.url });
    const m = await client.rent({ payer: createIdentity().id, size: 'small' });
    const r = await m.exec('head -c 3000000 /dev/zero > big; echo rc=$?; wc -c < big');
    assert.match(r.stdout, /rc=[1-9]/);
    assert.equal(r.stdout.trim().split('\n').pop().trim(), String(1024 * 1024));
    // a counter loop stops advancing while the machine is paused
    const counter = path.join(rootDir, m.machineId, 'count');
    m.execStream('i=0; while :; do i=$((i+1)); echo $i > count; sleep 0.05; done', { timeoutMs: 20_000 }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await m.status()).state, 'paused');
    const c1 = await fs.readFile(counter, 'utf8');
    await new Promise((res) => setTimeout(res, 600));
    const c2 = await fs.readFile(counter, 'utf8');
    assert.equal(c1, c2, 'process group is stopped');
  } finally { await node.close(); }
});
