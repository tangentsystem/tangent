import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { browserCandidates, findBrowsers, privateWindowArgs, openPrivateWindow } from '../../core/browser.js';

test('candidates cover Chrome, Edge, Brave and Chromium on Windows, macOS and Linux', () => {
  const win = browserCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } });
  for (const p of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\a\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Users\\a\\AppData\\Local\\Chromium\\Application\\chrome.exe']) {
    assert.ok(win.some((c) => c.path === p), p);
  }
  const mac = browserCandidates({ platform: 'darwin', env: { HOME: '/Users/a' } });
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Users/a/Applications/Chromium.app/Contents/MacOS/Chromium']) {
    assert.ok(mac.some((c) => c.path === p), p);
  }
  const lin = browserCandidates({ platform: 'linux', env: { PATH: '/opt/x/bin' } });
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/usr/bin/chromium', '/snap/bin/chromium', '/opt/x/bin/chromium-browser']) {
    assert.ok(lin.some((c) => c.path === p), p);
  }
  assert.deepEqual([...new Set(lin.map((c) => c.kind))].sort(), ['brave', 'chrome', 'chromium', 'edge']);
});

test('findBrowsers keeps one per kind, Chrome first', () => {
  const present = new Set(['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/brave-browser']);
  const found = findBrowsers({ platform: 'linux', env: { PATH: '' }, exists: (p) => present.has(p) });
  assert.deepEqual(found.map((b) => [b.name, b.path]), [['Chrome', '/usr/bin/google-chrome'], ['Brave', '/usr/bin/brave-browser'], ['Chromium', '/usr/bin/chromium']]);
  assert.deepEqual(findBrowsers({ platform: 'linux', env: { PATH: '' }, exists: () => false }), []);
});

test('the private window gets its own profile, the proxy and DNS through the hops', () => {
  const args = privateWindowArgs({ socksPort: 47612, profileDir: '/data/browser-profile', url: 'https://tangentsystems.net' });
  assert.deepEqual(args.slice(0, 3), ['--user-data-dir=/data/browser-profile', '--proxy-server=socks5://127.0.0.1:47612', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1']);
  assert.equal(args.at(-1), 'https://tangentsystems.net');
  assert.throws(() => privateWindowArgs({ socksPort: 0, profileDir: '/x' }));
});

test('openPrivateWindow starts the browser detached with the profile in the data folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-br-'));
  const spawned = [];
  const fake = (file, args, opts) => { spawned.push({ file, args, opts }); return { pid: 4242, on() {}, unref() { this.unrefd = true; } }; };
  const r = openPrivateWindow({ socksPort: 50000, dataDir: dir, url: 'https://example.org/', browser: { name: 'Edge', path: '/usr/bin/microsoft-edge' }, spawn: fake, env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x' } });
  assert.equal(r.browser, 'Edge');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, '/usr/bin/microsoft-edge');
  assert.ok(spawned[0].args.includes(`--user-data-dir=${path.join(dir, 'browser-profile')}`));
  assert.ok(spawned[0].args.includes('--proxy-server=socks5://127.0.0.1:50000'));
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, undefined, 'Electron variables are not passed to the browser');
  assert.equal(spawned[0].opts.env.NODE_OPTIONS, undefined);
  assert.ok((await fs.stat(path.join(dir, 'browser-profile'))).isDirectory());
  assert.throws(() => openPrivateWindow({ socksPort: 50000, dataDir: dir, find: () => [], spawn: fake }), (e) => e.code === 'NO_BROWSER');
  await fs.rm(dir, { recursive: true, force: true });
});
