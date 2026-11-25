import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startService } from './service.js';

const ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

function run(env) {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, out: () => out, err: () => err };
}

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out');
}

test('boot: empty env, real process, /api/health over HTTP, clean SIGTERM exit', async () => {
  const p = run({ PORT: '0' });
  try {
    const line = await waitFor(() => p.out().split('\n').find((l) => l.includes('"service.listening"')));
    const { port, storage, flags } = JSON.parse(line);
    assert.equal(storage, 'memory');
    assert.deepEqual(flags, { mongo: false, helius: false, token: false, rpc: false });
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'Tangent Systems');
    assert.equal(body.storage.kind, 'memory');
    assert.equal(body.modules.pay, false);
    assert.equal(body.modules.token, false);
    const dir = await (await fetch(`http://127.0.0.1:${port}/api/directory`)).json();
    assert.deepEqual(dir.directory.nodes, []);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json(), {});
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/map`)).json()).nodes, []);
    assert.match(p.out(), /Tangent Systems coordinator/);
    assert.match(p.out(), /WALLETS/);
    assert.match(p.out(), /NO DATABASE/);
    assert.ok(!/FUND THIS WALLET/.test(p.out()));
    p.child.kill('SIGTERM');
    assert.equal(await p.exited, 0);
    assert.match(p.out(), /service.stopping/);
  } finally { p.child.kill('SIGKILL'); }
});

test('boot: a malformed value exits 1, names the variable, never echoes it', async () => {
  const p = run({ PORT: '0', TOKEN_CA: 'MySecretValue123notAnAddress' });
  assert.equal(await p.exited, 1);
  assert.match(p.err(), /TOKEN_CA/);
  assert.ok(!p.err().includes('MySecretValue123'));
  assert.ok(!p.out().includes('MySecretValue123'));
});

test('boot: an unreachable MongoDB fails the boot without printing the URI', async () => {
  const p = run({ PORT: '0', MONGO_URI: 'mongodb://admin:HiddenPw77@127.0.0.1:1/x?serverSelectionTimeoutMS=300' });
  assert.equal(await p.exited, 1);
  assert.match(p.err(), /service.boot_failed/);
  assert.ok(!p.err().includes('HiddenPw77'));
  assert.ok(!p.out().includes('HiddenPw77'));
});

test('boot: startService in process wires modules through guarded imports and stops cleanly', async () => {
  const lines = [];
  const importer = async (p) => {
    if (p.includes('offgrid')) { const e = new Error(`Cannot find module '/x/src/offgrid/index.js'`); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; }
    return import(p);
  };
  const svc = await startService({ env: { PORT: '0' }, sink: (l) => lines.push(l), importer });
  const port = svc.server.address().port;
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(h.modules.offgrid, false);
    assert.equal(svc.modules.status.offgrid, 'missing');
    assert.equal(svc.modules.status.pay, 'off');
  } finally { await svc.stop(); }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`)); // socket closed after stop()
  assert.ok(lines.some((l) => l.includes('WALLETS')));
});
