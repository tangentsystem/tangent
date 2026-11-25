import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const APP = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
export const ELECTRON = require('electron'); // path to the Electron binary (the electron package exports it)
export const HAS_DISPLAY = Boolean(process.env.DISPLAY || process.platform !== 'linux');

export function bundle() {
  execFileSync(process.execPath, [path.join(APP, 'scripts', 'bundle.mjs')], { stdio: 'ignore' });
}

export function appEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS; // Electron refuses some Node options
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function sandboxArgs() {
  return process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];
}
