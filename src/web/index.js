// The Tangent Systems site. Every page is rendered on the server: the copy,
// the navigation and the token block are in the raw HTML. The token block
// (contract address, copy button, buy button) is only rendered when TOKEN_CA is
// set and the token layer can read the coin's real symbol from the chain.
//
// Two layouts share one WebGL scene (web/tangent.js):
//   journey  /, /nodes, /agents: statements inside the scene, one stop per scroll step
//   reading  /docs and every guide: long text over the scene, the camera follows the
//            section being read (data-k on each section)

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, GUIDES, DOCS_INDEX, X_URL, REPO_URL, SITE_URL } from './pages.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortCa = (ca) => `${ca.slice(0, 4)}…${ca.slice(-4)}`;

// `code` and [text](url) inside plain copy
export function inline(text) {
  const parts = String(text).split(/(`[^`]+`)/);
  return parts.map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return `<code${part.length <= 30 ? ' class="nw"' : ''}>${esc(part.slice(1, -1))}</code>`;
    return esc(part).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
  }).join('');
}

async function tokenBlock(token) {
  try {
    if (!token) return '';
    const configured = typeof token.configured === 'function' ? token.configured() : token.configured;
    if (!configured || !token.ca) return '';
    const stats = await Promise.race([
      token.stats(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    const ca = String(token.ca);
    const symbol = stats && stats.symbol ? String(stats.symbol) : null;
    const buyUrl = stats && stats.buyUrl ? String(stats.buyUrl) : null;
    if (!symbol) return '';
    const buy = buyUrl ? `<a class="buy" href="${esc(buyUrl)}" rel="noopener">Buy $${esc(symbol)}</a>` : '';
    return `<div class="tok"><span class="sym">$${esc(symbol)}</span><a class="ca" href="https://solscan.io/token/${esc(ca)}" rel="noopener" title="${esc(ca)}">${esc(shortCa(ca))}</a>`
      + `<button class="copyca" data-ca="${esc(ca)}">Copy</button>${buy}</div>`;
  } catch {
    return '';
  }
}

const ICON = '<svg viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="16" r="7"/><path d="M3 9h21"/></svg>';

function head(title, description, pagePath) {
  const url = `${SITE_URL}${pagePath === '/' ? '' : pagePath}`;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta name="twitter:site" content="@tangentsys">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 26 26%27 fill=%27none%27 stroke=%27%23f3f2ee%27 stroke-width=%272%27%3E%3Crect width=%2726%27 height=%2726%27 fill=%27%23060606%27 stroke=%27none%27/%3E%3Ccircle cx=%2711%27 cy=%2716%27 r=%277%27/%3E%3Cpath d=%27M3 9h21%27/%3E%3C/svg%3E">
<link rel="preload" href="/vendor/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/tangent.css">
</head>`;
}

function nav(current) {
  const top = PAGES.filter((p) => p.nav).map((p) => [p.nav, p.path]).concat([[DOCS_INDEX.nav, DOCS_INDEX.path]]);
  const isCur = (href) => current === href || (href === '/docs' && current.startsWith('/docs'));
  const links = top.map(([label, href]) => `<a class="plain${isCur(href) ? ' cur' : ''}" href="${href}">${esc(label)}</a>`).join('');
  const sheet = [['Home', '/'], ...top.filter(([, h]) => h !== '/docs'), ['Docs', '/docs'], ...GUIDES.map((g) => [g.nav === 'Agents' ? 'Agents guide' : g.nav, g.path])]
    .map(([label, href]) => `<a class="${href.startsWith('/docs/') ? 'sub' : ''}${current === href ? ' cur' : ''}" href="${href}">${esc(label)}</a>`).join('');
  return `<nav>
  <a class="brand" href="/">${ICON}Tangent Systems</a>
  <div class="links">${links}<a class="plain" href="${REPO_URL}" rel="noopener">GitHub</a><a class="plain" href="${X_URL}" rel="noopener">X</a><a class="run" href="/docs/run-a-node">Run a node</a></div>
  <details class="menu"><summary><span class="o">Menu</span><span class="c">Close</span></summary><div class="sheet">${sheet}<a href="${REPO_URL}" rel="noopener">GitHub</a><a href="${X_URL}" rel="noopener">X</a></div></details>
</nav>`;
}

const pageJson = (data) => `<script type="application/json" id="page">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

function renderJourney(page, tok) {
  const data = { mode: 'journey', word: page.word, seq: page.seq, say: page.say, sub: page.sub || {}, cmd: page.cmd || {}, lab: page.lab || {} };
  const actions = (page.actions || []).map(([label, href, cls]) => `<a class="${cls}" href="${esc(href)}">${esc(label)}</a>`).join('');
  const segs = page.seq.map(() => '<i></i>').join('');
  return `${head(page.title, page.hero, page.path)}
<body class="journey">
<canvas id="gl"></canvas>
<div class="fade"></div>
${nav(page.path)}
<div class="hero" id="hero">${esc(page.hero)}<small>Scroll<i></i></small></div>
<pre id="cmd"></pre>
<div id="sub"></div>
<div class="act" id="act">${actions}</div>
<div class="prog" id="prog">${segs}</div>
<div id="labs"></div>
${tok}
<main></main>
${pageJson(data)}
<script type="module" src="/tangent.js"></script>
</body>
</html>
`;
}

function block(b) {
  const [kind, v, k] = b;
  if (kind === 'p') return `<p>${inline(v)}</p>`;
  if (kind === 'h3') return `<h3${k !== undefined ? ` data-k="${k}"` : ''}>${inline(v)}</h3>`;
  if (kind === 'list') return `<ul>${v.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`;
  if (kind === 'opts') return `<dl class="opts">${v.map(([t, d]) => `<div><dt><code>${esc(t)}</code></dt><dd>${inline(d)}</dd></div>`).join('')}</dl>`;
  if (kind === 'code') return `<div class="code"><pre><code>${esc(v)}</code></pre><button class="copy" type="button" aria-label="Copy">Copy</button></div>`;
  throw new Error(`unknown block ${kind}`);
}

function rail(current) {
  const items = [['Overview', '/docs'], ...GUIDES.map((g) => [g.nav, g.path])]
    .map(([label, href]) => `<a${href === current ? ' class="cur" aria-current="page"' : ''} href="${href}">${esc(label)}</a>`).join('');
  return `<aside class="rail solid" aria-label="Docs">${items}</aside>`;
}

function renderGuide(g, tok) {
  const i = GUIDES.indexOf(g);
  const prev = i > 0 ? GUIDES[i - 1] : { nav: 'Overview', path: '/docs' };
  const next = GUIDES[i + 1] || null;
  const toc = g.sections.map((s) => `<a href="#${s.id}">${esc(s.h)}</a>`).join('');
  const sections = g.sections.map((s) => `<section id="${s.id}" data-k="${s.k}">
<h2>${esc(s.h)}</h2>
${s.blocks.map(block).join('\n')}
</section>`).join('\n');
  const pn = `<div class="pn"><a class="prev" href="${prev.path}"><small>Previous</small>${esc(prev.nav)}</a>`
    + (next ? `<a class="next" href="${next.path}"><small>Next</small>${esc(next.nav)}</a>` : '') + '</div>';
  const data = { mode: 'read', word: 'TANGENT', lab: g.lab || {} };
  return `${head(g.title, g.lede, g.path)}
<body class="reading">
<canvas id="gl"></canvas>
<div class="scrim"></div>
${nav(g.path)}
<div class="read">
${rail(g.path)}
<div class="col">
<header class="dh" data-k="${g.k}"><div class="solid">
<a class="up" href="/docs">Docs</a>
<h1>${esc(g.h1)}</h1>
<p class="lede">${inline(g.lede)}</p>
<div class="toc">${toc}</div>
${tok}
</div></header>
<article class="doc solid">
${sections}
${pn}
</article>
</div>
</div>
<div id="labs"></div>
${pageJson(data)}
<script type="module" src="/tangent.js"></script>
</body>
</html>
`;
}

function renderDocsIndex(tok) {
  const d = DOCS_INDEX;
  const rows = GUIDES.map((g) => `<a class="row" href="${g.path}" data-k="${d.rows[g.path]}"><span class="t">${esc(g.nav)}</span><span class="b">${esc(g.blurb)}</span><span class="go" aria-hidden="true">→</span></a>`).join('\n');
  const data = { mode: 'read', index: true, word: d.word, lab: {} };
  return `${head(d.title, d.hero, d.path)}
<body class="reading index">
<canvas id="gl"></canvas>
<div class="scrim"></div>
${nav(d.path)}
<div class="ihero" data-k="0" data-s="0"><h1>${esc(d.hero)}</h1><small>Scroll<i></i></small></div>
<div class="read">
<div class="col">
<header class="dh" data-k="0.9"><div class="solid"><h2>Pick a guide</h2><p class="lede">Each one covers one thing, start to finish.</p>${tok}</div></header>
<div class="rows solid">
${rows}
</div>
</div>
</div>
<div id="labs"></div>
${pageJson(data)}
<script type="module" src="/tangent.js"></script>
</body>
</html>
`;
}

export function createWeb({ token = null } = {}) {
  const router = express.Router();
  const file = (name, type) => (_req, res) => { res.type(type); res.sendFile(path.join(WEB_DIR, name)); };
  router.get('/tangent.js', file('tangent.js', 'text/javascript'));
  router.get('/tangent.css', file('tangent.css', 'text/css'));
  router.use('/vendor', express.static(path.join(WEB_DIR, 'vendor'), { index: false, etag: false, lastModified: false, cacheControl: false }));
  const html = (fn) => async (_req, res) => { res.type('html').send(fn(await tokenBlock(token))); };
  const routes = [
    ...PAGES.map((p) => [p.path, (tok) => renderJourney(p, tok)]),
    [DOCS_INDEX.path, (tok) => renderDocsIndex(tok)],
    ...GUIDES.map((g) => [g.path, (tok) => renderGuide(g, tok)]),
  ];
  for (const [p, fn] of routes) {
    router.get(p, html(fn));
    if (p !== '/') router.get(`${p}.html`, (_req, res) => res.redirect(301, p));
  }
  router.get('/index.html', (_req, res) => res.redirect(301, '/'));
  router.get('/docs/index.html', (_req, res) => res.redirect(301, '/docs'));
  return router;
}

export const ROUTES = () => [...PAGES.map((p) => p.path), DOCS_INDEX.path, ...GUIDES.map((g) => g.path)];
