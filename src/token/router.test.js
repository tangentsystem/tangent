// The token router over real HTTP: not configured, configured, broken config, price outage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Keypair } from '@solana/web3.js';
import { createToken } from './index.js';
import { createSvmConnection } from './testkit/svm-connection.js';
import { writePumpCurve } from './testkit/pump-world.js';

const quiet = { warn() {}, error() {}, info() {} };

async function serve(tok) {
  const app = express();
  app.use('/api/token', tok.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/token`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test('no CA: router says only configured false, every call is a clean not configured state', async () => {
  for (const ca of [undefined, '', '   ']) {
    const tok = createToken({ connection: createSvmConnection(), ca, log: quiet });
    assert.deepEqual(await tok.detect(), { configured: false });
    assert.deepEqual(await tok.stats(), { configured: false });
    assert.deepEqual(await tok.claimFees({ signer: Keypair.generate() }), { configured: false });
    assert.equal(tok.buyUrl(), null);
    const s = await serve(tok);
    const r = await fetch(s.base + '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { configured: false });
    await s.close();
  }
});

test('configured pump coin: full public view with links', async () => {
  const conn = createSvmConnection();
  const creator = Keypair.generate();
  const w = await writePumpCurve(conn, { creator: creator.publicKey, name: 'Pump Coin', symbol: 'PUMPC', curveHolds: 900_000_000_000_000n });
  const ca = w.mint.toBase58();
  const tok = createToken({ connection: conn, ca, log: quiet, solUsd: { get: async () => ({ solUsd: 150 }) } });
  const s = await serve(tok);
  const r = await fetch(s.base + '/');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const b = await r.json();
  assert.equal(b.configured, true);
  assert.equal(b.ca, ca);
  assert.equal(b.platform, 'pumpfun');
  assert.equal(b.stage, 'curve');
  assert.equal(b.symbol, 'PUMPC');
  assert.equal(b.name, 'Pump Coin');
  assert.ok(Math.abs(b.priceUsd - 4.193849021435228e-6) < 1e-15);
  assert.ok(Math.abs(b.marketCapUsd - 4193.849021435228) < 1e-6);
  assert.equal(b.buyUrl, `https://pump.fun/coin/${ca}`);
  assert.deepEqual(b.explorer, { token: `https://solscan.io/token/${ca}`, pool: `https://solscan.io/account/${w.curve.toBase58()}` });
  await s.close();
});

test('SOL/USD outage: price fields null with a reason, nothing invented', async () => {
  const conn = createSvmConnection();
  const w = await writePumpCurve(conn, { creator: Keypair.generate().publicKey });
  const tok = createToken({ connection: conn, ca: w.mint.toBase58(), log: quiet, solUsd: { get: async () => null } });
  const s = await serve(tok);
  const b = await (await fetch(s.base + '/')).json();
  assert.equal(b.priceUsd, null);
  assert.equal(b.marketCapUsd, null);
  assert.equal(b.priceReason, 'sol_usd_unavailable');
  assert.equal(b.platform, 'pumpfun');
  await s.close();
});

test('bad CA, missing connection, RPC failure: configured but unavailable', async () => {
  const bad = createToken({ connection: createSvmConnection(), ca: 'not-a-key', log: quiet });
  let s = await serve(bad);
  let b = await (await fetch(s.base + '/')).json();
  assert.equal(b.configured, true);
  assert.equal(b.available, false);
  assert.equal(b.reason, 'invalid_ca');
  assert.equal(b.priceUsd, null);
  assert.equal(b.buyUrl, null);
  await s.close();

  const ca = Keypair.generate().publicKey.toBase58();
  const noConn = createToken({ connection: null, ca, log: quiet });
  assert.equal((await noConn.detect()).reason, 'no_connection');

  const broken = { getAccountInfo: async () => { throw new Error('fetch failed'); } };
  const rpcDown = createToken({ connection: broken, ca, log: quiet });
  s = await serve(rpcDown);
  b = await (await fetch(s.base + '/')).json();
  assert.equal(b.reason, 'rpc_error');
  assert.equal(b.explorer.token, `https://solscan.io/token/${ca}`);
  assert.equal(b.explorer.pool, undefined);
  await s.close();
});
