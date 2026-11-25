// Host checks for node descriptors. A node may only publish a public address:
// loopback, private, link local, carrier grade NAT, multicast, reserved and
// unspecified ranges are refused (unless the dev flag ALLOW_PRIVATE_HOSTS is on),
// and so are names that only resolve locally (localhost, *.local, *.internal ...).
// Hostnames are checked by name only: they are not resolved here, so a public
// name that points at a private address is not caught (see docs/coordinator.md).
import { isIP } from 'node:net';

function v4Parts(ip) {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? p : null;
}

export function isPrivateV4(ip) {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && p[2] === 100) return true;
  if (a === 203 && b === 0 && p[2] === 113) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

export function isPrivateV6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // mapped in hex form, refuse
  const first = parseInt(s.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (s.startsWith('2001:db8:') || s.startsWith('64:ff9b:') || s.startsWith('100::')) return true;
  return false;
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.intranet', '.corp', '.private', '.test', '.invalid', '.example', '.onion'];

// true when the host must not be published
export function isPrivateHost(host) {
  if (typeof host !== 'string' || host.length === 0) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  const kind = isIP(h.replace(/^\[|\]$/g, ''));
  if (kind === 4) return isPrivateV4(h);
  if (kind === 6) return isPrivateV6(h);
  if (h === 'localhost' || !h.includes('.')) return true;
  if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (/^[0-9.]+$/.test(h)) return true; // odd numeric forms like 127.1
  return !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h);
}
