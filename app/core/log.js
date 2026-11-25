// JSON line log in <data>/logs/app.log. Callers never pass secrets; long values are cut.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

export function createLog({ dir = null, echo = false } = {}) {
  let file = null;
  if (dir) {
    try {
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true, mode: 0o700 });
      file = path.join(dir, 'logs', 'app.log');
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* first run */ }
    } catch { file = null; }
  }
  const clean = (v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, 300) : v);
  function log(level, event, fields = {}) {
    if (level === 'debug') return;
    let line;
    try {
      const f = {};
      for (const [k, v] of Object.entries(fields || {})) f[k] = clean(v);
      line = JSON.stringify({ t: new Date().toISOString(), level, event: String(event).slice(0, 80), ...f }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch { line = JSON.stringify({ t: new Date().toISOString(), level, event: String(event) }); }
    if (file) { try { fs.appendFileSync(file, line + '\n', { mode: 0o600 }); } catch { /* never let logging stop the app */ } }
    if (echo) process.stderr.write(line + '\n');
  }
  log.file = file;
  return log;
}
