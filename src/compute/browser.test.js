import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '../core/identity.js';
import { createProcessDriver } from './drivers/process.js';
import { createComputeClient } from './client.js';
import { createBrowserPool, isPrivateAddress } from './browser.js';
import { startNode, startPage } from './test-helpers.js';

const rootDir = path.join(os.tmpdir(), 'network-compute-btest-' + process.pid);
const PAGE = `<!doctype html><html><head><title>Test Page</title></head><body>
<h1>Local test page</h1><p id="msg">waiting</p>
<input id="name"><button id="go" onclick="document.getElementById('msg').textContent='hello '+document.getElementById('name').value">Go</button>
<a id="next" href="/next">next</a></body></html>`;

test('browser: open, read, type, click, screenshot against a local page', { timeout: 90_000 }, async (t) => {
  const page = await startPage(PAGE);
  const node = await startNode({ driver: createProcessDriver({ dev: true, rootDir }) });
  t.after(async () => { await node.close(); await page.close(); });
  const client = createComputeClient({ baseUrl: node.url });
  const m = await client.rent({ payer: createIdentity().id });
  const info = await client.info();
  assert.deepEqual(info.browser.sealed, false);
  assert.equal(info.browser.runsIn, 'node host');
  const o = await m.browserOpen(page.url);
  assert.equal(o.title, 'Test Page');
  // process driver: every browser answer says it is not sealed
  assert.equal(o.sealed, false);
  assert.match(o.warning, /NOT sealed/);
  assert.equal(o.status, 200);
  let txt = await m.browserText();
  assert.match(txt.text, /Local test page/);
  assert.match(txt.text, /waiting/);
  await m.browserType('#name', 'robot');
  await m.browserClick('#go');
  txt = await m.browserText();
  assert.match(txt.text, /hello robot/);
  const shotRes = await fetch(new URL(`machines/${m.machineId}/browser/screenshot`, node.url), { headers: { authorization: `Bearer ${m.token}` } });
  assert.equal(shotRes.headers.get('x-tangent-browser-sealed'), 'false');
  assert.match(shotRes.headers.get('x-tangent-warning'), /NOT sealed/);
  const png = await m.browserScreenshot();
  assert.ok(png.length > 1000);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await m.browserClick('#next');
  assert.match((await m.browserText()).text, /second page/);
  await assert.rejects(m.browserOpen('file:///etc/passwd'), (e) => e.status === 400);
  // another machine has its own browser
  const m2 = await client.rent({ payer: createIdentity().id });
  await m2.browserOpen(page.url + 'next');
  assert.match((await m.browserText()).text, /second page/);
  assert.equal((await m2.browserText()).title, 'Next');
  await m.stop(); await m2.stop();
});

test('browser: private addresses are refused unless allowed', async () => {
  assert.ok(isPrivateAddress('127.0.0.1'));
  assert.ok(isPrivateAddress('10.1.2.3'));
  assert.ok(isPrivateAddress('192.168.1.1'));
  assert.ok(isPrivateAddress('169.254.169.254'));
  assert.ok(isPrivateAddress('::1'));
  assert.ok(isPrivateAddress('::ffff:127.0.0.1'));
  assert.ok(isPrivateAddress('fd00::1'));
  assert.ok(!isPrivateAddress('1.1.1.1'));
  assert.ok(!isPrivateAddress('2606:4700::1111'));
  const pool = createBrowserPool({});
  assert.equal(await pool.hostAllowed('http://127.0.0.1:8080/'), false);
  assert.equal(await pool.hostAllowed('http://localhost/'), false);
  assert.equal(await pool.hostAllowed('http://[::1]/'), false);
  assert.equal(await pool.hostAllowed('http://169.254.169.254/latest'), false);
  assert.equal(await pool.hostAllowed('file:///etc/passwd'), false);
  assert.equal(await pool.hostAllowed('http://1.1.1.1/'), true);
  const page = await startPage(PAGE);
  try {
    const s = pool.get('x');
    await assert.rejects(s.open(page.url), /not allowed/);
    await s.open('data:text/html,<a id=l href="' + page.url + '">x</a><p>data page</p>');
    // a navigation to a private address from inside a page is blocked as well
    await s.click('#l').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch((await s.text()).text, /Local test page/);
  } finally { await pool.closeAll(); await page.close(); }
});
