// The App page and its guide exist only while a desktop build is really published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../coord/testkit.js';
import { ROUTES } from './index.js';
import { appPage, appGuide, GUIDES } from './pages.js';

const L = 'https://github.com/tangentsystem/tangent/releases/latest/download';
const rel = (o) => ({ current: () => ({ windows: null, linux: null, extension: null, version: null, app: false, ...o }) });
const ALL = { windows: `${L}/Tangent-Setup.exe`, linux: `${L}/Tangent.AppImage`, extension: `${L}/tangent-chrome-extension.zip`, version: '0.1.0', app: true };
const SITE = ['/', '/nodes', '/agents', '/docs', '/docs/run-a-node', '/docs/payments', '/docs/private-internet', '/docs/off-grid', '/docs/agents', '/docs/reference'];

test('nothing published: no App page, no guide, no link anywhere', async () => {
  for (const releases of [null, rel({}), rel({ extension: ALL.extension }), { current: () => { throw new Error('boom'); } }]) {
    const h = await startApp({ releases });
    try {
      for (const p of ['/app', '/docs/app', '/app.html', '/docs/app.html']) {
        const r = await h.get(p);
        assert.equal(r.status, 404, p);
        assert.equal(r.json.error, 'NOT_FOUND', p);
      }
      for (const p of SITE) {
        const t = (await h.get(p)).text;
        assert.ok(!t.includes('href="/app"') && !t.includes('href="/docs/app"'), `${p} has no app link`);
        assert.ok(!/Download for|Tangent-Setup|AppImage/.test(t), `${p} offers no download`);
      }
    } finally { await h.close(); }
  }
});

test('published: the App page, its guide and the links appear, with the real download addresses', async () => {
  const h = await startApp({ releases: rel(ALL) });
  try {
    assert.ok(!ROUTES().includes('/app'), 'the fixed route list is unchanged');
    for (const p of SITE) {
      const t = (await h.get(p)).text;
      assert.ok(t.includes('<a class="plain" href="/app">App</a>') || t.includes('<a class="plain cur" href="/app">App</a>'), `${p} links the App page`);
    }
    const a = await h.get('/app');
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('cache-control'), 'no-store');
    assert.ok(a.text.includes(`<a class="btn" href="${ALL.windows}" rel="noopener">Download for Windows</a>`));
    assert.ok(a.text.includes(`<a class="txt" href="${ALL.linux}" rel="noopener">Linux</a>`));
    assert.ok(a.text.includes('<a class="txt" href="/docs/app">Setup guide</a>'));
    assert.ok(a.text.includes('<a class="plain cur" href="/app">App</a>'));
    assert.ok(a.text.includes('<canvas id="gl">'));
    const g = await h.get('/docs/app');
    assert.equal(g.status, 200);
    for (const s of appGuide(ALL).sections) assert.ok(g.text.includes(`<h2>${s.h}</h2>`), s.h);
    assert.ok(g.text.includes(`href="${ALL.windows}"`) && g.text.includes(`href="${ALL.linux}"`) && g.text.includes(`href="${ALL.extension}"`));
    assert.ok(g.text.includes(`href="${GUIDES[0].path}"`), 'next guide is linked');
    const idx = await h.get('/docs');
    assert.ok(idx.text.includes('href="/docs/app"'));
    for (const p of ['/app.html', '/docs/app.html']) {
      const r = await fetch(h.base + p, { redirect: 'manual' });
      assert.equal(r.status, 301, p);
    }
  } finally { await h.close(); }
});

test('only what is published is offered', async () => {
  const win = await startApp({ releases: rel({ windows: ALL.windows }) });
  const lin = await startApp({ releases: rel({ linux: ALL.linux }) });
  try {
    const a = (await win.get('/app')).text;
    assert.ok(a.includes('Download for Windows') && !a.includes('Linux<') && !a.includes('AppImage'));
    const g = (await win.get('/docs/app')).text;
    assert.ok(!g.includes('<h3 data-k="2">Linux</h3>') && !g.includes('Tangent for Chrome</h2>') && !g.includes('AppImage'));
    const b = (await lin.get('/app')).text;
    assert.ok(b.includes(`<a class="btn" href="${ALL.linux}" rel="noopener">Download for Linux</a>`) && !b.includes('Windows'));
    const gl = (await lin.get('/docs/app')).text;
    assert.ok(gl.includes('chmod +x Tangent.AppImage') && !gl.includes('Run anyway'));
  } finally { await win.close(); await lin.close(); }
});

test('a download address that is not a release file of a GitHub repo is never rendered', async () => {
  const bad = ['https://evil.example/Tangent-Setup.exe', 'javascript:alert(1)', 'https://github.com/a/b/releases/latest/download/x"><script>', 'http://github.com/a/b/releases/latest/download/x.exe'];
  for (const u of bad) {
    const h = await startApp({ releases: rel({ windows: u, app: true }) });
    try {
      assert.equal((await h.get('/app')).status, 404, u);
      assert.ok(!(await h.get('/')).text.includes('href="/app"'), u);
    } finally { await h.close(); }
  }
});

test('copy rules: no dashes used as punctuation, no banned words', () => {
  const texts = [];
  const page = appPage(ALL);
  const guide = appGuide(ALL);
  texts.push(page.hero, page.title, ...Object.values(page.sub), ...Object.values(page.say).flatMap((s) => s.d.map((d) => d[0])), ...page.actions.map((a) => a[0]));
  texts.push(guide.h1, guide.lede, guide.blurb);
  for (const s of guide.sections) {
    texts.push(s.h);
    for (const b of s.blocks) { if (b[0] === 'p' || b[0] === 'h3') texts.push(b[1]); if (b[0] === 'list') texts.push(...b[1]); }
  }
  for (const t of texts) {
    const plain = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`[^`]+`/g, '');
    assert.ok(!/[–—]| - /.test(plain), `dash in: ${t}`);
    assert.ok(!/\b(server|indexer|daemon|coming soon|soon|TBA|loading|beta|not tested|unaudited)\b/i.test(plain), `banned word in: ${t}`);
  }
});
