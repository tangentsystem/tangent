// Real HTTP through the pay router on a local port.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makePay, fund, keyFor, createIdentity } from './testkit.js';
import { prepareTokens, finalizeTokens, issueRequest, redeemRequest, newAccount, withdrawRequest, balanceRequest } from './client.js';

async function serve(pay) {
  const app = express();
  app.use('/api/pay', pay.router);
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/pay';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('router: deposit, keys, challenge, issue, redeem, account, balance, withdraw over HTTP', async () => {
  const ctx = makePay();
  const http = await serve(ctx.pay);
  try {
    const alice = createIdentity();
    let r = await http.call('GET', '/deposit/' + alice.id);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.equal(r.body.vault.explorer, 'https://solscan.io/account/' + ctx.rings.vaultAddress());
    assert.equal((await http.call('GET', '/deposit/xyz')).status, 400);

    await fund(ctx, alice, 30_000_000n);
    r = await http.call('POST', '/balance', balanceRequest(alice, ctx.now()));
    assert.equal(r.body.balance, '30000000');

    r = await http.call('GET', '/keys');
    assert.equal(r.body.keys.length, 4);
    const key = r.body.keys.find((k) => k.denomination === '10000000');
    const { pending, blinded } = await prepareTokens(key, 2);
    const { body: ch } = await http.call('POST', '/challenge', { wallet: alice.id });
    r = await http.call('POST', '/issue', issueRequest(alice, { challenge: ch.challenge, denomination: '10000000', blinded }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tokens = await finalizeTokens(key, pending, r.body.blindSigs);

    const acct = newAccount();
    r = await http.call('POST', '/redeem', redeemRequest(tokens[0], acct));
    assert.deepEqual([r.status, r.body.balance], [200, '10000000']);
    r = await http.call('POST', '/redeem', redeemRequest(tokens[0], acct));
    assert.deepEqual([r.status, r.body.error], [409, 'TOKEN_SPENT']);
    r = await http.call('GET', '/account/' + acct.id);
    assert.equal(r.body.balance, '10000000');
    r = await http.call('GET', '/account/' + newAccount().id);
    assert.equal(r.status, 404);

    const { body: ch2 } = await http.call('POST', '/challenge', { wallet: alice.id });
    const dest = createIdentity().id;
    r = await http.call('POST', '/withdraw', withdrawRequest(alice, { challenge: ch2.challenge, to: dest, amount: '5000000' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await ctx.pay.processWithdrawals();
    r = await http.call('GET', '/withdraw/' + r.body.id);
    assert.equal(r.body.status, 'sent');
    assert.equal(r.body.to.explorer, 'https://solscan.io/account/' + dest);

    // validation and errors
    r = await http.call('POST', '/issue', { wallet: alice.id });
    assert.deepEqual([r.status, r.body.error], [400, 'BAD_REQUEST']);
    r = await http.call('POST', '/redeem', '{not json');
    assert.equal(r.status, 400);
    assert.equal(r.cache, 'no-store');
    const { body: ch3 } = await http.call('POST', '/challenge', { wallet: alice.id });
    r = await http.call('POST', '/issue', { ...issueRequest(alice, { challenge: ch3.challenge, denomination: '10000000', blinded }), sig: createIdentity().signObject({ x: 1 }) });
    assert.equal(r.status, 401);
  } finally {
    await http.close();
  }
});

test('router: with a sim adapter that is not exposed, nothing about deposits or withdrawals is offered', async () => {
  const ctx = makePay({ config: { payExposeSim: false } });
  const http = await serve(ctx.pay);
  try {
    const w = createIdentity();
    let r = await http.call('GET', '/deposit/' + w.id);
    assert.deepEqual([r.status, r.body.error], [503, 'RINGS_NOT_CONFIGURED']);
    assert.equal(JSON.stringify(r.body).includes(ctx.rings.vaultAddress()), false);
    r = await http.call('POST', '/withdraw', withdrawRequest(w, { challenge: 'x'.repeat(20), to: w.id, amount: '5000' }));
    assert.equal(r.status, 503);
    // keys and accounts still answer
    assert.equal((await http.call('GET', '/keys')).status, 200);
  } finally {
    await http.close();
  }
});
