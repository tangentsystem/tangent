import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createIdentity, signVoucher } from '../core/index.js';
import { createClient, buildCircuit } from './index.js';
import { CELL_SIZE, CIRC_WINDOW } from './cells.js';
import { startRelay, startHttpServer, startEchoServer, socksConnect, httpGetViaSocks, sha256, waitFor, sleep, track, cleanupAll } from './testing/harness.js';

afterEach(cleanupAll);

const MAX_QUEUE = CIRC_WINDOW + 256;

function throwawayCredit() {
  const ids = new Map();
  const calls = [];
  return {
    enabled: true,
    calls,
    identityFor(nodeId) {
      if (!this.enabled) return null;
      calls.push(nodeId);
      if (!ids.has(nodeId)) ids.set(nodeId, createIdentity());
      return ids.get(nodeId);
    },
    ids,
  };
}

async function stopAll(list) { for (const x of list) await x?.relay?.stop?.(); }

// Download through SOCKS, collecting raw bytes from the socket (HTTP/1.0 style response).
function rawGet(sock, host, path) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    const state = { chunks, get total() { return total; }, done: false, error: null, sock };
    sock.on('data', (c) => { chunks.push(c); total += c.length; });
    sock.on('end', () => { state.done = true; resolve(state); });
    sock.on('error', (e) => { state.error = e; });
    sock.on('close', () => { state.done = true; resolve(state); });
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    state.promise = null;
  });
}

function bodyOf(buf) { const i = buf.indexOf('\r\n\r\n'); return buf.subarray(i + 4); }

test('HTTP through SOCKS over 3 hops; middle sees only ciphertext; exit never sees the client', async () => {
  const marker = 'secret-' + randomBytes(8).toString('hex');
  const taps = new Map();
  const mkTap = () => {
    const t = { cells: [], in: [], out: [] };
    return [t, (ev, d) => { if (ev === 'cell-in') t.cells.push(d.cell); if (ev === 'conn-in') t.in.push(d); if (ev === 'conn-out') t.out.push(d); }];
  };
  const [ta, fa] = mkTap(), [tb, fb] = mkTap(), [tx, fx] = mkTap();
  const a = await startRelay({ _tap: fa });
  const b = await startRelay({ _tap: fb });
  const exit = await startRelay({ roles: ['relay', 'exit'], _tap: fx });
  taps.set(a.descriptor.id, ta); taps.set(b.descriptor.id, tb); taps.set(exit.descriptor.id, tx);
  const http = await startHttpServer((req, res) => res.end(`hello ${marker} ${req.url}`));
  const client = track(createClient({ directory: [a.descriptor, b.descriptor, exit.descriptor] }));
  await client.start();
  try {
    const r = await httpGetViaSocks(client.socksPort, 'localhost', http.port, '/path-' + marker);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), `hello ${marker} /path-${marker}`);
    const [circ] = client.circuits();
    assert.equal(circ.path.length, 3);
    assert.equal(circ.path[2], exit.descriptor.id);
    const entryTap = taps.get(circ.path[0]), middleTap = taps.get(circ.path[1]);

    // middle: every cell is exactly CELL_SIZE and none of them carries the payload or the destination
    assert.ok(middleTap.cells.length > 4);
    assert.ok(middleTap.cells.every((c) => c.length === CELL_SIZE));
    for (const tap of [middleTap, entryTap]) {
      const all = Buffer.concat(tap.cells);
      for (const needle of [marker, 'localhost', `"port":${http.port}`, 'hello', 'GET /', 'HTTP/1.1', 'Host:']) {
        assert.equal(all.includes(Buffer.from(needle)), false, `relay saw ${needle}`);
      }
    }
    // middle only knows its neighbours: it connected to the exit relay port, never to the destination
    assert.deepEqual(middleTap.out.map((c) => c.port), [exit.relay.port]);

    // exit: its only incoming peer is the middle, never the client's socket
    const clientPorts = entryTap.in.map((c) => c.remotePort);
    assert.equal(tx.in.length, 1);
    assert.ok(!clientPorts.includes(tx.in[0].remotePort));
    // destination: sees the exit's outbound socket, not the client
    assert.ok(!clientPorts.includes(http.peers[0]));
  } finally {
    await client.stop();
  }
  try {
    // teardown reaches every hop and closes the metered sessions
    await waitFor(() => [a, b, exit].every((n) => n.relay.stats().circuits === 0));
    for (const n of [a, b, exit]) assert.equal(n.meter.list().length, 0);
  } finally {
    await http.close();
    await stopAll([a, b, exit]);
  }
});

