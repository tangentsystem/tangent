// "Open a private window" for real: the launcher starts the installed Chrome with its own
// profile, pointed at the app's local proxy, and a page load crosses the local network's hops.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startNetwork, waitFor } from '../support/network.js';
import { createCore } from '../../core/index.js';
import { findBrowsers } from '../../core/browser.js';
import { HAS_DISPLAY } from './support.js';

const browsers = findBrowsers();

test('the private window loads a page through the hops', { skip: !HAS_DISPLAY ? 'needs a display (run under xvfb-run)' : !browsers.length ? 'no Chromium based browser installed' : false, timeout: 240_000 }, async () => {
  const network = await startNetwork();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chrome-'));
  const core = createCore({ env: { TANGENT_COORDINATOR: network.coordUrl, TANGENT_APP_DATA: data, TANGENT_CONTROL_PORT: '0', TANGENT_SOCKS_PORT: '0' }, version: 'test' });
  let child = null;
  try {
    core.session.connect();
    const s = await core.session.settled();
    assert.equal(s.connected, true);
    const mark = `/through-chrome-${Date.now()}`;
    const extra = [
      // the test page is on 127.0.0.1, which Chrome never sends to a proxy unless told to
      '--proxy-bypass-list=<-loopback>',
      ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
      '--no-service-autorun', '--password-store=basic',
    ];
    const r = core.openPrivateWindow({ url: network.destUrl(mark), browser: browsers[0], extraArgs: extra });
    child = r.child;
    assert.equal(r.browser, browsers[0].name);
    assert.ok(r.args.includes(`--proxy-server=socks5://127.0.0.1:${s.socks.port}`));
    assert.ok(r.args.includes('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'));
    assert.ok(r.profileDir.startsWith(data), 'the profile is inside the app data folder');
    const hit = await waitFor(() => network.hits.find((h) => h.url === mark), { what: 'the page request at the destination', timeoutMs: 90_000, every: 250 });
    assert.match(hit.ua, /Chrome/);
    // it went through the app's proxy and the exit, not straight to the page
    assert.ok(core.session.targets().includes(`127.0.0.1:${network.destPort}`), 'the app proxy carried the connection');
    const st = core.session.status();
    assert.ok(st.usage.bytesDown > 0 && st.usage.bytesUp > 0);
    const exits = network.nodes.filter((n) => n.roles.includes('exit'));
    const streams = await Promise.all(exits.map(async (n) => (await network.nodeApi(n)).relay.streamsOpened));
    assert.ok(streams.some((x) => x > 0), 'an exit opened the stream to the page');
    assert.ok(fs.readdirSync(r.profileDir).length > 0, 'Chrome wrote its profile there');
  } finally {
    if (child && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } } }
    await core.stop().catch(() => {});
    await network.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
