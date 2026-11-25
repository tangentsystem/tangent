// The coordinator api with the real src/pay and src/offgrid modules on this
// service's store (createPayStore), over real HTTP. Only Rings is simulated
// (pay's sim adapter) and the chain is a fake connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createIdentity, signVoucher } from '../core/index.js';
import { checkClaim, splitTip, signReceipt, buildClaim, appendTrail } from '../offgrid/index.js';
import { createPay, createSimRings } from '../pay/index.js';
import { fund, buyTokens, redeemInto } from '../pay/testkit.js';
import { createMemoryStore } from '../storage/index.js';
import { createPayStore } from '../storage/pay-store.js';
import { ensureKeys } from '../keys.js';
import { loadConfig } from '../config.js';
import { createApp } from './app.js';
import { makeNode, fakeConnection, txSignature, T0 } from './testkit.js';

test('integration: register, redeem a real voucher, claim a real tip, read earnings', async () => {
  let t = T0;
  const now = () => t;
  const store = await createMemoryStore();
  const keys = await ensureKeys({ store });
  const config = loadConfig({});
  const nodesColl = store.collection('nodes');
  const rings = createSimRings({});
  const pay = createPay({
    store: createPayStore(store), rings, now,
    config: { payExposeSim: true, payoutMinLamports: '1000000', withdrawMinLamports: '1000' },
    nodes: { isRegistered: async (id) => Boolean(await nodesColl.get(id)), payoutAddress: async (id) => (await nodesColl.get(id))?.descriptor.payout ?? null },
  });
  const connection = fakeConnection();
  const app = createApp({ store, pay, config, connection, keys, offgrid: { checkClaim, splitTip }, now });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json() }; };
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json(), cc: r.headers.get('cache-control') }; };
  try {
    const relay = makeNode({ roles: ['relay'] });
    const gw = makeNode({ roles: ['gateway'] });
    assert.equal((await post('/api/nodes/register', relay.descriptor(t))).status, 201);
    assert.equal((await post('/api/nodes/register', gw.descriptor(t))).status, 201);

    // a user deposits, buys a blind token, redeems it into an anonymous account, pays the relay by voucher
    const wallet = createIdentity();
    await fund({ pay, rings }, wallet, 50_000_000n);
    const { tokens } = await buyTokens(pay, wallet, '10000000', 1);
    const { account } = await redeemInto(pay, tokens[0]);
    const v = signVoucher(account, { session: 'circ-1', node: relay.id, kind: 'relay', cumulative: 3_000_000, seq: 1, expires: t + 60_000 });
    const req = { node: relay.id, ts: t, voucher: v };
    const r = await post('/api/vouchers/redeem', { ...req, sig: relay.identity.signObject(req) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.credited, '3000000');

    // an off grid transaction carried by the relay, landed by the gateway, tipping the network
    const bundleId = randomBytes(32).toString('hex');
    const trail = appendTrail(bundleId, [], relay.identity);
    const signature = txSignature();
    connection.add(signature, { payer: createIdentity().id, tipAccount: keys.tip.address, tip: 100_000n });
    const receipt = signReceipt(gw.identity, { bundleId, status: 'landed', signature, slot: 9, origin: createIdentity().id, trail, ts: t });
    const c = await post('/api/offgrid/claim', buildClaim(relay.identity, receipt, { ts: t }));
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const shares = Object.fromEntries(c.json.credits.map((x) => [x.node, x.lamports]));
    assert.equal(BigInt(shares[gw.id]) + BigInt(shares[relay.id]), 100_000n);
    assert.equal((await post('/api/offgrid/claim', buildClaim(gw.identity, receipt, { ts: t }))).status, 409);

    const e = await get(`/api/nodes/${relay.id}/earnings`);
    assert.equal(e.status, 200);
    assert.equal(e.cc, 'no-store');
    assert.equal(BigInt(e.json.earnings.earned), 3_000_000n + BigInt(shares[relay.id]));
    const stats = (await get('/api/stats')).json;
    assert.equal(stats.redeemedLamports, '3000000');
    assert.equal(stats.offgridTipLamports, '100000');
    assert.equal((await pay.totals()).balanced, true);
    // pay's own router is mounted under /api/pay
    const keysRes = await fetch(base + '/api/pay/keys').catch(() => null);
    assert.ok(keysRes);
    assert.equal(keysRes.headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    await store.close();
  }
});
