// The private internet: a local SOCKS5 listener whose every connection rides a 3 hop circuit
// built by the repo's relay client (src/relay/client.js). The listener is ours (not the relay
// client's own) so the app can count the bytes it carries; the SOCKS parsing is the repo's.
//
// Paying the hops. Relays carry a small unpaid amount per circuit (creditLimit in
// src/relay/relay.js: by default the price of 1 MB per hop) and send a bill when half of it
// is used. With balance in the wallet the app buys credit up front and the automatic top up
// keeps it going (src/node/credit.js createAutoTopUp), like `client.js proxy`. With an empty
// wallet it still connects: the bills find no payer, the hop stalls once its allowance is
// used, and needsBalance turns on so the person is sent to the Wallet view.
import net from 'node:net';
import { createClient } from '../../src/relay/client.js';
import { readSocksRequest, replyCell, repForReason, REP } from '../../src/relay/socks.js';
import { createAutoTopUp, AUTO_TOP_UP_DEFAULT_LIMIT } from '../../src/node/credit.js';

const relaysOf = (dir) => dir.filter((d) => d.roles.includes('relay') || d.roles.includes('exit'));
const STARVE_WINDOW_MS = 15_000;

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

export function friendlyError(err) {
  const m = String((err && err.message) || err || '');
  if (/unreachable|ENOTFOUND|ECONNREFUSED|fetch failed|timeout/i.test(m) && /coordinator/i.test(m)) return 'We could not reach the network. Check your connection and try again.';
  if (/no exit|not enough relays|path:/i.test(m)) return 'Not enough nodes are online to build a private path right now.';
  if (/signature|coordinator/i.test(m)) return 'We could not read the network directory. Try again in a moment.';
  return 'We could not build a private path. Try again in a moment.';
}

