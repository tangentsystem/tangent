import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, verifyObject, checkDescriptor, signVoucher } from '../core/index.js';
import { startApp, makeNode, fakePay, fakeToken, T0 } from './testkit.js';

const SECRET_ENV = { HELIUS_API_KEY: 'zz9secretkey-abc123', MONGO_URI: 'mongodb+srv://admin:Pw0rdSecret@cluster.example.net/x' };

test('health: answers with name, storage, booleans only and never secrets', async () => {
  const h = await startApp({ env: SECRET_ENV });
  try {
    const r = await h.get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.name, 'Tangent Systems');
    assert.equal(r.json.version, '0.1.0');
    assert.equal(r.json.storage.kind, 'memory');
    assert.deepEqual(r.json.config, { mongo: true, helius: true, token: false, rpc: true });
    for (const v of Object.values(r.json.config)) assert.equal(typeof v, 'boolean');
    assert.deepEqual(r.json.modules, { pay: false, token: false, offgrid: false });
    assert.equal(r.json.network.coordinator, h.keys.coordinator.id);
    assert.equal(r.json.network.links.tipAccount, `https://solscan.io/account/${h.keys.tip.address}`);
    assert.ok(!r.text.includes('zz9secretkey'));
    assert.ok(!r.text.includes('Pw0rdSecret'));
    assert.ok(!r.text.includes('mongodb'));
    const secrets = await h.store.collection('keys').find({});
    for (const k of secrets) assert.ok(!r.text.includes(k.secret));
  } finally { await h.close(); }
});

test('no-store and JSON on every route, including errors and mounted routers', async () => {
  const h = await startApp({ pay: fakePay(), token: fakeToken(), overrides: { bodyLimitKb: 4 } });
  const bare = await startApp();
  try {
    const node = makeNode();
    const hits = [
      await h.get('/api/health'),
      await h.get('/api/directory'),
      await h.get('/api/directory?role=bogus'),
      await h.get('/api/map'),
      await h.get('/api/stats'),
      await h.get('/api/pay/ping'),
      await h.get('/api/token/info'),
      await h.get('/api/nope'),
      await h.get('/nope'),
      await h.post('/api/nodes/register', node.descriptor(T0)),
      await h.post('/api/nodes/register', '{"broken json'),
      await h.post('/api/nodes/register', JSON.stringify({ pad: 'x'.repeat(8000) })),
      await h.post('/api/nodes/heartbeat', {}),
      await h.post('/api/vouchers/redeem', {}),
      await h.post('/api/offgrid/claim', {}),
      await h.get(`/api/nodes/${node.id}/earnings`),
      await h.get('/api/nodes/bad!id/earnings'),
      await bare.get('/api/pay/anything'),
      await bare.get('/api/token/anything'),
      await bare.get(`/api/nodes/${node.id}/earnings`),
    ];
    for (const r of hits) {
      assert.equal(r.headers.get('cache-control'), 'no-store', `status ${r.status} ${r.text.slice(0, 60)}`);
      assert.match(r.headers.get('content-type') || '', /application\/json/);
      assert.ok(r.json !== null);
    }
    assert.equal(hits[5].json.pong, true);
    assert.equal(hits[6].json.token, true);
    assert.equal(hits[7].status, 404);
    assert.equal(hits[10].status, 400);
    assert.equal(hits[10].json.error, 'BAD_JSON');
    assert.equal(hits[11].status, 413);
    assert.equal(hits[17].status, 503);
    assert.equal(hits[17].json.error, 'NOT_CONFIGURED');
    assert.equal(hits[18].status, 503);
    assert.equal(hits[19].status, 503);
  } finally { await h.close(); await bare.close(); }
});

