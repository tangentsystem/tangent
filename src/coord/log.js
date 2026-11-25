// Structured logs without secrets. Every line goes through redact(): the Mongo
// URI, the Helius key and the RPC URL are replaced by [hidden], and so is
// anything that looks like a connection string or an api-key query value.
//   log.info(event, fields)  -> one JSON line {t, level, event, ...fields}
//   log.warn / log.error     -> same with another level
//   log.line(text)           -> one plain text line (used for the wallet block, which people read)
import { secretsOf } from '../config.js';

export function redact(text, config = {}) {
  let s = String(text);
  for (const secret of secretsOf(config)) s = s.split(secret).join('[hidden]');
  s = s.replace(/api[-_]?key=[^&\s"']+/gi, 'api-key=[hidden]');
  s = s.replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, 'mongodb://[hidden]');
  return s.replace(/[\r\n]+/g, ' ');
}

function safe(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function createLogger({ config = {}, sink = (line) => process.stdout.write(line + '\n'), quiet = false } = {}) {
  const emit = (line) => {
    if (quiet) return;
    try { sink(redact(line, config)); } catch { /* a broken sink must never stop the service */ }
  };
  const structured = (level) => (event, fields = {}) => {
    let body;
    try {
      body = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }, (_k, v) => safe(v));
    } catch {
      body = JSON.stringify({ t: new Date().toISOString(), level, event, note: 'fields not serialisable' });
    }
    emit(body);
  };
  const log = {
    info: structured('info'),
    warn: structured('warn'),
    error: structured('error'),
    line: (text) => emit(String(text)),
  };
  return log;
}

// A logger that keeps lines in memory (tests).
export function createMemoryLogger(config = {}) {
  const lines = [];
  const log = createLogger({ config, sink: (l) => lines.push(l) });
  log.lines = lines;
  return log;
}
