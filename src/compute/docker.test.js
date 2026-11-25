// Runs only when a Docker daemon is reachable (DOCKER_HOST or the default socket)
// and the alpine and node images are present locally. Otherwise every test here is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { createIdentity } from '../core/identity.js';
import { createDockerDriver } from './drivers/docker.js';
import { createComputeClient } from './client.js';
import { startNode } from './test-helpers.js';
import { runApiSuite } from './api-suite.js';

const probe = createDockerDriver();
const check = await probe.check();
const imgs = check.ok ? await probe.images() : [];
const ready = check.ok && imgs.includes('alpine') && imgs.includes('node');
const skip = ready ? false : `no usable Docker daemon or images here (${check.reason || 'missing alpine/node images'})`;
const prefix = `nctest${process.pid}-`;
const make = () => createDockerDriver({ namePrefix: prefix });

if (ready) runApiSuite('docker driver', make, { image: 'alpine' });

test('docker driver: sealing flags and resource limits', { skip, timeout: 180_000 }, async () => {
  const node = await startNode({ driver: createDockerDriver({ namePrefix: prefix, sizes: { small: { cpus: 0.5, memoryMb: 64, pids: 48, diskMb: 8, priceMultiplier: 1n } } }), creditLimitSeconds: 600 });
  try {
    const client = createComputeClient({ baseUrl: node.url });
    const m = await client.rent({ payer: createIdentity().id, image: 'alpine', size: 'small' });
    const ins = await node.compute.inspect(m.machineId);
    assert.equal(ins.privileged, false);
    assert.deepEqual(ins.capDrop, ['ALL']);
    assert.equal(ins.readOnlyRoot, true);
    assert.equal(ins.networkMode, 'none');
    assert.equal(ins.memory, 64 * 1024 * 1024);
    assert.equal(ins.pidsLimit, 48);
    assert.equal(ins.nanoCpus, 0.5e9);
    assert.equal(ins.user, '1000:1000');
    assert.ok(ins.securityOpt.includes('no-new-privileges'));

    const id = await m.exec('id -u; touch /etc/x 2>&1; echo rc=$?');
    assert.match(id.stdout, /^1000\n/);
    assert.match(id.stdout, /Read-only file system/);
    // disk: work dir capped at 8 MB
    const disk = await m.exec('dd if=/dev/zero of=/work/big bs=1M count=20 2>&1; wc -c < /work/big');
    assert.match(disk.stdout, /No space left/);
    assert.equal(disk.stdout.trim().split('\n').pop().trim(), String(8 * 1024 * 1024));
    await assert.rejects(m.writeFile('more.bin', Buffer.alloc(1024 * 1024)), (e) => e.status === 507);
    await m.exec('rm -f /work/big');
    // pids: cannot start more than the limit
    const pids = await m.exec('for i in $(seq 1 80); do sleep 2 & done 2>&1; wait', { timeoutMs: 20_000 });
    assert.match(pids.stdout + pids.stderr, /can't fork|Resource temporarily unavailable/);
    await new Promise((r) => setTimeout(r, 2500));
    // memory: a process above the limit is killed
    const mem = await m.exec('x=$(head -c 200000000 /dev/zero | tr "\\0" a); echo ${#x}', { timeoutMs: 30_000 });
    assert.notEqual(mem.exitCode, 0);
    assert.doesNotMatch(mem.stdout, /200000000/);
    // network: none
    const netr = await m.exec('wget -T 3 -q -O- http://1.1.1.1/ 2>&1; echo rc=$?; ls /sys/class/net');
    assert.match(netr.stdout, /unreachable|bad address|rc=1/i);
    assert.match(netr.stdout, /^lo$/m);
    assert.doesNotMatch(netr.stdout, /^eth0$/m);
  } finally { await node.close(); }
});

test('docker driver: with an egress proxy the machine reaches only the proxy', { skip, timeout: 180_000 }, async () => {
  // stand in for the egress SOCKS proxy: echoes with a prefix
  const proxy = net.createServer((c) => c.on('data', (b) => c.write('via-proxy:' + b.toString())));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const other = net.createServer((c) => c.end('direct'));
  await new Promise((r) => other.listen(0, '0.0.0.0', r));
  const node = await startNode({ driver: make(), creditLimitSeconds: 600, egressProxy: { socksHost: '127.0.0.1', socksPort: proxy.address().port } });
  try {
    const client = createComputeClient({ baseUrl: node.url });
    const m = await client.rent({ payer: createIdentity().id, image: 'alpine', size: 'small' });
    const ins = await node.compute.inspect(m.machineId);
    assert.match(ins.networkMode, /^container:/);
    const env = await m.exec('echo $ALL_PROXY');
    assert.equal(env.stdout.trim(), 'socks5h://127.0.0.1:1080');
    let r;
    for (let i = 0; i < 20; i++) { // sidecar may still be starting
      r = await m.exec('(printf ping; sleep 1) | nc -w 2 127.0.0.1 1080', { timeoutMs: 10_000 });
      if (r.stdout.includes('via-proxy')) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.equal(r.stdout, 'via-proxy:ping');
    const hostIp = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address || '10.0.0.1';
    const direct = await m.exec(`nc -w 2 ${hostIp} ${other.address().port} 2>&1; echo rc=$?; wget -T 2 -q -O- http://1.1.1.1/ 2>&1; ls /sys/class/net`, { timeoutMs: 15_000 });
    assert.doesNotMatch(direct.stdout, /direct/);
    assert.match(direct.stdout, /^lo$/m);
    assert.doesNotMatch(direct.stdout, /^eth0$/m);
  } finally {
    await node.close();
    proxy.close(); other.close();
  }
});