test('register: accepts a signed descriptor, is idempotent, and updates on a newer one', async () => {
  const h = await startApp();
  try {
    const n = makeNode({ roles: ['relay', 'exit'] });
    const r1 = await h.post('/api/nodes/register', n.descriptor(T0));
    assert.equal(r1.status, 201);
    assert.equal(r1.json.id, n.id);
    assert.equal(r1.json.link, `https://solscan.io/account/${n.id}`);
    const r2 = await h.post('/api/nodes/register', n.descriptor(T0));
    assert.equal(r2.status, 200);
    assert.equal(r2.json.created, false);
    h.clock.t += 1000;
    n.port += 1;
    assert.equal((await h.post('/api/nodes/register', n.descriptor(h.clock.t))).status, 200);
    const dir = await h.get('/api/directory');
    assert.equal(dir.json.directory.nodes.length, 1);
    assert.equal(dir.json.directory.nodes[0].descriptor.port, n.port);
    const older = await h.post('/api/nodes/register', n.descriptor(T0 - 1000));
    assert.equal(older.status, 409);
    assert.equal(older.json.error, 'OLDER');
  } finally { await h.close(); }
});

test('register: rejects bad signatures, stale timestamps, private hosts and missing addresses', async () => {
  const h = await startApp();
  try {
    const n = makeNode();
    const forged = { ...n.descriptor(T0), port: 1 };
    assert.equal((await h.post('/api/nodes/register', forged)).json.error, 'BAD_SIGNATURE');
    const other = createIdentity();
    const stolen = { ...n.descriptor(T0), sig: other.signObject({ x: 1 }) };
    assert.equal((await h.post('/api/nodes/register', stolen)).status, 401);
    const stale = await h.post('/api/nodes/register', n.descriptor(T0 - 11 * 60 * 1000));
    assert.equal(stale.status, 400);
    assert.equal(stale.json.error, 'STALE');
    for (const host of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.1.1', '100.64.0.1', 'localhost', 'printer.local', 'db.internal', '::1', 'fd00::1', '0.0.0.0']) {
      const r = await h.post('/api/nodes/register', makeNode({ host }).descriptor(T0));
      assert.equal(r.status, 400, host);
      assert.ok(['PRIVATE_HOST', 'INVALID'].includes(r.json.error), host + ' ' + r.json.error);
    }
    const none = await h.post('/api/nodes/register', makeNode({ host: '' }).descriptor(T0));
    assert.equal(none.status, 400);
    const onionOnly = makeNode({ host: '', onion: 'a'.repeat(56) + '.onion' });
    assert.equal((await h.post('/api/nodes/register', onionOnly.descriptor(T0))).status, 201);
  } finally { await h.close(); }
});

test('register: private hosts are allowed only with the dev flag', async () => {
  const h = await startApp({ env: { ALLOW_PRIVATE_HOSTS: 'true' } });
  try {
    assert.equal((await h.post('/api/nodes/register', makeNode({ host: '127.0.0.1' }).descriptor(T0))).status, 201);
  } finally { await h.close(); }
});

test('register: a host:port owned by another node is refused, and freed when the owner moves', async () => {
  const h = await startApp();
  try {
    const a = makeNode({ host: 'shared.example.org', port: 7000 });
    const b = makeNode({ host: 'shared.example.org', port: 7000 });
    assert.equal((await h.post('/api/nodes/register', a.descriptor(T0))).status, 201);
    const clash = await h.post('/api/nodes/register', b.descriptor(T0));
    assert.equal(clash.status, 409);
    assert.equal(clash.json.error, 'HOST_TAKEN');
    a.port = 7001;
    h.clock.t += 10;
    assert.equal((await h.post('/api/nodes/register', a.descriptor(h.clock.t))).status, 200);
    assert.equal((await h.post('/api/nodes/register', b.descriptor(h.clock.t))).status, 201);
  } finally { await h.close(); }
});

test('register: concurrent claims on one host:port, exactly one node wins', async () => {
  const h = await startApp();
  try {
    const nodes = Array.from({ length: 10 }, () => makeNode({ host: 'race.example.org', port: 7100 }));
    const res = await Promise.all(nodes.map((n, i) => h.post('/api/nodes/register', n.descriptor(T0), { 'x-forwarded-for': `198.51.${i}.9` })));
    assert.equal(res.filter((r) => r.status === 201).length, 1);
    assert.equal(res.filter((r) => r.status === 409).length, 9);
  } finally { await h.close(); }
});

