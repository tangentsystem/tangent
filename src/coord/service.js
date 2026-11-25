// Boot order of the one deployable service:
//   config -> logger -> store -> keys -> connection -> modules -> http app -> listen
//   -> provisioner (wallet block, funding watch) -> sweeper (evicts dead nodes)
// Nothing here waits for funding and nothing sends a transaction.
import http from 'node:http';
import { loadConfig, PRODUCT_NAME } from '../config.js';
import { createStore } from '../storage/index.js';
import { ensureKeys } from '../keys.js';
import { createProvisioner } from '../provision.js';
import { createLogger } from './log.js';
import { createApp } from './app.js';
import { loadModules, createConnection } from './modules.js';

export async function startService({ env = process.env, sink, listen = true, importer } = {}) {
  const config = loadConfig(env);
  const log = createLogger({ config, sink });
  const store = await createStore(config);
  const parts = { config, log, store, server: null, provisioner: null, modules: null, sweeper: null };
  try {
    if (store.kind === 'mongo' && !store.capabilities.transactions) {
      log.warn('storage.no_transactions', { note: 'standalone MongoDB: multi document units use the in process fallback, run one instance only' });
    }
    const keys = await ensureKeys({ store });
    let connection = null;
    try { connection = await createConnection(config); } catch (err) { log.warn('solana.connection_failed', { reason: String(err && err.message).slice(0, 120) }); }
    const modules = await loadModules({ config, store, keys, log, connection, ...(importer ? { importer } : {}) });
    parts.modules = modules;
    let tipRentLamports = null;
    if (connection) {
      try { tipRentLamports = BigInt(await connection.getMinimumBalanceForRentExemption(0)); } catch { tipRentLamports = null; }
    }
    const provisioner = createProvisioner({
      config, keys, log, tipRentLamports,
      getBalance: connection ? async (address) => {
        const { PublicKey } = await import('@solana/web3.js');
        return BigInt(await connection.getBalance(new PublicKey(address)));
      } : null,
      extra: modules.pay && typeof modules.pay.fundingNeeds === 'function' ? await modules.pay.fundingNeeds() : [],
      onFunded: async (label) => { if (modules.pay && typeof modules.pay.onFunded === 'function') await modules.pay.onFunded(label); },
    });
    parts.provisioner = provisioner;
    // Self test on deploy (MONGO_URI + HELIUS_API_KEY): money actions stay closed until it passes.
    let selftest = null;
    try {
      const { createServiceSelfTest } = await import('../selftest/index.js');
      selftest = await createServiceSelfTest({ config, store, keys, connection, log, env });
    } catch (err) {
      // it could not even be built: keep money closed rather than open it untested
      log.error('selftest.setup_failed', { reason: String(err && err.message).slice(0, 200) });
      selftest = { clear: () => false, report: () => ({ state: 'setup_failed', clear: false, reason: 'the self test could not start; see the logs' }), summary: () => ({ state: 'setup_failed', clear: false }), start: async () => {}, stop: async () => {} };
    }
    parts.selftest = selftest;
    const app = createApp({ store, pay: modules.pay, token: modules.token, offgrid: modules.offgrid, config, connection, log, keys, provisioner, selftest, onion: () => (parts.siteOnion ? parts.siteOnion.address() : null) });
    parts.app = app;
    if (listen) {
      const server = http.createServer(app);
      server.requestTimeout = 30_000;
      server.headersTimeout = 20_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => { server.off('error', reject); resolve(); });
      });
      parts.server = server;
    }
    const port = parts.server ? parts.server.address().port : null;
    log.line(`${PRODUCT_NAME} coordinator ${config.version}  port ${port}  storage ${store.kind}`);
    log.info('service.listening', { port, storage: store.kind, transactions: store.capabilities.transactions, modules: modules.status, flags: config.flags });
    provisioner.start();
    // The site's own .onion address: only on a real database (the key must be kept) and a real port.
    if (config.siteOnion && port && store.kind === 'mongo') {
      import('./site-onion.js')
        .then(({ startSiteOnion }) => startSiteOnion({ store, port, log, torBin: config.torBin }))
        .then((h) => { parts.siteOnion = h; })
        .catch((err) => log.warn('site_onion.failed', { reason: String(err && err.message).slice(0, 200) }));
    }
    if (selftest) selftest.start().catch((err) => log.warn('selftest.failed', { reason: String(err && err.message).slice(0, 200) }));
    await app.locals.sweep().catch(() => {});
    parts.sweeper = setInterval(() => { app.locals.sweep().catch((err) => log.warn('nodes.sweep_failed', { reason: String(err && err.message).slice(0, 120) })); }, config.sweepIntervalMs);
    parts.sweeper.unref();
    if (modules.pay && typeof modules.pay.tick === 'function') {
      // deposits, withdrawals and payouts; pay sends nothing until its Rings wallet is ready
      let busy = false;
      parts.payTicker = setInterval(async () => {
        if (busy) return;
        busy = true;
        try { await modules.pay.tick(); } catch (err) { log.warn('pay.tick_failed', { reason: String(err && err.message).slice(0, 120) }); } finally { busy = false; }
      }, config.payTickMs);
      parts.payTicker.unref();
    }
    // Off grid tips move from the tip account into the Rings vault by themselves. Nothing
    // happens until Rings is configured and ready and the self test gate is open (src/coord/tip-sweep.js).
    if (modules.pay && modules.rings && typeof modules.rings.depositFrom === 'function' && connection) {
      const { createTipSweeper } = await import('./tip-sweep.js');
      const { ensureKey } = await import('../keys.js');
      const { unb58 } = await import('../core/index.js');
      const tipKey = await ensureKey(store, 'tip'); // the saved key, read only
      parts.tipSweeper = createTipSweeper({
        store, rings: modules.rings, tipSeed: unb58(tipKey.secret), tipAddress: keys.tip.address,
        vaultAddress: modules.rings.vaultAddress(), connection,
        // the self test gate; with no self test (development: memory store, simulated Rings) only the simulation may sweep
        gateOpen: () => (selftest ? Boolean(selftest.clear()) : modules.rings.mode !== 'real'),
        intervalMs: config.offgridSweepIntervalMs, minLamports: config.offgridSweepMinLamports,
        log: { info: (e, f) => log.info(e, f), warn: (e, f) => log.warn(e, f) },
      });
      parts.tipSweeper.start();
    }
  } catch (err) {
    await store.close().catch(() => {});
    throw err;
  }

  let stopping = null;
  parts.stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (parts.selftest) await parts.selftest.stop().catch(() => {});
      if (parts.tipSweeper) await parts.tipSweeper.stop().catch(() => {});
      if (parts.siteOnion) await parts.siteOnion.stop().catch(() => {});
      if (parts.sweeper) clearInterval(parts.sweeper);
      if (parts.payTicker) clearInterval(parts.payTicker);
      if (parts.server) {
        const server = parts.server;
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
          setTimeout(() => server.closeAllConnections(), 3000).unref();
        });
      }
      if (parts.provisioner) await parts.provisioner.stop();
      for (const m of [parts.modules && parts.modules.pay, parts.modules && parts.modules.token]) {
        if (m && typeof m.stop === 'function') await m.stop().catch(() => {});
      }
      await store.close();
    })();
    return stopping;
  };
  return parts;
}
