// The site: every page is server rendered html with no-store, clean urls, the token
// block only with a configured token and its real symbol, and docs that match the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../coord/testkit.js';
import { ROUTES } from './index.js';
import { PAGES, GUIDES, DOCS_INDEX, shownCode, SITE_URL, X_URL } from './pages.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const fakeToken = (symbol = 'TNGT') => ({ configured: true, ca: CA, stats: async () => ({ symbol, buyUrl: `https://pump.fun/coin/${CA}` }) });

const EXPECTED = ['/', '/nodes', '/agents', '/docs', '/docs/run-a-node', '/docs/payments', '/docs/private-internet', '/docs/off-grid', '/docs/agents', '/docs/reference'];

test('every page answers 200 html with no-store, canonical url and the X link', async () => {
  const h = await startApp();
  try {
    assert.deepEqual([...ROUTES()].sort(), [...EXPECTED].sort());
    for (const p of EXPECTED) {
      const r = await h.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/, p);
      assert.equal(r.headers.get('cache-control'), 'no-store', p);
      assert.ok(r.text.includes(`<link rel="canonical" href="${SITE_URL}${p === '/' ? '' : p}">`), p);
      assert.ok(r.text.includes(X_URL), p);
      assert.ok(r.text.includes('<canvas id="gl">') && r.text.includes('/tangent.js'), `${p} carries the scene`);
      assert.ok(!/https?:\/\/(fonts\.|cdn|unpkg|jsdelivr)/.test(r.text), `${p} loads nothing from outside`);
    }
  } finally { await h.close(); }
});

test('guide copy is in the raw html', async () => {
  const h = await startApp();
  try {
    for (const g of GUIDES) {
      const r = await h.get(g.path);
      for (const s of g.sections) assert.ok(r.text.includes(`<h2>${s.h}</h2>`), `${g.path} ${s.h}`);
      assert.ok(r.text.includes('class="copy"'), `${g.path} has copy buttons`);
    }
    const idx = await h.get('/docs');
    for (const g of GUIDES) assert.ok(idx.text.includes(`href="${g.path}"`));
  } finally { await h.close(); }
});

