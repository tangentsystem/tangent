// The Tangent Systems node: one process that runs all three jobs.
//
//   relay     private internet hop (src/relay), optional exit, optional Tor onion
//   offgrid   off grid transaction mesh (src/offgrid), gateway when it has a Solana RPC
//   compute   agent computers (src/compute), only when switched on
//
// Start order: keys -> coordinator health (tip account, coordinator id) -> meter and
// voucher book -> relay (real port) -> onion -> offgrid -> egress client -> compute ->
// http api -> payout -> signed descriptor -> relay.setDescriptor -> register ->
// heartbeats. Everything the node creates (identity, kx, payout, onion, wallet keys)
// is stored insert only with a backup in the node's data folder (src/node/keystore.js).
// Rented machine wallet keys are backed up in backups/machine-wallets/ and kept for 30 days
// after the machine ends, then deleted by a purge job (src/node/machine-wallets.js).
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { createMeter, signDescriptor } from '../core/index.js';
import { createRelay, createClient, publishOnion } from '../relay/index.js';
import { createOffgrid, createFileStore, createTcpTransport, createUdpTransport } from '../offgrid/index.js';
import { createKeystore } from './keystore.js';
import { createMachineWalletVault } from './machine-wallets.js';
import { createCoordinatorClient } from './coord-client.js';
import { createVoucherBook } from './vouchers.js';
import { createClaimPoster } from './claims.js';
import { createCredit, payerFor } from './credit.js';
import { resolvePayout } from './payout.js';

export const NODE_VERSION = '0.1.0';
export const NODE_DEFAULTS = Object.freeze({
  bind: '0.0.0.0',
  relayPort: 9101,
  apiPort: 9102,
  offgridPort: 9103,
  perMbLamports: 10_000n,
  perTxLamports: 0n,
  perSecondLamports: 1000n,
  reregisterMs: 5 * 60_000,
  directoryRefreshMs: 60_000,
  egressHops: 3,
  maxUnsettledLamports: 10_000_000n,
});

