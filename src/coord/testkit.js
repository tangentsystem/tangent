// Test helpers for the coordinator api: a real HTTP server on a free port, a
// controllable clock, node identities with signed descriptors, and fakes for
// pay, token and the Solana connection.
import http from 'node:http';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { createIdentity, createKxKeypair, signDescriptor, b58 } from '../core/index.js';
import { createMemoryStore } from '../storage/index.js';
import { ensureKeys } from '../keys.js';
import { loadConfig } from '../config.js';
import { createMemoryLogger } from './log.js';
import { createApp } from './app.js';

export const T0 = 1_800_000_000_000;

export function makeNode({ roles = ['relay'], host, port = 9000 + Math.floor(Math.random() * 1000), region = 'eu-west', identity = createIdentity(), onion } = {}) {
  const kx = createKxKeypair();
  const n = {
    identity,
    id: identity.id,
    host: host === undefined ? `node-${identity.id.slice(0, 6).toLowerCase()}.example.org` : host,
    port,
    descriptor(ts, extra = {}) {
      return signDescriptor(identity, { roles, host: n.host, port: n.port, apiPort: 0, kx: kx.pub, region, onion, prices: { perMbLamports: 1000 }, ts, ...extra });
    },
    heartbeat(ts, load = 0.2) {
      const body = { id: identity.id, ts, load };
      return { ...body, sig: identity.signObject(body) };
    },
  };
  return n;
}

export function fakePay({ credited = '1000' } = {}) {
  const router = express.Router();
  router.get('/ping', (_req, res) => res.json({ pong: true }));
  const pay = {
    redeemed: [],
    credits: [],
    failCredit: false,
    reject: null,
    router,
    async redeemVoucher(v) {
      pay.redeemed.push(v);
      if (pay.reject) return { ok: false, reason: pay.reject };
      return { ok: true, credited };
    },
    async earnings(nodeId) { return { nodeId, pendingLamports: 0n, paidLamports: 0n }; },
    async creditTip(args) {
      if (pay.failCredit) throw new Error('credit store down');
      pay.credits.push(args);
      return { ok: true }; // no shares: the coordinator reports its own split
    },
  };
  return pay;
}

export function fakeToken() {
  const router = express.Router();
  router.get('/info', (_req, res) => res.json({ token: true }));
  return { router };
}

export function txSignature() { return b58(randomBytes(64)); }

// getTransaction result shaped like @solana/web3.js (v0 message).
export function fakeConnection() {
  const txs = new Map();
  const raw = new Map();
  return {
    txs,
    raw,
    calls: 0,
    async getRawTransaction(signature) { return raw.get(signature) || null; },
    add(signature, { payer, tipAccount, tip = 0n, err = null, other }) {
      const keys = [payer, other || createIdentity().id];
      const pre = [10_000_000_000, 0];
      const post = [10_000_000_000 - 5000 - Number(tip), 0];
      if (tipAccount) { keys.push(tipAccount); pre.push(1_000_000); post.push(1_000_000 + Number(tip)); }
      txs.set(signature, {
        slot: 123,
        transaction: { signatures: [signature], message: { staticAccountKeys: keys.map((k) => ({ toBase58: () => k })) } },
        meta: { err, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] } },
      });
    },
    async getTransaction(signature) {
      this.calls += 1;
      return txs.get(signature) || null;
    },
  };
}

export async function startApp({ env = {}, overrides = {}, pay = null, token = null, connection = null, offgrid = null, stake = null, releases = null } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const store = await createMemoryStore();
  const keys = await ensureKeys({ store });
  const config = { ...loadConfig(env), ...overrides };
  const log = createMemoryLogger(config);
  const app = createApp({ store, pay, token, config, connection, log, keys, offgrid, stake, now, releases });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['content-type'] = init.headers['content-type'] || 'application/json';
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  return {
    clock, store, keys, config, log, app, base, call,
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    async close() { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); await store.close(); },
  };
}
