// "Open a private window": an installed Chromium based browser, started with its own profile
// inside the app's data folder and pointed at the local private internet. DNS goes through
// the hops too (host resolver rules), and nothing system wide is changed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

const NAMES = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave', chromium: 'Chromium' };

export function browserCandidates({ platform = process.platform, env = process.env, home = env.HOME || env.USERPROFILE || '' } = {}) {
  const out = [];
  const add = (kind, p) => { if (p) out.push({ kind, name: NAMES[kind], path: p }); };
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['chrome', 'Google\\Chrome\\Application\\chrome.exe'],
      ['edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['chromium', 'Chromium\\Application\\chrome.exe'],
    ];
    for (const [kind, r] of rel) for (const root of roots) add(kind, path.win32.join(root, r));
  } else if (platform === 'darwin') {
    const apps = [
      ['chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['chromium', 'Chromium.app/Contents/MacOS/Chromium'],
    ];
    for (const [kind, a] of apps) { add(kind, path.posix.join('/Applications', a)); if (home) add(kind, path.posix.join(home, 'Applications', a)); }
  } else {
    const names = [
      ['chrome', 'google-chrome'], ['chrome', 'google-chrome-stable'],
      ['edge', 'microsoft-edge'], ['edge', 'microsoft-edge-stable'],
      ['brave', 'brave-browser'], ['brave', 'brave'],
      ['chromium', 'chromium'], ['chromium', 'chromium-browser'],
    ];
    const dirs = [...new Set([...(env.PATH || '').split(':').filter(Boolean), '/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome', '/var/lib/flatpak/exports/bin'])];
    for (const [kind, n] of names) for (const d of dirs) add(kind, path.posix.join(d, n));
    add('chrome', '/opt/google/chrome/chrome');
    add('edge', '/opt/microsoft/msedge/msedge');
    add('brave', '/opt/brave.com/brave/brave');
  }
  return out;
}

function isExecutable(p) {
  try { const st = fs.statSync(p); if (!st.isFile()) return false; if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// -> installed browsers, one per kind, in order of preference
export function findBrowsers({ exists = isExecutable, ...opts } = {}) {
  const seen = new Set();
  const out = [];
  for (const c of browserCandidates(opts)) {
    if (seen.has(c.kind) || !exists(c.path)) continue;
    seen.add(c.kind);
    out.push(c);
  }
  return out;
}

export function privateWindowArgs({ socksPort, profileDir, url = null, extraArgs = [] }) {
  if (!Number.isInteger(socksPort) || socksPort <= 0) throw new Error('the private internet is not on');
  return [
    `--user-data-dir=${profileDir}`,
    `--proxy-server=socks5://127.0.0.1:${socksPort}`,
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--new-window',
    ...extraArgs,
    ...(url ? [url] : []),
  ];
}

export function openPrivateWindow({ socksPort, dataDir, url = null, browser = null, extraArgs = [], spawn = nodeSpawn, find = findBrowsers, env = process.env }) {
  const b = browser || find()[0];
  if (!b) { const e = new Error('No Chrome, Edge, Brave or Chromium was found on this computer.'); e.code = 'NO_BROWSER'; throw e; }
  const profileDir = path.join(dataDir, 'browser-profile');
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const args = privateWindowArgs({ socksPort, profileDir, url, extraArgs });
  const childEnv = { ...env };
  for (const k of Object.keys(childEnv)) if (/^(ELECTRON_|NODE_OPTIONS$|CHROME_DEVEL_SANDBOX$)/.test(k)) delete childEnv[k];
  const child = spawn(b.path, args, { detached: true, stdio: 'ignore', env: childEnv });
  child.on?.('error', () => {});
  child.unref?.();
  return { browser: b.name, path: b.path, pid: child.pid, profileDir, args, child };
}