test('register: validation failures list issues', async () => {
  const h = await startApp();
  try {
    const n = makeNode();
    const bad = [
      {},
      { ...n.descriptor(T0), roles: ['miner'] },
      { ...n.descriptor(T0), port: 70000 },
      { ...n.descriptor(T0), id: 'not base58 0OIl' },
      { ...n.descriptor(T0), region: 'Exact Street 12, Somewhere' },
      { ...n.descriptor(T0), ts: 'yesterday' },
      { ...n.descriptor(T0), onion: 'short.onion' },
      [],
      'a string',
    ];
    for (const body of bad) {
      const r = await h.post('/api/nodes/register', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.ok(['INVALID', 'BAD_JSON'].includes(r.json.error));
    }
    const r = await h.post('/api/nodes/register', { ...n.descriptor(T0), roles: ['miner'] });
    assert.ok(Array.isArray(r.json.issues) && r.json.issues.length > 0);
  } finally { await h.close(); }
});

test('heartbeat: signed, fresh, newer than the last, from a registered node', async () => {
  const h = await startApp();
  try {
    const n = makeNode();
    assert.equal((await h.post('/api/nodes/heartbeat', n.heartbeat(T0))).status, 404);
    await h.post('/api/nodes/register', n.descriptor(T0));
    const ok = await h.post('/api/nodes/heartbeat', n.heartbeat(T0 + 1));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.live, true);
    const replay = await h.post('/api/nodes/heartbeat', n.heartbeat(T0 + 1));
    assert.equal(replay.status, 409);
    const forged = { ...n.heartbeat(T0 + 2), load: 0.9 };
    assert.equal((await h.post('/api/nodes/heartbeat', forged)).status, 401);
    assert.equal((await h.post('/api/nodes/heartbeat', n.heartbeat(T0 + 10 * 60 * 1000))).json.error, 'STALE');
    assert.equal((await h.post('/api/nodes/heartbeat', { ...n.heartbeat(T0 + 3), load: 5 })).status, 400);
  } finally { await h.close(); }
});

test('directory: signed by the coordinator; the client can verify it and spot tampering', async () => {
  const h = await startApp();
  try {
    const relay = makeNode({ roles: ['relay'] });
    const gw = makeNode({ roles: ['gateway', 'relay'] });
    await h.post('/api/nodes/register', relay.descriptor(T0));
    await h.post('/api/nodes/register', gw.descriptor(T0));
    const pinned = (await h.get('/api/health')).json.network.coordinator;
    const r = await h.get('/api/directory');
    const { directory, sig } = r.json;
    // client side checks: pinned coordinator id, coordinator signature, each node's own signature
    assert.equal(directory.coordinator, pinned);
    assert.equal(verifyObject(pinned, directory, sig), true);
    assert.equal(directory.ts, T0);
    assert.equal(directory.nodes.length, 2);
    for (const entry of directory.nodes) {
      assert.equal(checkDescriptor(entry.descriptor, { now: T0 }).ok, true);
      assert.equal(entry.links.id, `https://solscan.io/account/${entry.descriptor.id}`);
      assert.ok(entry.links.payout.startsWith('https://solscan.io/account/'));
      assert.equal(typeof entry.reputation, 'number');
    }
    const tampered = structuredClone(directory);
    tampered.nodes[0].descriptor.host = 'evil.example.org';
    assert.equal(verifyObject(pinned, tampered, sig), false);
    const dropped = { ...directory, nodes: directory.nodes.slice(1) };
    assert.equal(verifyObject(pinned, dropped, sig), false);
    const filtered = await h.get('/api/directory?role=gateway');
    assert.deepEqual(filtered.json.directory.nodes.map((x) => x.descriptor.id), [gw.id]);
    assert.equal(filtered.json.directory.role, 'gateway');
    assert.equal(verifyObject(pinned, filtered.json.directory, filtered.json.sig), true);
    assert.equal((await h.get('/api/directory?role=exit')).json.directory.nodes.length, 0);
    assert.equal((await h.get('/api/directory?role=bogus')).status, 400);
  } finally { await h.close(); }
});

