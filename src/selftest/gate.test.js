// The money gate in the coordinator app: closed while the self test has not passed, open after.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createMemoryStore } from '../storage/index.js';
import { ensureKeys } from '../keys.js';
import { loadConfig } from '../config.js';
import { createApp } from '../coord/app.js';
import { createIdentity } from '../core/index.js';

async function serve(selftest) {
  const store = await createMemoryStore();
  const keys = await ensureKeys({ store });
  const config = loadConfig({ TRUST_PROXY: 'false' });
  const router = express.Router();
  const hits = [];
  router.use((req, res) => { hits.push(`${req.method} ${req.path}`); res.json({ ok: true }); });
  const pay = { router, redeemVoucher: async () => ({ ok: true, credited: '0' }), earnings: async () => null };
  const app = createApp({ store, pay, config, keys, selftest });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, cache: r.headers.get('cache-control'), json: await r.json() };
  };
  return { call, hits, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test('money actions answer SELFTEST_PENDING until the self test is clear; reads stay open', async () => {
  let clear = false;
  const report = { state: 'waiting_for_funds', clear: false, checks: [] };
  const selftest = { clear: () => clear, report: () => report, summary: () => ({ state: report.state, clear }) };
  const s = await serve(selftest);
  try {
    const gated = [
      ['GET', '/api/pay/deposit/' + createIdentity().id],
      ['POST', '/api/pay/deposit/build', {}],
      ['POST', '/api/pay/issue', {}],
      ['POST', '/api/pay/redeem', {}],
      ['POST', '/api/pay/withdraw', {}],
      ['POST', '/api/vouchers/redeem', {}],
      ['POST', '/api/offgrid/claim', {}],
    ];
    for (const [m, p, b] of gated) {
      const r = await s.call(m, p, b);
      assert.equal(r.status, 503, `${m} ${p}`);
      assert.equal(r.json.error, 'SELFTEST_PENDING');
      assert.equal(r.cache, 'no-store');
    }
    assert.equal(s.hits.length, 0, 'the pay router never saw a gated call');
    for (const [m, p, b] of [['GET', '/api/pay/keys'], ['POST', '/api/pay/challenge', {}], ['POST', '/api/pay/balance', {}], ['GET', '/api/pay/account/x']]) {
      const r = await s.call(m, p, b);
      assert.equal(r.status, 200, `${m} ${p} stays open`);
    }
    const h = await s.call('GET', '/api/health');
    assert.equal(h.json.selftest.state, 'waiting_for_funds');
    assert.equal(h.json.selftest.moneyActions, 'closed');
    const st = await s.call('GET', '/api/selftest');
    assert.equal(st.cache, 'no-store');
    assert.equal(st.json.enabled, true);
    assert.equal(st.json.moneyActions, 'closed');
    assert.equal(st.json.report.state, 'waiting_for_funds');

    clear = true;
    report.state = 'passed';
    const r = await s.call('POST', '/api/pay/issue', {});
    assert.equal(r.status, 200);
    assert.equal((await s.call('GET', '/api/health')).json.selftest.moneyActions, 'open');
  } finally { await s.close(); }
});

test('without a self test (memory storage or no Helius key) nothing is gated and /api/selftest says why', async () => {
  const s = await serve(null);
  try {
    assert.equal((await s.call('POST', '/api/pay/issue', {})).status, 200);
    const st = await s.call('GET', '/api/selftest');
    assert.equal(st.json.enabled, false);
    assert.match(st.json.reason, /MONGO_URI and HELIUS_API_KEY/);
    assert.equal((await s.call('GET', '/api/health')).json.selftest.state, 'off');
  } finally { await s.close(); }
});
