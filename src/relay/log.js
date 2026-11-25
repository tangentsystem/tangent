// Accepts a console-like object, a function(level, msg, meta) or nothing (warnings only).
export function normLog(log) {
  if (typeof log === 'function') {
    return { debug: (m, o) => log('debug', m, o), info: (m, o) => log('info', m, o), warn: (m, o) => log('warn', m, o), error: (m, o) => log('error', m, o) };
  }
  if (log && typeof log === 'object') {
    const f = (k) => (typeof log[k] === 'function' ? log[k].bind(log) : () => {});
    return { debug: f('debug'), info: f('info'), warn: f('warn'), error: f('error') };
  }
  return { debug() {}, info() {}, warn() {}, error() {} };
}
