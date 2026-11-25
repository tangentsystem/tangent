// Every rule of app/CONTROL-API.md, against the real control API and pairing store.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createControlApi } from '../../core/control-api.js';
import { createPairing, REQUEST_TTL_MS } from '../../core/pairing.js';

function req(port, { method = 'GET', path: p = '/v1/hello', host, origin, token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== null) h.host = host || `127.0.0.1:${port}`;
    if (origin) h.origin = origin;
    if (token) h.authorization = `Bearer ${token}`;
    let data = null;
    if (body !== undefined) { data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function fakeSession() {
  let connected = false;
  const calls = [];
  const status = () => ({
    connected, connecting: false, socks: connected ? { host: '127.0.0.1', port: 47612 } : null,
    hops: connected ? [{ id: 'A' }, { id: 'B' }, { id: 'C' }] : [], usage: { bytesUp: 1, bytesDown: 2 },
    since: connected ? 1795618440414 : null, needsBalance: false, error: null,
  });
  return { calls, status, connect() { calls.push('connect'); connected = true; return status(); }, async disconnect() { calls.push('disconnect'); connected = false; return status(); } };
}

async function setup(t, { now } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-ctl-'));
  const opened = [];
  const session = fakeSession();
  const pairing = createPairing({ dataDir: dir, now });
  const api = createControlApi({ port: 0, version: '9.8.7', session, pairing, onOpen: (v) => opened.push(v) });
  const port = await api.start();
  t.after(async () => { await api.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, port, session, pairing, opened, api };
}

async function pairToken(port, pairing, client = 'Tangent for Chrome') {
  const r = await req(port, { method: 'POST', path: '/v1/pair', body: { client } });
  assert.equal(r.status, 200);
  assert.ok(pairing.approve(r.json.request));
  const g = await req(port, { path: `/v1/pair/${r.json.request}` });
  return g.json.token;
}

test('listens on 127.0.0.1 only', async (t) => {
  const { api } = await setup(t);
  assert.ok(api.port > 0);
  // the default port in the contract
  assert.equal(createControlApi({ session: fakeSession(), pairing: {}, version: '1' }).port, 47611);
});

test('hello answers app, version and api', async (t) => {
  const { port } = await setup(t);
  const r = await req(port);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { app: 'tangent', version: '9.8.7', api: 1 });
  assert.match(r.headers['content-type'], /application\/json/);
});

test('Host must be 127.0.0.1:<port> or localhost:<port>', async (t) => {
  const { port } = await setup(t);
  assert.equal((await req(port, { host: `localhost:${port}` })).status, 200);
  assert.equal((await req(port, { host: `LOCALHOST:${port}` })).status, 200);
  for (const host of [`evil.example:${port}`, '127.0.0.1', 'localhost', `127.0.0.1:${port + 1}`, `[::1]:${port}`, `0.0.0.0:${port}`, `127.0.0.1.nip.io:${port}`]) {
    const r = await req(port, { host });
    assert.equal(r.status, 403, host);
    assert.deepEqual(r.json, { error: 'forbidden_host' });
  }
  assert.equal((await req(port, { host: null })).status, 403, 'no Host header');
  // the rule applies to every route, also with a valid token
  assert.equal((await req(port, { path: '/v1/status', host: `evil.example:${port}` })).status, 403);
});

test('Origin: none or a browser extension; anything else is refused', async (t) => {
  const { port } = await setup(t);
  const ok = await req(port, { origin: 'chrome-extension://abcdefghijklmnop' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
  const moz = await req(port, { origin: 'moz-extension://1234-5678' });
  assert.equal(moz.status, 200);
  assert.equal(moz.headers['access-control-allow-origin'], 'moz-extension://1234-5678');
  for (const origin of ['https://evil.example', 'http://127.0.0.1:47611', 'null', 'file://', 'chrome://settings', 'https://chrome-extension.evil']) {
    const r = await req(port, { origin });
    assert.equal(r.status, 403, origin);
    assert.deepEqual(r.json, { error: 'forbidden_origin' });
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  const none = await req(port);
  assert.equal(none.status, 200);
  assert.equal(none.headers['access-control-allow-origin'], undefined);
  // a page cannot pair either
  assert.equal((await req(port, { method: 'POST', path: '/v1/pair', origin: 'https://evil.example', body: { client: 'x' } })).status, 403);
});

test('OPTIONS preflights are answered with the allowed headers', async (t) => {
  const { port } = await setup(t);
  const origin = 'chrome-extension://abc';
  const r = await req(port, { method: 'OPTIONS', path: '/v1/status', origin, headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.ok(r.status === 204 || r.status === 200);
  assert.equal(r.headers['access-control-allow-origin'], origin);
  assert.equal(r.headers['access-control-allow-headers'], 'authorization, content-type');
  assert.match(r.headers['access-control-allow-methods'], /POST/);
  const bad = await req(port, { method: 'OPTIONS', path: '/v1/status', origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
});

test('everything except hello and pairing needs a paired token', async (t) => {
  const { port } = await setup(t);
  for (const [method, p] of [['GET', '/v1/status'], ['POST', '/v1/connect'], ['POST', '/v1/disconnect'], ['POST', '/v1/open']]) {
    const r = await req(port, { method, path: p, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, p);
    assert.deepEqual(r.json, { error: 'unpaired' });
    const w = await req(port, { method, path: p, token: 'not-a-token', body: method === 'POST' ? {} : undefined });
    assert.equal(w.status, 401);
    assert.deepEqual(w.json, { error: 'unpaired' });
  }
  const basic = await req(port, { path: '/v1/status', headers: { authorization: 'Basic abc' } });
  assert.equal(basic.status, 401);
});

test('pairing: waiting, approved with a token once, then forgotten', async (t) => {
  const { port, pairing, dir } = await setup(t);
  const events = [];
  const r = await req(port, { method: 'POST', path: '/v1/pair', body: { client: 'Tangent for Chrome' } });
  assert.equal(r.status, 200);
  assert.match(r.json.request, /^[A-Za-z0-9_-]{10,}$/);
  assert.deepEqual(pairing.pending().map((p) => p.client), ['Tangent for Chrome']);
  assert.deepEqual((await req(port, { path: `/v1/pair/${r.json.request}` })).json, { state: 'waiting' });
  assert.ok(pairing.approve(r.json.request));
  assert.deepEqual(pairing.pending(), []);
  const g = await req(port, { path: `/v1/pair/${r.json.request}` });
  assert.equal(g.status, 200);
  assert.equal(g.json.state, 'approved');
  assert.match(g.json.token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  const again = await req(port, { path: `/v1/pair/${r.json.request}` });
  assert.equal(again.status, 404, 'the request is forgotten after the token is read');
  // the token works
  const s = await req(port, { path: '/v1/status', token: g.json.token });
  assert.equal(s.status, 200);
  // only a hash is on disk
  const file = await fs.readFile(path.join(dir, 'control-tokens.json'), 'utf8');
  assert.ok(!file.includes(g.json.token));
  assert.equal(JSON.parse(file).tokens.length, 1);
  assert.equal(events.length, 0);
  assert.equal((await req(port, { path: '/v1/pair/unknownid123' })).status, 404);
});

test('pairing: denied stays denied', async (t) => {
  const { port, pairing } = await setup(t);
  const r = await req(port, { method: 'POST', path: '/v1/pair', body: { client: 'Tangent for Chrome' } });
  assert.ok(pairing.deny(r.json.request));
  assert.deepEqual((await req(port, { path: `/v1/pair/${r.json.request}` })).json, { state: 'denied' });
  assert.deepEqual((await req(port, { path: `/v1/pair/${r.json.request}` })).json, { state: 'denied' });
  assert.equal(pairing.approve(r.json.request), false, 'a denied request cannot be approved later');
});

test('pairing: a request expires after 2 minutes', async (t) => {
  let now = 1_000_000;
  const { port, pairing } = await setup(t, { now: () => now });
  const r = await req(port, { method: 'POST', path: '/v1/pair', body: { client: 'Tangent for Chrome' } });
  now += REQUEST_TTL_MS - 1000;
  assert.deepEqual((await req(port, { path: `/v1/pair/${r.json.request}` })).json, { state: 'waiting' });
  now += 2000;
  assert.deepEqual((await req(port, { path: `/v1/pair/${r.json.request}` })).json, { state: 'expired' });
  assert.equal(pairing.approve(r.json.request), false, 'an expired request cannot be approved');
  assert.equal(REQUEST_TTL_MS, 120_000);
});

test('pairing: too many waiting requests are refused, bad bodies are refused', async (t) => {
  const { port } = await setup(t);
  for (let i = 0; i < 8; i++) assert.equal((await req(port, { method: 'POST', path: '/v1/pair', body: { client: 'x' + i } })).status, 200);
  const busy = await req(port, { method: 'POST', path: '/v1/pair', body: { client: 'nine' } });
  assert.equal(busy.status, 429);
  assert.deepEqual(busy.json, { error: 'busy' });
  const bad = await req(port, { method: 'POST', path: '/v1/pair', body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.json.error, 'string');
  const big = await req(port, { method: 'POST', path: '/v1/pair', body: { client: 'x'.repeat(20_000) } });
  assert.equal(big.status, 413);
});

test('status has exactly the contract shape; connect and disconnect answer it', async (t) => {
  const { port, pairing, session } = await setup(t);
  const token = await pairToken(port, pairing);
  const keys = ['connected', 'connecting', 'socks', 'hops', 'usage', 'since', 'needsBalance', 'error'];
  const s0 = (await req(port, { path: '/v1/status', token })).json;
  assert.deepEqual(Object.keys(s0).sort(), [...keys].sort());
  assert.equal(s0.connected, false);
  assert.equal(s0.socks, null);
  assert.deepEqual(s0.hops, []);
  assert.deepEqual(Object.keys(s0.usage).sort(), ['bytesDown', 'bytesUp']);
  const c = await req(port, { method: 'POST', path: '/v1/connect', token });
  assert.equal(c.status, 200);
  assert.equal(c.json.connected, true);
  assert.deepEqual(c.json.socks, { host: '127.0.0.1', port: 47612 });
  assert.deepEqual(c.json.hops, [{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
  assert.equal(typeof c.json.since, 'number');
  const d = await req(port, { method: 'POST', path: '/v1/disconnect', token, origin: 'chrome-extension://abc' });
  assert.equal(d.status, 200);
  assert.equal(d.json.connected, false);
  assert.equal(d.headers['access-control-allow-origin'], 'chrome-extension://abc');
  assert.deepEqual(session.calls, ['connect', 'disconnect']);
  assert.equal((await req(port, { method: 'GET', path: '/v1/connect', token })).status, 405);
});

test('open brings a view to the front; unknown views are refused', async (t) => {
  const { port, pairing, opened } = await setup(t);
  const token = await pairToken(port, pairing);
  for (const view of ['internet', 'wallet', 'computers', 'network']) {
    const r = await req(port, { method: 'POST', path: '/v1/open', token, body: { view } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  }
  assert.deepEqual(opened, ['internet', 'wallet', 'computers', 'network']);
  const bad = await req(port, { method: 'POST', path: '/v1/open', token, body: { view: 'settings' } });
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.json.error, 'string');
});

test('tokens survive a restart and can be removed', async (t) => {
  const { port, pairing, dir } = await setup(t);
  const token = await pairToken(port, pairing, 'Tangent for Chrome');
  const again = createPairing({ dataDir: dir });
  assert.ok(again.check(token), 'a new app run knows the token');
  assert.equal(again.check(token + 'x'), false);
  const [app] = again.list();
  assert.equal(app.client, 'Tangent for Chrome');
  assert.ok(pairing.remove(pairing.list()[0].id));
  const r = await req(port, { path: '/v1/status', token });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: 'unpaired' });
  assert.equal(createPairing({ dataDir: dir }).check(token), false, 'removed for good');
});

test('unknown routes answer a short error code', async (t) => {
  const { port, pairing } = await setup(t);
  const token = await pairToken(port, pairing);
  const r = await req(port, { path: '/v2/status', token });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: 'not_found' });
});
