import { shortId, formatBytes, formatDuration } from './lib/format.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

// ---- the route drawing -------------------------------------------------------------------
const XS = [92, 156, 220];
const L = 22, R = 290;
const Y = 50;
function el(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
function cube(g, cx, cy, s) {
  const k = s * 0.866;
  const p = (pts) => 'M' + pts.map((q) => q.join(' ')).join('L') + 'Z';
  const top = [cx, cy - s], rt = [cx + k, cy - s / 2], rb = [cx + k, cy + s / 2];
  const bot = [cx, cy + s], lb = [cx - k, cy + s / 2], lt = [cx - k, cy - s / 2], c = [cx, cy];
  el('path', { class: 'l', d: p([lt, c, bot, lb]) }, g);
  el('path', { class: 'r', d: p([c, rt, rb, bot]) }, g);
  el('path', { class: 't', d: p([top, rt, c, lt]) }, g);
}
function drawRoute() {
  const svg = $('route');
  const last = XS[2];
  el('path', { class: 'wire', d: `M${L} ${Y}H${last}` }, svg);
  el('path', { class: 'wire out', d: `M${last} ${Y}H${R}` }, svg);
  el('path', { class: 'lit', d: `M${L} ${Y}H${R}` }, svg);
  el('path', { class: 'glow', d: `M${L} ${Y}H${R}` }, svg);
  el('path', { class: 'gap', d: `M${last + 28} ${Y - 8}V${Y + 8}M${last + 34} ${Y - 8}V${Y + 8}` }, svg);
  el('rect', { class: 'end', x: L - 3, y: Y - 3, width: 6, height: 6, rx: 1 }, svg);
  el('rect', { class: 'end', x: R - 3, y: Y - 3, width: 6, height: 6, rx: 1 }, svg);
  for (const x of XS) cube(el('g', { class: 'cube' }, svg), x, Y, 17);
  const you = el('text', { x: L, y: Y + 40, 'text-anchor': 'middle' }, svg); you.textContent = 'You';
  const web = el('text', { x: R, y: Y + 40, 'text-anchor': 'middle' }, svg); web.textContent = 'Web';
  XS.forEach((x, i) => { el('text', { class: 'id', id: `hop${i}`, x, y: Y + 40, 'text-anchor': 'middle' }, svg); });
}

// ---- copy for each state -----------------------------------------------------------------
const NOTES = {
  denied: 'The app turned the request down. Send a new one when you are ready.',
  expired: 'The request timed out. Send a new one.',
  failed: 'The app did not take the request. Try again.',
};

function render(v) {
  const app = $('app');
  if (!v) return;
  const s = { title: '', sub: '', primary: null, link: false, secondary: null, tech: '', light: false };

  switch (v.name) {
    case 'noapp':
      s.title = 'Open the Tangent app';
      s.sub = 'We run the private internet from the app on this computer. Open it and this updates on its own.';
      s.link = true;
      break;
    case 'unpaired':
      s.title = 'Connect this browser';
      s.sub = NOTES[v.pairNote] || 'Link Tangent for Chrome to the app once, then switch it on from here any time.';
      s.primary = ['Connect to the app', 'pair'];
      break;
    case 'pairing':
      s.title = 'Approve it in the Tangent app';
      s.sub = 'Choose Allow in the app window and we will take it from there.';
      s.secondary = ['Cancel', 'cancelPair'];
      break;
    case 'off':
      s.title = 'Tangent is off';
      s.sub = v.note === 'timeout'
        ? 'The app is still building your path. Try again in a moment.'
        : v.note || 'This browser uses the open internet.';
      s.primary = ['Turn on', 'on'];
      break;
    case 'turning':
      s.title = 'Turning on';
      s.sub = 'Building your path over three nodes.';
      break;
    case 'on':
      s.title = 'Private internet is on';
      s.sub = 'Every page here travels through three nodes before it reaches the web.';
      s.primary = ['Turn off', 'off'];
      s.light = true;
      s.tech = `SOCKS5 ${v.host}:${v.port}`;
      break;
    case 'balance':
      s.title = 'Add balance to keep going';
      s.sub = 'Your wallet in the Tangent app needs balance for the private internet.';
      s.primary = ['Open wallet', 'openWallet'];
      if (v.engaged) s.secondary = ['Browse without Tangent', 'without'];
      break;
    case 'paused':
      s.title = 'Tangent is off, so this browser is paused';
      if (v.reason === 'app') {
        s.sub = 'We hold every page until the private internet is back. Open the Tangent app to continue.';
        s.primary = ['Turn back on', 'on'];
      } else if (v.reason === 'unpaired') {
        s.sub = NOTES[v.pairNote] || 'The app no longer knows this browser. Connect again to continue.';
        s.primary = ['Connect again', 'pair'];
      } else {
        s.sub = 'We hold every page until the private internet is back, so nothing reaches the open web.';
        s.primary = ['Turn back on', 'on'];
      }
      s.secondary = ['Browse without Tangent', 'without'];
      break;
    case 'controlled':
      if (v.by === 'policy') {
        s.title = 'Your organization sets this browser’s connection';
        s.sub = 'Tangent can’t switch it while that setting is in place.';
      } else {
        s.title = 'Another extension is in charge';
        s.sub = 'It decides how this browser connects, so Tangent can’t switch it. Turn that extension off, then come back here.';
        s.primary = ['Manage extensions', 'extensions'];
      }
      break;
    default:
      return;
  }

  app.dataset.state = v.name;
  $('title').textContent = s.title;
  $('sub').textContent = s.sub;

  const p = $('primary');
  p.hidden = !s.primary;
  if (s.primary) {
    p.textContent = s.primary[0];
    p.dataset.act = s.primary[1];
    p.classList.toggle('light', s.light);
    p.disabled = false;
  }
  $('primary-link').hidden = !s.link;
  const q = $('secondary');
  q.hidden = !s.secondary;
  if (s.secondary) { q.textContent = s.secondary[0]; q.dataset.act = s.secondary[1]; }
  $('tech').textContent = s.tech;

  // hops and numbers, hidden when empty
  for (let i = 0; i < 3; i++) $(`hop${i}`).textContent = v.name === 'on' && v.hops && v.hops[i] ? shortId(v.hops[i]) : '';
  current = v;
  tick();
  app.classList.add('ready');
}

let current = null;
function tick() {
  const v = current;
  const on = v && v.name === 'on';
  const data = on ? formatBytes(v.bytes) : '';
  const time = on && v.since ? formatDuration(Date.now() - v.since) : '';
  $('data').textContent = data;
  $('time').textContent = time;
  $('stat-data').hidden = !data;
  $('stat-time').hidden = !time;
  $('stats').hidden = !data && !time;
}

// ---- actions -----------------------------------------------------------------------------
async function act(name) {
  if (name === 'extensions') { chrome.tabs.create({ url: 'chrome://extensions' }); return; }
  if (name === 'on') render({ ...(current || {}), name: 'turning' });
  if (name === 'openWallet') { await send('openWallet'); return; }
  const v = await send(name);
  render(v);
}

$('primary').addEventListener('click', (e) => act(e.currentTarget.dataset.act));
$('secondary').addEventListener('click', (e) => act(e.currentTarget.dataset.act));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

drawRoute();
async function refresh() {
  try { render(await send('check')); } catch { /* the worker is waking up */ }
}
refresh();
setInterval(refresh, 1500);
setInterval(tick, 1000);
