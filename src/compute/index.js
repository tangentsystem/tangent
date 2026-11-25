// Agent computers: a node rents machines to AI agents, billed per second.
// createCompute({ identity, driver, meter, onVoucher, egressProxy, log, ...options })
//   -> { router, start(), stop(), machines() }
// Machines come from a driver (docker = sealed containers; process = development
// only, NOT sealed). Each machine has a bearer token, a shell, files, a headless
// Chrome session, a Solana wallet held in the node process, and a public inbox.
// With a walletVault (every node passes one) the node keeps a backup of each machine
// wallet's key for 30 days after the machine ends; the renter gets it back by signing a
// challenge with the payer identity that rented the machine (wallet-recovery routes).
import express from 'express';
import { z } from 'zod';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { checkVoucher } from '../core/voucher.js';
import { verifyObject, canonical, b58 as toB58 } from '../core/index.js';
import { createMachineWallet, explorerAccount, explorerTx } from './wallet.js';
import { createInbox, createRateLimiter } from './limits.js';
import { createBrowserPool } from './browser.js';

export { pickDriver, createDockerDriver, createProcessDriver, DEFAULT_SIZES, DEFAULT_IMAGES } from './drivers/index.js';
export { createComputeClient, createAutopay } from './client.js';

const hashToken = (t) => createHash('sha256').update(String(t)).digest();
const newId = () => 'm_' + randomBytes(12).toString('hex');

function httpError(status, message, extra) { return Object.assign(new Error(message), { status, extra }); }

