// Target policy for exits (and for relay to relay extends): refuse loopback, private,
// link local (incl. cloud metadata 169.254.169.254 and fd00:ec2::254), CGNAT, multicast,
// reserved and unspecified ranges. IPv4 mapped / NAT64 IPv6 addresses are checked as
// the IPv4 address they carry.
import net from 'node:net';
import dns from 'node:dns';

const block = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) block.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 32], ['2002::', 16],
]) block.addSubnet(a, p, 'ipv6');

function embeddedV4(ip6) {
  const lower = ip6.toLowerCase();
  // ::ffff:a.b.c.d or ::ffff:xxxx:xxxx
  let m = lower.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  m = lower.match(/^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) || lower.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPrivateAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return block.check(ip, 'ipv4');
  if (fam === 6) {
    const v4 = embeddedV4(ip.replace(/%.*$/, ''));
    if (v4) return block.check(v4, 'ipv4');
    if (block.check(ip.replace(/%.*$/, ''), 'ipv6')) return true;
    return false;
  }
  return true; // not an ip: treat as unsafe
}

export function validHost(host) {
  if (typeof host !== 'string' || !host.length || host.length > 255) return false;
  if (net.isIP(host)) return true;
  return /^[a-zA-Z0-9._-]+$/.test(host) && !host.startsWith('.') && !host.includes('..');
}

export function validPort(port) { return Number.isInteger(port) && port > 0 && port < 65536; }

export function defaultResolve(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, list) => err ? reject(err) : resolve(list.map((x) => x.address)));
  });
}

// Resolve a host and return the first address the policy allows.
// Throws Error with .code 'policy' | 'resolve'.
export async function resolveTarget(host, { allowPrivate = false, resolve = defaultResolve } = {}) {
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = await resolve(host); } catch { const e = new Error('resolve failed'); e.code = 'resolve'; throw e; }
  }
  if (!addrs || !addrs.length) { const e = new Error('resolve failed'); e.code = 'resolve'; throw e; }
  const ok = allowPrivate ? addrs : addrs.filter((a) => !isPrivateAddress(a));
  if (!ok.length) { const e = new Error('target refused by policy'); e.code = 'policy'; throw e; }
  return ok[0];
}
