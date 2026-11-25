// The real window (Electron, under xvfb on Linux) against a local network: turn the private
// internet on, see the three hops, open the Wallet view, approve a pairing request, turn off.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { _electron } from 'playwright-core';
import { startNetwork, waitFor } from '../support/network.js';
import { APP, ELECTRON, HAS_DISPLAY, bundle, appEnv, sandboxArgs } from './support.js';

const SHOTS = process.env.TANGENT_SHOTS || null;

function api(port, method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('the app window: on, three hops, wallet, pairing, off', { skip: HAS_DISPLAY ? false : 'needs a display (run under xvfb-run)', timeout: 300_000 }, async () => {
  bundle();
  const network = await startNetwork();
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-ui-'));
  const controlPort = 47000 + Math.floor(Math.random() * 500);
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [APP, ...sandboxArgs()],
    env: appEnv({ TANGENT_COORDINATOR: network.coordUrl, TANGENT_APP_DATA: data, TANGENT_CONTROL_PORT: String(controlPort), TANGENT_SOCKS_PORT: '0', TANGENT_MCP_PORT: '0' }),
  });
  const errors = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await win.waitForSelector('body.ready', { timeout: 30_000 });
    const size = await win.evaluate(() => [window.innerWidth, window.innerHeight]);
    assert.ok(size[0] >= 900 && size[1] >= 600, `window ${size}`);
    assert.equal(await win.textContent('#in-title'), 'Private internet');
    assert.equal(await win.textContent('#in-toggle'), 'Turn on');
    // the renderer has no Node
    assert.equal(await win.evaluate(() => typeof require + typeof process), 'undefinedundefined');
    assert.deepEqual(await win.evaluate(() => Object.keys(window.tangent).sort()), ['call', 'on', 'platform']);
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ui-test-off.png') });

    // turn on
    await win.click('#in-toggle');
    await win.waitForSelector('#in-path:not([hidden])', { timeout: 60_000 });
    assert.equal(await win.textContent('#in-title'), 'You are private');
    const hops = await win.$$eval('#in-path li:not(.sep) code', (els) => els.map((e) => e.textContent));
    assert.equal(hops.length, 3, 'three hops shown');
    const status = await win.evaluate(() => window.tangent.call('status'));
    assert.equal(status.connected, true);
    assert.equal(status.hops.length, 3);
    const ids = status.hops.map((h) => h.id);
    assert.deepEqual(hops, ids.map((id) => id.slice(0, 4) + '…' + id.slice(-4)));
    const dir = await (await fetch(network.coordUrl + '/api/directory')).json();
    const known = new Set(dir.directory.nodes.map((n) => n.descriptor.id));
    assert.ok(ids.every((id) => known.has(id)));
    assert.equal(await win.isVisible('#in-window'), true, 'Open a private window is offered');
    await win.waitForTimeout(2500);
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ui-test-on.png') });

    // wallet view
    await win.click('.views button[data-go=wallet]');
    await win.waitForSelector('#v-wallet.on');
    const addr = await win.getAttribute('#wa-addr', 'title');
    assert.match(addr, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(await win.isVisible('#wa-bal'), false, 'a zero balance is hidden');
    assert.equal(await win.isVisible('#wa-add'), true);
    await win.click('#wa-add');
    await win.waitForSelector('#wa-dep:not([hidden])', { timeout: 15_000 });
    assert.match(await win.textContent('#wa-memo'), new RegExp(addr));
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ui-test-wallet.png') });

    // a pairing request from the extension is approved in the window
    const pr = await api(controlPort, 'POST', '/v1/pair', { body: { client: 'Tangent for Chrome' } });
    assert.equal(pr.status, 200);
    await win.waitForSelector('#pair:not([hidden])', { timeout: 10_000 });
    assert.equal(await win.textContent('#pair-title'), 'Allow Tangent for Chrome to control the private internet?');
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ui-test-pairing.png') });
    await win.click('#pair-allow');
    await win.waitForSelector('#pair', { state: 'hidden' });
    const got = (await api(controlPort, 'GET', `/v1/pair/${pr.json.request}`)).json;
    assert.equal(got.state, 'approved');
    const s = (await api(controlPort, 'GET', '/v1/status', { token: got.token })).json;
    assert.equal(s.connected, true);
    assert.deepEqual(s.hops.map((h) => h.id), ids);

    // connected apps lists it
    await win.click('.views button[data-go=internet]');
    await win.waitForSelector('#in-apps:not([hidden])');

    // the extension can bring the window to a view
    assert.equal((await api(controlPort, 'POST', '/v1/open', { token: got.token, body: { view: 'network' } })).status, 200);
    await win.waitForSelector('#v-network.on', { timeout: 10_000 });
    await waitFor(async () => (await win.$$('#nw-list li')).length === 4, { what: 'four nodes listed' });
    await win.click('.views button[data-go=internet]');

    // turn off
    await win.click('#in-toggle');
    await win.waitForSelector('#in-path', { state: 'hidden', timeout: 20_000 });
    assert.equal(await win.textContent('#in-title'), 'Private internet');
    assert.equal((await api(controlPort, 'GET', '/v1/status', { token: got.token })).json.connected, false);
    assert.deepEqual(errors, [], 'no errors in the window');
  } finally {
    await app.close().catch(() => {});
    await network.stop();
    await fs.rm(data, { recursive: true, force: true }).catch(() => {});
  }
});
