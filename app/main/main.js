// Electron main process: one window, a tray, and IPC to the headless core (app/core).
// The renderer has no Node access; it calls a short list of named actions through the preload.
import { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, nativeImage, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../core/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// bundled: dist/main.mjs next to dist/preload.cjs, renderer/ and assets/ one level up
const ROOT = path.basename(HERE) === 'dist' || path.basename(HERE) === 'main' ? path.join(HERE, '..') : HERE;
const RENDERER = path.join(ROOT, 'renderer', 'index.html');
const PRELOAD = path.join(ROOT, 'dist', 'preload.cjs');
const ASSETS = path.join(ROOT, 'assets');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  let win = null;
  let tray = null;
  let core = null;
  let quitting = false;
  let pendingView = null;

  app.setName('Tangent');
  if (process.platform === 'win32') app.setAppUserModelId('net.tangentsystems.app');

  function showWindow(view = null) {
    if (!win) createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (view) {
      if (win.webContents.isLoading()) pendingView = view;
      else win.webContents.send('event', 'open', { view });
    }
  }

  function createWindow() {
    const isMac = process.platform === 'darwin';
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    win = new BrowserWindow({
      width: Math.min(1080, sw), height: Math.min(700, sh), minWidth: 900, minHeight: 600,
      show: false,
      backgroundColor: '#060606',
      title: 'Tangent',
      icon: path.join(ASSETS, 'icon.png'),
      titleBarStyle: 'hidden',
      ...(isMac ? { trafficLightPosition: { x: 18, y: 19 } } : { titleBarOverlay: { color: '#060606', symbolColor: '#f3f2ee', height: 52 } }),
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged || process.env.TANGENT_DEVTOOLS === '1',
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    win.once('ready-to-show', () => win.show());
    win.webContents.on('did-finish-load', () => {
      if (pendingView) { win.webContents.send('event', 'open', { view: pendingView }); pendingView = null; }
    });
    win.on('close', (e) => {
      // with the private internet on, closing the window keeps it running from the tray
      if (!quitting && tray && core && core.session.status().connected) { e.preventDefault(); win.hide(); }
    });
    win.on('closed', () => { win = null; });
    win.loadFile(RENDERER);
  }

  function send(name, payload) {
    if (win && !win.isDestroyed()) win.webContents.send('event', name, payload);
  }

  function trayImage() {
    const img = nativeImage.createFromPath(path.join(ASSETS, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
    return img;
  }

  function updateTray() {
    if (!tray) return;
    const s = core.session.status();
    const label = s.connected ? 'Turn off private internet' : s.connecting ? 'Turning on' : 'Turn on private internet';
    tray.setToolTip(s.connected ? 'Tangent: private internet is on' : 'Tangent');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label, enabled: !s.connecting, click: () => (s.connected ? core.session.disconnect() : core.session.connect()) },
      { type: 'separator' },
      { label: 'Open Tangent', click: () => showWindow() },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  const SAFE_LINK = /^https:\/\/(solscan\.io|tangentsystems\.net|[a-z0-9.-]+\.[a-z]{2,})(\/|$)/i;
  let tokenCache = null;

  async function snapshot() {
    const [walletInfo, token] = await Promise.all([
      core.wallet.info().catch(() => null),
      core.network.token().catch(() => null),
    ]);
    tokenCache = token;
    return {
      version: app.getVersion(),
      platform: process.platform,
      coordinator: core.config.coordinator,
      status: core.session.details(),
      wallet: walletInfo,
      token,
      pairing: core.pairing.pending(),
      apps: core.pairing.list(),
      mcp: core.mcp.status(),
      control: core.controlState(),
      browsers: core.browsers().map((b) => b.name),
      machines: core.computers.list(),
      withdrawals: core.wallet.withdrawals(),
    };
  }

  const actions = {
    snapshot,
    status: () => core.session.details(),
    connect: () => core.session.connect(),
    disconnect: () => core.session.disconnect(),
    openPrivateWindow: () => { const r = core.openPrivateWindow(); return { browser: r.browser }; },
    walletInfo: () => core.wallet.info(),
    walletBalance: () => core.wallet.balance(),
    deposit: () => core.wallet.deposit(),
    withdraw: (a) => core.wallet.withdraw({ to: a && a.to, amount: a && a.amount, public: !!(a && a.public) }),
    withdrawals: () => core.wallet.withdrawals(),
    networkNodes: () => core.network.nodes(),
    token: async () => (tokenCache = await core.network.token()),
    computerNodes: () => core.computers.nodes(),
    rent: (a) => core.computers.rent({ node: a && a.node, image: a && a.image, size: a && a.size }),
    exec: (a) => core.computers.exec(String(a && a.id), String(a && a.cmd)),
    stopComputer: (a) => core.computers.stop(String(a && a.id)),
    machines: () => core.computers.list(),
    mcpStart: () => core.mcp.start(),
    mcpStop: () => core.mcp.stop(),
    pairAllow: (a) => core.pairing.approve(String(a && a.id)),
    pairDeny: (a) => core.pairing.deny(String(a && a.id)),
    appsRemove: (a) => core.pairing.remove(String(a && a.id)),
    copy: (a) => { clipboard.writeText(String(a && a.text).slice(0, 4000)); return true; },
    openLink: (a) => {
      const url = String(a && a.url);
      if (!SAFE_LINK.test(url)) return false;
      shell.openExternal(url);
      return true;
    },
  };

  ipcMain.handle('core', async (event, name, args) => {
    const frameUrl = event.senderFrame && event.senderFrame.url;
    if (!frameUrl || !frameUrl.startsWith('file://')) throw new Error('refused');
    const fn = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
    if (!fn) throw new Error('unknown action');
    try {
      return { ok: true, value: await fn(args) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 200), code: err && err.code ? String(err.code) : null };
    }
  });

  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || quitting) app.quit();
  });
  app.on('before-quit', (e) => {
    if (core && !core._stopped) {
      quitting = true;
      e.preventDefault();
      core._stopped = true;
      core.stop().finally(() => app.quit());
    }
  });

  app.whenReady().then(async () => {
    core = createCore({ userData: app.getPath('userData'), version: app.getVersion() });
    core.on((name, payload) => {
      if (name === 'open') return showWindow(payload && payload.view);
      if (name === 'pairing' && Array.isArray(payload) && payload.length) showWindow();
      if (name === 'status') updateTray();
      send(name, payload);
    });
    await core.start();
    try {
      tray = new Tray(trayImage());
      tray.on('click', () => showWindow());
      updateTray();
    } catch (err) { core.log('warn', 'tray.failed', { reason: err.message }); }
    createWindow();
  });
}