export function createCompute({
  identity,
  driver,
  meter,
  onVoucher = async () => ({ ok: false, reason: 'no voucher handler configured' }),
  egressProxy = null,
  log = () => {},
  perSecondLamports = 1000n,
  creditLimitSeconds = 10,
  graceMs = 60_000,
  idleMs = 15 * 60_000,
  maxLifetimeMs = 24 * 3600_000,
  tickMs = 1000,
  maxMachines = 16,
  defaultExecTimeoutMs = 60_000,
  maxExecTimeoutMs = 15 * 60_000,
  maxConcurrentExecs = 8,
  maxBufferedOutputBytes = 1024 * 1024,
  maxStreamOutputBytes = 64 * 1024 * 1024,
  maxFileBytes = 32 * 1024 * 1024,
  inbox: inboxOpts = {},
  rentRateLimit = { limit: 20, windowMs: 60_000 },
  browser: browserOpts = {},
  tombstoneMs = 10 * 60_000,
  // Machine wallet key backups (src/node/machine-wallets.js shape):
  // { retentionDays, backup({ machineId, address, payer, secretKey }), ended({ machineId, reason }),
  //   lookup(machineId), reveal(machineId) }. backup runs before the rent answers; if it throws,
  // the rent fails. Without a vault the key lives only in the node's memory.
  walletVault = null,
  walletRecovery: recoveryOpts = {},
} = {}) {
  if (!identity || !driver || !meter) throw new Error('createCompute: identity, driver and meter are required');
  const inboxCfg = { maxMessageBytes: 16 * 1024, maxMessages: 200, perIp: { limit: 30, windowMs: 60_000 }, perMachine: { limit: 120, windowMs: 60_000 }, ...inboxOpts };
  const base = BigInt(perSecondLamports);
  const machines = new Map();
  const tombstones = new Map();
  const browsers = createBrowserPool({ driver, egressProxy, log, ...browserOpts });
  const rentLimiter = createRateLimiter(rentRateLimit);
  const recoveryCfg = { challengeTtlMs: 5 * 60_000, perIp: { limit: 10, windowMs: 60_000 }, perMachine: { limit: 10, windowMs: 60_000 }, now: Date.now, ...recoveryOpts };
  const recoveryIpLimiter = createRateLimiter(recoveryCfg.perIp);
  const recoveryMachineLimiter = createRateLimiter(recoveryCfg.perMachine);
  const challenges = new Map(); // nonce -> { machineId, body (canonical string), expiresAt }
  const keptNote = walletVault ? `this node keeps this wallet's key for ${walletVault.retentionDays} days after the machine ends so the renter can recover it (wallet-recovery, signed by the payer), then deletes it` : null;
  const inboxIpLimiter = createRateLimiter(inboxCfg.perIp);
  const inboxMachineLimiter = createRateLimiter(inboxCfg.perMachine);
  let ticker = null;
  let started = false;

  const priceFor = (size) => base * BigInt(driver.sizes[size].priceMultiplier ?? 1n);

  // ---- billing -------------------------------------------------------------
  function charge(m, now = Date.now()) {
    if (m.state === 'running') meter.add(m.id, Math.max(0, now - m.lastTick));
    m.lastTick = now;
  }
  function usage(m) {
    const s = meter.get(m.id);
    return { milliseconds: s ? Number(s.units) : 0, owedLamports: meter.owed(m.id).toString(), paidLamports: s ? s.paid.toString() : '0', unpaidLamports: meter.unpaid(m.id).toString() };
  }
  async function pause(m, why) {
    if (m.state !== 'running') return;
    m.state = 'paused'; m.pausedAt = Date.now();
    try { await driver.pause(m.handle); } catch (e) { log('compute.pause.error', { id: m.id, error: e.message }); }
    log('compute.paused', { id: m.id, why });
  }
  async function resume(m) {
    if (m.state !== 'paused') return;
    try { await driver.resume(m.handle); } catch (e) { log('compute.resume.error', { id: m.id, error: e.message }); return; }
    m.state = 'running'; m.pausedAt = null; m.lastTick = Date.now();
    log('compute.resumed', { id: m.id });
  }
  async function destroy(m, reason) {
    if (m.state === 'stopped') return m.final;
    charge(m);
    m.state = 'stopped';
    machines.delete(m.id);
    for (const x of m.running) x.kill();
    await browsers.close(m.id).catch(() => {});
    await driver.destroy(m.handle).catch((e) => log('compute.destroy.error', { id: m.id, error: e.message }));
    m.wallet.destroy(); // the in-memory copy; the vault's backup stays for the retention period
    m.inbox.clear();
    let kept = null;
    if (walletVault) {
      try { kept = await walletVault.ended({ machineId: m.id, reason }); } catch (e) { log('compute.wallet_ended.error', { id: m.id, error: e.message }); }
    }
    const u = usage(m);
    meter.close(m.id);
    m.final = {
      machineId: m.id, state: 'stopped', reason, stoppedAt: Date.now(), usage: u, lastVoucherSeq: m.voucher ? m.voucher.seq : null,
      ...(walletVault ? { wallet: { address: m.wallet.address, explorer: explorerAccount(m.wallet.address), keyKeptUntil: kept ? kept.deleteAfter : null, note: keptNote } } : {}),
    };
    tombstones.set(m.id, { tokenHash: m.tokenHash, final: m.final, until: Date.now() + tombstoneMs });
    log('compute.destroyed', { id: m.id, reason });
    return m.final;
  }
  async function sweep() {
    const now = Date.now();
    for (const m of [...machines.values()]) {
      charge(m, now);
      if (now - m.createdAt > maxLifetimeMs) { await destroy(m, 'max lifetime reached'); continue; }
      if (now - m.lastActive > idleMs) { await destroy(m, 'idle'); continue; }
      if (m.state === 'running' && meter.unpaid(m.id) > m.creditLimit) await pause(m, 'unpaid');
      if (m.state === 'paused' && now - m.pausedAt > graceMs) await destroy(m, 'unpaid after grace period');
    }
    for (const [id, t] of tombstones) if (t.until < now) tombstones.delete(id);
  }

  function status(m) {
    return {
      machineId: m.id, state: m.state, image: m.image, size: m.size, sealed: driver.sealed, driver: driver.name,
      createdAt: m.createdAt, expiresAt: m.createdAt + maxLifetimeMs, pausedAt: m.pausedAt, graceEndsAt: m.pausedAt ? m.pausedAt + graceMs : null,
      priceLamportsPerSecond: m.price.toString(), creditLimitLamports: m.creditLimit.toString(), usage: usage(m),
      wallet: { address: m.wallet.address, explorer: explorerAccount(m.wallet.address), ...(keptNote ? { keyKept: keptNote } : {}) },
      inbox: { messages: m.inbox.size() },
    };
  }

  // ---- auth ----------------------------------------------------------------
  function tokenOk(stored, req) {
    const h = req.get('authorization') || '';
    const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!t) return false;
    return timingSafeEqual(stored, hashToken(t));
  }
  // loads the machine for an authenticated call and brings billing up to date
  function auth({ needRunning = false } = {}) {
    return (req, res, next) => {
      const m = machines.get(req.params.id);
      if (!m) {
        const t = tombstones.get(req.params.id);
        if (t && tokenOk(t.tokenHash, req)) return res.status(410).json({ error: 'machine stopped', ...t.final });
        return res.status(404).json({ error: 'no such machine' });
      }
      if (!tokenOk(m.tokenHash, req)) return res.status(401).json({ error: 'bad or missing token for this machine' });
      m.lastActive = Date.now();
      charge(m);
      if (m.state === 'running' && meter.unpaid(m.id) > m.creditLimit) pause(m, 'unpaid');
      if (needRunning && m.state !== 'running') {
        return res.status(402).json({ error: 'payment required: send a voucher to resume this machine', ...usage(m), creditLimitLamports: m.creditLimit.toString(), state: m.state });
      }
      req.machine = m; next();
    };
  }

  const json = express.json({ limit: '256kb' });
  const parse = (schema, data) => {
    const r = schema.safeParse(data);
    if (!r.success) throw httpError(400, 'invalid request: ' + r.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; '));
    return r.data;
  };

  // ---- schemas -------------------------------------------------------------
  const b58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const RentBody = z.object({ payer: b58, image: z.string().max(64).optional(), size: z.string().max(32).optional() }).strict();
  const ExecBody = z.object({
    cmd: z.string().min(1).max(64 * 1024),
    timeoutMs: z.number().int().positive().max(maxExecTimeoutMs).optional(),
    stdin: z.string().max(1024 * 1024).optional(),
    stdinBase64: z.string().max(1.5 * 1024 * 1024).optional(),
    stream: z.boolean().optional(),
  }).strict();
  const UrlBody = z.object({ url: z.string().min(1).max(4096) }).strict();
  const SelBody = z.object({ selector: z.string().min(1).max(1024) }).strict();
  const TypeBody = z.object({ selector: z.string().min(1).max(1024), text: z.string().max(64 * 1024), submit: z.boolean().optional() }).strict();
  const SignMsgBody = z.object({ message: z.string().max(64 * 1024).optional(), messageBase64: z.string().max(96 * 1024).optional() }).strict()
    .refine((b) => (b.message === undefined) !== (b.messageBase64 === undefined), 'give exactly one of message or messageBase64');
  const SignTxBody = z.object({ transaction: z.string().min(1).max(64 * 1024) }).strict();
  const InboxQuery = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
  const PathQuery = z.object({ path: z.string().min(1).max(1024) });
  const InboxMsg = z.object({ from: z.string().max(256).optional(), subject: z.string().max(512).optional(), body: z.string() }).strict();

  // ---- router --------------------------------------------------------------
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/info', async (req, res) => {
    const images = await driver.images().catch(() => []);
    const sizes = Object.fromEntries(Object.entries(driver.sizes).map(([k, v]) => [k, { cpus: v.cpus, memoryMb: v.memoryMb, diskMb: v.diskMb, pids: v.pids, priceLamportsPerSecond: priceFor(k).toString() }]));
    res.json({
      node: identity.id, nodeExplorer: explorerAccount(identity.id), driver: driver.name, sealed: driver.sealed,
      ...(driver.sealed ? {} : { warning: 'development driver: machines are NOT sealed' }),
      images, sizes, browser: browsers.sealed ? { sealed: true, runsIn: 'machine container', images: driver.browserImages || [] } : { sealed: false, runsIn: 'node host', warning: browsers.notSealedWarning },
      creditLimitSeconds, graceMs, idleMs, maxLifetimeMs, egress: !!egressProxy,
      machines: { running: machines.size, max: maxMachines },
    });
  });

  router.post('/machines', json, async (req, res) => {
    if (!started) throw httpError(503, 'compute is not started');
    const lim = rentLimiter.take('rent:' + req.ip);
    if (!lim.ok) return res.status(429).json({ error: 'too many requests' });
    const body = parse(RentBody, req.body ?? {});
    if (machines.size >= maxMachines) throw httpError(503, 'this node has no free machines');
    const size = body.size || 'small';
    if (!driver.sizes[size]) throw httpError(400, 'unknown size');
    const available = await driver.images();
    const image = body.image || available[0];
    if (!image || !available.includes(image)) throw httpError(400, 'image not available on this node');
    const id = newId();
    const token = randomBytes(32).toString('base64url');
    const price = priceFor(size);
    let walletSecret = null;
    const wallet = createMachineWallet({ backup: walletVault ? (w) => { walletSecret = w; } : null });
    if (walletVault) {
      try { await walletVault.backup({ machineId: id, address: walletSecret.address, payer: body.payer, secretKey: walletSecret.secretKey }); } catch (e) {
        wallet.destroy();
        log('compute.wallet_backup.error', { id, error: e.message });
        throw httpError(503, 'could not keep a backup of the machine wallet key; no machine was rented');
      } finally { walletSecret.secretKey.fill(0); walletSecret = null; }
    }
    let handle;
    try { handle = await driver.create({ id, image, size, egress: egressProxy }); } catch (e) {
      wallet.destroy();
      if (walletVault) await walletVault.ended({ machineId: id, reason: 'machine could not be created' }).catch(() => {});
      throw e;
    }
    const now = Date.now();
    const m = {
      id, tokenHash: hashToken(token), payer: body.payer, image, size, price, creditLimit: price * BigInt(creditLimitSeconds),
      handle, state: 'running', createdAt: now, lastActive: now, lastTick: now, pausedAt: null, voucher: null,
      wallet, inbox: createInbox({ maxMessages: inboxCfg.maxMessages }), running: new Set(), lock: Promise.resolve(),
    };
    meter.open(id, { kind: 'compute', priceLamports: price, payer: body.payer });
    machines.set(id, m);
    log('compute.rented', { id, image, size, driver: driver.name });
    res.status(201).json({
      ...status(m), token, node: identity.id, session: id,
      voucher: { kind: 'compute', session: id, node: identity.id, payer: body.payer },
      inboxUrl: `inbox/${id}`,
    });
  });

  router.get('/machines/:id', auth(), (req, res) => res.json(status(req.machine)));
  router.delete('/machines/:id', auth(), async (req, res) => res.json(await destroy(req.machine, 'stopped by renter')));

  // Vouchers carry their own signature, so no bearer token is needed here.
  router.post('/machines/:id/voucher', json, async (req, res) => {
    const m = machines.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'no such machine' });
    const v = req.body;
    const result = await (m.lock = m.lock.then(async () => {
      if (!v || typeof v !== 'object') return { status: 400, body: { error: 'voucher required' } };
      const c = checkVoucher(v, { node: identity.id, prev: m.voucher });
      if (!c.ok) return { status: 400, body: { error: 'voucher rejected', reason: c.reason } };
      if (v.kind !== 'compute' || v.session !== m.id || v.payer !== m.payer) return { status: 400, body: { error: 'voucher rejected', reason: 'not for this machine' } };
      let r;
      try { r = await onVoucher(v); } catch (e) { r = { ok: false, reason: e.message }; }
      if (!r || !r.ok) return { status: 402, body: { error: 'voucher not accepted', reason: r?.reason || 'refused' } };
      m.voucher = v;
      charge(m);
      meter.setPaid(m.id, BigInt(v.cumulative));
      if (m.state === 'paused' && meter.unpaid(m.id) < m.creditLimit) await resume(m);
      return { status: 200, body: { accepted: true, state: m.state, ...usage(m) } };
    }).catch((e) => ({ status: 500, body: { error: e.message } })));
    res.status(result.status).json(result.body);
  });

  router.post('/machines/:id/exec', json, auth({ needRunning: true }), async (req, res) => {
    const m = req.machine;
    const body = parse(ExecBody, req.body ?? {});
    if (m.running.size >= maxConcurrentExecs) throw httpError(429, 'too many commands running on this machine');
    const stdin = body.stdinBase64 !== undefined ? Buffer.from(body.stdinBase64, 'base64') : body.stdin !== undefined ? Buffer.from(body.stdin) : null;
    const timeoutMs = body.timeoutMs || defaultExecTimeoutMs;
    const stream = body.stream === true || (req.get('accept') || '').includes('text/event-stream');
    if (stream) {
      let sent = 0; let truncated = false; let finished = false; let x = null;
      const early = [];
      const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const out = (kind) => (b) => {
        m.lastActive = Date.now();
        if (truncated) return;
        if (sent + b.length > maxStreamOutputBytes) { b = b.subarray(0, maxStreamOutputBytes - sent); truncated = true; }
        sent += b.length;
        if (b.length) { if (res.headersSent) send(kind, { b64: b.toString('base64') }); else early.push([kind, b]); }
        if (truncated && x) x.kill();
      };
      x = driver.exec(m.handle, { cmd: body.cmd, stdin, timeoutMs, onStdout: out('stdout'), onStderr: out('stderr') });
      m.running.add(x);
      res.status(200).set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      for (const [kind, b] of early) send(kind, { b64: b.toString('base64') });
      res.on('close', () => { if (!finished) x.kill(); });
      const r = await x.done;
      finished = true; m.running.delete(x);
      send('exit', { ...r, truncated });
      res.end();
      return;
    }
    const bufs = { stdout: [], stderr: [] }; const n = { stdout: 0, stderr: 0 }; const trunc = { stdout: false, stderr: false };
    const collect = (k) => (b) => {
      if (n[k] >= maxBufferedOutputBytes) { trunc[k] = true; return; }
      const room = maxBufferedOutputBytes - n[k];
      if (b.length > room) { b = b.subarray(0, room); trunc[k] = true; }
      bufs[k].push(b); n[k] += b.length;
    };
    const x = driver.exec(m.handle, { cmd: body.cmd, stdin, timeoutMs, onStdout: collect('stdout'), onStderr: collect('stderr') });
    m.running.add(x);
    const r = await x.done;
    m.running.delete(x);
    res.json({ ...r, stdout: Buffer.concat(bufs.stdout).toString('utf8'), stderr: Buffer.concat(bufs.stderr).toString('utf8'), stdoutTruncated: trunc.stdout, stderrTruncated: trunc.stderr });
  });

  router.put('/machines/:id/files', auth({ needRunning: true }), express.raw({ type: () => true, limit: maxFileBytes }), async (req, res) => {
    const { path } = parse(PathQuery, req.query);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await driver.writeFile(req.machine.handle, path, data);
    res.json({ path, bytes: data.length });
  });
  router.get('/machines/:id/files', auth({ needRunning: true }), async (req, res) => {
    const { path } = parse(PathQuery, req.query);
    const data = await driver.readFile(req.machine.handle, path, maxFileBytes);
    res.set('Content-Type', 'application/octet-stream').send(data);
  });

  router.post('/machines/:id/browser/open', json, auth({ needRunning: true }), async (req, res) => {
    const { url } = parse(UrlBody, req.body ?? {});
    res.json(await browsers.get(req.machine.id, req.machine.handle).open(url));
  });
  router.get('/machines/:id/browser/text', auth({ needRunning: true }), async (req, res) => {
    res.json(await browsers.get(req.machine.id, req.machine.handle).text());
  });
  router.post('/machines/:id/browser/click', json, auth({ needRunning: true }), async (req, res) => {
    const { selector } = parse(SelBody, req.body ?? {});
    res.json(await browsers.get(req.machine.id, req.machine.handle).click(selector));
  });
  router.post('/machines/:id/browser/type', json, auth({ needRunning: true }), async (req, res) => {
    const b = parse(TypeBody, req.body ?? {});
    res.json(await browsers.get(req.machine.id, req.machine.handle).type(b.selector, b.text, b.submit));
  });
  router.get('/machines/:id/browser/screenshot', auth({ needRunning: true }), async (req, res) => {
    const png = await browsers.get(req.machine.id, req.machine.handle).screenshot(req.query.fullPage === '1' || req.query.fullPage === 'true');
    res.set({ 'Content-Type': 'image/png', 'X-Tangent-Browser-Sealed': String(browsers.sealed) });
    if (!browsers.sealed) res.set('X-Tangent-Warning', browsers.notSealedWarning);
    res.send(png);
  });

  router.get('/machines/:id/wallet', auth(), (req, res) => {
    const a = req.machine.wallet.address;
    res.json({ address: a, explorer: explorerAccount(a) });
  });
  router.post('/machines/:id/wallet/sign-message', json, auth({ needRunning: true }), (req, res) => {
    const b = parse(SignMsgBody, req.body ?? {});
    const bytes = b.message !== undefined ? Buffer.from(b.message, 'utf8') : Buffer.from(b.messageBase64, 'base64');
    const a = req.machine.wallet.address;
    res.json({ address: a, explorer: explorerAccount(a), signature: req.machine.wallet.signMessage(bytes) });
  });
  router.post('/machines/:id/wallet/sign-transaction', json, auth({ needRunning: true }), (req, res) => {
    const b = parse(SignTxBody, req.body ?? {});
    let out;
    try { out = req.machine.wallet.signTransaction(Buffer.from(b.transaction, 'base64')); } catch (e) { throw httpError(400, 'could not sign: ' + e.message); }
    const a = req.machine.wallet.address;
    res.json({ address: a, explorer: explorerAccount(a), transaction: out.transaction.toString('base64'), signature: out.signature, txExplorer: explorerTx(out.signature) });
  });

  router.get('/machines/:id/inbox', auth(), (req, res) => {
    const q = parse(InboxQuery, req.query);
    res.json(req.machine.inbox.read(q));
  });

  // ---- wallet key recovery (the renter, by a signature of the payer identity) --------------
  const RecoveryChallengeBody = z.object({ machineId: z.string().regex(/^m_[0-9a-f]{24}$/) }).strict();
  const RecoveryBody = z.object({
    challenge: z.object({ kind: z.literal('tangent-machine-wallet-recovery'), node: z.string(), machineId: z.string(), nonce: z.string(), expiresAt: z.number() }).strict(),
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
  }).strict();
  const goneBody = (st) => ({
    error: 'expired, deleted', machineId: st.machineId, address: st.address || null,
    endedAt: st.endedAt ?? null, deletedAt: st.deletedAt ?? st.deleteAfter ?? null,
    reason: `the node kept this wallet key for ${walletVault.retentionDays} days after the machine ended, then deleted it; it cannot be recovered`,
  });
  const recoveryLimited = (req, machineId) => !recoveryIpLimiter.take('ip:' + req.ip).ok || !recoveryMachineLimiter.take('m:' + machineId).ok;
  function sweepChallenges(t) { for (const [n, c] of challenges) if (c.expiresAt <= t) challenges.delete(n); }

  router.post('/wallet-recovery/challenge', json, async (req, res) => {
    if (!walletVault) return res.status(404).json({ error: 'this node keeps no machine wallet keys' });
    const { machineId } = parse(RecoveryChallengeBody, req.body ?? {});
    if (recoveryLimited(req, machineId)) return res.status(429).json({ error: 'too many requests' });
    const st = await walletVault.lookup(machineId);
    if (st.state === 'none') return res.status(404).json({ error: 'no wallet key backup for this machine on this node' });
    if (st.state === 'expired' || st.state === 'deleted') return res.status(410).json(goneBody(st));
    const t = recoveryCfg.now();
    sweepChallenges(t);
    if (challenges.size > 10_000) return res.status(429).json({ error: 'too many open challenges' });
    const challenge = { kind: 'tangent-machine-wallet-recovery', node: identity.id, machineId, nonce: randomBytes(24).toString('base64url'), expiresAt: t + recoveryCfg.challengeTtlMs };
    challenges.set(challenge.nonce, { machineId, body: canonical(challenge), expiresAt: challenge.expiresAt });
    res.json({ challenge, sign: 'sign canonical JSON of challenge (keys sorted) with the payer identity that rented this machine, then POST { challenge, signature } to wallet-recovery. One use, expires at expiresAt.' });
  });

  router.post('/wallet-recovery', json, async (req, res) => {
    if (!walletVault) return res.status(404).json({ error: 'this node keeps no machine wallet keys' });
    const body = parse(RecoveryBody, req.body ?? {});
    const { challenge, signature } = body;
    if (recoveryLimited(req, challenge.machineId)) return res.status(429).json({ error: 'too many requests' });
    const t = recoveryCfg.now();
    const open = challenges.get(challenge.nonce);
    challenges.delete(challenge.nonce); // single use, whatever the outcome
    if (!open || open.body !== canonical(challenge) || challenge.node !== identity.id) return res.status(401).json({ error: 'unknown or already used challenge' });
    if (t >= open.expiresAt) return res.status(401).json({ error: 'challenge expired; ask for a new one' });
    const st = await walletVault.lookup(challenge.machineId);
    if (st.state === 'none') return res.status(404).json({ error: 'no wallet key backup for this machine on this node' });
    if (st.state === 'expired' || st.state === 'deleted') return res.status(410).json(goneBody(st));
    if (!verifyObject(st.payer, challenge, signature)) {
      log('compute.wallet_recovery.refused', { id: challenge.machineId, reason: 'signature is not from the payer' });
      return res.status(403).json({ error: 'signature is not from the payer identity that rented this machine' });
    }
    let secretKey;
    try { secretKey = await walletVault.reveal(challenge.machineId); } catch (e) {
      if (e.state === 'expired' || e.state === 'deleted') return res.status(410).json(goneBody(await walletVault.lookup(challenge.machineId)));
      throw e;
    }
    const out = toB58(secretKey);
    secretKey.fill(0);
    log('compute.wallet_recovered', { id: challenge.machineId, address: st.address });
    res.json({
      machineId: st.machineId, address: st.address, explorer: explorerAccount(st.address),
      secretKey: out, secretKeyFormat: 'base58 of the 64 byte Solana secret key (seed then public key)',
      createdAt: st.createdAt, endedAt: st.endedAt, keyKeptUntil: st.deleteAfter,
      note: st.endedAt === null
        ? `the machine has not ended; this node keeps the key until ${walletVault.retentionDays} days after it ends, then deletes it`
        : `this node keeps the key until keyKeptUntil, then deletes it`,
    });
  });

  // Public: anyone can leave a message for a machine. Size and rate limited.
  router.post('/inbox/:machineId', express.raw({ type: () => true, limit: inboxCfg.maxMessageBytes }), (req, res) => {
    const m = machines.get(req.params.machineId);
    if (!m) return res.status(404).json({ error: 'no such machine' });
    if (!inboxIpLimiter.take('ip:' + req.ip).ok || !inboxMachineLimiter.take('m:' + m.id).ok) return res.status(429).json({ error: 'too many messages' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!raw.length) throw httpError(400, 'empty message');
    const type = (req.get('content-type') || 'text/plain').split(';')[0].trim().toLowerCase();
    let msg;
    if (type === 'application/json') {
      let parsed; try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw httpError(400, 'invalid json'); }
      msg = { ...parse(InboxMsg, parsed), contentType: 'application/json' };
    } else if (type.startsWith('text/')) {
      msg = { body: raw.toString('utf8'), contentType: 'text/plain' };
    } else throw httpError(415, 'send text/plain or application/json');
    const id = m.inbox.push(msg);
    res.status(202).json({ accepted: true, id });
  });

  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.too.large') status = 413;
    if (status >= 500 && status !== 503 && status !== 507) log('compute.error', { path: req.path, error: err.message });
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.status(status).json({ error: status === 500 ? 'internal error' : err.message, ...(err.extra || {}) });
  });

  return {
    router,
    driver,
    async start() {
      if (started) return;
      const c = await driver.check();
      if (!c.ok) throw new Error(`compute driver ${driver.name} not usable: ${c.reason}`);
      if (!driver.sealed) log('compute.warning', { message: 'process driver in use: machines are NOT sealed, development only' });
      const imgs = await driver.images().catch(() => []);
      if (!imgs.length) log('compute.warning', { message: 'no machine images present on this node; pull one of: ' + (driver.imageNames || []).join(', ') });
      const removed = await driver.cleanup().catch(() => 0);
      if (removed) log('compute.cleanup', { removed });
      ticker = setInterval(() => { sweep().catch((e) => log('compute.sweep.error', { error: e.message })); }, tickMs);
      ticker.unref?.();
      started = true;
    },
    async stop() {
      started = false;
      if (ticker) clearInterval(ticker); ticker = null;
      await Promise.all([...machines.values()].map((m) => destroy(m, 'node shutdown')));
      await browsers.closeAll();
    },
    // operator / test view of the driver state of one machine (no secrets)
    async inspect(machineId) { const m = machines.get(machineId); return m ? driver.inspect(m.handle) : null; },
    machines() { return [...machines.values()].map((m) => ({ machineId: m.id, state: m.state, image: m.image, size: m.size, createdAt: m.createdAt, payer: m.payer, usage: usage(m) })); },
    sweep,
  };
}
