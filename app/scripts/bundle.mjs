// Bundles the main process with the headless core, the repo's src/ and their npm packages into
// dist/main.mjs, so electron-builder only has to pack the app folder.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(APP, 'dist');
await fs.mkdir(DIST, { recursive: true });
// src/relay/crypto.js needs chacha20-poly1305, which Electron's node:crypto lacks (core/crypto-shim.js)
const shim = {
  name: 'relay-crypto-shim',
  setup(b) {
    b.onResolve({ filter: /^(node:)?crypto$/ }, (args) => {
      if (args.importer.endsWith(path.join('src', 'relay', 'crypto.js'))) return { path: path.join(APP, 'core', 'crypto-shim.js') };
      return null;
    });
  },
};
const r = await build({
  plugins: [shim],
  entryPoints: [path.join(APP, 'main', 'main.js')],
  outfile: path.join(DIST, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  // CommonJS packages inside an ES module bundle still need require for node builtins
  banner: { js: "import { createRequire as __tgCreateRequire } from 'node:module'; const require = __tgCreateRequire(import.meta.url);" },
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
  metafile: true,
});
await fs.copyFile(path.join(APP, 'main', 'preload.cjs'), path.join(DIST, 'preload.cjs'));
await fs.mkdir(path.join(APP, 'renderer', 'fonts'), { recursive: true });
await fs.copyFile(path.join(APP, '..', 'web', 'vendor', 'inter.woff2'), path.join(APP, 'renderer', 'fonts', 'inter.woff2'));
const size = (await fs.stat(path.join(DIST, 'main.mjs'))).size;
console.log(`dist/main.mjs ${(size / 1024 / 1024).toFixed(2)} MB, ${Object.keys(r.metafile.inputs).length} inputs`);
