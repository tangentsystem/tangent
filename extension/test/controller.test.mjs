import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, proxyConfig, PAIR_TTL_MS } from '../lib/controller.js';
import { startMockApp } from './mock-app.mjs';
import { fakeChrome } from './fake-chrome.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(opts = {}, ctlOpts = {}) {
  const app = await startMockApp({ port: 0, socksPort: 0, approveDelayMs: 30, connectDelayMs: 60, ...opts });
  const chrome = fakeChrome();
  const ctl = createController({ chrome, base: app.base, pollMs: 25, connectWaitMs: 3000, ...ctlOpts });
  return { app, chrome, ctl };
}

async function pairAndWait(ctl) {
  let v = await ctl.startPairing();
  assert.equal(v.name, 'pairing');
  for (let i = 0; i < 100 && v.name === 'pairing'; i++) { await wait(20); v = await ctl.check(); }
  return v;
}

async function onState() {
  const s = await setup();
  await pairAndWait(s.ctl);
  const v = await s.ctl.turnOn();
  assert.equal(v.name, 'on');
  return s;
}

test('no app running: says so, touches nothing', async () => {
  const chrome = fakeChrome();
  const ctl = createController({ chrome, base: 'http://127.0.0.1:9' });
  const v = await ctl.check();
  assert.equal(v.name, 'noapp');
  assert.equal(chrome.proxySetting.sets, 0);
  assert.deepEqual(chrome.icons, ['off']);
});

test('pairing: request, approval in the app, token stored once', async () => {
  const { app, chrome, ctl } = await setup({ approve: 'manual' });
  try {
    assert.equal((await ctl.check()).name, 'unpaired');
    let v = await ctl.startPairing();
    assert.equal(v.name, 'pairing');
    assert.equal(app.pending().length, 1);
    assert.equal(app.pairs.get(app.pending()[0]).client, 'Tangent for Chrome');
    v = await ctl.check();
    assert.equal(v.name, 'pairing', 'still waiting for the person');
    app.approve(app.pending()[0]);
    // two checks racing for the one time token must not lose it
    const [a, b] = await Promise.all([ctl.check(), ctl.check()]);
    assert.equal(a.name, 'off');
    assert.equal(b.name, 'off');
    assert.ok(chrome.store.token && app.tokens.has(chrome.store.token));
    assert.equal(chrome.store.pairing, null);
  } finally { await app.close(); }
});

test('pairing denied and expired', async () => {
  const d = await setup({ approve: 'deny' });
  try {
    const v = await pairAndWait(d.ctl);
    assert.deepEqual([v.name, v.pairNote], ['unpaired', 'denied']);
  } finally { await d.app.close(); }

  let clock = 1_000_000;
  const e = await setup({ approve: 'manual' }, { now: () => clock });
  try {
    await e.ctl.startPairing();
    clock += PAIR_TTL_MS + 10_000;
    const v = await e.ctl.check();
    assert.deepEqual([v.name, v.pairNote], ['unpaired', 'expired']);
  } finally { await e.app.close(); }
});

test('cancel pairing returns to the connect screen', async () => {
  const { app, ctl } = await setup({ approve: 'manual' });
  try {
    await ctl.startPairing();
    const v = await ctl.cancelPairing();
    assert.equal(v.name, 'unpaired');
  } finally { await app.close(); }
});

test('turn on: waits for the path, points the browser at the reported port, WebRTC locked down', async () => {
  const { app, chrome, ctl } = await setup();
  try {
    await pairAndWait(ctl);
    const v = await ctl.turnOn();
    assert.equal(v.name, 'on');
    assert.equal(v.hops.length, 3);
    assert.equal(v.port, app.socks.port);
    assert.deepEqual(chrome.proxySetting.ours, proxyConfig(app.socks.port, []));
    assert.equal(chrome.proxySetting.ours.rules.singleProxy.scheme, 'socks5');
    assert.equal(chrome.proxySetting.ours.rules.singleProxy.host, '127.0.0.1');
    assert.deepEqual(chrome.proxySetting.ours.rules.bypassList, ['<local>', '127.0.0.1', 'localhost']);
    assert.equal(chrome.webrtcSetting.ours, 'disable_non_proxied_udp');
    assert.equal(chrome.store.engaged, true);
    assert.equal(chrome.icons.at(-1), 'on');
  } finally { await app.close(); }
});

test('turn off (default): unhooks this browser only, the app keeps running, settings restored', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    const v = await ctl.turnOff();
    assert.equal(v.name, 'off');
    assert.equal(chrome.proxySetting.effective().mode, 'system');
    assert.equal(chrome.webrtcSetting.effective(), 'default');
    assert.equal(app.state.connected, true, 'app stays on');
    assert.ok(!app.requests.some((r) => r.path === '/v1/disconnect'));
    assert.equal(chrome.icons.at(-1), 'off');
  } finally { await app.close(); }
});

test('turn off with "also turn off the app" chosen calls disconnect', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    await ctl.setAlsoStopApp(true);
    await ctl.turnOff();
    assert.equal(app.state.connected, false);
    assert.ok(app.requests.some((r) => r.path === '/v1/disconnect'));
    assert.equal(chrome.proxySetting.effective().mode, 'system');
  } finally { await app.close(); }
});

test('kill switch: the private internet drops, the browser stays pointed at Tangent', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    const port = chrome.proxySetting.ours.rules.singleProxy.port;
    await app.drop();
    const v = await ctl.check();
    assert.deepEqual([v.name, v.reason], ['paused', 'dropped']);
    assert.equal(chrome.proxySetting.ours.rules.singleProxy.port, port, 'still pointed at Tangent');
    assert.equal(chrome.webrtcSetting.ours, 'disable_non_proxied_udp');
    assert.equal(chrome.icons.at(-1), 'off');
    // turn back on
    const back = await ctl.turnOn();
    assert.equal(back.name, 'on');
  } finally { await app.close(); }
});

