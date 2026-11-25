// Test helpers: start relays on localhost, a local HTTP server and a TCP echo server.
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { SocksClient } from 'socks';
import { createIdentity, createKxKeypair, signDescriptor, createMeter } from '../../core/index.js';
import { createRelay } from '../relay.js';

// Everything a test starts is tracked so a failing test cannot leave sockets open.
const live = new Set();
export function track(x) { live.add(x); return x; }
export async function cleanupAll() {
  const list = [...live]; live.clear();
  for (const x of list) { try { await (x.stop ? x.stop() : x.close()); } catch { /* already closed */ } }
}

export async function startRelay({ roles = ['relay'], perMbLamports = 0n, creditLimitLamports, onVoucher, allowPrivateTargets = true, allowPrivateRelays = true, ...rest } = {}) {
  const identity = createIdentity();
  const kx = createKxKeypair();
  const meter = createMeter();
  const vouchers = [];
  // descriptor needs the port, so listen first then sign
  const relay = createRelay({
    identity, kx, host: '127.0.0.1', port: 0, exit: roles.includes('exit'), meter,
    creditLimitLamports, allowPrivateTargets, allowPrivateRelays,
    onVoucher: onVoucher || (async (v) => { vouchers.push(v); return { ok: true }; }),
    ...rest,
  });
  await relay.start();
  track(relay);
  const descriptor = signDescriptor(identity, { roles, host: '127.0.0.1', port: relay.port, kx: kx.pub, prices: { perMbLamports } });
  relay.setDescriptor(descriptor); // price per MB comes from the signed descriptor
  return { relay, identity, kx, meter, descriptor, vouchers };
}

export function startHttpServer(handler) {
  return new Promise((resolve) => {
    const peers = [];
    const srv = http.createServer((req, res) => { peers.push(req.socket.remotePort); handler(req, res); });
    srv.listen(0, '127.0.0.1', () => resolve(track({ server: srv, port: srv.address().port, peers, close: () => new Promise((r) => { srv.closeAllConnections?.(); if (!srv.listening) return r(); srv.close(() => r()); }) })));
  });
}

export function startEchoServer() {
  return new Promise((resolve) => {
    const socks = new Set();
    const srv = net.createServer((s) => { socks.add(s); s.on('close', () => socks.delete(s)); s.on('error', () => {}); s.pipe(s); });
    srv.listen(0, '127.0.0.1', () => resolve(track({ server: srv, port: srv.address().port, close: () => new Promise((r) => { for (const s of socks) s.destroy(); if (!srv.listening) return r(); srv.close(() => r()); }) })));
  });
}

export async function socksConnect(socksPort, host, port) {
  const { socket } = await SocksClient.createConnection({
    proxy: { host: '127.0.0.1', port: socksPort, type: 5 },
    command: 'connect',
    destination: { host, port },
    timeout: 20_000,
  });
  return socket;
}

// GET through SOCKS with node's http client on top of the SOCKS socket.
export async function httpGetViaSocks(socksPort, host, port, path = '/') {
  const sock = await socksConnect(socksPort, host, port);
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET', createConnection: () => sock, agent: false, headers: { connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

export function waitFor(fn, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