export function heliusRpcUrl(apiKey, cluster = 'mainnet') {
  return `https://${cluster === 'devnet' ? 'devnet' : 'mainnet'}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

// JSON line logger; secrets never reach it (api keys are cut out of anything that looks like a URL).
export function createNodeLogger({ sink = (line) => process.stdout.write(line + '\n'), quiet = false } = {}) {
  const clean = (s) => String(s).replace(/api[-_]?key=[^&\s"']+/gi, 'api-key=[hidden]').replace(/[\r\n]+/g, ' ');
  const log = (level, event, fields = {}) => {
    if (quiet && level === 'debug') return;
    let line;
    try { line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch { line = JSON.stringify({ t: new Date().toISOString(), level, event }); }
    try { sink(clean(line)); } catch { /* never let logging stop the node */ }
  };
  return log;
}

export async function createNode(opts = {}) {
  const o = { ...NODE_DEFAULTS, ...opts };
  if (!o.coordinator) throw new Error('node: --coordinator is required');
  if (!o.dataDir) throw new Error('node: a data folder is required');
  if (!o.host && !o.torControl) throw new Error('node: --host (the public address others reach this node at) is required unless Tor is used');
  const log = o.log || createNodeLogger();
  const parts = {};
  const timers = [];
  let stopped = false;
  let payout = null;
  let registered = null;

  await fs.mkdir(o.dataDir, { recursive: true, mode: 0o700 });
  const keystore = await createKeystore({ dir: o.dataDir });
  const { identity, created: idCreated } = await keystore.identity('identity');
  const { kx } = await keystore.kx('kx');
  log('info', 'node.identity', { id: identity.id, created: idCreated, explorer: `https://solscan.io/account/${identity.id}` });

  // Rented machine wallet key backups: purge at start (keys 30 days past their machine's end)
  // and on an interval. Runs on every node, so old backups expire even with --compute off.
  const walletVault = await createMachineWalletVault({ dataDir: o.dataDir, identity, log, ...(o.walletVaultOptions || {}) });
  await walletVault.start({ intervalMs: o.walletPurgeMs || 3600_000 });

  const coord = createCoordinatorClient({ url: o.coordinator, identity, coordinatorId: o.coordinatorId || null });
  let health = null;
  for (let i = 0; ; i++) {
    try { health = await coord.health(); break; } catch (err) {
      if (i >= (o.healthRetries ?? 30)) throw new Error('node: coordinator unreachable: ' + err.message);
      log('warn', 'node.coordinator_wait', { reason: String(err.message).slice(0, 120) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const tipAccount = health.network && health.network.tipAccount;

  const meter = createMeter();
  const book = createVoucherBook({ coord, log, maxUnsettledLamports: o.maxUnsettledLamports });
  book.start();

  // ---- relay
  const relayLog = (level, msg, meta) => log(level === 'debug' ? 'debug' : level, 'relay.' + String(msg).replace(/^relay: /, '').replace(/\s+/g, '_').slice(0, 60), meta || {});
  const relay = createRelay({
    identity, kx, port: o.relayPort, host: o.bind, exit: Boolean(o.exit), meter, onVoucher: book.onVoucher,
    perMbLamports: o.perMbLamports, creditLimitLamports: o.creditLimitLamports ?? o.perMbLamports,
    allowPrivateTargets: Boolean(o.devAllowPrivate), allowPrivateRelays: Boolean(o.devAllowPrivate), log: relayLog,
  });
  await relay.start();
  parts.relay = relay;

  // ---- Tor onion (optional)
  let onion = null;
  if (o.torControl) {
    const saved = await keystore.get('onion');
    const r = await publishOnion({ torControl: o.torControl, localPort: relay.port, virtualPort: relay.port, privateKey: saved ? saved.secret : undefined }).catch((err) => { log('warn', 'onion.failed', { reason: err.message }); return null; });
    if (r && r.onion) {
      onion = r.onion;
      if (r.privateKey && !saved) await keystore.insert('onion', { kind: 'tor-onion', publicKey: r.onion, secret: r.privateKey });
      log('info', 'onion.published', { onion });
    } else log('warn', 'onion.unavailable', { note: 'Tor control port did not publish an onion service' });
  }

  // ---- off grid mesh
  let connection = null;
  const rpcUrl = o.rpcUrl || (o.heliusApiKey ? heliusRpcUrl(o.heliusApiKey, o.cluster) : '');
  if (o.gateway) {
    if (!rpcUrl) log('warn', 'gateway.no_rpc', { note: 'gateway asked for but no RPC: set HELIUS_API_KEY or --rpc-url; running as a carrier only' });
    else {
      const { Connection } = await import('@solana/web3.js');
      connection = new Connection(rpcUrl, 'confirmed');
    }
  }
  const transports = [createTcpTransport({ host: o.bind, port: o.offgridPort, peers: o.peers || [], log: (m) => log('debug', 'offgrid.tcp', { m }) })];
  if (o.udpPort !== undefined && o.udpPort !== null) transports.push(createUdpTransport({ port: o.udpPort, log: (m) => log('debug', 'offgrid.udp', { m }) }));
  const claimPoster = createClaimPoster({ coord, identity, log });
  const offgrid = createOffgrid({
    identity, transports, store: await createFileStore({ dir: path.join(o.dataDir, 'offgrid') }),
    gateway: connection ? { connection } : null, meter, tipAccount, perTxLamports: o.perTxLamports,
    log: (m) => log('debug', 'offgrid', { m: String(m).slice(0, 200) }), ...(o.offgridOptions || {}),
  });
  offgrid.onClaim((c) => claimPoster.add(c));
  await offgrid.start();
  for (const c of offgrid.claims()) claimPoster.add(c);
  claimPoster.start();
  parts.offgrid = offgrid;

  // ---- egress client (the node's own way out through the network, used by compute)
  let credit = null;
  let egress = null;
  if (o.compute && o.egress !== false) {
    credit = await createCredit({ coord, keystore, dir: o.dataDir, log });
    egress = createClient({ directory: [], hops: o.egressHops, credit, socksPort: 0, socksHost: '127.0.0.1', log: relayLog });
    await egress.start();
    parts.egress = egress;
    log('info', 'egress.ready', { socksPort: egress.socksPort, wallet: credit.wallet.id, note: 'rented machines leave through this node\'s own circuits; they need credit bought from this wallet' });
  }

  // ---- compute (agent computers)
  let compute = null;
  if (o.compute) {
    const { createCompute, pickDriver } = await import('../compute/index.js');
    const driver = await pickDriver({ dev: Boolean(o.computeDev), docker: o.dockerOptions || {}, log: (e, d) => log('info', e, d || {}) });
    if (!driver.sealed) log('warn', 'compute.not_sealed', { driver: driver.name, note: 'development driver: machines are NOT sealed' });
    log('info', 'compute.machine_wallet_backups', { folder: walletVault.dir, keptDaysAfterEnd: walletVault.retentionDays, note: 'each rented machine wallet key is kept encrypted for 30 days after the machine ends so its renter can recover it, then deleted' });
    compute = createCompute({
      identity, driver, meter, onVoucher: book.onVoucher, perSecondLamports: o.perSecondLamports,
      egressProxy: egress ? { socksHost: '127.0.0.1', socksPort: egress.socksPort } : null,
      browser: { allowPrivateNetwork: Boolean(o.devAllowPrivate), ...(o.browserOptions || {}) },
      walletVault,
      log: (e, d) => log('info', e, d || {}),
      ...(o.computeOptions || {}),
    });
    await compute.start();
    parts.compute = compute;
  }

  // ---- http api
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', o.trustProxy ?? false);
  app.set('json replacer', (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  let descriptor = null;
  app.get('/api/node', (_req, res) => {
    res.json({
      name: 'Tangent Systems node', version: NODE_VERSION, id: identity.id, explorer: `https://solscan.io/account/${identity.id}`,
      roles: descriptor ? descriptor.roles : [], registered: Boolean(registered),
      payout: payout ? { address: payout.address, explorer: `https://solscan.io/account/${payout.address}`, rings: payout.status } : null,
      relay: relay.stats(), offgrid: offgrid.stats(), vouchers: book.stats(), claims: claimPoster.results(),
      compute: compute ? { machines: compute.machines().length } : null,
    });
  });
  if (compute) app.use('/api/compute', compute.router);
  let mcpRouter = null;
  if (o.mcp && compute && credit) {
    // Operator only: spends this node's own credit, so it answers loopback connections only.
    app.use('/mcp', (req, res, next) => {
      const a = req.socket.remoteAddress || '';
      if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) return res.status(403).json({ error: 'the MCP endpoint answers this machine only' });
      if (!mcpRouter) return res.status(503).json({ error: 'not ready' });
      return mcpRouter(req, res, next);
    });
  }
  app.use((_req, res) => res.status(404).json({ error: 'no such route' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) log('error', 'http.error', { reason: String(err && err.message).slice(0, 200) });
    res.status(status).json({ error: status >= 500 ? 'something went wrong' : String(err.message).slice(0, 200), ...(err && err.extra ? err.extra : {}) });
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.apiPort, o.bind, () => { server.off('error', reject); resolve(); }); });
  parts.server = server;
  const apiPort = server.address().port;
  if (o.mcp && compute && credit) {
    const { createMcpHttpRouter } = await import('../compute/mcp.js');
    mcpRouter = createMcpHttpRouter({ nodeUrl: `http://127.0.0.1:${apiPort}/api/compute`, payer: payerFor(credit, identity.id) });
  }

  // ---- payout
  payout = await resolvePayout({ keystore, dataDir: o.dataDir, payout: o.payout || null, heliusApiKey: o.heliusApiKey || '', ringsEndpoint: o.ringsEndpoint || '', cluster: o.cluster, log, ringsFactory: o.ringsFactory || null });
  await payout.check();
  if (payout.own && payout.status !== 'ready') {
    const t = setInterval(() => { if (payout.status !== 'ready') payout.check().catch(() => {}); }, o.payoutCheckMs || 10 * 60_000);
    t.unref?.(); timers.push(t);
  }

  // ---- descriptor, registration, heartbeats
  const roles = ['relay'];
  if (o.exit) roles.push('exit');
  if (connection) roles.push('gateway');
  if (compute) roles.push('compute');
  function freshDescriptor() {
    return signDescriptor(identity, {
      roles, host: o.host || '', port: relay.port, apiPort, onion: onion || undefined, kx: kx.pub, payout: payout.address,
      prices: { perMbLamports: o.perMbLamports, perTxLamports: o.perTxLamports, perSecondLamports: o.perSecondLamports },
      region: o.region || undefined, version: NODE_VERSION, ts: Date.now(),
    });
  }
  descriptor = freshDescriptor();
  relay.setDescriptor(descriptor);

  let heartbeatMs = 60_000;
  async function register() {
    descriptor = freshDescriptor();
    relay.setDescriptor(descriptor);
    const r = await coord.register(descriptor);
    registered = r;
    if (r.heartbeatIntervalMs) heartbeatMs = r.heartbeatIntervalMs;
    return r;
  }
  for (let i = 0; ; i++) {
    try { await register(); break; } catch (err) {
      if (err.status && err.status < 500 && err.status !== 429) throw new Error(`node: the coordinator refused the registration: ${err.code || err.status} ${err.message}`);
      if (i >= 30) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log('info', 'node.registered', { id: identity.id, roles, heartbeatIntervalMs: heartbeatMs });

  let hbTimer = null;
  const beat = async () => {
    if (stopped) return;
    try {
      const load = Math.min(1, os.loadavg()[0] / Math.max(1, os.cpus().length));
      await coord.heartbeat(load);
    } catch (err) {
      if (err.status === 404) await register().catch((e) => log('warn', 'node.reregister_failed', { reason: e.message }));
      else log('warn', 'node.heartbeat_failed', { reason: String(err.message).slice(0, 120) });
    }
    if (!stopped) { hbTimer = setTimeout(beat, heartbeatMs); hbTimer.unref?.(); }
  };
  hbTimer = setTimeout(beat, Math.min(heartbeatMs, 1000)); hbTimer.unref?.();
  const rereg = setInterval(() => { register().catch((e) => log('warn', 'node.reregister_failed', { reason: e.message })); }, o.reregisterMs);
  rereg.unref?.(); timers.push(rereg);

  async function refreshDirectory() {
    if (!egress) return;
    const dir = (await coord.directory()).filter((d) => d.id !== identity.id);
    egress.setDirectory(dir);
    const hops = dir.filter((d) => d.roles.includes('relay') || d.roles.includes('exit')).map((d) => d.id);
    try { await credit.fund(hops); } catch (err) {
      log('warn', 'egress.no_credit', { wallet: credit.wallet.id, reason: String(err.message).slice(0, 120), note: 'machine traffic stalls after the free credit limit until this wallet holds balance (deposit through Privacy Rings)' });
    }
  }
  if (egress) {
    await refreshDirectory().catch((e) => log('warn', 'egress.directory_failed', { reason: e.message }));
    const t = setInterval(() => { refreshDirectory().catch((e) => log('warn', 'egress.directory_failed', { reason: e.message })); }, o.directoryRefreshMs);
    t.unref?.(); timers.push(t);
  }

  const info = {
    id: identity.id, roles, host: o.host || '', relayPort: relay.port, apiPort, offgridPort: transports[0].port,
    socksPort: egress ? egress.socksPort : null, onion, payout: payout.address, wallet: credit ? credit.wallet.id : null,
  };
  log('info', 'node.ready', info);

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (hbTimer) clearTimeout(hbTimer);
    for (const t of timers) clearInterval(t);
    claimPoster.stop();
    if (mcpRouter && mcpRouter.closeAll) await mcpRouter.closeAll().catch(() => {});
    if (compute) await compute.stop().catch(() => {});
    walletVault.stop();
    await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    if (egress) await egress.stop().catch(() => {});
    await offgrid.stop().catch(() => {});
    await relay.stop().catch(() => {});
    await book.stop().catch(() => {});
  }

  return { info, identity, relay, offgrid, compute, egress, credit, book, coord, walletVault, stop, descriptor: () => descriptor };
}