test('large transfers keep integrity, pay every hop, and memory stays bounded', async (t) => {
  const price = 1000n; // lamports per MB, credit limit = price of 1 MB
  const nodes = [await startRelay({ perMbLamports: price }), await startRelay({ perMbLamports: price }), await startRelay({ roles: ['relay', 'exit'], perMbLamports: price })];
  const big = randomBytes(12 * 1024 * 1024);
  const http = await startHttpServer((req, res) => { res.setHeader('content-length', big.length); res.end(big); });
  const echo = await startEchoServer();
  const credit = throwawayCredit();
  const client = track(createClient({ directory: nodes.map((n) => n.descriptor), credit }));
  await client.start();
  let peakQueue = 0;
  const heap0 = process.memoryUsage().heapUsed;
  let peakHeap = heap0;
  const sampler = setInterval(() => {
    for (const n of nodes) peakQueue = Math.max(peakQueue, n.relay.stats().queuedCells);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 10);
  try {
    // 12 MB download
    const r = await httpGetViaSocks(client.socksPort, '127.0.0.1', http.port, '/big');
    assert.equal(r.status, 200);
    assert.equal(r.body.length, big.length);
    assert.equal(sha256(r.body), sha256(big));

    // 10 MB upload, echoed back (both directions at once)
    const up = randomBytes(10 * 1024 * 1024);
    const sock = await socksConnect(client.socksPort, '127.0.0.1', echo.port);
    const got = [];
    let n = 0;
    const done = new Promise((resolve) => sock.on('data', (c) => { got.push(c); n += c.length; if (n >= up.length) resolve(); }));
    Readable.from((function* () { for (let i = 0; i < up.length; i += 64 * 1024) yield up.subarray(i, i + 64 * 1024); })()).pipe(sock, { end: false });
    await done;
    assert.equal(sha256(Buffer.concat(got)), sha256(up));
    sock.destroy();

    // memory: no hop ever held more than its hard queue cap, heap growth far below data volume
    assert.ok(peakQueue <= MAX_QUEUE, `peak queue ${peakQueue}`);
    for (const nd of nodes) assert.ok(nd.relay.stats().maxQueue <= MAX_QUEUE);
    // payments: each hop billed and was paid by vouchers from its own throwaway identity
    const payers = nodes.map((nd) => { assert.ok(nd.vouchers.length > 0, 'hop got vouchers'); return nd.vouchers.at(-1).payer; });
    assert.equal(new Set(payers).size, 3, 'a different payer identity per hop');
    for (let i = 0; i < 3; i++) assert.equal(payers[i], credit.ids.get(nodes[i].descriptor.id).id);
    for (const nd of nodes) {
      const s = nd.relay.sessions()[0];
      const owed = nd.meter.owed(s.session);
      assert.ok(owed >= 22n, `owed ${owed}`); // ~22 MB carried at 1000 lamports/MB
      assert.ok(BigInt(s.paid) >= owed - price, `paid ${s.paid} owed ${owed}`);
      assert.equal(nd.relay.stats().vouchersRejected, 0);
    }
  } finally {
    clearInterval(sampler);
    await client.stop();
  }
  t.diagnostic(`peak relay queue ${peakQueue} cells, heap growth ${((peakHeap - heap0) / 1e6).toFixed(1)} MB`);
  await http.close(); await echo.close();
  await stopAll(nodes);
});

test('slow reader: back pressure reaches the destination instead of buffering in the network', async (t) => {
  const nodes = [await startRelay(), await startRelay(), await startRelay({ roles: ['relay', 'exit'] })];
  const total = 64 * 1024 * 1024;
  let produced = 0;
  const http = await startHttpServer((req, res) => {
    res.setHeader('content-length', total);
    const chunk = Buffer.alloc(64 * 1024, 7);
    Readable.from((function* () { while (produced < total) { produced += chunk.length; yield chunk; } })()).pipe(res);
  });
  const client = track(createClient({ directory: nodes.map((n) => n.descriptor) }));
  await client.start();
  try {
    const sock = await socksConnect(client.socksPort, '127.0.0.1', http.port);
    let received = 0;
    sock.on('data', (c) => { received += c.length; });
    sock.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    await waitFor(() => received > 512 * 1024);
    sock.pause();
    await sleep(1500);
    const producedWhilePaused = produced;
    const gap = producedWhilePaused - received;
    for (const n of nodes) assert.ok(n.relay.stats().queuedCells <= MAX_QUEUE);
    // windows (~0.5 MB) plus kernel socket buffers; never the whole 64 MB
    assert.ok(gap < 24 * 1024 * 1024, `gap ${gap}`);
    await sleep(500);
    assert.ok(produced - producedWhilePaused < 1024 * 1024, 'producer is stalled while the reader is paused');
    sock.resume();
    await waitFor(() => received >= total, { timeoutMs: 60_000 });
    t.diagnostic(`slow reader: ${(gap / 1e6).toFixed(1)} MB in flight while paused, producer stalled`);
    sock.destroy();
  } finally {
    await client.stop();
  }
  await http.close();
  await stopAll(nodes);
});

test('vouchers: no credit stalls the stream, forged voucher refused, valid voucher resumes', async () => {
  const price = 1000n;
  const nodes = [await startRelay({ perMbLamports: price }), await startRelay({ perMbLamports: price }), await startRelay({ roles: ['relay', 'exit'], perMbLamports: price })];
  const size = 4 * 1024 * 1024;
  const data = randomBytes(size);
  const http = await startHttpServer((req, res) => { res.setHeader('content-length', size); res.end(data); });
  const credit = throwawayCredit();
  credit.enabled = false; // no credit: the client cannot sign vouchers
  const client = track(createClient({ directory: nodes.map((n) => n.descriptor), credit }));
  await client.start();
  try {
    const sock = await socksConnect(client.socksPort, '127.0.0.1', http.port);
    const st = await new Promise((resolve) => { const p = rawGet(sock, '127.0.0.1', '/'); resolve({ p, sock }); });
    let received = 0;
    sock.on('data', (c) => { received += c.length; });
    // wait until progress stops
    let last = -1;
    await waitFor(() => { const still = received === last && received > 0; last = received; return still; }, { intervalMs: 700, timeoutMs: 20_000 });
    assert.ok(received < 2 * 1024 * 1024, `stalled after about the credit limit, got ${received}`);
    assert.ok(nodes.some((n) => n.relay.stats().stalledCircuits > 0), 'a hop stalled');
    assert.equal(nodes.reduce((a, n) => a + n.vouchers.length, 0), 0);

    // forged voucher: right session and node, signed by an identity that is not the payer it claims
    const circ = await client.getCircuit();
    const hop0 = nodes.find((n) => n.descriptor.id === circ.path[0].id);
    const session = hop0.relay.sessions()[0].session;
    const results = [];
    circ.on('voucher-result', (r) => results.push(r));
    const liar = createIdentity(), claimed = createIdentity();
    const forged = { ...signVoucher(liar, { session, node: hop0.descriptor.id, kind: 'relay', cumulative: 10n ** 9n, seq: 1, expires: Date.now() + 60_000 }), payer: claimed.id };
    circ.sendVoucher(0, forged);
    await waitFor(() => results.length >= 1);
    assert.deepEqual([results[0].ok, results[0].reason], [false, 'signature']);
    await sleep(300);
    assert.equal(hop0.relay.stats().stalledCircuits, 1, 'still stalled after a forged voucher');
    assert.equal(hop0.vouchers.length, 0, 'onVoucher never saw the forged voucher');

    // credit comes back: hops re-bill every second, client pays, transfer completes
    credit.enabled = true;
    await waitFor(() => received >= size, { timeoutMs: 30_000 });
    const res = await st.p;
    assert.equal(sha256(bodyOf(Buffer.concat(res.chunks))), sha256(data));
    for (const n of nodes) assert.ok(n.vouchers.length > 0);
    // stale voucher: replaying the newest accepted one is refused
    const newest = hop0.vouchers.at(-1);
    const before = hop0.vouchers.length;
    results.length = 0;
    circ.sendVoucher(0, newest);
    await waitFor(() => results.some((r) => r.hop === 0 && r.ok === false));
    assert.equal(results.find((r) => r.hop === 0 && !r.ok).reason, 'stale seq');
    assert.equal(hop0.vouchers.length, before);
  } finally {
    await client.stop();
  }
  await http.close();
  await stopAll(nodes);
});

test('voucher checks at a hop: wrong node, wrong session, expired, stale, then valid', async () => {
  const nodes = [await startRelay({ perMbLamports: 1000n }), await startRelay({ roles: ['relay', 'exit'], perMbLamports: 1000n })];
  const circ = await buildCircuit({ path: nodes.map((n) => n.descriptor), credit: null });
  try {
    const results = [];
    circ.on('voucher-result', (r) => results.push(r));
    const payer = createIdentity();
    const hop = nodes[1];
    const session = hop.relay.sessions()[0].session;
    const base = { session, node: hop.descriptor.id, kind: 'relay', expires: Date.now() + 60_000 };
    const send = async (v) => { const n = results.length; circ.sendVoucher(1, v); await waitFor(() => results.length > n); return results.at(-1); };
    assert.equal((await send(signVoucher(payer, { ...base, node: nodes[0].descriptor.id, cumulative: 5n, seq: 1 }))).reason, 'wrong node');
    assert.equal((await send(signVoucher(payer, { ...base, session: 'other', cumulative: 5n, seq: 1 }))).reason, 'wrong session');
    assert.equal((await send(signVoucher(payer, { ...base, expires: Date.now() - 1, cumulative: 5n, seq: 1 }))).reason, 'expired');
    assert.equal((await send(signVoucher(payer, { ...base, kind: 'compute', cumulative: 5n, seq: 1 }))).reason, 'wrong kind');
    const ok = await send(signVoucher(payer, { ...base, cumulative: 5n, seq: 1 }));
    assert.equal(ok.ok, true);
    assert.equal(ok.hop, 1);
    assert.equal((await send(signVoucher(payer, { ...base, cumulative: 9n, seq: 1 }))).reason, 'stale seq');
    assert.equal((await send(signVoucher(payer, { ...base, cumulative: 4n, seq: 2 }))).reason, 'amount went down');
    assert.equal((await send(signVoucher(createIdentity(), { ...base, cumulative: 50n, seq: 3 }))).reason, 'session mismatch');
    assert.equal(hop.vouchers.length, 1);
    assert.equal(hop.relay.sessions()[0].paid, '5');
    // the entry hop never saw any of these: they were addressed to hop 1 inside the onion
    assert.equal(nodes[0].relay.stats().vouchersAccepted + nodes[0].relay.stats().vouchersRejected, 0);
  } finally { circ.close(); }
  await stopAll(nodes);
});

test('onVoucher refusal (coordinator says no) keeps the voucher out', async () => {
  const nodes = [await startRelay({ perMbLamports: 1000n, roles: ['relay', 'exit'], onVoucher: async () => ({ ok: false, reason: 'no funds' }) })];
  const circ = await buildCircuit({ path: nodes.map((n) => n.descriptor), credit: null });
  try {
    const results = [];
    circ.on('voucher-result', (r) => results.push(r));
    const session = nodes[0].relay.sessions()[0].session;
    circ.sendVoucher(0, signVoucher(createIdentity(), { session, node: nodes[0].descriptor.id, kind: 'relay', cumulative: 5n, seq: 1, expires: Date.now() + 60_000 }));
    await waitFor(() => results.length);
    assert.deepEqual([results[0].ok, results[0].reason], [false, 'no funds']);
    assert.equal(nodes[0].relay.sessions()[0].paid, '0');
  } finally { circ.close(); }
  await stopAll(nodes);
});

test('a hop dies mid transfer: circuit closes, client marks it and rebuilds on a new path', async () => {
  const nodes = [await startRelay(), await startRelay(), await startRelay(), await startRelay({ roles: ['relay', 'exit'] }), await startRelay({ roles: ['relay', 'exit'] })];
  const size = 40 * 1024 * 1024;
  const http = await startHttpServer((req, res) => {
    if (req.url === '/small') return res.end('after rebuild');
    res.setHeader('content-length', size);
    const chunk = Buffer.alloc(64 * 1024, 1);
    let sent = 0;
    Readable.from((function* () { while (sent < size) { sent += chunk.length; yield chunk; } })()).pipe(res);
  });
  const client = track(createClient({ directory: nodes.map((n) => n.descriptor) }));
  await client.start();
  try {
    const sock = await socksConnect(client.socksPort, '127.0.0.1', http.port);
    let received = 0;
    sock.on('data', (c) => { received += c.length; });
    const closed = new Promise((r) => sock.on('close', r));
    sock.write(`GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    await waitFor(() => received > 1024 * 1024);
    const [circ] = client.circuits();
    const middleId = circ.path[1];
    const middle = nodes.find((n) => n.descriptor.id === middleId);
    await middle.relay.stop();
    await closed;
    assert.ok(received < size, 'transfer was cut');
    await waitFor(() => client.circuits().length === 0);
    assert.ok(client.failedNodes().includes(middleId), 'client learned which hop died');
    // entry and exit cleaned up their side
    await waitFor(() => nodes.filter((n) => n !== middle).every((n) => n.relay.stats().circuits === 0));

    const r = await httpGetViaSocks(client.socksPort, '127.0.0.1', http.port, '/small');
    assert.equal(r.body.toString(), 'after rebuild');
    const [fresh] = client.circuits();
    assert.ok(!fresh.path.includes(middleId));
  } finally {
    await client.stop();
  }
  await http.close();
  await stopAll(nodes);
});

test('exit refuses loopback, private, link local and metadata targets without the test flag', async () => {
  const nodes = [await startRelay(), await startRelay(), await startRelay({ roles: ['relay', 'exit'], allowPrivateTargets: false })];
  const http = await startHttpServer((req, res) => res.end('should never be reached'));
  const client = track(createClient({ directory: nodes.map((n) => n.descriptor) }));
  await client.start();
  try {
    for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '10.0.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1']) {
      await assert.rejects(socksConnect(client.socksPort, host, http.port), (e) => /not allowed|ruleset|Socks5 proxy rejected/i.test(e.message), host);
    }
    assert.equal(http.peers.length, 0, 'destination never got a connection');
    assert.equal(nodes[2].relay.stats().streamsRefused, 7);
    // the circuit is still fine after refusals
    assert.equal(client.circuits().length, 1);
    assert.equal(client.circuits()[0].open, true);
  } finally { await client.stop(); }
  await http.close();
  await stopAll(nodes);
});

test('limits: max circuits per relay, max streams per circuit, non exit refuses BEGIN, wrong identity rejected', async () => {
  const busy = await startRelay({ roles: ['relay', 'exit'], maxCircuits: 1, maxStreamsPerCircuit: 2 });
  const echo = await startEchoServer();
  const c1 = await buildCircuit({ path: [busy.descriptor], credit: null });
  await assert.rejects(buildCircuit({ path: [busy.descriptor], credit: null }), /busy/);
  assert.equal(busy.relay.stats().circuitsRefused, 1);
  const s1 = await c1.openStream('127.0.0.1', echo.port);
  const s2 = await c1.openStream('127.0.0.1', echo.port);
  await assert.rejects(c1.openStream('127.0.0.1', echo.port), /limit/);
  s1.destroy(); s2.destroy();
  c1.close();

  const plain = await startRelay({ roles: ['relay'] });
  const c2 = await buildCircuit({ path: [plain.descriptor], credit: null });
  await assert.rejects(c2.openStream('127.0.0.1', echo.port), /not exit/);
  c2.close();

  // a descriptor that names plain's identity but points at busy's port: handshake must fail
  const { signDescriptor } = await import('../core/index.js');
  const lie = signDescriptor(plain.identity, { roles: ['relay', 'exit'], host: '127.0.0.1', port: busy.relay.port, kx: plain.kx.pub });
  await waitFor(() => busy.relay.stats().circuits === 0);
  await assert.rejects(buildCircuit({ path: [lie], credit: null }), /signature|confirmation/);
  await echo.close();
  await stopAll([busy, plain]);
});

test('credit top up: a refused voucher reaches credit.short, and after a fresh account new streams take a new circuit', async () => {
  const price = 1000n;
  const dry = new Set(); // payer ids whose vouchers the hops refuse
  const onVoucher = async (v) => (dry.has(v.payer) ? { ok: false, reason: 'insufficient funds' } : { ok: true });
  const nodes = [await startRelay({ perMbLamports: price, onVoucher }), await startRelay({ perMbLamports: price, onVoucher }), await startRelay({ roles: ['relay', 'exit'], perMbLamports: price, onVoucher })];
  const body = randomBytes(2 * 1024 * 1024);
  const http = await startHttpServer((req, res) => { res.setHeader('content-length', body.length); res.end(body); });
  const current = new Map();
  const shorts = [];
  const credit = {
    identityFor(nodeId) { if (!current.has(nodeId)) current.set(nodeId, createIdentity()); return current.get(nodeId); },
    isCurrent: (nodeId, accountId) => !current.has(nodeId) || current.get(nodeId).id === accountId,
    short: (nodeId, reason) => shorts.push([nodeId, reason]),
  };
  const client = track(createClient({ directory: nodes.map((n) => n.descriptor), credit }));
  await client.start();
  try {
    const c1 = await client.getCircuit();
    const first = await rawGet(await socksConnect(client.socksPort, '127.0.0.1', http.port), '127.0.0.1', '/');
    assert.equal(sha256(bodyOf(Buffer.concat(first.chunks))), sha256(body));
    await waitFor(() => c1.payers().length === 3, { timeoutMs: 10_000 });
    // every account of this circuit runs dry: the hops refuse, and credit hears about it
    for (const p of c1.payers()) dry.add(p.account);
    const sock = await socksConnect(client.socksPort, '127.0.0.1', http.port);
    rawGet(sock, '127.0.0.1', '/'); // stalls once the unpaid amount passes the limit
    await waitFor(() => shorts.length > 0, { timeoutMs: 10_000 });
    assert.equal(shorts[0][1], 'insufficient funds');
    assert.ok(c1.payers().some((p) => p.node === shorts[0][0]));
    // credit moves one node to a fresh account: the old circuit is no longer picked for new streams
    assert.equal(await client.getCircuit(), c1);
    current.set(c1.payers()[0].node, createIdentity());
    const c2 = await client.getCircuit();
    assert.notEqual(c2, c1);
    assert.equal(c1.closed, false, 'the old circuit is left to finish what runs on it');
  } finally {
    await client.stop();
  }
});
