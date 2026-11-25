// The extension's brain. Everything chrome.* and network related is injected so the same code
// runs in the service worker and in node --test with a fake chrome object.

import { createApi, isTangentHello } from './api.js';
import { chromeBypassList, parseBypass } from './bypass.js';
import { deriveView, decideProxy, iconOn } from './view.js';

export const PAIR_TTL_MS = 2 * 60 * 1000;
export const CONNECT_WAIT_MS = 60 * 1000;
export const ALARM = 'tangent-check';

const ICON_SIZES = [16, 32, 48, 128];
export const iconPaths = (on) => Object.fromEntries(ICON_SIZES.map((n) => [n, `icons/${on ? 'on' : 'off'}-${n}.png`]));

export const DEFAULTS = Object.freeze({
  token: null,        // bearer token from pairing
  engaged: false,     // the person wants this browser on Tangent
  port: null,         // last port we pointed the browser at
  bypass: [],         // the person's own sites that skip Tangent
  alsoStopApp: false, // turning off here also turns off the app's private internet
  pairing: null,      // { id, started }
  pairNote: null,
  note: null,
});

export function proxyConfig(port, userBypass = []) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'socks5', host: '127.0.0.1', port: Number(port) },
      bypassList: chromeBypassList(userBypass),
    },
  };
}

