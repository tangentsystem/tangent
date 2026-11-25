// A whole Tangent network on this machine, the way test/e2e/network.test.js starts one:
// the real coordinator boot (memory store, simulated Privacy Rings), a LiteSVM chain behind a
// local JSON-RPC endpoint, and 4 node processes (bin/node.js). Plus a local web server that
// traffic through the network can reach. Nothing here talks to the live network.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LiteSVM } from 'litesvm';
import { startService } from '../../../src/coord/service.js';
import { startSvmRpc } from '../../../test/e2e/support/svm-rpc.js';

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const NODE_BIN = path.join(ROOT, 'bin', 'node.js');

function lines(stream, onLine) {
  let buf = '';
  stream.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); } });
}

function startNodeProc(args, { timeoutMs = 120_000 } = {}) {
  const env = { ...process.env };
  const proc = spawn(process.execPath, [NODE_BIN, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('node not ready in time:\n' + log.slice(-15).join('\n'))), timeoutMs);
    const on = (l) => {
      log.push(l); if (log.length > 4000) log.shift();
      let j; try { j = JSON.parse(l); } catch { return; }
      if (j.event === 'node.ready') { clearTimeout(t); resolve(j); }
    };
    lines(proc.stdout, on); lines(proc.stderr, on);
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`node exited ${code}:\n` + log.slice(-15).join('\n'))); });
  });
  return { proc, log, ready };
}

async function stopProc(p) {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill('SIGTERM');
  const t = setTimeout(() => p.kill('SIGKILL'), 15_000);
  await done; clearTimeout(t);
}

export async function waitFor(fn, { timeoutMs = 60_000, every = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// compute: false | 'docker' | 'dev'
export async function startNetwork({ compute = false, token = null } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tangent-app-net-'));
  const procs = [];
  const hits = [];
  const big = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  const dest = http.createServer((req, res) => {
    hits.push({ url: req.url, ua: req.headers['user-agent'] || '', at: Date.now() });
    if (req.url.startsWith('/big')) { res.writeHead(200, { 'content-length': big.length, 'content-type': 'application/octet-stream' }); res.end(big); return; }
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>reached</title><p>hello through three hops</p>');
  });
  await new Promise((r) => dest.listen(0, '127.0.0.1', r));
  const svm = new LiteSVM();
  const rpc = await startSvmRpc(svm);
  const coordLog = [];
  const svc = await startService({
    env: {
      PORT: '0', ALLOW_PRIVATE_HOSTS: 'true', PAY_DEV_SIM: 'true', PAY_DEV_SIM_ROUTES: 'true', SOLANA_RPC_URL: rpc.url, TRUST_PROXY: 'false',
      HEARTBEAT_INTERVAL_MS: '2000', PAY_TICK_MS: '500', RATE_LIMIT_PER_MIN: '100000', HEARTBEAT_LIMIT_PER_MIN: '100000',
      REDEEM_LIMIT_PER_MIN: '100000', CLAIM_LIMIT_PER_MIN: '10000', REGISTER_LIMIT_PER_HOUR: '1000',
      OFFGRID_SWEEP_MIN_LAMPORTS: '10000', OFFGRID_SWEEP_INTERVAL_MS: '86400000',
    },
    sink: (l) => { coordLog.push(l); if (coordLog.length > 4000) coordLog.shift(); },
  });
  const coordUrl = `http://127.0.0.1:${svc.server.address().port}`;
  const common = ['--coordinator', coordUrl, '--host', '127.0.0.1', '--bind', '127.0.0.1', '--relay-port', '0', '--api-port', '0', '--offgrid-port', '0', '--dev-allow-private', '--region', 'test-local'];
  const nodes = [];
  const startNode = async (name, extra) => {
    const p = startNodeProc([...common, '--data', path.join(tmp, name), ...extra]);
    procs.push(p.proc);
    const info = await p.ready;
    const n = { name, ...info, log: p.log, proc: p.proc };
    nodes.push(n);
    return n;
  };
  try {
    await startNode('n4', ['--exit', '--gateway', '--rpc-url', rpc.url]);
    await startNode('n3', ['--exit']);
    await startNode('n2', []);
    await startNode('n1', compute === 'docker' ? ['--compute'] : compute === 'dev' ? ['--compute-dev'] : []);
    await waitFor(async () => {
      const b = await (await fetch(coordUrl + '/api/directory')).json();
      return b.directory.nodes.length === 4;
    }, { what: 'four nodes in the directory' });
  } catch (err) {
    for (const p of procs) await stopProc(p);
    await svc.stop().catch(() => {});
    await rpc.close().catch(() => {});
    await new Promise((r) => { dest.close(() => r()); dest.closeAllConnections(); });
    throw err;
  }

  return {
    tmp, coordUrl, svc, svm, rpc, nodes, hits, big, coordLog,
    destPort: dest.address().port,
    destUrl: (p = '/') => `http://127.0.0.1:${dest.address().port}${p}`,
    // simulated Privacy Rings deposit into an app wallet
    fund(walletId, lamports = 100_000_000n) {
      svc.modules.rings.sim.fund(walletId, 'SOL', BigInt(lamports));
      svc.modules.rings.sim.userSendToVault(walletId, 'SOL', BigInt(lamports));
    },
    nodeApi: async (n) => (await fetch(`http://127.0.0.1:${n.apiPort}/api/node`)).json(),
    async stop() {
      for (const p of procs) await stopProc(p);
      await svc.stop().catch(() => {});
      await rpc.close().catch(() => {});
      await new Promise((r) => { dest.close(() => r()); dest.closeAllConnections(); });
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    },
  };
}
