// Real browser test: loads the unpacked extension into Chrome for Testing, pairs with the mock
// app, turns Tangent on and proves pages go through the SOCKS5 listener with names unresolved,
// then proves the kill switch holds and that "Browse without Tangent" lets go.
//
// Run: npm run test:browser   (CHROME=/path/to/chrome to override, SHOTS=dir to save screenshots)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startMockApp } from './mock-app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT ? resolve(process.env.EXT) : resolve(here, '..');
const require = createRequire(pathToFileURL(resolve(here, '..', '..', 'package.json')));
const { chromium } = require('playwright-core');

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS || '';
const NAME = 'site.tangent.test'; // only exists inside the test: the SOCKS side maps it to 127.0.0.1
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx, sw, extId, popup, page, site, app;
const hits = [];
const pageErrors = [];
const watch = (p) => {
  p.on('pageerror', (e) => pageErrors.push(`${p.url()} ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && p.url().startsWith('chrome-extension://')) pageErrors.push(`${p.url()} ${m.text()}`); });
};

async function shot(name, target = popup) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await wait(1900); // let the slow transitions settle
  await target.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function popupShows(text, timeout = 15_000) {
  await popup.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

before(async () => {
  site = http.createServer((req, res) => {
    if (req.url !== '/') { res.writeHead(404); return res.end(); } // favicon and the like
    hits.push({ host: req.headers.host, url: req.url });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>t</title><h1 id="ok">reached the page</h1>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));

  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tangent-chrome-')), {
    executablePath: CHROME,
    headless: true,
    deviceScaleFactor: 2,
    viewport: { width: 360, height: 500 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      // Only used when Tangent is off, to prove direct loading works again. While on, Chrome
      // hands the name to the SOCKS5 side unresolved, which the test checks below.
      `--host-resolver-rules=MAP ${NAME} 127.0.0.1`,
    ],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  extId = new URL(sw.url()).host;
  popup = await ctx.newPage();
  page = await ctx.newPage();
  watch(popup);
});

after(async () => {
  await ctx?.close();
  await app?.close();
  site?.close();
});

const pageUrl = () => `http://${NAME}:${site.address().port}/`;
const proxySetting = () => sw.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
const webrtcSetting = () => sw.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}));

test('the extension loads with its service worker and icons', async () => {
  assert.match(extId, /^[a-p]{32}$/);
  const m = await sw.evaluate(() => chrome.runtime.getManifest());
  assert.equal(m.name, 'Tangent');
  assert.equal(m.version, '0.1.0');
  assert.deepEqual([...m.permissions].sort(), ['alarms', 'privacy', 'proxy', 'storage']);
});

test('before the app runs: the popup says to open the app, pages load directly', async () => {
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popupShows('Open the Tangent app');
  assert.equal(await popup.locator('#primary-link').getAttribute('href'), 'https://tangentsystems.net/app');
  await shot('01-app-not-running');
  await page.goto(pageUrl());
  assert.equal(await page.textContent('#ok'), 'reached the page');
  assert.equal(hits.at(-1).host, `${NAME}:${site.address().port}`);
});

