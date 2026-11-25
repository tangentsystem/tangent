// The Tangent app's headless core. Everything that is not UI lives here and runs under plain
// Node: the Electron main process is a thin shell around it (app/main/main.js).
import fs from 'node:fs';
import { createCoordinatorClient } from '../../src/node/coord-client.js';
import { resolveConfig } from './config.js';
import { createLog } from './log.js';
import { createEmitter } from './emitter.js';
import { createWallet } from './wallet.js';
import { createSession } from './session.js';
import { createComputers } from './computers.js';
import { createMcp } from './mcp.js';
import { createNetworkInfo } from './network.js';
import { createPairing } from './pairing.js';
import { createControlApi } from './control-api.js';
import { findBrowsers, openPrivateWindow } from './browser.js';

export { resolveConfig } from './config.js';

export function createCore(opts = {}) {
  const cfg = { ...resolveConfig({ env: opts.env || process.env, userData: opts.userData || null }), ...(opts.config || {}) };
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const version = opts.version || '0.0.0';
  const log = opts.log || createLog({ dir: cfg.dataDir, echo: opts.echoLog === true });
  const events = createEmitter();
  const emit = (name, payload) => events.emit('event', name, payload);
  const coord = createCoordinatorClient({ url: cfg.coordinator });

  const wallet = createWallet({ coord, dataDir: cfg.dataDir, log, emit });
  const session = createSession({ coord, wallet, dataDir: cfg.dataDir, log, emit, socksPort: cfg.socksPort, ...(opts.session || {}) });
  const computers = createComputers({ coord, wallet, dataDir: cfg.dataDir, log, emit });
  const mcp = createMcp({ coord, wallet, dataDir: cfg.dataDir, port: cfg.mcpPort, log, emit });
  const network = createNetworkInfo({ coord });
  const pairing = createPairing({ dataDir: cfg.dataDir, emit });
  const control = createControlApi({
    port: cfg.controlPort, version, session, pairing, log,
    onOpen: (view) => emit('open', { view }),
  });
  let controlError = null;

  // a balance change may end a stall
  events.on('event', (name) => { if (name === 'wallet') session.walletChanged(); });

  return {
    config: cfg,
    version,
    log,
    coord,
    wallet,
    session,
    computers,
    mcp,
    network,
    pairing,
    control,
    on(fn) { events.on('event', fn); return () => events.off('event', fn); },
    async start() {
      try { await control.start(); } catch (err) {
        controlError = err.code === 'EADDRINUSE' ? 'in_use' : 'failed';
        log('warn', 'control.not_started', { reason: err.code || err.message });
      }
      return { controlPort: controlError ? null : control.port };
    },
    controlState: () => (controlError ? { on: false, reason: controlError } : { on: true, port: control.port }),
    browsers: () => findBrowsers().map((b) => ({ name: b.name, path: b.path })),
    openPrivateWindow(o = {}) {
      const s = session.status();
      if (!s.connected) { const e = new Error('Turn on the private internet first.'); e.code = 'OFF'; throw e; }
      const r = openPrivateWindow({ socksPort: s.socks.port, dataDir: cfg.dataDir, url: o.url === undefined ? cfg.coordinator : o.url, ...o });
      log('info', 'browser.opened', { browser: r.browser });
      return r;
    },
    async stop() {
      await control.stop().catch(() => {});
      await mcp.stop().catch(() => {});
      await computers.stopAll().catch(() => {});
      await session.disconnect().catch(() => {});
    },
  };
}
