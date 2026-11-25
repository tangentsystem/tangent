// A stand in for the Tangent desktop app's control API (app/CONTROL-API.md), for tests and for
// trying the extension by hand. When "connected" it runs a real SOCKS5 listener so a browser
// pointed at it actually loads pages through it.
//
// By hand:  node test/mock-app.mjs [--approve=auto|manual|deny] [--balance]
//   auto approves pairing after 2 seconds. Type "a" + Enter to approve in manual mode,
//   "d" to drop the private internet (kill switch), "c" to bring it back, "b" to toggle balance.

import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const nodeId = () => Array.from(randomBytes(44), (b) => B58[b % 58]).join('');

// ---- tiny SOCKS5 server: no auth, CONNECT only, names forwarded unresolved to us ----------
export function startSocks({ port = 0, host = '127.0.0.1', resolve = {}, onConnect = () => {}, onBytes = () => {} } = {}) {
  const sockets = new Set();
  const seen = [];
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        if (buf[0] !== 5) return client.destroy();
        const methods = buf.subarray(2, 2 + buf[1]);
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(0)) return client.end(Buffer.from([5, 0xff]));
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        const cmd = buf[1], atyp = buf[3];
        let target, off;
        if (atyp === 1) { if (buf.length < 10) return; target = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else if (atyp === 3) { const l = buf[4]; if (buf.length < 7 + l) return; target = buf.subarray(5, 5 + l).toString(); off = 5 + l; }
        else if (atyp === 4) { if (buf.length < 22) return; target = buf.subarray(4, 20).toString('hex').match(/.{4}/g).join(':'); off = 20; }
        else return client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
        const tport = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        stage = 2;
        client.removeListener('data', onData);
        const entry = { host: target, port: tport, addressType: atyp === 3 ? 'name' : atyp === 1 ? 'ipv4' : 'ipv6', at: Date.now() };
        seen.push(entry);
        onConnect(entry);
        if (cmd !== 1) return client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
        const upstream = net.connect({ host: resolve[target] ?? target, port: tport });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.once('connect', () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.on('data', (d) => onBytes(d.length, 0));
          upstream.on('data', (d) => onBytes(0, d.length));
          client.pipe(upstream).pipe(client);
        });
        upstream.once('error', () => {
          if (!client.destroyed) client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        });
      }
    };
    client.on('data', onData);
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => {
      res({
        port: server.address().port,
        seen,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

// ---- the control API -----------------------------------------------------------------------
export async function startMockApp({
  port = 47611,
  socksPort = 47612,
  approve = 'auto',          // 'auto' | 'manual' | 'deny'
  approveDelayMs = 300,
  connectDelayMs = 400,
  resolve = {},
  failConnect = null,        // a sentence: connect ends with this error instead of a path
  log = () => {},
} = {}) {
  const pairs = new Map();  // id -> { state, token, created }
  const tokens = new Set();
  const state = {
    connected: false, connecting: false, socks: null, hops: [],
    usage: { bytesUp: 0, bytesDown: 0 }, since: null, needsBalance: false, error: null,
  };
  let socks = null;
  let connectTimer = null;
  const opened = [];
  const requests = [];

  const statusBody = () => ({
    connected: state.connected,
    connecting: state.connecting,
    socks: state.connected && socks ? { host: '127.0.0.1', port: socks.port } : null,
    hops: state.connected ? state.hops.map((id) => ({ id })) : [],
    usage: { ...state.usage },
    since: state.connected ? state.since : null,
    needsBalance: state.needsBalance,
    error: state.error,
  });

  async function bringUp() {
    if (state.connected) return;
    try {
      socks = await startSocks({
        port: socksPort,
        resolve,
        onBytes: (up, down) => { state.usage.bytesUp += up; state.usage.bytesDown += down; },
      });
      state.hops = [nodeId(), nodeId(), nodeId()];
      state.connected = true;
      state.since = Date.now();
      state.error = null;
    } catch (e) {
      state.error = 'We could not open the local port.';
    }
    state.connecting = false;
  }

  async function bringDown() {
    clearTimeout(connectTimer);
    state.connecting = false;
    state.connected = false;
    state.hops = [];
    state.since = null;
    if (socks) { const s = socks; socks = null; await s.close(); }
  }

  function approvePair(id, ok = true) {
    const p = pairs.get(id);
    if (!p || p.state !== 'waiting') return false;
    if (ok) {
      p.state = 'approved';
      p.token = randomBytes(32).toString('base64url');
      tokens.add(p.token);
    } else {
      p.state = 'denied';
    }
    return true;
  }

  const send = (res, code, body, origin) => {
    const h = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (origin) { h['access-control-allow-origin'] = origin; h.vary = 'Origin'; }
    res.writeHead(code, h);
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const { method } = req;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    requests.push({ method, path, origin: req.headers.origin ?? null, host: req.headers.host ?? null, auth: !!req.headers.authorization });
    log(`${method} ${path}`);

    const actualPort = server.address().port;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return send(res, 403, { error: 'host' });
    const origin = req.headers.origin;
    if (origin !== undefined && !(origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
      return send(res, 403, { error: 'origin' });
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin ?? '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
      return res.end();
    }

    let body = null;
    if (method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      if (raw) { try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'json' }, origin); } }
    }

    // open calls
    if (method === 'GET' && path === '/v1/hello') return send(res, 200, { app: 'tangent', version: '0.0.0-mock', api: 1 }, origin);
    if (method === 'POST' && path === '/v1/pair') {
      const id = randomBytes(12).toString('base64url');
      pairs.set(id, { state: 'waiting', token: null, created: Date.now(), client: body?.client ?? '' });
      if (approve === 'auto') setTimeout(() => approvePair(id, true), approveDelayMs);
      if (approve === 'deny') setTimeout(() => approvePair(id, false), approveDelayMs);
      log(`pair request ${id} from ${body?.client}`);
      return send(res, 200, { request: id }, origin);
    }
    const pm = path.match(/^\/v1\/pair\/([^/]+)$/);
    if (method === 'GET' && pm) {
      const p = pairs.get(decodeURIComponent(pm[1]));
      if (!p) return send(res, 404, { error: 'unknown' }, origin);
      if (p.state === 'waiting' && Date.now() - p.created > 120_000) p.state = 'expired';
      if (p.state === 'approved') { pairs.delete(pm[1]); return send(res, 200, { state: 'approved', token: p.token }, origin); }
      return send(res, 200, { state: p.state }, origin);
    }

    // everything else needs a token
    const auth = req.headers.authorization ?? '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokens.has(tok)) return send(res, 401, { error: 'unpaired' }, origin);

    if (method === 'GET' && path === '/v1/status') return send(res, 200, statusBody(), origin);
    if (method === 'POST' && path === '/v1/connect') {
      if (!state.connected && !state.connecting && !state.needsBalance) {
        state.connecting = true;
        state.error = null;
        connectTimer = setTimeout(() => {
          if (failConnect) { state.connecting = false; state.error = failConnect; } else bringUp();
        }, connectDelayMs);
      }
      return send(res, 200, statusBody(), origin);
    }
    if (method === 'POST' && path === '/v1/disconnect') {
      await bringDown();
      return send(res, 200, statusBody(), origin);
    }
    if (method === 'POST' && path === '/v1/open') {
      const view = body?.view;
      if (!['internet', 'wallet', 'computers', 'network'].includes(view)) return send(res, 400, { error: 'view' }, origin);
      opened.push(view);
      return send(res, 200, { ok: true }, origin);
    }
    return send(res, 404, { error: 'not_found' }, origin);
  });

  const conns = new Set();
  server.on('connection', (s) => { conns.add(s); s.on('close', () => conns.delete(s)); });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });

  return {
    port: server.address().port,
    base: `http://127.0.0.1:${server.address().port}`,
    state, pairs, tokens, opened, requests,
    get socks() { return socks; },
    approve: approvePair,
    pending: () => [...pairs.entries()].filter(([, p]) => p.state === 'waiting').map(([id]) => id),
    revokeAll: () => tokens.clear(),
    connectNow: bringUp,
    drop: bringDown,                         // the private internet stops (app still running)
    setNeedsBalance: (v) => { state.needsBalance = !!v; },
    setError: (e) => { state.error = e; },
    close: async () => {
      await bringDown();
      for (const s of conns) s.destroy();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// ---- run by hand -----------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}`));
  const approve = (arg('approve') ?? '--approve=auto').split('=')[1];
  const app = await startMockApp({ approve, approveDelayMs: 2000, connectDelayMs: 1500, log: (l) => console.log(new Date().toISOString().slice(11, 19), l) });
  if (arg('balance')) app.setNeedsBalance(true);
  console.log(`mock Tangent app on ${app.base} (pairing: ${approve}). keys: a approve, d drop, c connect, b balance, x revoke, q quit`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (line) => {
    const k = line.trim();
    if (k === 'a') { for (const id of app.pending()) app.approve(id); console.log('approved'); }
    if (k === 'd') { await app.drop(); console.log('dropped'); }
    if (k === 'c') { await app.connectNow(); console.log('connected'); }
    if (k === 'b') { app.setNeedsBalance(!app.state.needsBalance); console.log('needsBalance', app.state.needsBalance); }
    if (k === 'x') { app.revokeAll(); console.log('tokens removed'); }
    if (k === 'q') { await app.close(); process.exit(0); }
  });
}
