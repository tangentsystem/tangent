// Headless browser for machines, driven by playwright-core. One browser per machine,
// started lazily on the first browser call, closed when the machine is destroyed.
//
// Where the browser runs is decided by the driver (driver.browser(handle)):
// - docker driver (sealed): Chromium runs INSIDE the machine's container, started with
//   `docker exec` as the machine user. Playwright talks to it over its debugging pipe
//   carried by the exec's stdin/stdout (drivers/browser-exec.sh); no port is opened.
//   The container gives it the machine's CPU / memory / pids limits, its read only
//   root, its dropped capabilities and its network namespace: loopback only, plus the
//   egress forwarder when the node offers egress. The profile, cache and cookies live
//   in the machine's /tmp tmpfs and die with the container. On the node, playwright
//   only keeps two empty bookkeeping dirs, removed with the machine.
// - process driver (development only, NOT sealed): Chrome runs on the node host as a
//   child of the node process. Every response says `sealed: false` with a warning.
//   Requests to private, loopback and link local addresses are refused unless
//   allowPrivateNetwork is set (tests only), and with an egress proxy Chrome uses it.
import { chromium } from 'playwright-core';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const MAX_TEXT = 200_000;
const NOT_SEALED = 'development driver: this browser runs on the node host and is NOT sealed';
const COMMON_ARGS = ['--disable-background-networking', '--disable-sync', '--no-first-run', '--disable-extensions',
  '--disable-default-apps', '--mute-audio', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true; // unknown format: refuse
}

// Only web content: no file:, chrome:, view-source: and the like.
export function schemeAllowed(urlStr) {
  if (urlStr === 'about:blank') return true;
  let u; try { u = new URL(urlStr); } catch { return false; }
  return ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'].includes(u.protocol);
}

