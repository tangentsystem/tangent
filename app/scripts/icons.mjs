// Draws the app icons from the project logo (a circle with a line across its top, from the
// ICON svg in src/web/index.js): icon.png (1024), icon.ico (16 to 256) and tray icons.
// Rendered with a local Chromium through playwright-core.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP, 'assets');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
await fs.mkdir(OUT, { recursive: true });

const glyph = (stroke, w) => `<circle cx="11" cy="16" r="7" fill="none" stroke="${stroke}" stroke-width="${w}"/><path d="M3 9h21" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`;
const appSvg = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#060606"/>
  <rect x="64.5" y="64.5" width="895" height="895" rx="200" fill="none" stroke="rgba(243,242,238,.14)" stroke-width="2"/>
  <g transform="translate(512 512) scale(25.5) translate(-13.5 -16)">${glyph('#f3f2ee', 1.7)}</g>
</svg>`;
const traySvg = (px, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="1 3.5 25 25">${glyph(color, 2.4)}</svg>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(svg, px) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  return page.locator('svg').screenshot({ omitBackground: true, type: 'png' });
}

const files = {};
files['icon.png'] = await render(appSvg(1024), 1024);
files['icon-512.png'] = await render(appSvg(512), 512);
files['tray.png'] = await render(traySvg(16, '#f3f2ee'), 16);
files['tray@2x.png'] = await render(traySvg(32, '#f3f2ee'), 32);
files['trayTemplate.png'] = await render(traySvg(16, '#000000'), 16);
files['trayTemplate@2x.png'] = await render(traySvg(32, '#000000'), 32);
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = [];
for (const s of icoSizes) icoPngs.push(await render(appSvg(s), s));
await browser.close();

// ICO with PNG entries (Windows Vista and later read these)
function ico(pngs, sizes) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const s = sizes[i];
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16); dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2); dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(p.length, i * 16 + 8); dir.writeUInt32LE(offset, i * 16 + 12);
    offset += p.length;
  });
  return Buffer.concat([head, dir, ...pngs]);
}
files['icon.ico'] = ico(icoPngs, icoSizes);
for (const [name, buf] of Object.entries(files)) await fs.writeFile(path.join(OUT, name), buf);
console.log(Object.entries(files).map(([n, b]) => `${n} ${b.length}`).join('\n'));
