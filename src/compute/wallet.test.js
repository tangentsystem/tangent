import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import { createIdentity } from '../core/identity.js';
import { createMachineWallet } from './wallet.js';
import { pickDriver } from './drivers/index.js';
import { createProcessDriver } from './drivers/process.js';
import { createComputeClient } from './client.js';
import { startNode } from './test-helpers.js';

test('wallet never prints its key and is unusable after destroy', () => {
  const w = createMachineWallet();
  assert.equal(util.inspect(w), `MachineWallet(${w.address})`);
  assert.deepEqual(JSON.parse(JSON.stringify(w)), { address: w.address });
  assert.equal(bs58.decode(w.signMessage(Buffer.from('x'))).length, 64);
  w.destroy();
  assert.throws(() => w.signMessage(Buffer.from('x')), /destroyed/);
});

test('logs never contain machine tokens or wallet keys', async () => {
  const lines = [];
  const node = await startNode({ driver: createProcessDriver({ dev: true, rootDir: path.join(os.tmpdir(), 'tangent-compute-wtest-' + process.pid) }), log: (...a) => lines.push(JSON.stringify(a)) });
  const c = createComputeClient({ baseUrl: node.url });
  const m = await c.rent({ payer: createIdentity().id });
  await m.exec('echo hi'); await m.signMessage('x'); await m.stop();
  await node.close();
  const all = lines.join('\n');
  assert.ok(lines.length > 0);
  assert.ok(!all.includes(m.token));
  assert.ok(!/secret/i.test(all));
});

test('pickDriver never falls back to the unsealed process driver without the dev flag', async () => {
  await assert.rejects(pickDriver({ docker: { dockerBin: '/nonexistent/docker' } }), /dev flag/);
  const d = await pickDriver({ docker: { dockerBin: '/nonexistent/docker' }, dev: true });
  assert.equal(d.name, 'process'); assert.equal(d.sealed, false);
});
