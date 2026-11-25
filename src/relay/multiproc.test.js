// Relays as separate OS processes on localhost, one killed with SIGKILL mid transfer.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createClient } from './index.js';
import { startHttpServer, socksConnect, httpGetViaSocks, waitFor, sha256 } from './testing/harness.js';
import { randomBytes } from 'node:crypto';

const script = fileURLToPath(new URL('./testing/relay-proc.js', import.meta.url));
const procs = [];
after(() => { for (const p of procs) p.kill('SIGKILL'); });

function spawnRelay(cfg) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'inherit'] });
    procs.push(p);
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const i = out.indexOf('\n');
      if (i >= 0) resolve({ proc: p, descriptor: JSON.parse(out.slice(0, i)) });
    });
    p.on('exit', (code) => reject(new Error('relay process exited ' + code)));
  });
}

test('relays in separate processes: HTTP through SOCKS, SIGKILL of the middle, rebuild', async () => {
  const relays = [
    await spawnRelay({ roles: ['relay'] }), await spawnRelay({ roles: ['relay'] }), await spawnRelay({ roles: ['relay'] }),
    await spawnRelay({ roles: ['relay', 'exit'], allowPrivateTargets: true }),
  ];
  const page = randomBytes(256 * 1024);
  const http = await startHttpServer((req, res) => {
    if (req.url === '/page') return res.end(page);
    const size = 64 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024, 5);
    let sent = 0;
    res.setHeader('content-length', size);
    Readable.from((function* () { while (sent < size) { sent += chunk.length; yield chunk; } })()).pipe(res);
  });
  const client = createClient({ directory: relays.map((r) => r.descriptor) });
  await client.start();
  try {
    const r = await httpGetViaSocks(client.socksPort, '127.0.0.1', http.port, '/page');
    assert.equal(r.status, 200);
    assert.equal(sha256(r.body), sha256(page));

    const sock = await socksConnect(client.socksPort, '127.0.0.1', http.port);
    let received = 0;
    sock.on('data', (c) => { received += c.length; });
    sock.on('error', () => {});
    const closed = new Promise((res) => sock.on('close', res));
    sock.write('GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    await waitFor(() => received > 1024 * 1024);
    const middleId = client.circuits()[0].path[1];
    relays.find((x) => x.descriptor.id === middleId).proc.kill('SIGKILL');
    await closed;
    assert.ok(received < 64 * 1024 * 1024);
    await waitFor(() => client.failedNodes().includes(middleId));

    const again = await httpGetViaSocks(client.socksPort, '127.0.0.1', http.port, '/page');
    assert.equal(sha256(again.body), sha256(page));
    assert.ok(!client.circuits().some((c) => c.path.includes(middleId)));
  } finally {
    await client.stop();
    await http.close();
  }
});