test('kill switch: the app quits entirely, then "browse without Tangent" restores the open internet', async () => {
  const { app, chrome, ctl } = await onState();
  await app.close();
  const v = await ctl.check();
  assert.deepEqual([v.name, v.reason], ['paused', 'app']);
  assert.notEqual(chrome.proxySetting.ours, undefined);
  const after = await ctl.browseWithout();
  assert.equal(after.name, 'noapp');
  assert.equal(chrome.proxySetting.effective().mode, 'system');
  assert.equal(chrome.webrtcSetting.effective(), 'default');
});

test('kill switch: if our setting was removed while engaged, it is put back so nothing leaks', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    await app.drop();
    await chrome.proxySetting.clear();
    await ctl.check();
    assert.equal(chrome.proxySetting.effective().rules.singleProxy.scheme, 'socks5');
  } finally { await app.close(); }
});

test('the app comes back on a different port: the browser follows it', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    const old = app.socks.port;
    await app.drop();
    await app.connectNow(); // socksPort 0: a new port
    assert.notEqual(app.socks.port, old);
    const v = await ctl.check();
    assert.equal(v.name, 'on');
    assert.equal(chrome.proxySetting.ours.rules.singleProxy.port, app.socks.port);
  } finally { await app.close(); }
});

test('the app forgets this browser while on: paused, then pairing again', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    app.revokeAll();
    const v = await ctl.check();
    assert.deepEqual([v.name, v.reason], ['paused', 'unpaired']);
    assert.equal(chrome.store.token, null);
    assert.notEqual(chrome.proxySetting.ours, undefined, 'still holding');
    const p = await pairAndWait(ctl);
    assert.equal(p.name, 'on');
  } finally { await app.close(); }
});

test('another extension controls the setting: we say so and do not fight it', async () => {
  const { app, chrome, ctl } = await setup();
  try {
    await pairAndWait(ctl);
    chrome.proxySetting.other = 'controlled_by_other_extensions';
    const v = await ctl.check();
    assert.deepEqual([v.name, v.by], ['controlled', 'extension']);
    const t = await ctl.turnOn();
    assert.equal(t.name, 'controlled');
    assert.equal(chrome.proxySetting.sets, 0);
    assert.ok(!app.requests.some((r) => r.path === '/v1/connect'), 'did not start the app for nothing');
    chrome.proxySetting.other = 'not_controllable';
    assert.equal((await ctl.check()).by, 'policy');
  } finally { await app.close(); }
});

test('a leftover setting of ours while off gets cleaned up', async () => {
  const { app, chrome, ctl } = await setup();
  try {
    await pairAndWait(ctl);
    await chrome.proxySetting.set({ value: proxyConfig(47612) });
    await ctl.check();
    assert.equal(chrome.proxySetting.effective().mode, 'system');
  } finally { await app.close(); }
});

test('needs balance: shown before turning on, and turning on does not hook the browser', async () => {
  const { app, chrome, ctl } = await setup();
  try {
    await pairAndWait(ctl);
    app.setNeedsBalance(true);
    assert.equal((await ctl.check()).name, 'balance');
    const v = await ctl.turnOn();
    assert.equal(v.name, 'balance');
    assert.equal(chrome.proxySetting.sets, 0);
    const r = await ctl.openApp('wallet');
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(app.opened, ['wallet']);
  } finally { await app.close(); }
});

test('a failed connect shows the app\u2019s sentence and leaves the browser alone', async () => {
  const { app, chrome, ctl } = await setup({ failConnect: 'No nodes answered.' });
  try {
    await pairAndWait(ctl);
    const v = await ctl.turnOn();
    assert.deepEqual([v.name, v.note], ['off', 'No nodes answered.']);
    assert.equal(chrome.proxySetting.sets, 0);
  } finally { await app.close(); }
});

test('timeout while the app builds a path', async () => {
  const { app, chrome, ctl } = await setup({ connectDelayMs: 10_000 }, { connectWaitMs: 150 });
  try {
    await pairAndWait(ctl);
    const v = await ctl.turnOn();
    assert.deepEqual([v.name, v.note], ['off', 'timeout']);
    assert.equal(chrome.proxySetting.sets, 0);
    assert.equal(chrome.store.note, 'timeout');
  } finally { await app.close(); }
});

test('bypass list: saved, validated, and applied live while on', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    const bad = await ctl.saveBypass('example.com\nnot valid');
    assert.equal(bad.ok, false);
    assert.equal(bad.errors[0].line, 2);
    const good = await ctl.saveBypass('example.com\n10.0.0.0/8');
    assert.equal(good.ok, true);
    const list = chrome.proxySetting.ours.rules.bypassList;
    assert.deepEqual(list, ['<local>', '127.0.0.1', 'localhost', 'example.com', '*.example.com', '10.0.0.0/8']);
    assert.deepEqual((await ctl.getSettings()).bypass, ['example.com', '10.0.0.0/8']);
  } finally { await app.close(); }
});

test('forget this pairing: token dropped and the browser unhooked', async () => {
  const { app, chrome, ctl } = await onState();
  try {
    const v = await ctl.forget();
    assert.equal(v.name, 'unpaired');
    assert.equal(chrome.store.token, null);
    assert.equal(chrome.proxySetting.effective().mode, 'system');
  } finally { await app.close(); }
});
