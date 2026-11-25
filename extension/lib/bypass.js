// Sites that skip Tangent. The person writes one per line; we validate and normalise them
// into entries Chrome's bypass list understands.

// Always present: plain names without dots, and this computer itself.
export const BASE_BYPASS = Object.freeze(['<local>', '127.0.0.1', 'localhost']);

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isHostname(h) {
  if (h.length > 253) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]); // a numeric last label is a broken IP, not a name
}

function isIPv6(h) {
  if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(':')) return false;
  try { return new URL(`http://[${h}]/`).hostname.length > 2; } catch { return false; }
}

// Parses one line. Returns { entry } or { error } or {} for a blank / comment line.
export function parseLine(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.startsWith('#')) return {};
  if (/\s/.test(s)) return { error: 'has a space in it' };

  // A pasted address like https://example.com/page becomes example.com.
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      if (!['http:', 'https:'].includes(u.protocol)) return { error: 'is not a website address' };
      s = u.host;
    } catch {
      return { error: 'is not a website address' };
    }
  } else if (s.includes('/') && !/^[0-9a-f:.]+\/\d{1,3}$/.test(s)) {
    s = s.split('/')[0];
  }

  // Address ranges: 192.168.0.0/16 or fd00::/8
  const cidr = s.match(/^([0-9a-f:.]+)\/(\d{1,3})$/);
  if (cidr) {
    const [, ip, bits] = cidr;
    const n = Number(bits);
    if (IPV4.test(ip) && n <= 32) return { entry: `${ip}/${n}` };
    if (isIPv6(ip) && n <= 128) return { entry: `${ip}/${n}` };
    return { error: 'is not a valid address range' };
  }

  let port = '';
  let host = s;
  const v6 = s.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/);
  if (v6) {
    if (!isIPv6(v6[1])) return { error: 'is not a valid address' };
    host = `[${v6[1]}]`;
    port = v6[2] ?? '';
  } else if (isIPv6(s)) {
    return { entry: `[${s}]` };
  } else {
    const m = s.match(/^([^:]+)(?::(\d+))?$/);
    if (!m) return { error: 'is not a site name' };
    host = m[1];
    port = m[2] ?? '';
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) return { error: 'has a port that does not exist' };
  host = host.replace(/\.$/, '');

  if (host.startsWith('[')) return { entry: port ? `${host}:${port}` : host };
  if (IPV4.test(host)) return { entry: port ? `${host}:${port}` : host };
  let wild = false;
  if (host.startsWith('*.')) { wild = true; host = host.slice(2); }
  else if (host.startsWith('.')) { wild = true; host = host.slice(1); }
  if (host.includes('*')) return { error: 'can only use * at the start, like *.example.com' };
  if (!isHostname(host)) return { error: 'is not a site name' };
  const name = wild ? `*.${host}` : host;
  return { entry: port ? `${name}:${port}` : name };
}

// Parses the whole text box. Returns { list, errors } where errors are
// { line, text, message } with 1 based line numbers.
export function parseBypass(text) {
  const list = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const r = parseLine(raw);
    if (r.error) errors.push({ line: i + 1, text: raw.trim(), message: r.error });
    else if (r.entry && !list.includes(r.entry)) list.push(r.entry);
  });
  if (list.length > 500) errors.push({ line: 0, text: '', message: 'is too long, keep it under 500 sites' });
  return { list, errors };
}

// The list handed to Chrome. A plain name also covers its subdomains, which is what people
// mean when they write example.com.
export function chromeBypassList(userList = []) {
  const out = [...BASE_BYPASS];
  for (const e of userList) {
    const add = (x) => { if (!out.includes(x)) out.push(x); };
    add(e);
    if (/^[a-z0-9]/.test(e) && !IPV4.test(e.split(':')[0]) && !e.includes('/') && !e.startsWith('[')) add(`*.${e}`);
  }
  return out;
}