test('liveness: silent nodes leave the directory, come back on heartbeat, and are evicted later', async () => {
  const h = await startApp({ overrides: { livenessMs: 180_000, evictAfterMs: 3_600_000 } });
  try {
    const a = makeNode({ host: 'keep.example.org', port: 7200 });
    const b = makeNode();
    await h.post('/api/nodes/register', a.descriptor(T0));
    await h.post('/api/nodes/register', b.descriptor(T0));
    h.clock.t = T0 + 120_000;
    await h.post('/api/nodes/heartbeat', b.heartbeat(h.clock.t));
    h.clock.t = T0 + 200_000; // a is past liveness, b is not
    let ids = (await h.get('/api/directory')).json.directory.nodes.map((x) => x.descriptor.id);
    assert.deepEqual(ids, [b.id]);
    assert.deepEqual((await h.get('/api/map')).json.nodes.map((x) => x.id), [b.id]);
    await h.post('/api/nodes/heartbeat', a.heartbeat(h.clock.t));
    ids = (await h.get('/api/directory')).json.directory.nodes.map((x) => x.descriptor.id).sort();
    assert.deepEqual(ids, [a.id, b.id].sort());
    assert.equal(await h.app.locals.sweep(), 0);
    h.clock.t += 3_700_000;
    assert.equal((await h.get('/api/directory')).json.directory.nodes.length, 0);
    assert.equal(await h.app.locals.sweep(), 2);
    assert.equal(await h.store.collection('nodes').count({}), 0);
    assert.equal((await h.post('/api/nodes/heartbeat', a.heartbeat(h.clock.t))).status, 404);
    // the evicted node's host is free again
    const c = makeNode({ host: 'keep.example.org', port: 7200 });
    assert.equal((await h.post('/api/nodes/register', c.descriptor(h.clock.t))).status, 201);
  } finally { await h.close(); }
});

test('map: public fields only, never host, ip, port, onion or kx (raw JSON)', async () => {
  const h = await startApp();
  try {
    const n = makeNode({ host: '8.8.4.4', port: 4444, onion: 'b'.repeat(56) + '.onion' });
    await h.post('/api/nodes/register', n.descriptor(T0));
    const named = makeNode({ host: 'secret-host.example.org', port: 5555, region: null });
    await h.post('/api/nodes/register', named.descriptor(T0));
    h.clock.t += 60_000;
    await h.post('/api/nodes/heartbeat', n.heartbeat(h.clock.t));
    const r = await h.get('/api/map');
    for (const leak of ['8.8.4.4', '4444', 'secret-host', '5555', '.onion', '"host"', '"port"', '"onion"', '"kx"', '"ip"']) {
      assert.ok(!r.text.includes(leak), 'map leaked ' + leak);
    }
    const one = r.json.nodes.find((x) => x.id === n.id);
    assert.deepEqual(Object.keys(one).sort(), ['id', 'link', 'region', 'reputation', 'roles', 'uptimeSeconds']);
    assert.equal(one.uptimeSeconds, 60);
    assert.equal(one.link, `https://solscan.io/account/${n.id}`);
    assert.equal('region' in r.json.nodes.find((x) => x.id === named.id), false);
  } finally { await h.close(); }
});

