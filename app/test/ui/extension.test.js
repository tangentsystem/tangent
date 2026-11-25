// The real extension (../../../extension, loaded unpacked into Chrome) against the real app
// core on its real control port, over a whole local network (coordinator, 4 node processes).
//
// Proves: pairing is approved in the app and the token works; turning on in the browser turns
// the private internet on in the app and points Chrome at it; a page then really travels the
// three hops (the app's own circuit counts the bytes); when the private internet drops the
// browser holds pages instead of leaking them; "Browse without Tangent" lets go.
//
// Skipped when the control port 47611 is taken or Chrome is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startNetwork, waitFor } from '../support/network.js';
import { createCore } from '../../core/index.js';

const require = createRequire(import.meta.url);
const EXT = fileURLToPath(new URL('../../../extension', import.meta.url));
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS || '';

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
// an address of this machine that is not loopback: Chrome never sends loopback through a proxy
const ownAddress = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address || null;

test('the real extension drives the real app', { timeout: 600_000 }, async (t) => {
  if (!fs.existsSync(CHROME)) return t.skip('Chrome is not installed here');
  if (!(await portFree(47611))) return t.skip('port 47611 is in use');
  const addr = ownAddress();
  if (!addr) return t.skip('this machine has no address besides loopback');
  const { chromium } = require('playwright-core');

  const hits = [];
  const site = http.createServer((req, res) => {
    if (req.url !== '/') { res.writeHead(404); return res.end(); }
    hits.push(req.headers.host);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>t</title><h1 id="ok">reached the page</h1><p>${'x'.repeat(6000)}</p>`);
  });
  await new Promise((r) => site.listen(0, '0.0.0.0', r));
  const pageUrl = `http://${addr}:${site.address().port}/`;

  const network = await startNetwork({});
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-app-ext-'));
  const core = createCore({ env: { TANGENT_COORDINATOR: network.coordUrl, TANGENT_APP_DATA: data, TANGENT_MCP_PORT: '0' }, version: '0.1.0' });
  const events = [];
  core.on((name, p) => events.push([name, p]));
  let ctx = null;
  try {
    const { controlPort } = await core.start();
    assert.equal(controlPort, 47611, 'the app listens where the extension looks');

    ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chrome-')), {
      executablePath: CHROME, headless: true, deviceScaleFactor: 2, viewport: { width: 360, height: 500 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
    const extId = new URL(sw.url()).host;
    const popup = await ctx.newPage();
    const page = await ctx.newPage();
    const errors = [];
    popup.on('pageerror', (e) => errors.push(e.message));
    popup.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const shows = (text, timeout = 30_000) => popup.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
    const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await new Promise((r) => setTimeout(r, 1900)); await popup.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); } };
    const proxySetting = () => sw.evaluate(() => chrome.proxy.settings.get({ incognito: false }));

    // ---- pairing, approved in the app
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await shows('Connect this browser');
    await popup.click('#primary');
    await shows('Approve it in the Tangent app');
    const asked = await waitFor(() => events.findLast(([n, p]) => n === 'pairing' && p.length === 1), { what: 'the app asking the person', timeoutMs: 15_000 });
    assert.equal(asked[1][0].client, 'Tangent for Chrome');
    assert.ok(core.pairing.approve(asked[1][0].id));
    await shows('Tangent is off');
    assert.equal(core.pairing.list().length, 1);
    assert.equal(core.pairing.list()[0].client, 'Tangent for Chrome');

    // ---- before turning on: direct
    await page.goto(pageUrl);
    assert.equal(await page.textContent('#ok'), 'reached the page');
    assert.equal(core.session.status().connected, false);

    // ---- turn on from the browser: the app connects, Chrome points at it
    await popup.click('#primary');
    await shows('Private internet is on', 90_000);
    const s1 = core.session.status();
    assert.equal(s1.connected, true);
    const ps = await proxySetting();
    assert.equal(ps.levelOfControl, 'controlled_by_this_extension');
    assert.deepEqual(ps.value.rules.singleProxy, { scheme: 'socks5', host: '127.0.0.1', port: s1.socks.port });
    await shot('real-on');

    // ---- a page really travels the three hops
    const usedBefore = core.session.status().usage.bytesDown;
    const hitsBefore = hits.length;
    await page.goto(pageUrl);
    assert.equal(await page.textContent('#ok'), 'reached the page');
    assert.equal(hits.length, hitsBefore + 1);
    const s2 = await waitFor(() => { const s = core.session.status(); return s.usage.bytesDown >= usedBefore + 6000 && s.hops.length === 3 ? s : null; }, { what: 'the page counted on the app circuit', timeoutMs: 15_000 });
    const dir = new Set((await core.coord.directory()).map((d) => d.id));
    for (const h of s2.hops) assert.ok(dir.has(h.id), 'each hop is a node of the network');
    assert.equal(new Set(s2.hops.map((h) => h.id)).size, 3);
    const circuits = core.session.details().circuits;
    assert.ok(circuits.some((c) => c.hops.every((h) => h.cells > 0)), 'every hop carried cells');
    // the popup shows the same three hops
    await popup.reload();
    await shows('Private internet is on');
    const text = await popup.locator('#route').textContent();
    for (const h of s2.hops) assert.ok(text.includes(h.id.slice(0, 4)), `the popup shows hop ${h.id.slice(0, 4)}`);

    // ---- the private internet drops: pages are held, nothing leaks
    await core.session.disconnect();
    const leaksBefore = hits.length;
    await assert.rejects(page.goto(pageUrl, { timeout: 15_000 }), /ERR_|net::|Timeout/);
    assert.equal(hits.length, leaksBefore, 'no request reached the site while paused');
    await popup.reload();
    await shows('this browser is paused');
    assert.equal((await proxySetting()).levelOfControl, 'controlled_by_this_extension');
    await shot('real-paused');

    // ---- turn back on from the popup: the app connects again and pages flow
    await popup.click('#primary');
    await shows('Private internet is on', 90_000);
    assert.equal(core.session.status().connected, true);
    await page.goto(pageUrl);
    assert.equal(await page.textContent('#ok'), 'reached the page');

    // ---- drop again, then choose to browse without Tangent
    await core.session.disconnect();
    await popup.reload();
    await shows('this browser is paused');
    await popup.click('#secondary');
    await shows('Tangent is off');
    assert.notEqual((await proxySetting()).levelOfControl, 'controlled_by_this_extension');
    await page.goto(pageUrl);
    assert.equal(await page.textContent('#ok'), 'reached the page');

    assert.deepEqual(errors, [], 'no errors in the popup');
  } finally {
    await ctx?.close().catch(() => {});
    await core.stop().catch(() => {});
    await network.stop().catch(() => {});
    await new Promise((r) => { site.close(() => r()); site.closeAllConnections(); });
  }
});