export function createSession({
  coord, wallet, log = () => {}, emit = () => {}, dataDir,
  socksHost = '127.0.0.1', socksPort = 47612, hops = 3,
  topUpLimitLamports = AUTO_TOP_UP_DEFAULT_LIMIT, refreshMs = 60_000, tickMs = 2_000,
  clientOptions = {}, now = Date.now,
}) {
  let phase = 'off';
  let since = null;
  let error = null;
  let usage = { bytesUp: 0, bytesDown: 0 };
  let streams = 0;
  let port = null;
  let client = null;
  let server = null;
  let auto = null;
  let credit = null;
  let dirIds = [];
  let walletCanPay = false;
  let walletCheckedAt = 0;
  let lastStarveAt = 0;
  let limitReached = false;
  let timers = [];
  let run = 0;
  const sockets = new Set();
  const targets = []; // last few targets, for tests and the technical line (host:port only)
  let lastSig = '';

  function hopsNow() {
    if (!client) return [];
    const open = client.circuits().filter((c) => c.open && !c.closed);
    if (!open.length) return [];
    open.sort((a, b) => (b.streams - a.streams) || (a.ageMs - b.ageMs));
    return open[0].path.map((id) => ({ id }));
  }

  function needsBalance() {
    return phase === 'on' && now() - lastStarveAt < STARVE_WINDOW_MS && !walletCanPay;
  }

  function status() {
    return {
      connected: phase === 'on',
      connecting: phase === 'connecting',
      socks: phase === 'on' ? { host: socksHost, port } : null,
      hops: phase === 'on' ? hopsNow() : [],
      usage: { bytesUp: usage.bytesUp, bytesDown: usage.bytesDown },
      since: phase === 'on' ? since : null,
      needsBalance: needsBalance(),
      error,
    };
  }
  // status plus what only the app shows
  function details() {
    return { ...status(), limitReached: phase === 'on' && limitReached && !needsBalance(), streams, circuits: client ? client.circuits() : [] };
  }

  function changed(force = false) {
    const s = status();
    const sig = JSON.stringify([s.connected, s.connecting, s.hops, s.needsBalance, s.error, s.socks, limitReached]);
    if (force || sig !== lastSig) { lastSig = sig; emit('status', details()); }
  }

  async function checkWallet(force = false) {
    if (!force && now() - walletCheckedAt < 10_000) return walletCanPay;
    walletCheckedAt = now();
    const before = walletCanPay;
    try { walletCanPay = (await wallet.balance()).canPay; } catch { /* keep what we knew */ }
    if (walletCanPay && !before && phase === 'on') fundAll().catch(() => {});
    return walletCanPay;
  }

  async function fundAll() {
    if (!credit || !walletCanPay || !dirIds.length) return;
    try { await credit.fund(dirIds, { tokensEach: 1 }); } catch (err) { log('warn', 'session.fund_failed', { reason: err.message }); }
    if (auto) { try { await auto.check(dirIds); } catch { /* logged by auto top up */ } }
  }

  // The credit the relay client sees. Unknown nodes are only funded while the wallet can pay,
  // so an empty wallet does not ask the coordinator for tokens on every bill.
  function payingCredit(real) {
    let shortHandler = null;
    return {
      identityFor(nodeId) {
        if (real.has(nodeId)) return real.identityFor(nodeId);
        lastStarveAt = now();
        if (walletCanPay) return real.identityFor(nodeId);
        return null;
      },
      isCurrent: (n, a) => real.isCurrent(n, a),
      short(nodeId, reason) {
        lastStarveAt = now();
        if (shortHandler) shortHandler(nodeId, reason);
      },
      onShort(fn) { shortHandler = typeof fn === 'function' ? fn : null; },
      has: (n) => real.has(n),
      balanceOf: (n) => real.balanceOf(n),
      topUp: (...a) => real.topUp(...a),
      tokenLamports: () => real.tokenLamports(),
    };
  }

  function onSocks(sock) {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    (async () => {
      let req;
      try { req = await readSocksRequest(sock); } catch { return; }
      const c = client;
      if (!c) { if (!sock.destroyed) sock.end(replyCell(REP.GENERAL)); return; }
      let stream;
      try { stream = await c.openStream(req.host, req.port); } catch (e) {
        if (!sock.destroyed) sock.end(replyCell(e.reason ? repForReason(e.reason) : REP.GENERAL));
        return;
      }
      if (sock.destroyed) { stream.destroy(); return; }
      streams++;
      targets.push(`${req.host}:${req.port}`); if (targets.length > 50) targets.shift();
      sock.write(replyCell(REP.OK));
      if (req.rest.length) { usage.bytesUp += req.rest.length; stream.write(req.rest); }
      sock.on('data', (b) => { usage.bytesUp += b.length; });
      stream.on('data', (b) => { usage.bytesDown += b.length; });
      sock.pipe(stream);
      stream.pipe(sock);
      stream.on('error', () => sock.destroy());
      stream.on('close', () => {
        if (sock.destroyed) return;
        if (stream.readableEnded && sock.writableEnded) return;
        sock.destroy();
      });
      sock.on('close', () => { if (!stream.destroyed) stream.destroy(); });
    })();
  }

  async function teardown() {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (auto) { auto.stop(); auto = null; }
    for (const s of sockets) s.destroy();
    sockets.clear();
    if (server) { const s = server; server = null; await new Promise((r) => s.close(() => r())); }
    if (client) { const c = client; client = null; await c.stop().catch(() => {}); }
  }

  async function start(myRun) {
    credit = await wallet.credit();
    const dir = relaysOf(await coord.directory());
    if (myRun !== run) return;
    dirIds = dir.map((d) => d.id);
    await checkWallet(true);
    const pay = payingCredit(credit);
    // the automatic top up listens on pay.onShort: a hop that refuses a payment asks it to look
    auto = await createAutoTopUp({
      credit: pay, dir: dataDir, limitLamports: topUpLimitLamports, tokens: 1, fresh: true,
      log: (level, event, fields) => {
        if (event === 'credit.top_up_limit_reached') limitReached = true;
        if (event === 'credit.topped_up') { limitReached = false; checkWallet(true).catch(() => {}); }
        log(level, event, fields);
      },
    });
    if (walletCanPay) await fundAll();
    if (myRun !== run) return;
    client = createClient({ directory: dir, hops, credit: pay, log: (level, msg, meta) => { if (level === 'warn' || level === 'error') log(level, 'relay.' + String(msg).slice(0, 60), meta || {}); }, ...clientOptions });
    await client.getCircuit(); // the first path is built now, so the person sees it at once
    if (myRun !== run) return;
    server = net.createServer(onSocks);
    try { port = await listen(server, socksPort, socksHost); } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      server = net.createServer(onSocks);
      port = await listen(server, 0, socksHost); // the usual port is taken: any free one
      log('info', 'session.port_fallback', { wanted: socksPort, port });
    }
    if (myRun !== run) return;
    since = now();
    phase = 'on';
    log('info', 'session.connected', { port, hops: hopsNow().length, walletCanPay });
    timers.push(setInterval(async () => {
      try {
        const d = relaysOf(await coord.directory());
        if (!client) return;
        client.setDirectory(d);
        dirIds = d.map((x) => x.id);
        await checkWallet(true);
        if (walletCanPay) await fundAll();
      } catch (err) { log('warn', 'session.refresh_failed', { reason: err.message }); }
    }, refreshMs));
    timers.push(setInterval(() => {
      if (now() - lastStarveAt < STARVE_WINDOW_MS) checkWallet().catch(() => {}).finally(() => changed());
      else changed();
      // keep a circuit ready so the path stays on screen
      if (client && !hopsNow().length) client.getCircuit().then(() => changed(), () => {});
    }, tickMs));
    for (const t of timers) t.unref?.();
    changed(true);
  }

  return {
    status,
    details,
    targets: () => [...targets],
    connect() {
      if (phase !== 'off') return status();
      const myRun = ++run;
      phase = 'connecting';
      error = null;
      usage = { bytesUp: 0, bytesDown: 0 };
      streams = 0;
      lastStarveAt = 0;
      limitReached = false;
      changed(true);
      start(myRun).catch(async (err) => {
        if (myRun !== run) return;
        log('warn', 'session.connect_failed', { reason: err.message });
        await teardown();
        phase = 'off';
        error = friendlyError(err);
        changed(true);
      });
      return status();
    },
    async disconnect() {
      run++;
      const was = phase;
      await teardown();
      phase = 'off';
      since = null;
      port = null;
      if (was !== 'off') log('info', 'session.disconnected', { bytesUp: usage.bytesUp, bytesDown: usage.bytesDown });
      changed(true);
      return status();
    },
    walletChanged() { walletCheckedAt = 0; if (phase === 'on') checkWallet(true).then(() => changed()).catch(() => {}); },
    // waits until connect() settles (tests and the tray)
    async settled({ timeoutMs = 60_000 } = {}) {
      const end = now() + timeoutMs;
      while (phase === 'connecting' && now() < end) await new Promise((r) => setTimeout(r, 100));
      return status();
    },
  };
}