test('pairing: one button, approve in the app, then off', async () => {
  app = await startMockApp({ approve: 'manual', connectDelayMs: 2600, resolve: { [NAME]: '127.0.0.1' }, socksPort: 0 });
  await popupShows('Connect this browser');
  await shot('02-not-paired');
  await popup.click('#primary');
  await popupShows('Approve it in the Tangent app');
  await shot('03-approve-in-app');
  const pending = app.pending();
  assert.equal(pending.length, 1);
  const req = app.requests.find((r) => r.path === '/v1/pair');
  assert.match(req.origin, /^chrome-extension:\/\//, 'the real Origin header passes the app rule');
  assert.equal(req.host, '127.0.0.1:47611');
  app.approve(pending[0]);
  await popupShows('Tangent is off');
  await shot('04-off');
  const stored = await sw.evaluate(() => chrome.storage.local.get('token'));
  assert.ok(app.tokens.has(stored.token));
});

test('turn on: the browser goes through the SOCKS5 listener, names resolved at the far side', async () => {
  await popup.click('#primary');
  await popupShows('Turning on');
  await shot('05-turning-on');
  await popupShows('Private internet is on');

  const ps = await proxySetting();
  assert.equal(ps.levelOfControl, 'controlled_by_this_extension');
  assert.equal(ps.value.mode, 'fixed_servers');
  assert.deepEqual(ps.value.rules.singleProxy, { scheme: 'socks5', host: '127.0.0.1', port: app.socks.port });
  assert.deepEqual(ps.value.rules.bypassList, ['<local>', '127.0.0.1', 'localhost']);
  assert.equal((await webrtcSetting()).value, 'disable_non_proxied_udp');

  const before = app.socks.seen.length;
  const hitsBefore = hits.length;
  await page.goto(pageUrl());
  assert.equal(await page.textContent('#ok'), 'reached the page');
  const seen = app.socks.seen.slice(before);
  assert.ok(seen.length >= 1, 'the SOCKS5 listener saw the connection');
  assert.deepEqual({ host: seen[0].host, port: seen[0].port, addressType: seen[0].addressType },
    { host: NAME, port: site.address().port, addressType: 'name' }, 'name handed over unresolved');
  assert.equal(hits.length, hitsBefore + 1);

  await popup.reload();
  await popupShows('Private internet is on');
  await wait(1200); // let usage and time on show
  const ids = await popup.locator('#route text.id').allTextContents();
  assert.equal(ids.filter(Boolean).length, 3);
  for (const id of ids) assert.match(id, /^.{4}….{4}$/);
  assert.ok(await popup.locator('#data').isVisible());
  await shot('06-on');
});

test('kill switch: the private internet drops, pages fail, popup says paused', async () => {
  const hitsBefore = hits.length;
  await app.drop(); // the app's listener goes away
  await assert.rejects(page.goto(pageUrl(), { timeout: 10_000 }), /ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS|ERR_CONNECTION_REFUSED|ERR_TUNNEL/);
  assert.equal(hits.length, hitsBefore, 'nothing reached the page on the open internet');
  await popupShows('Tangent is off, so this browser is paused');
  await shot('07-paused');
  const ps = await proxySetting();
  assert.equal(ps.levelOfControl, 'controlled_by_this_extension', 'still holding');
  assert.equal(ps.value.mode, 'fixed_servers');
});

test('kill switch also holds when the app quits, and wakes the popup on open', async () => {
  const hitsBefore = hits.length;
  await app.close();
  app = null;
  await popup.reload();
  await popupShows('Tangent is off, so this browser is paused');
  await popupShows('Open the Tangent app to continue');
  await assert.rejects(page.goto(pageUrl(), { timeout: 10_000 }));
  assert.equal(hits.length, hitsBefore);
});

test('browse without Tangent: direct loading works again and settings are restored', async () => {
  await popup.click('#secondary');
  await popupShows('Open the Tangent app');
  const ps = await proxySetting();
  assert.equal(ps.levelOfControl, 'controllable_by_this_extension');
  assert.notEqual(ps.value.mode, 'fixed_servers');
  assert.notEqual((await webrtcSetting()).value, 'disable_non_proxied_udp');
  const hitsBefore = hits.length;
  await page.goto(pageUrl());
  assert.equal(await page.textContent('#ok'), 'reached the page');
  assert.equal(hits.length, hitsBefore + 1);
});

test('needs balance and the wallet button', async () => {
  app = await startMockApp({ approve: 'auto', connectDelayMs: 300, resolve: { [NAME]: '127.0.0.1' }, socksPort: 0 });
  // the earlier app's token is unknown to this one: the popup asks to connect again
  await popupShows('Connect this browser');
  await popup.click('#primary');
  await popupShows('Tangent is off');
  app.setNeedsBalance(true);
  await popupShows('Add balance to keep going');
  await shot('08-needs-balance');
  await popup.click('#primary');
  await wait(400);
  assert.deepEqual(app.opened, ['wallet']);
  app.setNeedsBalance(false);
  await popupShows('Tangent is off');
});

test('turn off leaves the app running by default', async () => {
  await popup.click('#primary');
  await popupShows('Private internet is on');
  await popup.click('#primary');
  await popupShows('Tangent is off');
  assert.equal(app.state.connected, true);
  assert.ok(!app.requests.some((r) => r.path === '/v1/disconnect'));
  assert.equal((await proxySetting()).levelOfControl, 'controllable_by_this_extension');
});

test('options page: bypass list validated and saved, pairing can be forgotten', async () => {
  const opt = await ctx.newPage();
  watch(opt);
  await opt.setViewportSize({ width: 1100, height: 900 });
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.getByText('Sites that skip Tangent').first().waitFor();
  await opt.fill('#bypass', 'example.com\nnot a site\n10.0.0.0/8');
  await opt.click('#save');
  await opt.getByText('has a space in it').waitFor();
  await shot('10-options-error', opt);
  await opt.fill('#bypass', 'example.com\nhttps://bank.example.org/login\n10.0.0.0/8');
  await opt.click('#save');
  await opt.getByText('Saved').waitFor();
  assert.equal(await opt.inputValue('#bypass'), 'example.com\nbank.example.org\n10.0.0.0/8');
  const st = await sw.evaluate(() => chrome.storage.local.get('bypass'));
  assert.deepEqual(st.bypass, ['example.com', 'bank.example.org', '10.0.0.0/8']);
  await shot('09-options', opt);

  // the saved sites go into the live setting when on
  await popup.click('#primary');
  await popupShows('Private internet is on');
  const ps = await proxySetting();
  assert.deepEqual(ps.value.rules.bypassList, ['<local>', '127.0.0.1', 'localhost', 'example.com', '*.example.com', 'bank.example.org', '*.bank.example.org', '10.0.0.0/8']);

  await opt.reload();
  await opt.click('#forget');
  await opt.getByText('not paired with the Tangent app').waitFor();
  await popupShows('Connect this browser');
  assert.equal((await proxySetting()).levelOfControl, 'controllable_by_this_extension');
  await opt.close();
});

test('no errors in the extension pages, nothing blocked by the content security policy', () => {
  assert.deepEqual(pageErrors, []);
});