test('stats: empty network is an empty object; real counts appear, zeros stay hidden', async () => {
  const pay = fakePay({ credited: '2500' });
  const h = await startApp({ pay });
  try {
    assert.deepEqual((await h.get('/api/stats')).json, {});
    const a = makeNode({ roles: ['relay', 'exit'] });
    const b = makeNode({ roles: ['gateway'] });
    await h.post('/api/nodes/register', a.descriptor(T0));
    await h.post('/api/nodes/register', b.descriptor(T0));
    let s = (await h.get('/api/stats')).json;
    assert.deepEqual(s, { nodes: { online: 2, relay: 1, exit: 1, gateway: 1 } });
    const payer = createIdentity();
    const v = signVoucher(payer, { session: 's1', node: a.id, kind: 'relay', cumulative: 2500, seq: 1, expires: T0 + 60_000 });
    const req = { node: a.id, ts: T0, voucher: v };
    assert.equal((await h.post('/api/vouchers/redeem', { ...req, sig: a.identity.signObject(req) })).status, 200);
    s = (await h.get('/api/stats')).json;
    assert.deepEqual(s, { nodes: { online: 2, relay: 1, exit: 1, gateway: 1 }, sessions: '1', redemptions: '1', redeemedLamports: '2500' });
  } finally { await h.close(); }
});

function redeemBody(node, voucher, ts) {
  const req = { node: node.id, ts, voucher };
  return { ...req, sig: node.identity.signObject(req) };
}

test('vouchers: redeem path through pay, with every refusal', async () => {
  const pay = fakePay({ credited: '1500' });
  const h = await startApp({ pay });
  try {
    const n = makeNode();
    const payer = createIdentity();
    const v = signVoucher(payer, { session: 'abc', node: n.id, kind: 'relay', cumulative: 1500, seq: 3, expires: T0 + 60_000 });
    const notReg = await h.post('/api/vouchers/redeem', redeemBody(n, v, T0));
    assert.equal(notReg.status, 403);
    assert.equal(notReg.json.error, 'NOT_REGISTERED');
    await h.post('/api/nodes/register', n.descriptor(T0));
    const forged = { ...redeemBody(n, v, T0), ts: T0 + 1 };
    assert.equal((await h.post('/api/vouchers/redeem', forged)).status, 401);
    const other = makeNode();
    await h.post('/api/nodes/register', other.descriptor(T0));
    const wrong = await h.post('/api/vouchers/redeem', redeemBody(other, v, T0));
    assert.equal(wrong.json.error, 'WRONG_NODE');
    const badVoucher = { ...v, cumulative: '999999' };
    assert.equal((await h.post('/api/vouchers/redeem', redeemBody(n, badVoucher, T0))).json.error, 'BAD_VOUCHER');
    const expired = signVoucher(payer, { session: 'abc', node: n.id, kind: 'relay', cumulative: 1, seq: 1, expires: T0 - 1 });
    assert.equal((await h.post('/api/vouchers/redeem', redeemBody(n, expired, T0))).json.error, 'BAD_VOUCHER');
    assert.equal((await h.post('/api/vouchers/redeem', redeemBody(n, v, T0 - 10 * 60 * 1000))).json.error, 'STALE');
    assert.equal(pay.redeemed.length, 0);
    const ok = await h.post('/api/vouchers/redeem', redeemBody(n, v, T0));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, credited: '1500' });
    assert.equal(pay.redeemed.length, 1);
    assert.equal(pay.redeemed[0].session, 'abc');
    pay.reject = 'stale seq';
    const rej = await h.post('/api/vouchers/redeem', redeemBody(n, v, T0));
    assert.equal(rej.status, 409);
    assert.equal(rej.json.error, 'REJECTED');
    const e = await h.get(`/api/nodes/${n.id}/earnings`);
    assert.equal(e.status, 200);
    assert.deepEqual(e.json.redeemed, { count: '1', lamports: '1500' });
    assert.equal(e.json.link, `https://solscan.io/account/${n.id}`);
    assert.ok(e.json.payoutLink.startsWith('https://solscan.io/account/'));
    assert.ok(e.json.reputation.work > 0);
    assert.equal(e.json.earnings.nodeId, n.id);
  } finally { await h.close(); }
  const bare = await startApp();
  try {
    const n = makeNode();
    await bare.post('/api/nodes/register', n.descriptor(T0));
    const v = signVoucher(createIdentity(), { session: 'x', node: n.id, kind: 'compute', cumulative: 5, seq: 1, expires: T0 + 60_000 });
    const r = await bare.post('/api/vouchers/redeem', redeemBody(n, v, T0));
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'NOT_CONFIGURED');
  } finally { await bare.close(); }
});

