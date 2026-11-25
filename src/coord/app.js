// The coordinator HTTP api (Express). createApp() wires the routes onto a store,
// the coordinator keys and whatever modules exist; nothing here opens a socket
// or starts a timer (src/index.js does that).
//
// Every response: JSON, Cache-Control: no-store. Every route validates its
// input with zod. Bodies are capped (bodyLimitKb). Rate limits per client
// address: a general bucket for everything plus tighter ones for registration,
// heartbeats, voucher redemption and off grid claims.
import express from 'express';
import { z } from 'zod';
import { checkVoucher, verifyObject, ROLES, VOUCHER_KINDS } from '../core/index.js';
import { PRODUCT_NAME, solscan, solscanTx } from '../config.js';
import { createRateLimiter } from './ratelimit.js';
import { createWeb } from '../web/index.js';
import { createRegistry, CoordError, reputationOf } from './registry.js';
import { createHash } from 'node:crypto';
import { splitTip as defaultSplit, lamportsReceived, accountKeysOf, rawTxBytes } from './offgrid-claim.js';

const B58 = '1-9A-HJ-NP-Za-km-z';
const id = z.string().regex(new RegExp(`^[${B58}]{32,44}$`), 'must be a base58 address');
const sig = z.string().regex(new RegExp(`^[${B58}]{64,90}$`), 'must be a base58 signature');
const digits = z.union([z.string().regex(/^[0-9]{1,20}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]);
const ts = z.number().int().positive().max(1e15);

const descriptorSchema = z.object({
  v: z.literal(1).optional(),
  id,
  roles: z.array(z.enum(ROLES)).min(1).max(4),
  host: z.string().max(253).optional().default(''),
  port: z.number().int().min(0).max(65535).optional().default(0),
  apiPort: z.number().int().min(0).max(65535).optional().default(0),
  onion: z.string().regex(/^[a-z2-7]{56}\.onion$/, 'must be a v3 onion address').optional(),
  kx: id,
  payout: id.optional(),
  prices: z.object({ perMbLamports: digits.optional(), perTxLamports: digits.optional(), perSecondLamports: digits.optional() }).optional().default({}),
  region: z.string().regex(/^[a-z0-9-]{1,32}$/, 'coarse region such as eu-west').optional(),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
  ts,
  sig,
});

const heartbeatSchema = z.object({ id, ts, load: z.number().min(0).max(1), sig });

const voucherSchema = z.object({
  v: z.literal(1),
  session: z.string().min(1).max(128),
  payer: id,
  node: id,
  kind: z.enum(VOUCHER_KINDS),
  cumulative: z.string().regex(/^[0-9]{1,20}$/),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expires: z.number().int().nonnegative().max(1e15),
  sig,
});
const redeemSchema = z.object({ node: id, ts, voucher: voucherSchema, sig });

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 hex chars');
const trailSchema = z.array(z.object({ node: id, sig })).max(8);
const claimSchema = z.strictObject({
  v: z.number().int().min(1).max(1000),
  t: z.string().min(1).max(64),
  role: z.enum(['gateway', 'carrier']),
  claimant: id,
  bundleId: hex64,
  signature: sig,
  slot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  gateway: id,
  trail: trailSchema,
  receipt: z.record(z.string(), z.unknown()),
  ts,
  sig,
});

const roleQuery = z.object({ role: z.enum(ROLES).optional() });
const emptyQuery = z.object({});
const idParams = z.object({ id });

function parse(schema, value) {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const err = new CoordError(400, 'INVALID', 'request did not pass validation');
  err.issues = r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw err;
}

function safeSummary(selftest) {
  try { return typeof selftest.summary === 'function' ? selftest.summary() : { state: 'unknown' }; } catch { return { state: 'unknown' }; }
}

function big(v) {
  try { return typeof v === 'bigint' ? v : BigInt(v ?? 0); } catch { return 0n; }
}

// pay.creditTip({ id, lamports, gateway, carriers }): pay applies its fee and split, exactly once per id.
async function creditSplit(pay, args) {
  if (pay && typeof pay.creditTip === 'function') return pay.creditTip(args);
  throw new CoordError(503, 'NOT_CONFIGURED', 'payments cannot credit tips');
}

export function createApp({
  store, pay = null, token = null, config, connection = null, log = null, keys,
  offgrid = null, stake = null, now = Date.now, provisioner = null, selftest = null, onion = null, releases = null,
} = {}) {
  if (!store) throw new Error('createApp: store is required');
  if (!config) throw new Error('createApp: config is required');
  if (!keys || !keys.coordinator || !keys.tip) throw new Error('createApp: keys are required (see src/keys.js ensureKeys)');
  const logger = log || { info() {}, warn() {}, error() {}, line() {} };
  const identity = keys.coordinator;
  const tipAccount = keys.tip.address;
  const startedAt = now();
  const registry = createRegistry({ store, config, identity, stake, now, log: logger });
  const stats = store.collection('stats');
  const sessions = store.collection('sessions');
  const claims = store.collection('offgrid_claims');
  const split = offgrid && typeof offgrid.splitTip === 'function' ? offgrid.splitTip : defaultSplit;
  const checkClaim = offgrid && typeof offgrid.checkClaim === 'function' ? offgrid.checkClaim : null;
  const skewOk = (t) => Math.abs(now() - t) <= config.requestMaxSkewMs;

  const limit = (max, windowMs) => createRateLimiter({ max, windowMs, now }).middleware;
  const limits = {
    general: limit(config.rateLimitPerMin, 60_000),
    register: limit(config.registerLimitPerHour, 3_600_000),
    heartbeat: limit(config.heartbeatLimitPerMin, 60_000),
    redeem: limit(config.redeemLimitPerMin, 60_000),
    claim: limit(config.claimLimitPerMin, 60_000),
  };

  // Money gate (docs/selftest.md): while the deploy self test has not passed its required checks,
  // user facing money actions answer 503 SELFTEST_PENDING. Without a self test (memory storage or
  // no Helius key) pay is off anyway and there is nothing to gate.
  const moneyOpen = () => !selftest || Boolean(selftest.clear());
  const moneyGate = (_req, res, next) => {
    if (moneyOpen()) return next();
    return res.status(503).json({ error: 'SELFTEST_PENDING', message: 'money actions open once the self test has passed; see /api/selftest' });
  };
  const GATED_PAY = [/^\/deposit(\/|$)/, /^\/issue\/?$/, /^\/redeem\/?$/, /^\/withdraw\/?$/];
  const payGate = (req, res, next) => {
    const gated = (req.method === 'POST' && GATED_PAY.some((r) => r.test(req.path))) || (req.method === 'GET' && /^\/deposit\//.test(req.path));
    return gated ? moneyGate(req, res, next) : next();
  };

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.trustProxy);
  app.set('json replacer', (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(limits.general);
  app.use(express.json({ limit: `${config.bodyLimitKb}kb`, strict: true }));

  const ready = registry.init().catch((err) => logger.error('registry.init_failed', { reason: String(err && err.message).slice(0, 200) }));
  app.use(async (_req, _res, next) => { await ready; next(); });

  const siteOnion = () => { try { return (typeof onion === 'function' && onion()) || null; } catch { return null; } };

  app.get('/api/health', (req, res) => {
    parse(emptyQuery, req.query);
    res.json({
      ok: true,
      name: PRODUCT_NAME,
      version: config.version,
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      storage: { kind: store.kind, transactions: Boolean(store.capabilities && store.capabilities.transactions) },
      config: { ...config.flags },
      modules: { pay: Boolean(pay), token: Boolean(token) && Boolean(config.flags && config.flags.token), offgrid: Boolean(offgrid), ...(pay && config.payDevSim && !(config.flags.mongo && config.flags.helius) ? { paySimulated: true } : {}) },
      network: {
        coordinator: identity.id,
        tipAccount,
        links: { coordinator: solscan(identity.id, config), tipAccount: solscan(tipAccount, config) },
        ...(siteOnion() ? { onion: `http://${siteOnion()}` } : {}),
      },
      selftest: selftest ? { ...safeSummary(selftest), moneyActions: moneyOpen() ? 'open' : 'closed' } : { state: 'off', reason: 'runs when MONGO_URI and HELIUS_API_KEY are set' },
    });
  });

  app.get('/api/selftest', (req, res) => {
    parse(emptyQuery, req.query);
    if (!selftest) return res.json({ enabled: false, reason: 'the self test runs when MONGO_URI and HELIUS_API_KEY are set' });
    const report = typeof selftest.report === 'function' ? selftest.report() : null;
    res.json({ enabled: true, moneyActions: moneyOpen() ? 'open' : 'closed', report: report || { state: 'starting' } });
  });

  app.post('/api/nodes/register', limits.register, async (req, res) => {
    const body = parse(descriptorSchema, req.body);
    const { node, created } = await registry.register(body);
    if (created) logger.info('node.registered', { id: node._id, roles: node.roles });
    res.status(created ? 201 : 200).json({
      ok: true,
      id: node._id,
      created,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      livenessMs: config.livenessMs,
      link: solscan(node._id, config),
    });
  });

  app.post('/api/nodes/heartbeat', limits.heartbeat, async (req, res) => {
    const body = parse(heartbeatSchema, req.body);
    res.json({ ok: true, ...(await registry.heartbeat(body)) });
  });

  app.get('/api/directory', async (req, res) => {
    const { role } = parse(roleQuery, req.query);
    res.json(await registry.directory(role));
  });

  app.get('/api/map', async (req, res) => {
    parse(emptyQuery, req.query);
    res.json({ nodes: await registry.map() });
  });

  app.get('/api/stats', async (req, res) => {
    parse(emptyQuery, req.query);
    const counts = await registry.onlineCounts();
    const totals = (await stats.get('totals')) || {};
    const out = {};
    const nodes = {};
    for (const [k, v] of Object.entries(counts)) if (v > 0) nodes[k] = v;
    if (Object.keys(nodes).length) out.nodes = nodes;
    for (const k of ['sessions', 'redemptions', 'redeemedLamports', 'offgridClaims', 'offgridTipLamports']) {
      const v = big(totals[k]);
      if (v > 0n) out[k] = v.toString();
    }
    res.json(out);
  });

  app.post('/api/vouchers/redeem', limits.redeem, moneyGate, async (req, res) => {
    const body = parse(redeemSchema, req.body);
    if (!verifyObject(body.node, { node: body.node, ts: body.ts, voucher: body.voucher }, body.sig)) throw new CoordError(401, 'BAD_SIGNATURE', 'request signature does not verify');
    if (!skewOk(body.ts)) throw new CoordError(400, 'STALE', 'request timestamp is too far from now');
    if (body.voucher.node !== body.node) throw new CoordError(400, 'WRONG_NODE', 'voucher is for another node');
    const node = await registry.get(body.node);
    if (!node) throw new CoordError(403, 'NOT_REGISTERED', 'node is not registered');
    const vc = checkVoucher(body.voucher, { node: body.node, now: now() });
    if (!vc.ok) throw new CoordError(400, 'BAD_VOUCHER', vc.reason);
    if (!pay || typeof pay.redeemVoucher !== 'function') throw new CoordError(503, 'NOT_CONFIGURED', 'payments are not switched on');
    const result = await pay.redeemVoucher(body.voucher, { node: body.node });
    if (!result || !result.ok) {
      const err = new CoordError(409, 'REJECTED', String((result && result.reason) || 'voucher was not accepted').slice(0, 120));
      throw err;
    }
    const credited = big(result.nodeCredited ?? result.credited);
    if (credited > 0n) {
      await registry.recordWork(body.node, credited);
      await stats.incr('totals', 'redemptions', 1n);
      await stats.incr('totals', 'redeemedLamports', credited);
      if (await sessions.insert({ _id: `${body.node}:${body.voucher.session}`, at: now() })) await stats.incr('totals', 'sessions', 1n);
    }
    const out = { ok: true, credited: credited.toString() };
    // A short account gives partial credit: the node learns it and can refuse the voucher.
    if (big(result.shortfall) > 0n) { out.partial = true; out.shortfall = big(result.shortfall).toString(); }
    res.json(out);
  });

  app.post('/api/offgrid/claim', limits.claim, moneyGate, async (req, res) => {
    const c = parse(claimSchema, req.body);
    if (!checkClaim) throw new CoordError(503, 'NOT_CONFIGURED', 'off grid claims are not switched on');
    const cc = checkClaim(c);
    if (!cc.ok) {
      const code = cc.reason === 'claimant signature' || cc.reason === 'receipt signature' ? 401 : 400;
      throw new CoordError(code, code === 401 ? 'BAD_SIGNATURE' : 'BAD_CLAIM', 'claim rejected: ' + String(cc.reason).slice(0, 80));
    }
    if (!skewOk(c.ts)) throw new CoordError(400, 'STALE', 'claim timestamp is too far from now');
    const carriers = c.trail.map((e) => e.node);
    const gw = await registry.get(c.gateway);
    if (!gw || !gw.roles.includes('gateway')) throw new CoordError(403, 'NOT_GATEWAY', 'gateway is not a registered gateway node');
    const registered = [];
    const unregistered = [];
    for (const carrier of carriers) ((await registry.get(carrier)) ? registered : unregistered).push(carrier);
    if (await claims.get(c.signature)) throw new CoordError(409, 'ALREADY_CLAIMED', 'this transaction was already claimed');
    if (!pay) throw new CoordError(503, 'NOT_CONFIGURED', 'payments are not switched on');
    if (!connection || typeof connection.getTransaction !== 'function') throw new CoordError(503, 'NOT_CONFIGURED', 'no Solana connection');

    let tx;
    try {
      tx = await connection.getTransaction(c.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    } catch (err) {
      logger.warn('offgrid.lookup_failed', { reason: String(err && err.message).slice(0, 120) });
      throw new CoordError(502, 'LOOKUP_FAILED', 'could not read the transaction, try again later');
    }
    if (!tx) throw new CoordError(404, 'TX_NOT_FOUND', 'transaction not found on chain');
    const sigs = tx.transaction && Array.isArray(tx.transaction.signatures) ? tx.transaction.signatures.map(String) : null;
    if (sigs && sigs.length && sigs[0] !== c.signature) throw new CoordError(400, 'TX_MISMATCH', 'transaction signature does not match');
    if (!tx.meta || tx.meta.err !== null) throw new CoordError(422, 'TX_FAILED', 'transaction did not succeed');
    // The claim's bundleId must be sha256 of the transaction's wire bytes, when the connection can return them.
    let raw = null;
    try { raw = await rawTxBytes(connection, c.signature); } catch { raw = null; }
    if (raw) {
      const want = offgrid && typeof offgrid.bundleIdOfTx === 'function' ? offgrid.bundleIdOfTx(raw) : createHash('sha256').update(raw).digest('hex');
      if (want !== c.bundleId) throw new CoordError(400, 'BUNDLE_MISMATCH', 'bundle id does not match the transaction');
    }
    const tip = lamportsReceived(tx, tipAccount);
    if (tip <= 0n || !accountKeysOf(tx).includes(tipAccount)) throw new CoordError(422, 'NO_TIP', 'transaction pays nothing to the network tip account');

    const t = now();
    if (!(await claims.insert({ _id: c.signature, status: 'pending', claimant: c.claimant, gateway: c.gateway, bundleId: c.bundleId, tipLamports: tip, at: t }))) {
      throw new CoordError(409, 'ALREADY_CLAIMED', 'this transaction was already claimed');
    }
    let credits;
    try {
      const r = await creditSplit(pay, { id: c.signature, lamports: tip.toString(), gateway: c.gateway, carriers: registered });
      if (r && r.ok === false) throw new CoordError(502, 'CREDIT_FAILED', String(r.reason || 'payments refused the credit').slice(0, 120));
      if (r && Array.isArray(r.shares)) {
        credits = r.shares.map((x) => ({ node: x.nodeId, role: x.role, lamports: big(x.lamports) }));
      } else {
        const parts = split(tip, registered.map((n) => ({ node: n })), c.gateway);
        credits = [{ node: parts.gateway.id, role: 'gateway', lamports: big(parts.gateway.lamports) }, ...parts.carriers.map((x) => ({ node: x.id, role: 'carrier', lamports: big(x.lamports) }))];
      }
      credits = credits.filter((x) => x.lamports > 0n);
    } catch (err) {
      await claims.delete(c.signature, { status: 'pending' });
      throw err;
    }
    await claims.update(c.signature, { set: { status: 'credited', credits: credits.map((x) => ({ node: x.node, role: x.role, lamports: x.lamports })) } });
    await stats.incr('totals', 'offgridClaims', 1n);
    await stats.incr('totals', 'offgridTipLamports', tip);
    logger.info('offgrid.claimed', { signature: c.signature, tip, parties: credits.length });
    const body = {
      ok: true,
      signature: c.signature,
      tipLamports: tip.toString(),
      credits: credits.map((x) => ({ node: x.node, role: x.role, lamports: x.lamports.toString(), link: solscan(x.node, config) })),
      link: solscanTx(c.signature, config),
    };
    if (unregistered.length) body.unpaidCarriers = unregistered.map((n) => ({ node: n, reason: 'not registered', link: solscan(n, config) }));
    res.json(body);
  });

  app.get('/api/nodes/:id/earnings', async (req, res) => {
    const { id: nodeId } = parse(idParams, req.params);
    parse(emptyQuery, req.query);
    if (!pay || typeof pay.earnings !== 'function') throw new CoordError(503, 'NOT_CONFIGURED', 'payments are not switched on');
    const node = await registry.get(nodeId);
    const earnings = await pay.earnings(nodeId);
    if (!node && !earnings) throw new CoordError(404, 'NOT_FOUND', 'unknown node');
    const out = { id: nodeId, link: solscan(nodeId, config), earnings: earnings ?? null };
    if (node) {
      out.payout = node.descriptor.payout;
      out.payoutLink = solscan(node.descriptor.payout, config);
      out.reputation = reputationOf(node, now());
      out.redeemed = { count: big(node.redeemedCount).toString(), lamports: big(node.redeemedLamports).toString() };
    }
    res.json(out);
  });

  const notConfigured = (_req, res) => res.status(503).json({ error: 'NOT_CONFIGURED', message: 'this part is not switched on' });
  app.use('/api/pay', payGate, pay && pay.router ? pay.router : notConfigured);
  app.use('/api/token', token && token.router ? token.router : notConfigured);

  app.use(createWeb({ token, onion: siteOnion, releases }));

  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'no such route' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (err instanceof CoordError) {
      const body = { error: err.code, message: err.message };
      if (err.issues) body.issues = err.issues;
      return res.status(err.status).json(body);
    }
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'TOO_LARGE', message: 'request body is too large' });
    if (err && (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) return res.status(400).json({ error: 'BAD_JSON', message: 'request body is not valid JSON' });
    if (err && err.name === 'PayError' && Number.isInteger(err.status) && typeof err.code === 'string') {
      return res.status(err.status).json({ error: err.code, message: String(err.message).slice(0, 200) });
    }
    if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'BAD_REQUEST', message: 'bad request' });
    logger.error('http.error', { path: req.path, reason: String(err && err.message).slice(0, 200) });
    return res.status(500).json({ error: 'INTERNAL', message: 'something went wrong' });
  });

  app.locals.registry = registry;
  app.locals.sweep = () => registry.sweep();
  app.locals.provisioner = provisioner;
  return app;
}
