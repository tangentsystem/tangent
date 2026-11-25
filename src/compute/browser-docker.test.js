// The sealed browser, tested against a REAL Docker daemon. Runs only when a daemon is
// reachable and the browser image (tangent-machine-browser) and the sidecar image
// (node:22-alpine) are present; otherwise every test here is skipped.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createIdentity } from '../core/identity.js';
import { createDockerDriver } from './drivers/docker.js';
import { createComputeClient, createAutopay } from './client.js';
import { createMcpHttpRouter } from './mcp.js';
import { startNode, fakePayer } from './test-helpers.js';

const probe = createDockerDriver();
const check = await probe.check();
const imgs = check.ok ? await probe.images() : [];
const ready = check.ok && imgs.includes('browser') && imgs.includes('node');
const skip = ready ? false : `no usable Docker daemon or images here (${check.reason || 'missing browser/node images'})`;
const prefix = `nbtest${process.pid}-`;
const browserRunDir = path.join(os.tmpdir(), `tangent-browser-test-${process.pid}`);
after(() => fs.rmSync(browserRunDir, { recursive: true, force: true }));
const make = (o = {}) => createDockerDriver({ namePrefix: prefix, browserRunDir, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const hostIp = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address || '10.0.0.1';

// ---- local test web server: records who connected ---------------------------
async function startSite() {
  const hits = [];
  const app = express();
  app.use((req, res, next) => { hits.push({ path: req.originalUrl, remotePort: req.socket.remotePort, host: req.get('host'), cookie: req.get('cookie') || '' }); res.set('Cache-Control', 'no-store'); next(); });
  app.get('/page', (req, res) => res.type('html').send(`<html><head><title>Egress Page</title></head><body><p id="p">served ${req.query.n || ''}</p>
<input id="q"><button id="b" onclick="document.getElementById('p').textContent='typed '+document.getElementById('q').value">b</button></body></html>`));
  app.get('/set', (req, res) => res.set('Set-Cookie', 'owner=machine-a; Path=/').type('html').send('<title>set</title><p>cookie set</p>'));
  app.get('/cookie', (req, res) => res.type('html').send(`<title>cookie</title><p>cookie=[${req.get('cookie') || ''}]</p>`));
  app.get('/hog', (req, res) => res.type('html').send(`<title>hog</title><p>hog</p><script>
setTimeout(() => { const a = []; for (;;) a.push(new Float64Array(4 * 1024 * 1024).fill(1.5)); }, 50);</script>`));
  const server = await new Promise((r) => { const s = app.listen(0, '0.0.0.0', () => r(s)); });
  return { port: server.address().port, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// ---- minimal SOCKS5 proxy standing in for the node's egress SOCKS port ---------
// Resolves only names in `names`, connects only to `allowPorts` on 127.0.0.1, records
// every request (with the name as the browser sent it) and the local port of every
// outbound connection it opens.
async function startSocks({ names, allowPorts }) {
  const requests = []; const outPorts = new Set(); const socks = new Set();
  const server = net.createServer((c) => {
    socks.add(c); c.on('close', () => socks.delete(c)); c.on('error', () => {});
    c.once('data', (hello) => {
      if (hello[0] !== 5) return c.destroy();
      c.write(Buffer.from([5, 0]));
      c.once('data', (req) => {
        const atyp = req[3]; let host; let off;
        if (atyp === 1) { host = [...req.subarray(4, 8)].join('.'); off = 8; }
        else if (atyp === 3) { const n = req[4]; host = req.subarray(5, 5 + n).toString(); off = 5 + n; }
        else if (atyp === 4) { host = 'ipv6'; off = 20; }
        const port = req.readUInt16BE(off);
        requests.push({ host, port, atyp });
        const target = names[host] || null;
        if (!target || !allowPorts.includes(port)) { c.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const up = net.connect(port, target, () => {
          outPorts.add(up.localPort);
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          const rest = req.subarray(off + 2); if (rest.length) up.write(rest);
          c.pipe(up); up.pipe(c);
        });
        socks.add(up); up.on('close', () => socks.delete(up));
        up.on('error', () => c.destroy()); c.on('close', () => up.destroy());
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, requests, outPorts,
    close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
  };
}

// host processes: pid, ppid, cmdline, cgroup
function hostProcs() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').trim();
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${d}/status`, 'utf8'))[1]);
      const cgroup = fs.readFileSync(`/proc/${d}/cgroup`, 'utf8');
      out.push({ pid: Number(d), ppid, cmd, cgroup });
    } catch {}
  }
  return out;
}
function descendsFrom(procs, pid, ancestor) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (let p = byPid.get(pid), n = 0; p && n < 64; p = byPid.get(p.ppid), n++) if (p.ppid === ancestor) return true;
  return false;
}
const containerId = (name) => docker('inspect', '-f', '{{.Id}}', name).stdout.trim();

async function openFails(m, url) {
  try { const r = await m.browserOpen(url); return { failed: false, r }; } catch (e) { return { failed: true, message: e.message }; }
}

test('sealed browser: runs inside the machine container, loads pages only through the egress route, leaves nothing behind', { skip, timeout: 300_000 }, async (t) => {
  const site = await startSite();
  const socks = await startSocks({ names: { 'site.test': '127.0.0.1' }, allowPorts: [site.port] });
  const node = await startNode({ driver: make(), creditLimitSeconds: 600, egressProxy: { socksHost: '127.0.0.1', socksPort: socks.port } });
  t.after(async () => { await node.close(); await socks.close(); await site.close(); });
  const client = createComputeClient({ baseUrl: node.url });
  const info = await client.info();
  assert.deepEqual(info.browser, { sealed: true, runsIn: 'machine container', images: ['browser'] });
  const m = await client.rent({ payer: createIdentity().id }); // default image is the browser image
  assert.equal(m.rent.image, 'browser');
  const name = prefix + m.machineId;
  const cid = containerId(name);
  assert.match(cid, /^[0-9a-f]{64}$/);

  // (2) a page load works through the egress route; the name is resolved by the proxy
  let o;
  for (let i = 0; i < 20; i++) { // the sidecar forwarder may still be starting
    try { o = await m.browserOpen(`http://site.test:${site.port}/page?n=1`); break; } catch { await sleep(500); }
  }
  assert.equal(o.title, 'Egress Page');
  assert.equal(o.status, 200);
  assert.equal(o.sealed, undefined, 'sealed responses carry no warning fields');
  const hit = site.hits.find((h) => h.path === '/page?n=1');
  assert.ok(hit, 'the site saw the request');
  assert.equal(hit.host, `site.test:${site.port}`);
  assert.ok(socks.outPorts.has(hit.remotePort), 'the request reached the site from the egress proxy, not directly');
  assert.ok(socks.requests.some((r) => r.host === 'site.test' && r.atyp === 3), 'the browser sent the name to the proxy (no local DNS)');
  await m.browserType('#q', 'sealed');
  await m.browserClick('#b');
  assert.match((await m.browserText()).text, /typed sealed/);
  const png = await m.browserScreenshot();
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // (1) Chromium is in the container's process list, and on the host it lives in the
  // container's cgroup and is not a child of the node process
  const ps = await m.exec('ps -o pid,user,args');
  assert.match(ps.stdout, /^\s*\d+\s+1000\s+\/usr\/lib\/chromium\/chromium .*--remote-debugging-pipe/m);
  const procs = hostProcs();
  const chrome = procs.filter((p) => p.cmd.startsWith('/usr/lib/chromium/chromium'));
  const ours = chrome.filter((p) => p.cgroup.includes(cid));
  assert.ok(ours.length >= 3, 'browser, renderer and utility processes of this machine');
  for (const p of ours) assert.equal(descendsFrom(procs, p.pid, process.pid), false, 'not a host child of the node process');
  assert.equal(procs.filter((p) => descendsFrom(procs, p.pid, process.pid) && /chrom/.test(p.cmd.split(' ')[0])).length, 0, 'no browser binary under the node process');
  // the profile is a path in the machine's /tmp, which does not exist on the host
  const profile = /--user-data-dir=(\S+)/.exec(ours[0].cmd)[1];
  assert.match(profile, /^\/tmp\/\.browser-[0-9a-f]{16}$/);
  assert.equal(fs.existsSync(profile), false);
  assert.match((await m.exec(`ls -d ${profile} && grep -c ' /tmp tmpfs' /proc/mounts`)).stdout, /\.browser-.*\n1\n/);

  // (6) the browser is inside the machine's cgroup limits
  const cg = await m.exec('cat /sys/fs/cgroup/pids/pids.current /sys/fs/cgroup/pids/pids.max /sys/fs/cgroup/memory/memory.limit_in_bytes');
  const [pidsNow, pidsMax, memLimit] = cg.stdout.trim().split('\n');
  assert.equal(pidsMax, '256');
  assert.equal(Number(memLimit), 256 * 1024 * 1024);
  assert.ok(Number(pidsNow) > 20, 'the browser threads count toward the machine pids limit');
  for (const p of ours) {
    const memLine = p.cgroup.split('\n').find((l) => /:memory:/.test(l));
    assert.match(memLine, new RegExp(cid), 'memory cgroup is the container one');
  }

  // (5) destroy the machine: no browser process, socket, profile or temp dir remains
  const hostDir = path.join(browserRunDir, prefix, m.machineId);
  assert.ok(fs.existsSync(hostDir), 'bookkeeping dir exists while the browser runs');
  assert.deepEqual(fs.readdirSync(path.join(hostDir, 'profile')), [], 'the host side profile stub stays empty');
  const egressDir = path.join(os.tmpdir(), 'tangent-compute-egress', m.machineId);
  await m.stop();
  await sleep(500);
  const after = hostProcs();
  assert.equal(after.filter((p) => p.cgroup.includes(cid)).length, 0, 'no process left in the machine cgroup');
  assert.equal(after.filter((p) => p.cmd.includes(name)).length, 0, 'no docker exec client left for the machine');
  assert.equal(after.filter((p) => ours.some((o2) => o2.pid === p.pid) && p.cmd.startsWith('/usr/lib/chromium')).length, 0);
  assert.equal(fs.existsSync(hostDir), false, 'browser bookkeeping dir removed');
  assert.equal(fs.existsSync(egressDir), false, 'egress socket dir removed');
  assert.equal(docker('ps', '-aq', '--filter', `name=${name}`).stdout.trim(), '', 'container and sidecar removed');
});

test('sealed browser: no egress or a stopped forwarder means no network; host loopback and metadata are unreachable', { skip, timeout: 300_000 }, async (t) => {
  const site = await startSite();
  // a host loopback service the browser must never reach
  const hostOnly = await startSite();
  const hostOnlyLo = await new Promise((r) => { const s = net.createServer((c) => { hostOnly.hits.push({ path: 'raw' }); c.destroy(); }); s.listen(0, '127.0.0.1', () => r(s)); });
  const socks = await startSocks({ names: { 'site.test': '127.0.0.1' }, allowPorts: [site.port] });
  const plain = await startNode({ driver: make(), creditLimitSeconds: 600 });
  const egress = await startNode({ driver: make(), creditLimitSeconds: 600, egressProxy: { socksHost: '127.0.0.1', socksPort: socks.port } });
  t.after(async () => { await plain.close(); await egress.close(); await socks.close(); await site.close(); await hostOnly.close(); hostOnlyLo.close(); });

  // (3a) egress disabled: the machine has no network, the browser reaches nothing
  const a = await createComputeClient({ baseUrl: plain.url }).rent({ payer: createIdentity().id, image: 'browser' });
  const targets = [
    `http://${hostIp}:${site.port}/page?n=direct`,          // the test site by host address
    `http://site.test:${site.port}/page?n=name`,              // by name
    `http://127.0.0.1:${hostOnlyLo.address().port}/`,       // (4) host loopback service
    'http://169.254.169.254/latest/meta-data/',             // (4) cloud metadata
    'http://1.1.1.1/',
  ];
  for (const u of targets) {
    const r = await openFails(a, u);
    assert.equal(r.failed, true, `${u} must fail`);
    assert.match(r.message, /ERR_|not allowed/, u);
  }
  assert.equal(site.hits.length, 0, 'the site saw nothing');
  assert.equal(hostOnly.hits.length, 0, 'the host loopback service saw nothing');
  // the browser itself works (data URL) and file URLs stay refused
  assert.equal((await a.browserOpen('data:text/html,<title>local</title>')).title, 'local');
  await assert.rejects(a.browserOpen('file:///etc/passwd'), (e) => e.status === 400);

  // (4) with egress: loopback stays the machine's own, metadata only via the proxy (refused there)
  const b = await createComputeClient({ baseUrl: egress.url }).rent({ payer: createIdentity().id, image: 'browser' });
  let ok;
  for (let i = 0; i < 20 && !ok; i++) { const r = await openFails(b, `http://site.test:${site.port}/page?n=warm`); if (!r.failed) ok = r.r; else await sleep(500); }
  assert.equal(ok.title, 'Egress Page');
  const before = socks.requests.length;
  for (const u of [`http://127.0.0.1:${hostOnlyLo.address().port}/`, `http://localhost:${hostOnly.port}/page`, 'http://169.254.169.254/latest/meta-data/', `http://${hostIp}:${hostOnly.port}/page`]) {
    const r = await openFails(b, u);
    assert.equal(r.failed, true, `${u} must fail`);
  }
  assert.equal(hostOnly.hits.length, 0, 'the host loopback service saw nothing');
  const seen = socks.requests.slice(before).map((r) => r.host);
  // Chromium never proxies loopback or link local (169.254/16) addresses, so those
  // were tried directly inside the machine network namespace, which has no route
  // to them (they failed above) and nothing was sent to the proxy for them
  assert.ok(!seen.includes('169.254.169.254'));
  assert.ok(seen.includes(hostIp), 'other addresses go to the egress proxy (which refused this one)');
  assert.ok(!seen.includes('127.0.0.1') && !seen.includes('localhost'), 'loopback is the machine own loopback, not sent out');

  // (3b) stop the forwarder (kill the egress sidecar): nothing loads any more
  const hitsBefore = site.hits.length;
  const sidecar = prefix + b.machineId + '-net';
  assert.equal(docker('kill', sidecar).status, 0);
  const r = await openFails(b, `http://site.test:${site.port}/page?n=after-stop`);
  assert.equal(r.failed, true);
  assert.equal(site.hits.length, hitsBefore, 'the site saw nothing after the forwarder stopped');
  await a.stop(); await b.stop();
});

test('sealed browser: memory limit applies to the browser; two machines are isolated', { skip, timeout: 300_000 }, async (t) => {
  const site = await startSite();
  const socks = await startSocks({ names: { 'site.test': '127.0.0.1' }, allowPorts: [site.port] });
  const node = await startNode({ driver: make(), creditLimitSeconds: 600, egressProxy: { socksHost: '127.0.0.1', socksPort: socks.port } });
  t.after(async () => { await node.close(); await socks.close(); await site.close(); });
  const client = createComputeClient({ baseUrl: node.url });
  const a = await client.rent({ payer: createIdentity().id, image: 'browser' });
  const b = await client.rent({ payer: createIdentity().id, image: 'browser' });
  const warm = async (m) => { for (let i = 0; i < 20; i++) { const r = await openFails(m, `http://site.test:${site.port}/page?n=w`); if (!r.failed) return r.r; await sleep(500); } throw new Error('egress did not come up'); };
  await warm(a); await warm(b);

  // (7) cookies of machine A are not in machine B
  await a.browserOpen(`http://site.test:${site.port}/set`);
  assert.match((await a.browserOpen(`http://site.test:${site.port}/cookie`)).title, /cookie/);
  assert.match((await a.browserText()).text, /cookie=\[owner=machine-a\]/);
  await b.browserOpen(`http://site.test:${site.port}/cookie`);
  assert.match((await b.browserText()).text, /cookie=\[\]/);
  // a service on A's loopback is reachable from A's browser only
  a.exec('while :; do printf "HTTP/1.0 200 OK\\r\\nContent-Type: text/html\\r\\n\\r\\n<title>only-a</title>" | nc -l -p 8080 >/dev/null 2>&1; done', { timeoutMs: 120_000 }).catch(() => {});
  let own;
  for (let i = 0; i < 20 && !own; i++) { const r = await openFails(a, 'http://127.0.0.1:8080/'); if (!r.failed) own = r.r; else await sleep(300); }
  assert.equal(own.title, 'only-a');
  assert.equal((await openFails(b, 'http://127.0.0.1:8080/')).failed, true);
  // each machine sees only its own browser processes, in its own cgroup
  const psA = (await a.exec('ps -o pid,args | grep -c "[/]usr/lib/chromium/chromium"')).stdout.trim();
  const psB = (await b.exec('ps -o pid,args | grep -c "[/]usr/lib/chromium/chromium"')).stdout.trim();
  const procs = hostProcs().filter((p) => p.cmd.startsWith('/usr/lib/chromium/chromium'));
  assert.equal(Number(psA), procs.filter((p) => p.cgroup.includes(containerId(prefix + a.machineId))).length);
  assert.equal(Number(psB), procs.filter((p) => p.cgroup.includes(containerId(prefix + b.machineId))).length);

  // (6) a page that eats memory hits the machine's 256 MB limit, not the host
  const oomKills = async () => Number(/oom_kill (\d+)/.exec((await b.exec('cat /sys/fs/cgroup/memory/memory.oom_control')).stdout)[1]);
  const killsBefore = await oomKills();
  await b.browserOpen(`http://site.test:${site.port}/hog`).catch(() => {});
  let killsAfter = killsBefore;
  for (let i = 0; i < 40 && killsAfter === killsBefore; i++) { await sleep(500); killsAfter = await oomKills(); }
  const maxUse = Number((await b.exec('cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes')).stdout);
  assert.ok(killsAfter > killsBefore, 'the machine cgroup OOM killer stopped the browser process');
  assert.ok(maxUse <= 256 * 1024 * 1024, 'usage never went above the limit');
  // the browser recovers (a crashed tab or browser is started again on the next call)
  let back;
  for (let i = 0; i < 10 && !back; i++) { const r = await openFails(b, `http://site.test:${site.port}/page?n=again`); if (!r.failed) back = r.r; else await sleep(1000); }
  assert.equal(back?.title, 'Egress Page');
  await a.stop(); await b.stop();
});

test('sealed browser over MCP with per second billing and autopay', { skip, timeout: 300_000 }, async (t) => {
  const site = await startSite();
  const socks = await startSocks({ names: { 'site.test': '127.0.0.1' }, allowPorts: [site.port] });
  const node = await startNode({ driver: make(), tickMs: 100, creditLimitSeconds: 1, egressProxy: { socksHost: '127.0.0.1', socksPort: socks.port } });
  const app = express();
  const mcpRouter = createMcpHttpRouter({ nodeUrl: node.url, payer: fakePayer(), autopayIntervalMs: 200 });
  app.use('/mcp', mcpRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const mcp = new Client({ name: 'test-agent', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`)));
  t.after(async () => { await mcp.close(); await mcpRouter.closeAll(); srv.closeAllConnections(); srv.close(); await node.close(); await socks.close(); await site.close(); });
  const call = (name, args = {}) => mcp.callTool({ name, arguments: args });
  const parse = (r) => JSON.parse(r.content[0].text);

  const rent = parse(await call('rent_computer', {}));
  assert.equal(rent.image, 'browser');
  assert.equal(rent.sealed, true);
  let o;
  for (let i = 0; i < 20; i++) { const r = await call('browser_open', { url: `http://site.test:${site.port}/page?n=mcp` }); if (!r.isError) { o = parse(r); break; } await sleep(500); }
  assert.equal(o.title, 'Egress Page');
  await call('browser_type', { selector: '#q', text: 'agent' });
  await call('browser_click', { selector: '#b' });
  assert.match((await call('browser_read')).content[0].text, /typed agent/);
  const shot = await call('browser_screenshot');
  assert.equal(shot.content.length, 1, 'sealed: image only, no warning');
  assert.equal(shot.content[0].type, 'image');
  // credit limit is 1 s; autopay keeps the machine running while the browser is used
  for (let i = 0; i < 3; i++) { await call('browser_read'); await sleep(800); }
  const bal = parse(await call('balance'));
  assert.equal(bal.machines[0].state, 'running');
  assert.ok(BigInt(bal.machines[0].usage.milliseconds) >= 2000n, 'billed by elapsed time');
  assert.ok(BigInt(bal.machines[0].usage.paidLamports) >= BigInt(bal.machines[0].usage.owedLamports));
  assert.ok(node.accepted.length >= 1, 'vouchers were paid');
  assert.equal(parse(await call('stop_computer')).state, 'stopped');
});

test('sealed browser: a machine image without a browser answers 409, and a paused machine 402', { skip, timeout: 180_000 }, async (t) => {
  const node = await startNode({ driver: make(), tickMs: 100, creditLimitSeconds: 1, graceMs: 60_000 });
  t.after(() => node.close());
  const client = createComputeClient({ baseUrl: node.url });
  if ((await probe.images()).includes('alpine')) {
    const m = await client.rent({ payer: createIdentity().id, image: 'alpine' });
    await assert.rejects(m.browserOpen('data:text/html,x'), (e) => e.status === 409 && /no browser/.test(e.message));
    await m.stop();
  }
  // unpaid: the machine (and its browser) is paused, browser calls get 402 until a voucher
  const wallet = fakePayer();
  const m = await client.rent({ payer: wallet.identityFor(node.identity.id).id, image: 'browser' });
  const pay = createAutopay({ machine: m, nodeId: node.identity.id, payer: wallet, intervalMs: 200, prepaySeconds: 1 });
  await pay.payNow(); pay.start();
  assert.equal((await m.browserOpen('data:text/html,<title>paid</title>')).title, 'paid');
  pay.stop();
  for (let i = 0; i < 40 && (await m.status()).state !== 'paused'; i++) await sleep(100);
  assert.equal((await m.status()).state, 'paused');
  assert.equal(docker('inspect', '-f', '{{.State.Paused}}', prefix + m.machineId).stdout.trim(), 'true', 'the whole container, browser included, is frozen');
  await assert.rejects(m.browserText(), (e) => e.status === 402);
  await pay.payNow();
  for (let i = 0; i < 40 && (await m.status()).state !== 'running'; i++) await sleep(100);
  assert.equal((await m.browserText()).title, 'paid');
  await m.stop();
});