test('reputation: rises with on time heartbeats and redeemed work', async () => {
  const pay = fakePay({ credited: '10' });
  const h = await startApp({ pay, overrides: { heartbeatIntervalMs: 60_000, livenessMs: 180_000 } });
  try {
    const steady = makeNode();
    const flaky = makeNode();
    await h.post('/api/nodes/register', steady.descriptor(T0));
    await h.post('/api/nodes/register', flaky.descriptor(T0));
    for (let i = 1; i <= 10; i++) {
      h.clock.t = T0 + i * 60_000;
      await h.post('/api/nodes/heartbeat', steady.heartbeat(h.clock.t));
      if (i % 5 === 0) await h.post('/api/nodes/heartbeat', flaky.heartbeat(h.clock.t));
    }
    const payer = createIdentity();
    for (let s = 0; s < 5; s++) {
      const v = signVoucher(payer, { session: 's' + s, node: steady.id, kind: 'relay', cumulative: 10, seq: 1, expires: h.clock.t + 60_000 });
      await h.post('/api/vouchers/redeem', redeemBody(steady, v, h.clock.t));
    }
    const map = (await h.get('/api/map')).json.nodes;
    const rs = map.find((x) => x.id === steady.id).reputation;
    const rf = map.find((x) => x.id === flaky.id).reputation;
    assert.ok(rs > rf, `${rs} > ${rf}`);
    assert.ok(rs > 0.8 && rs <= 1);
  } finally { await h.close(); }
});

test('rate limits: registrations per source address, with Retry-After', async () => {
  const h = await startApp({ overrides: { registerLimitPerHour: 2 } });
  try {
    const ip = { 'x-forwarded-for': '198.51.100.7' };
    assert.equal((await h.post('/api/nodes/register', makeNode().descriptor(T0), ip)).status, 201);
    assert.equal((await h.post('/api/nodes/register', makeNode().descriptor(T0), ip)).status, 201);
    const third = await h.post('/api/nodes/register', makeNode().descriptor(T0), ip);
    assert.equal(third.status, 429);
    assert.equal(third.json.error, 'RATE_LIMITED');
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.equal(third.headers.get('cache-control'), 'no-store');
    assert.equal((await h.post('/api/nodes/register', makeNode().descriptor(T0), { 'x-forwarded-for': '198.51.100.8' })).status, 201);
    h.clock.t += 3_600_001;
    assert.equal((await h.post('/api/nodes/register', makeNode().descriptor(h.clock.t), ip)).status, 201);
  } finally { await h.close(); }
});

test('rate limits: the general bucket covers every route', async () => {
  const h = await startApp({ overrides: { rateLimitPerMin: 5 } });
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await h.get('/api/health')).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  } finally { await h.close(); }
});

test('stake hook: an optional check can refuse a registration', async () => {
  const stake = { async check(d) { return d.roles.includes('exit') ? { ok: false, reason: 'exit nodes need stake' } : { ok: true }; } };
  const h = await startApp({ stake });
  try {
    assert.equal((await h.post('/api/nodes/register', makeNode({ roles: ['relay'] }).descriptor(T0))).status, 201);
    const r = await h.post('/api/nodes/register', makeNode({ roles: ['exit'] }).descriptor(T0));
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'STAKE');
  } finally { await h.close(); }
});

test('the site pages are server rendered html with no-store and clean urls', async () => {
  const h = await startApp();
  try {
    for (const path of ['/', '/nodes', '/agents', '/docs', '/docs/run-a-node', '/docs/payments', '/docs/private-internet', '/docs/off-grid', '/docs/agents', '/docs/reference']) {
      const r = await h.get(path);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await h.get('/proof')).status, 404);
    assert.equal((await h.get('/whitepaper')).status, 404);
  } finally {
    await h.close();
  }
});