export function createController({
  chrome,
  fetch: fetchFn = globalThis.fetch,
  base,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 700,
  connectWaitMs = CONNECT_WAIT_MS,
} = {}) {
  const api = createApi({ fetch: fetchFn, base });
  let turning = false;
  let lastIcon = null;
  let pairRead = null; // in flight GET /v1/pair/<id>; the token is only handed out once

  // One mutation at a time so a check never undoes a half finished on or off.
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function load() {
    const got = await chrome.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...got };
  }
  const save = (patch) => chrome.storage.local.set(patch);

  async function proxyLevel() {
    try {
      const d = await chrome.proxy.settings.get({ incognito: false });
      return { control: d.levelOfControl, value: d.value };
    } catch {
      return { control: 'not_controllable', value: null };
    }
  }

  async function applyProxy(port, bypass) {
    await chrome.proxy.settings.set({ value: proxyConfig(port, bypass), scope: 'regular' });
    try {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
    } catch { /* managed by policy; the proxy still holds */ }
  }

  async function clearProxy() {
    try { await chrome.proxy.settings.clear({ scope: 'regular' }); } catch { /* not ours */ }
    try { await chrome.privacy.network.webRTCIPHandlingPolicy.clear({}); } catch { /* not ours */ }
  }

  async function setIcon(on) {
    if (lastIcon === on) return;
    lastIcon = on;
    try {
      await chrome.action.setIcon({ path: iconPaths(on) });
      await chrome.action.setTitle({ title: on ? 'Tangent is on' : 'Tangent' });
    } catch { /* icon is cosmetic */ }
  }

  // Advances a waiting pairing request by one read.
  async function checkPairing(st) {
    if (!st.pairing) return st;
    if (now() - st.pairing.started > PAIR_TTL_MS + 5000) {
      await save({ pairing: null, pairNote: 'expired' });
      return { ...st, pairing: null, pairNote: 'expired' };
    }
    if (!pairRead) {
      const id = st.pairing.id;
      pairRead = (async () => {
        try { return await api.pairState(id); } finally { pairRead = null; }
      })();
    }
    let r;
    try {
      r = await pairRead;
    } catch (e) {
      if (e.code === 'unreachable') return st; // app closed for a moment; keep waiting
      await save({ pairing: null, pairNote: 'expired' }); // unknown request: the app forgot it
      return { ...st, pairing: null, pairNote: 'expired' };
    }
    const cur = await load();
    if (!cur.pairing || cur.pairing.id !== st.pairing.id) return cur; // cancelled meanwhile
    if (r.state === 'approved' && typeof r.token === 'string' && r.token) {
      await save({ token: r.token, pairing: null, pairNote: null });
      return { ...cur, token: r.token, pairing: null, pairNote: null };
    }
    if (r.state === 'denied' || r.state === 'expired') {
      await save({ pairing: null, pairNote: r.state });
      return { ...cur, pairing: null, pairNote: r.state };
    }
    return cur;
  }

  // Reads everything, applies the kill switch rules, updates the icon, returns the view.
  async function check() {
    let st = await load();
    st = await checkPairing(st);
    const { control } = await proxyLevel();

    let app = 'down';
    let status = null;
    let paired = !!st.token;
    if (st.token) {
      try {
        status = await api.status(st.token);
        app = 'up';
      } catch (e) {
        if (e.code === 'unpaired') {
          app = 'up';
          paired = false;
          await save({ token: null });
          st.token = null;
        } else if (e.code !== 'unreachable') {
          app = 'up';
        }
      }
    } else {
      try { app = isTangentHello(await api.hello()) ? 'up' : 'down'; } catch { app = 'down'; }
    }

    const snap = {
      app, paired, status, control, turning,
      pairing: st.pairing, pairNote: st.pairNote,
      engaged: st.engaged, note: st.note, now: now(),
    };

    const d = decideProxy(snap);
    if (d.action === 'apply') {
      if (control !== 'controlled_by_this_extension' || st.port !== d.port) {
        await applyProxy(d.port, st.bypass);
        await save({ port: d.port });
      }
    } else if (d.action === 'hold') {
      // Keep pages failing rather than leaking. If our setting vanished, put it back.
      if (control !== 'controlled_by_this_extension') await applyProxy(st.port || 47612, st.bypass);
    } else if (d.action === 'clear') {
      await clearProxy();
    }
    const after = (await proxyLevel()).control;
    snap.control = after;

    await setIcon(iconOn(snap));
    const view = deriveView(snap);
    view.settings = { alsoStopApp: !!st.alsoStopApp };
    return view;
  }

  async function startPairing() {
    let r;
    try {
      r = await api.pair();
    } catch (e) {
      await save({ pairNote: e.code === 'unreachable' ? null : 'failed' });
      return check();
    }
    if (!r || typeof r.request !== 'string') {
      await save({ pairNote: 'failed' });
      return check();
    }
    await save({ pairing: { id: r.request, started: now() }, pairNote: null });
    return check();
  }

  async function cancelPairing() {
    await save({ pairing: null, pairNote: null });
    return check();
  }

  // Asks the app to turn on, waits for a path, then points this browser at it.
  async function turnOn() {
    if (turning) return locked(check);
    turning = true;
    let result = null;
    let st;
    try {
      st = await load();
      const { control } = await proxyLevel();
      if (control === 'controlled_by_other_extensions' || control === 'not_controllable' || !st.token) {
        turning = false;
        return locked(check);
      }
      await save({ note: null });
      let s;
      try { s = await api.connect(st.token); } catch (e) { result = e.code === 'unreachable' ? 'app' : e.code; }
      const until = now() + connectWaitMs;
      while (!result) {
        if (s && s.needsBalance) { result = 'balance'; break; }
        if (s && s.connected && s.socks && s.socks.port) { result = { port: Number(s.socks.port) }; break; }
        if (s && !s.connecting && s.error) { result = 'error:' + s.error; break; }
        if (now() > until) { result = 'timeout'; break; }
        await sleep(pollMs);
        try { s = await api.status(st.token); } catch (e) { result = e.code === 'unreachable' ? 'app' : e.code; }
      }
    } catch {
      result = 'app';
    }
    return locked(async () => {
      turning = false;
      if (result && typeof result === 'object') {
        const cur = await load();
        await applyProxy(result.port, cur.bypass);
        await save({ engaged: true, port: result.port, note: null });
      } else if (typeof result === 'string' && result.startsWith('error:')) {
        await save({ note: result.slice(6) });
      } else if (result === 'timeout') {
        await save({ note: 'timeout' });
      }
      return check();
    });
  }

  // Unhooks this browser. With alsoStopApp (and only from a real "Turn off"), the app stops too.
  async function turnOff({ stopApp } = {}) {
    return locked(async () => {
      const st = await load();
      await clearProxy();
      await save({ engaged: false, note: null });
      const wantStop = stopApp === undefined ? st.alsoStopApp : stopApp;
      if (wantStop && st.token) {
        try { await api.disconnect(st.token); } catch { /* the browser is already unhooked */ }
      }
      return check();
    });
  }

  // Kill switch exit: browse on the open internet. Never stops the app.
  const browseWithout = () => turnOff({ stopApp: false });

  async function openApp(view) {
    const st = await load();
    if (!st.token) return { ok: false };
    try { await api.open(st.token, view); return { ok: true }; } catch { return { ok: false }; }
  }

  async function getSettings() {
    const st = await load();
    return { bypass: st.bypass, alsoStopApp: !!st.alsoStopApp, paired: !!st.token };
  }

  async function saveBypass(text) {
    const { list, errors } = parseBypass(text);
    if (errors.length) return { ok: false, errors };
    return locked(async () => {
      await save({ bypass: list });
      const st = await load();
      const { control } = await proxyLevel();
      if (st.engaged && control === 'controlled_by_this_extension' && st.port) await applyProxy(st.port, list);
      return { ok: true, list };
    });
  }

  async function setAlsoStopApp(v) {
    await save({ alsoStopApp: !!v });
    return getSettings();
  }

  // Forgetting the pairing also unhooks this browser: without a token we cannot watch the app,
  // so we would hold pages closed with no way back from here.
  async function forget() {
    return locked(async () => {
      await clearProxy();
      await save({ token: null, engaged: false, pairing: null, pairNote: null, note: null });
      return check();
    });
  }

  return {
    check: () => locked(check),
    startPairing: () => locked(startPairing),
    cancelPairing: () => locked(cancelPairing),
    turnOn,
    turnOff: () => turnOff(),
    browseWithout,
    openApp,
    getSettings,
    saveBypass,
    setAlsoStopApp,
    forget,
    get turning() { return turning; },
  };
}
