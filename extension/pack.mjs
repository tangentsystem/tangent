// Writes tangent-chrome-extension.zip with only what the browser needs (no tests, no package.json).
// Run: node pack.mjs   (uses the zip command)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const FILES = [
  'manifest.json', 'background.js',
  'popup.html', 'popup.css', 'popup.js',
  'options.html', 'options.css', 'options.js',
  'ui.css', 'fonts/inter.woff2',
  'lib/api.js', 'lib/bypass.js', 'lib/controller.js', 'lib/format.js', 'lib/view.js',
  ...['on', 'off'].flatMap((s) => [16, 32, 48, 128].map((n) => `icons/${s}-${n}.png`)),
];

for (const f of FILES) if (!existsSync(join(root, f))) throw new Error(`missing ${f}`);
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
const out = join(root, 'tangent-chrome-extension.zip');
if (existsSync(out)) unlinkSync(out);
execFileSync('zip', ['-X', '-q', '-9', out, ...FILES], { cwd: root });
console.log(`wrote ${out} (version ${version}, ${FILES.length} files, ${statSync(out).size} bytes)`);