test('.html paths redirect to clean urls; unknown paths keep the JSON 404; no /proof or /whitepaper', async () => {
  const h = await startApp();
  try {
    for (const p of EXPECTED) {
      const r = await fetch(h.base + (p === '/' ? '/index.html' : `${p}.html`), { redirect: 'manual' });
      assert.equal(r.status, 301, p);
      assert.equal(new URL(r.headers.get('location'), h.base).pathname, p);
    }
    for (const p of ['/nope', '/docs/nope', '/proof', '/whitepaper', '/proof.html', '/whitepaper.html']) {
      const r = await h.get(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.json.error, 'NOT_FOUND', p);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  } finally { await h.close(); }
});

test('token block: absent with no token, present with the real symbol and buy url when configured', async () => {
  const none = await startApp();
  const tok = await startApp({ token: fakeToken('TNGT') });
  const noSym = await startApp({ token: { configured: true, ca: CA, stats: async () => ({ symbol: null, buyUrl: null }) } });
  try {
    for (const p of EXPECTED) {
      const a = (await none.get(p)).text;
      assert.ok(!a.includes('class="tok"') && !a.includes('Buy $'), p);
      const b = (await tok.get(p)).text;
      assert.ok(b.includes('class="tok"'), p);
      assert.ok(b.includes(`data-ca="${CA}"`), p);
      assert.ok(b.includes(`href="https://pump.fun/coin/${CA}"`), p);
      assert.ok(b.includes('Buy $TNGT'), p);
      assert.ok(!/TICKER/.test(b), p);
      const c = (await noSym.get(p)).text;
      assert.ok(!c.includes('class="tok"'), `${p} hides the block without a real symbol`);
    }
  } finally { await none.close(); await tok.close(); await noSym.close(); }
});

// ---- docs against the code

const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
function optionsOf(file) {
  const s = src(file);
  const block = s.slice(s.indexOf('options: {'), s.indexOf('},\n});'));
  return new Set([...block.matchAll(/(?:'([a-z-]+)'|\b([a-z]+)):\s*\{\s*type:/g)].map((m) => m[1] || m[2]));
}
const NODE_OPTS = optionsOf('bin/node.js');
const CLIENT_OPTS = optionsOf('bin/client.js');
const CLIENT_CMDS = new Set([...src('bin/client.js').matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));

function words(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function commandLines() {
  const lines = [];
  for (const block of shownCode()) {
    for (const l of block.replace(/\\\n\s*/g, ' ').split('\n')) {
      const t = l.trim();
      if (/^node bin\//.test(t)) lines.push(t);
    }
  }
  return lines;
}

test('the code knows what the parser found (sanity)', () => {
  for (const o of ['coordinator', 'host', 'compute', 'exit', 'gateway', 'payout', 'peer']) assert.ok(NODE_OPTS.has(o), o);
  for (const o of ['tokens', 'nodes', 'socks-port', 'hops', 'node', 'machine', 'cmd', 'http', 'tip-account']) assert.ok(CLIENT_OPTS.has(o), o);
  for (const c of ['wallet', 'deposit', 'balance', 'credit', 'proxy', 'rent', 'recover-wallet', 'offgrid-send', 'mcp']) assert.ok(CLIENT_CMDS.has(c), c);
});

test('every command line shown on the site is a real command with real options', () => {
  const lines = commandLines();
  assert.ok(lines.length >= 20, `found ${lines.length} command lines`);
  for (const line of lines) {
    const w = words(line).filter((x) => !/^\[.*\]$/.test(x) && !/^[[\]]/.test(x));
    const file = w[1];
    let allowed;
    let rest = w.slice(2);
    if (file === 'bin/node.js') {
      allowed = NODE_OPTS;
      if (rest[0] && !rest[0].startsWith('-')) { assert.equal(rest[0], 'setup', line); rest = rest.slice(1); }
    } else if (file === 'bin/client.js') {
      allowed = CLIENT_OPTS;
      if (rest[0] !== '<command>') assert.ok(CLIENT_CMDS.has(rest[0]), `${line}: unknown command ${rest[0]}`);
      rest = rest.slice(1);
    } else if (file === 'bin/mcp.js') {
      allowed = CLIENT_OPTS;
    } else assert.fail(`unknown program in: ${line}`);
    for (const x of rest) if (x.startsWith('--')) assert.ok(allowed.has(x.slice(2)), `${line}: unknown option ${x}`);
  }
});

test('the reference lists every option of node and client, and nothing else', () => {
  const ref = GUIDES.find((g) => g.path === '/docs/reference');
  const terms = (id) => ref.sections.find((s) => s.id === id).blocks.filter((b) => b[0] === 'opts').flatMap((b) => b[1]);
  const nodeFlags = new Set(terms('node').map(([t]) => t.split(' ')[0].replace(/^--/, '')));
  const skip = new Set(['help', 'backup-machine-wallets']); // --help is mentioned once; the other is kept only for older scripts
  for (const o of NODE_OPTS) if (!skip.has(o)) assert.ok(nodeFlags.has(o), `reference misses node --${o}`);
  for (const o of nodeFlags) assert.ok(NODE_OPTS.has(o), `reference shows unknown node --${o}`);
  const clientRows = terms('client');
  assert.deepEqual(new Set(clientRows.map(([t]) => t)), CLIENT_CMDS);
  const flagsShown = new Set(clientRows.flatMap(([, d]) => [...d.matchAll(/`--([a-z-]+)/g)].map((m) => m[1])));
  for (const o of flagsShown) assert.ok(CLIENT_OPTS.has(o), `reference shows unknown client --${o}`);
  const common = new Set(['help', 'coordinator', 'coordinator-id', 'data']);
  for (const o of CLIENT_OPTS) if (!common.has(o)) assert.ok(flagsShown.has(o), `reference misses client --${o}`);
});

test('the help text of each program agrees with the reference defaults', () => {
  const help = src('bin/node.js');
  for (const [flag, def] of [['relay-port', '9101'], ['api-port', '9102'], ['offgrid-port', '9103'], ['price-mb', '10000'], ['price-second', '1000']]) {
    assert.match(help, new RegExp(`--${flag}.*default ${def}`), flag);
  }
  const client = src('bin/client.js');
  assert.match(client, /'--timeout-sec'\)/);
  assert.match(client, /int\(values\['timeout-sec'\], 120,/);
  assert.match(client, /int\(values\['socks-port'\], 1080,/);
  assert.match(client, /int\(values\.hops, 3,/);
});

test('the docs describe the machine wallet key as the code keeps it (30 days, then deleted)', () => {
  const nodeHelp = src('bin/node.js');
  assert.match(nodeHelp, /for 30 days after its machine ends so the renter can recover it, then deletes it/);
  assert.ok(fs.existsSync(path.join(ROOT, 'src/node/machine-wallets.js')));
  const agents = JSON.stringify(GUIDES.find((g) => g.path === '/docs/agents'));
  assert.match(agents, /30 days/);
  assert.ok(!/thrown away|discarded|destroyed immediately/i.test(agents));
});

// ---- copy rules

function proseOf() {
  const out = [];
  const add = (where, t) => out.push([where, String(t)]);
  for (const p of PAGES) {
    add(p.path, p.hero);
    for (const s of Object.values(p.sub || {})) add(p.path, s);
    for (const s of Object.values(p.say || {})) for (const [l] of s.d) add(p.path, l);
    for (const [l] of p.actions || []) add(p.path, l);
  }
  add('/docs', DOCS_INDEX.hero);
  for (const g of GUIDES) {
    add(g.path, g.h1); add(g.path, g.lede); add(g.path, g.blurb); add(g.path, g.nav);
    for (const s of g.sections) {
      add(g.path, s.h);
      for (const b of s.blocks) {
        if (b[0] === 'p' || b[0] === 'h3') add(g.path, b[1]);
        if (b[0] === 'list') b[1].forEach((x) => add(g.path, x));
        if (b[0] === 'opts') b[1].forEach(([, d]) => add(g.path, d));
      }
    }
  }
  // code spans and link targets are not prose
  return out.map(([w, t]) => [w, t.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']')]);
}

test('copy rules: no dashes as punctuation and no banned words in user facing prose', () => {
  const banned = /\b(server|servers|indexer|backend|daemon|endpoint|coordinator|coming soon|soon|tba|loading|not deployed|beta|experimental|untested|audited|ticker|financial advice)\b/i;
  for (const [where, t] of proseOf()) {
    assert.ok(!/[-–—]/.test(t), `${where}: dash in "${t}"`);
    assert.ok(!banned.test(t), `${where}: banned word in "${t}"`);
  }
});