export function createBrowserPool({
  driver = null,
  executablePath = '/usr/bin/google-chrome', // process driver only
  egressProxy = null,                        // process driver only (docker uses the machine's own route)
  allowPrivateNetwork = false,               // process driver only
  navigationTimeoutMs = 20_000,
  actionTimeoutMs = 10_000,
  launchTimeoutMs = 60_000,
  extraArgs = [],
  log = () => {},
} = {}) {
  const sessions = new Map();

  // host browser (process driver) address policy. The sealed browser does not need
  // it: its container has no route except the machine's egress, and it never
  // resolves names on the node.
  async function hostAllowed(urlStr) {
    if (!schemeAllowed(urlStr)) return false;
    const u = new URL(urlStr);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || urlStr === 'about:blank') return true;
    if (allowPrivateNetwork) return true;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (net.isIP(host)) return !isPrivateAddress(host);
    if (egressProxy) return true; // names are resolved by the proxy
    try {
      const addrs = await dns.lookup(host, { all: true });
      return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
    } catch { return false; }
  }

  async function guard(context, allowed) {
    await context.route('**/*', async (route) => {
      if (await allowed(route.request().url())) return route.continue();
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, async (ws) => {
      if (await allowed(ws.url())) ws.connectToServer(); else ws.close();
    });
    context.setDefaultTimeout(actionTimeoutMs);
    context.setDefaultNavigationTimeout(navigationTimeoutMs);
  }
  const contextOpts = { serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 } };

  // Chromium inside the machine container (docker driver)
  async function launchSealed(spec) {
    const profileStub = path.join(spec.hostDir, 'profile');
    const artifactsDir = path.join(spec.hostDir, 'artifacts');
    await fs.mkdir(profileStub, { recursive: true, mode: 0o700 });
    await fs.mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(profileStub, {
      executablePath: spec.executablePath, env: spec.env, headless: true, artifactsDir,
      args: [...COMMON_ARGS, ...spec.args, ...extraArgs], timeout: launchTimeoutMs,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ...contextOpts,
    });
    await guard(context, async (u) => schemeAllowed(u));
    const page = watch(context.pages()[0] || await context.newPage());
    return {
      context, page, sealed: true, runsIn: spec.runsIn,
      async close() {
        // a paused container cannot answer; do not wait long, the container goes next
        await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref?.())]);
        if (spec.kill) await spec.kill();
        await fs.rm(spec.hostDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  // Chrome on the node host (process driver, NOT sealed)
  async function launchHost() {
    const args = [...COMMON_ARGS, ...extraArgs];
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
    const browser = await chromium.launch({
      executablePath, headless: true, args, timeout: launchTimeoutMs,
      proxy: egressProxy ? { server: `socks5://${egressProxy.socksHost}:${egressProxy.socksPort}` } : undefined,
    });
    const context = await browser.newContext(contextOpts);
    await guard(context, hostAllowed);
    const page = watch(await context.newPage());
    return { context, page, sealed: false, runsIn: 'node host', close: () => browser.close().catch(() => {}) };
  }

  async function launch(handle) {
    if (driver && driver.sealed) {
      if (typeof driver.browser !== 'function') throw Object.assign(new Error('this driver has no sealed browser'), { status: 409 });
      return launchSealed(await driver.browser(handle));
    }
    return launchHost();
  }

  const watch = (page) => { page.on('crash', () => { page.__crashed = true; }); return page; };

  function sessionFor(id, handle) {
    let s = sessions.get(id);
    if (s) return s;
    let ready = null; let chain = Promise.resolve(); let closed = false;
    const start = () => {
      const p = launch(handle);
      // a failed launch, a crashed browser (for example killed for memory) or a
      // closed one is started again on the next call
      p.then((b) => b.context.on('close', () => { if (ready === p) ready = null; }), () => { if (ready === p) ready = null; });
      return p;
    };
    const run = (fn) => {
      const p = chain.then(async () => {
        if (closed) throw Object.assign(new Error('machine browser is closed'), { status: 410 });
        if (!ready) ready = start();
        const b = await ready;
        // a tab killed for memory (or crashed) is replaced by a fresh one
        if (b.page.isClosed() || b.page.__crashed) {
          await b.page.close().catch(() => {});
          b.page = await b.context.newPage();
          watch(b.page);
        }
        let out;
        try { out = await fn(b); } catch (e) {
          if (e.status) throw e;
          // page errors (net::ERR_..., timeouts, missing selectors) are the page's, not ours
          throw Object.assign(new Error(String(e.message || e).split('\n')[0].slice(0, 300)), { status: 502 });
        }
        return b.sealed ? out : (Buffer.isBuffer(out) ? out : { ...out, sealed: false, warning: NOT_SEALED });
      });
      chain = p.catch(() => {});
      return p;
    };
    s = {
      open: (url) => run(async (b) => {
        const ok = b.sealed ? schemeAllowed(url) : await hostAllowed(url);
        if (!ok) throw Object.assign(new Error('that address is not allowed'), { status: 400 });
        let resp = null;
        try { resp = await b.page.goto(url, { waitUntil: 'domcontentloaded' }); } catch (e) {
          // let the error page of a failed load settle so it cannot interrupt the next load
          await b.page.waitForLoadState('load', { timeout: 3000 }).catch(() => {});
          if (!/interrupted by another navigation/.test(e.message)) throw e;
          if (b.page.url() !== url) resp = await b.page.goto(url, { waitUntil: 'domcontentloaded' });
        }
        return { url: b.page.url(), title: await b.page.title(), status: resp ? resp.status() : null };
      }),
      text: () => run(async ({ page }) => {
        let text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
        const truncated = text.length > MAX_TEXT; if (truncated) text = text.slice(0, MAX_TEXT);
        return { url: page.url(), title: await page.title(), text, truncated };
      }),
      click: (selector) => run(async ({ page }) => { await page.click(selector); return { url: page.url() }; }),
      type: (selector, text, submit) => run(async ({ page }) => {
        await page.fill(selector, text);
        if (submit) await page.press(selector, 'Enter');
        return { url: page.url() };
      }),
      screenshot: (fullPage) => run(async ({ page }) => page.screenshot({ type: 'png', fullPage: !!fullPage })),
      async close() {
        closed = true;
        sessions.delete(id);
        const r = ready; ready = null;
        if (r) { const b = await r.catch(() => null); if (b) await b.close(); }
      },
      started: () => !!ready,
    };
    sessions.set(id, s);
    return s;
  }

  return {
    sealed: !!(driver && driver.sealed),
    notSealedWarning: NOT_SEALED,
    get: sessionFor,
    has: (id) => sessions.has(id),
    async close(id) { const s = sessions.get(id); if (s) await s.close(); },
    async closeAll() { await Promise.all([...sessions.values()].map((s) => s.close())); },
    hostAllowed,
  };
}
