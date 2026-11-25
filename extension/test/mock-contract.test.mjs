// Keeps the mock honest to app/CONTROL-API.md, so tests against it mean something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockApp } from './mock-app.mjs';

function req(port, { method = 'GET', path = '/v1/hello', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(body)); } else r.end();
  });
}

test('host and origin rules', async () => {
  const app = await startMockApp({ port: 0, socksPort: 0 });
  const p = app.port;
  try {
    assert.equal((await req(p)).status, 200);
    assert.deepEqual((await req(p)).body, { app: 'tangent', version: '0.0.0-mock', api: 1 });
    assert.equal((await req(p, { headers: { host: `localhost:${p}` } })).status, 200);
    assert.equal((await req(p, { headers: { host: 'evil.example:80' } })).status, 403, 'DNS rebinding blocked');
    assert.equal((await req(p, { headers: { host: '127.0.0.1' } })).status, 403);
    assert.equal((await req(p, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await req(p, { headers: { origin: 'null' } })).status, 403);
    const ok = await req(p, { headers: { origin: 'chrome-extension://abcdef' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'chrome-extension://abcdef');
    const pre = await req(p, { method: 'OPTIONS', path: '/v1/status', headers: { origin: 'chrome-extension://abcdef' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers['access-control-allow-headers'], /authorization/);
    assert.match(pre.headers['access-control-allow-headers'], /content-type/);
  } finally { await app.close(); }
});

test('auth, pairing, one time token, status shape, open', async () => {
  const app = await startMockApp({ port: 0, socksPort: 0, approve: 'manual', connectDelayMs: 20 });
  const p = app.port;
  try {
    assert.deepEqual(await req(p, { path: '/v1/status' }).then((r) => [r.status, r.body]), [401, { error: 'unpaired' }]);
    assert.equal((await req(p, { path: '/v1/status', headers: { authorization: 'Bearer nope' } })).status, 401);
    const pr = await req(p, { method: 'POST', path: '/v1/pair', body: { client: 'Tangent for Chrome' } });
    const id = pr.body.request;
    assert.equal((await req(p, { path: `/v1/pair/${id}` })).body.state, 'waiting');
    app.approve(id);
    const got = await req(p, { path: `/v1/pair/${id}` });
    assert.equal(got.body.state, 'approved');
    assert.match(got.body.token, /^[A-Za-z0-9_-]{43}$/, '32 bytes base64url');
    assert.equal((await req(p, { path: `/v1/pair/${id}` })).status, 404, 'forgotten after the first read');
    const auth = { authorization: `Bearer ${got.body.token}` };
    const st = (await req(p, { path: '/v1/status', headers: auth })).body;
    assert.deepEqual(Object.keys(st).sort(), ['connected', 'connecting', 'error', 'hops', 'needsBalance', 'since', 'socks', 'usage']);
    assert.equal(st.socks, null);
    assert.deepEqual(st.hops, []);
    const c = (await req(p, { method: 'POST', path: '/v1/connect', headers: auth, body: {} })).body;
    assert.equal(c.connecting, true);
    await new Promise((r) => setTimeout(r, 80));
    const on = (await req(p, { path: '/v1/status', headers: auth })).body;
    assert.equal(on.connected, true);
    assert.equal(on.hops.length, 3);
    assert.equal(on.socks.host, '127.0.0.1');
    assert.ok(on.since > 0);
    assert.deepEqual((await req(p, { method: 'POST', path: '/v1/open', headers: auth, body: { view: 'wallet' } })).body, { ok: true });
    assert.equal((await req(p, { method: 'POST', path: '/v1/open', headers: auth, body: { view: 'nope' } })).status, 400);
    const off = (await req(p, { method: 'POST', path: '/v1/disconnect', headers: auth, body: {} })).body;
    assert.equal(off.connected, false);
    assert.equal(off.socks, null);
  } finally { await app.close(); }
});
