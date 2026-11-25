// End to end: a whole local network (coordinator with memory store, simulated Privacy Rings,
// LiteSVM chain, 4 node processes), driven through the app's headless core and its control
// API, the way the desktop app drives it. Nothing here talks to the live network.
//
//   (a) an EMPTY wallet connects and fetches a page over 3 hops; once the unpaid allowance of
//       its circuit is used, traffic stalls and status says needsBalance
//   (b) a (simulated) deposit: credit is bought by itself, the stalled traffic carries on and
//       is paid, every hop redeems vouchers
//   (c) status, connect and disconnect over the control API with a paired token
//   (d) a computer: rented, a command run, stopped, billed (sealed with Docker, otherwise the
//       node's development driver)
//   (e) the MCP server over HTTP lists its tools and answers balance
//   (f) a withdrawal is accepted and followed until it is sent
//   (g) every key the app made is in backups/
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SocksClient } from 'socks';
import { Keypair } from '@solana/web3.js';
import { startNetwork, waitFor } from '../support/network.js';
import { createCore } from '../../core/index.js';

const DOCKER = Boolean(process.env.DOCKER_HOST);

function api(port, method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// GET through the app's local proxy. -> { head, body, complete }
async function socksGet(socksPort, destPort, p, { idleMs = 20_000 } = {}) {
  const { socket } = await SocksClient.createConnection({ proxy: { host: '127.0.0.1', port: socksPort, type: 5 }, command: 'connect', destination: { host: '127.0.0.1', port: destPort }, timeout: 30_000 });
  return new Promise((resolve) => {
    const chunks = []; let timer = null;
    const done = (complete) => { clearTimeout(timer); socket.destroy(); const all = Buffer.concat(chunks); const i = all.indexOf('\r\n\r\n'); resolve({ head: i < 0 ? '' : all.subarray(0, i).toString(), body: i < 0 ? Buffer.alloc(0) : all.subarray(i + 4), complete }); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => done(false), idleMs); };
    socket.on('data', (c) => { chunks.push(c); arm(); });
    socket.on('close', () => done(true));
    socket.on('error', () => done(false));
    arm();
    socket.write(`GET ${p} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
  });
}

test('app core end to end against a local network', { timeout: 900_000 }, async (t) => {
  const network = await startNetwork({ compute: DOCKER ? 'docker' : 'dev' });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-app-e2e-'));
  // the usual proxy port is taken: the app must pick another one
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const core = createCore({
    env: { TANGENT_COORDINATOR: network.coordUrl, TANGENT_APP_DATA: data, TANGENT_CONTROL_PORT: '0', TANGENT_SOCKS_PORT: String(taken), TANGENT_MCP_PORT: '0' },
    version: '0.1.0',
  });
  const events = [];
  core.on((name, p) => events.push([name, p]));
  try {
    const { controlPort } = await core.start();
    assert.ok(controlPort > 0);
    const dir = await core.coord.directory();
    const byId = new Map(dir.map((d) => [d.id, d]));
    assert.equal(dir.length, 4);

    // ---- pairing over the control API, approved in the app
    const hello = await api(controlPort, 'GET', '/v1/hello');
    assert.deepEqual(hello.json, { app: 'tangent', version: '0.1.0', api: 1 });
    const pr = await api(controlPort, 'POST', '/v1/pair', { body: { client: 'Tangent for Chrome' } });
    assert.ok(events.some(([n, p]) => n === 'pairing' && p.length === 1), 'the app was told to ask the person');
    assert.ok(core.pairing.approve(pr.json.request));
    const { token } = (await api(controlPort, 'GET', `/v1/pair/${pr.json.request}`)).json;
    assert.ok(token);

    const wallet = await core.wallet.balance();
    assert.equal(wallet.walletLamports, '0', 'a brand new wallet is empty');
    assert.equal(wallet.canPay, false);

    let socksPort;
    await t.test('(a) an empty wallet connects, fetches a page over 3 hops, then stalls and asks for balance', async () => {
      const c = await api(controlPort, 'POST', '/v1/connect', { token });
      assert.equal(c.status, 200);
      assert.ok(c.json.connecting || c.json.connected);
      const s = await waitFor(async () => { const r = (await api(controlPort, 'GET', '/v1/status', { token })).json; return r.connected ? r : null; }, { what: 'connected', timeoutMs: 60_000 });
      assert.deepEqual(Object.keys(s).sort(), ['connected', 'connecting', 'error', 'hops', 'needsBalance', 'since', 'socks', 'usage'].sort());
      assert.equal(s.socks.host, '127.0.0.1');
      assert.notEqual(s.socks.port, taken, 'a free port was used because the usual one was taken');
      socksPort = s.socks.port;
      assert.equal(s.hops.length, 3);
      assert.equal(new Set(s.hops.map((h) => h.id)).size, 3, 'three different nodes');
      for (const h of s.hops) assert.ok(byId.has(h.id), 'every hop is a live node');
      assert.ok(byId.get(s.hops[2].id).roles.includes('exit'), 'the last hop reaches the open web');
      assert.equal(s.needsBalance, false);
      assert.equal(s.error, null);
      assert.equal(typeof s.since, 'number');

      const page = await socksGet(socksPort, network.destPort, '/hello-empty-wallet');
      assert.equal(page.complete, true);
      assert.match(page.body.toString(), /hello through three hops/);
      assert.ok(network.hits.some((h) => h.url === '/hello-empty-wallet'), 'the page was fetched through the exit');
      assert.ok(core.session.targets().includes(`127.0.0.1:${network.destPort}`));
      const credit = await core.wallet.credit();
      assert.equal(credit.accounts().length, 0, 'nothing was bought with an empty wallet');

      // a big download uses up the unpaid allowance (about 1 MB per hop) and stalls
      const big = await socksGet(socksPort, network.destPort, '/big-stall', { idleMs: 12_000 });
      assert.equal(big.complete, false, 'traffic stalled for lack of balance');
      assert.ok(big.body.length > 100_000 && big.body.length < network.big.length, `got ${big.body.length} bytes before the stall`);
      const st = await waitFor(async () => { const r = (await api(controlPort, 'GET', '/v1/status', { token })).json; return r.needsBalance ? r : null; }, { what: 'needsBalance', timeoutMs: 20_000 });
      assert.equal(st.connected, true, 'still connected while it waits for balance');
      assert.ok(st.usage.bytesDown >= big.body.length);
      assert.equal((await core.wallet.balance()).walletLamports, '0');
    });

    await t.test('(b) a deposit: credit is bought by itself and traffic carries on, paid', async () => {
      const before = await Promise.all(network.nodes.map(async (n) => BigInt((await network.nodeApi(n)).vouchers.creditedByKind.relay || 0)));
      network.fund((await core.wallet.info()).address, 100_000_000n);
      await waitFor(async () => (await core.wallet.balance()).canPay, { what: 'deposit credited', timeoutMs: 30_000, every: 500 });
      const st = await waitFor(async () => { const r = (await api(controlPort, 'GET', '/v1/status', { token })).json; return !r.needsBalance ? r : null; }, { what: 'needsBalance off', timeoutMs: 30_000, every: 500 });
      assert.equal(st.connected, true);
      const credit = await core.wallet.credit();
      await waitFor(() => credit.accounts().length >= 3, { what: 'credit bought for the hops', timeoutMs: 30_000 });
      const got = await socksGet(socksPort, network.destPort, '/big-paid', { idleMs: 30_000 });
      assert.equal(got.complete, true);
      assert.equal(createHash('sha256').update(got.body).digest('hex'), createHash('sha256').update(network.big).digest('hex'), '4 MB arrived intact');
      const paid = await waitFor(async () => {
        const now = await Promise.all(network.nodes.map(async (n) => BigInt((await network.nodeApi(n)).vouchers.creditedByKind.relay || 0)));
        const up = now.filter((v, i) => v > before[i]).length;
        return up >= 3 ? now : null;
      }, { what: 'three hops paid', timeoutMs: 60_000, every: 1000 });
      assert.ok(paid.length === 4);
      const w = await core.wallet.balance();
      assert.ok(BigInt(w.walletLamports) < 100_000_000n, 'credit was bought from the wallet');
      assert.ok(BigInt(w.creditLamports) > 0n);
      const s = (await api(controlPort, 'GET', '/v1/status', { token })).json;
      assert.ok(s.usage.bytesDown > network.big.length, 'data used counts what came back');
      assert.ok(s.usage.bytesUp > 0);
    });

    await t.test('(c) disconnect over the control API', async () => {
      const d = await api(controlPort, 'POST', '/v1/disconnect', { token });
      assert.equal(d.status, 200);
      assert.equal(d.json.connected, false);
      assert.equal(d.json.socks, null);
      assert.deepEqual(d.json.hops, []);
      await assert.rejects(socksGet(socksPort, network.destPort, '/after-off'), 'the local proxy is closed');
      const again = await api(controlPort, 'POST', '/v1/connect', { token });
      assert.equal(again.status, 200);
      const s = await waitFor(async () => { const r = (await api(controlPort, 'GET', '/v1/status', { token })).json; return r.connected ? r : null; }, { what: 'connected again' });
      assert.equal(s.hops.length, 3);
      const page = await socksGet(s.socks.port, network.destPort, '/hello-again');
      assert.match(page.body.toString(), /hello through three hops/);
      await core.session.disconnect();
    });

    await t.test(`(d) rent a computer, run a command, stop it, see the bill (${DOCKER ? 'sealed, Docker' : 'development driver, Docker not available'})`, async () => {
      const nodes = await core.computers.nodes();
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].sealed, DOCKER);
      const image = DOCKER ? 'alpine' : nodes[0].images[0];
      assert.ok(nodes[0].images.includes(image));
      const m = await core.computers.rent({ node: nodes[0].id, image, size: 'small' });
      assert.equal(m.state, 'running');
      const out = [];
      const off = core.on((n, p) => { if (n === 'output' && p.id === m.id) out.push(p.text); });
      const r = await core.computers.exec(m.id, 'echo hello from the computer; id -u');
      assert.equal(r.exitCode, 0);
      await new Promise((res) => setTimeout(res, 1500));
      off();
      assert.match(out.join(''), /hello from the computer/);
      if (DOCKER) assert.match(out.join(''), /^1000$/m, 'runs as uid 1000 inside the sealed computer');
      const stopped = await core.computers.stop(m.id);
      assert.equal(stopped.state, 'stopped');
      assert.ok(stopped.bill.seconds > 0);
      assert.ok(BigInt(stopped.bill.owedLamports) > 0n);
      assert.ok(BigInt(stopped.paid) >= BigInt(stopped.bill.owedLamports), 'paid for the time it ran');
      assert.deepEqual(core.computers.list(), []);
    });

    await t.test('(e) the MCP server over HTTP for an AI agent', async () => {
      const st = await core.mcp.start();
      assert.match(st.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.deepEqual(JSON.parse(st.snippet), { mcpServers: { tangent: { type: 'http', url: st.url } } });
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'app-e2e', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(st.url)));
      try {
        const tools = (await client.listTools()).tools.map((x) => x.name);
        for (const name of ['rent_computer', 'exec', 'stop_computer', 'balance']) assert.ok(tools.includes(name), name);
        const bal = await client.callTool({ name: 'balance', arguments: {} });
        assert.ok(!bal.isError, JSON.stringify(bal));
        assert.match(bal.content[0].text, /balance_lamports/);
      } finally { await client.close(); }
      // a web page cannot reach it
      const evil = await fetch(st.url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(evil.status, 403);
      await core.mcp.stop();
      assert.equal(core.mcp.status(), null);
    });

    await t.test('(f) withdraw to a public address, followed until it is sent', async () => {
      const to = Keypair.generate().publicKey.toBase58();
      const w = await core.wallet.withdraw({ to, amount: '0.01', public: true });
      assert.equal(w.lamports, '10000000');
      assert.equal(w.public, true);
      const done = await waitFor(() => { const x = core.wallet.withdrawals().find((y) => y.id === w.id); return x && x.status !== 'pending' ? x : null; }, { what: 'withdrawal sent', timeoutMs: 60_000, every: 500 });
      assert.equal(done.status, 'sent');
      await assert.rejects(core.wallet.withdraw({ to, amount: '50', public: true }), /lower than that amount/);
      await assert.rejects(core.wallet.withdraw({ to: 'nope', amount: '0.01' }));
    });

    await t.test('(g) every key the app made has its backup', async () => {
      const keys = (await fs.readdir(path.join(data, 'keys'))).filter((n) => n.endsWith('.json'));
      const backups = await fs.readdir(path.join(data, 'backups'));
      assert.ok(keys.includes('wallet.json'));
      assert.ok(keys.filter((k) => k.startsWith('acct-')).length >= 4, 'throwaway accounts for the hops and the computer node');
      for (const k of keys) {
        const row = JSON.parse(await fs.readFile(path.join(data, 'keys', k), 'utf8'));
        const b = backups.find((x) => x.startsWith(`${row.label}-`));
        assert.ok(b, `backup of ${k}`);
        assert.equal(JSON.parse(await fs.readFile(path.join(data, 'backups', b), 'utf8')).secret, row.secret);
      }
      const logText = await fs.readFile(path.join(data, 'logs', 'app.log'), 'utf8');
      for (const k of keys) {
        const row = JSON.parse(await fs.readFile(path.join(data, 'keys', k), 'utf8'));
        assert.ok(!logText.includes(row.secret), 'no secret in the log');
      }
    });
  } finally {
    await core.stop().catch(() => {});
    await new Promise((r) => blocker.close(r));
    await network.stop();
    await fs.rm(data, { recursive: true, force: true }).catch(() => {});
  }
});
