// Service worker: wires the controller to Chrome events and to the popup and options pages.

import { createController, ALARM } from './lib/controller.js';

const ctl = createController({ chrome, fetch: (...a) => fetch(...a) });

const check = () => ctl.check().catch(() => null);

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
  });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); check(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); check(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) check(); });

// A failed connection to Tangent or a change made by someone else: look again right away.
let soon = null;
const checkSoon = () => {
  if (soon) return;
  soon = setTimeout(() => { soon = null; check(); }, 400);
};
chrome.proxy.onProxyError.addListener(checkSoon);
chrome.proxy.settings.onChange.addListener(checkSoon);

const handlers = {
  check: () => ctl.check(),
  pair: () => ctl.startPairing(),
  cancelPair: () => ctl.cancelPairing(),
  on: () => ctl.turnOn(),
  off: () => ctl.turnOff(),
  without: () => ctl.browseWithout(),
  openWallet: () => ctl.openApp('wallet'),
  openInternet: () => ctl.openApp('internet'),
  settings: () => ctl.getSettings(),
  saveBypass: (m) => ctl.saveBypass(m.text),
  alsoStopApp: (m) => ctl.setAlsoStopApp(m.value),
  forget: () => ctl.forget(),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || !handlers[msg.type]) return false;
  handlers[msg.type](msg).then(reply, () => reply(null));
  return true;
});

ensureAlarm();
check();
