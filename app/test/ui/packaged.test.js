// The packaged build (release/linux-unpacked after `npm run build`) starts, shows the Internet
// view and turns the private internet on against a local network. Packaging mistakes (a file
// left out of the asar, a module the bundle missed) only show up here.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { _electron } from 'playwright-core';
import { startNetwork } from '../support/network.js';
import { APP, HAS_DISPLAY, appEnv, sandboxArgs } from './support.js';

const BIN = path.join(APP, 'release', 'linux-unpacked', 'tangent');
const SHOTS = process.env.TANGENT_SHOTS || null;

test('the packaged app starts and reaches the Internet view', { skip: !HAS_DISPLAY ? 'needs a display (run under xvfb-run)' : !fs.existsSync(BIN) ? 'no packaged build: run npm run build first' : false, timeout: 240_000 }, async () => {
  const network = await startNetwork();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pkg-'));
  const app = await _electron.launch({
    executablePath: BIN,
    args: sandboxArgs(),
    env: appEnv({ TANGENT_COORDINATOR: network.coordUrl, TANGENT_APP_DATA: data, TANGENT_CONTROL_PORT: '0', TANGENT_SOCKS_PORT: '0', TANGENT_MCP_PORT: '0' }),
  });
  const errors = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    await win.waitForSelector('body.ready', { timeout: 30_000 });
    assert.equal(await win.textContent('#in-title'), 'Private internet');
    assert.equal(await win.evaluate(() => document.fonts.check('600 16px Inter')), true, 'Inter is bundled');
    const version = await win.textContent('#ver');
    assert.equal(version, `Tangent ${JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version}`);
    const packaged = await app.evaluate(({ app: a }) => a.isPackaged);
    assert.equal(packaged, true);
    // single instance: a second start hands over to the running one and quits
    const second = spawn(BIN, sandboxArgs(), { env: appEnv({ TANGENT_COORDINATOR: network.coordUrl, TANGENT_APP_DATA: data, TANGENT_CONTROL_PORT: '0' }), stdio: 'ignore' });
    const code = await new Promise((resolve) => { const t = setTimeout(() => { second.kill('SIGKILL'); resolve('still running'); }, 20_000); second.once('exit', (c) => { clearTimeout(t); resolve(c); }); });
    assert.equal(code, 0, 'the second instance quit at once');
    assert.equal(await win.isVisible('#in-toggle'), true, 'the first one is still there');
    await win.click('#in-toggle');
    await win.waitForSelector('#in-path:not([hidden])', { timeout: 60_000 });
    const st = await win.evaluate(() => window.tangent.call('status'));
    assert.equal(st.hops.length, 3, 'the packaged build builds circuits (relay crypto works inside Electron)');
    await win.waitForTimeout(2500);
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'packaged-on.png') });
    await win.click('#in-toggle');
    await win.waitForSelector('#in-path', { state: 'hidden', timeout: 20_000 });
    // the keys it made are backed up next to them
    const keys = fs.readdirSync(path.join(data, 'keys'));
    const backups = fs.readdirSync(path.join(data, 'backups'));
    assert.ok(keys.includes('wallet.json'));
    assert.ok(backups.some((b) => b.startsWith('wallet-')));
    assert.deepEqual(errors, []);
  } finally {
    await app.close().catch(() => {});
    await network.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
