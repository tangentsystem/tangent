// Real browser: another extension holds the connection setting. Tangent must say so plainly
// and must not try to take it over.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startMockApp } from './mock-app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '..');
const OTHER = resolve(here, 'fixtures', 'other-proxy');
const { chromium } = createRequire(pathToFileURL(resolve(EXT, '..', 'package.json')))('playwright-core');
const SHOTS = process.env.SHOTS || '';

let ctx, app;
after(async () => { await ctx?.close(); await app?.close(); });

test('another extension in charge: the popup says so and offers the extensions page', async (t) => {
  app = await startMockApp({ approve: 'auto', socksPort: 0 });
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tangent-chrome-')), {
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    deviceScaleFactor: 2,
    viewport: { width: 360, height: 500 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${EXT},${OTHER}`, `--load-extension=${EXT},${OTHER}`],
  });
  // find Tangent's worker among the two
  let sw = null;
  for (let i = 0; i < 50 && !sw; i++) {
    for (const w of ctx.serviceWorkers()) {
      const name = await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
      if (name === 'Tangent') sw = w;
    }
    if (!sw) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(sw, 'Tangent worker found');
  const id = new URL(sw.url()).host;
  const level = await sw.evaluate(() => chrome.proxy.settings.get({}));
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  if (level.levelOfControl !== 'controlled_by_other_extensions') {
    // Chrome gives the setting to the extension installed last; if that was Tangent the
    // fixture cannot win and this test has nothing to show.
    t.skip('Tangent was installed last in this run');
    return;
  }
  await popup.getByText('Another extension is in charge').waitFor({ timeout: 10_000 });
  assert.equal(await popup.textContent('#primary'), 'Manage extensions');
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await new Promise((r) => setTimeout(r, 1500));
    await popup.screenshot({ path: join(SHOTS, '11-controlled-by-other-extension.png') });
  }
  const after = await sw.evaluate(() => chrome.proxy.settings.get({}));
  assert.equal(after.levelOfControl, 'controlled_by_other_extensions', 'we did not fight it');
});
