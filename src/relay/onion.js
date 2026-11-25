// Publish the relay port as a Tor v3 onion service through a running Tor's control port
// (ADD_ONION). Returns { onion, privateKey? } or null when Tor is not reachable or says no.
// privateKey is returned only when Tor generated a new key; the caller must store it
// (insert only, with backup) and pass it back next time to keep the same address.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { normLog } from './log.js';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// The v3 service id (56 chars, no ".onion") of a Tor "ED25519-V3:<base64>" key. The key is Tor's
// expanded secret key: a clamped scalar (32 bytes, little endian) then the hash prefix. The address
// is base32(pubkey || checksum[0..2] || 0x03), checksum = SHA3-256(".onion checksum" || pubkey || 0x03).
export function serviceIdFromKey(privateKey) {
  const m = /^ED25519-V3:([A-Za-z0-9+/=]+)$/.exec(String(privateKey || ''));
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length !== 64) return null;
  let scalar = 0n;
  for (let i = 31; i >= 0; i--) scalar = (scalar << 8n) | BigInt(raw[i]);
  scalar %= ed25519.Point.Fn.ORDER;
  if (scalar === 0n) return null;
  const pub = ed25519.Point.BASE.multiply(scalar).toBytes();
  const version = Uint8Array.of(3);
  const check = sha3_256(Buffer.concat([Buffer.from('.onion checksum'), pub, version])).subarray(0, 2);
  return base32(Buffer.concat([pub, check, version]));
}

function controlSession(sock, timeoutMs) {
  let buf = '';
  const waiters = [];
  let lines = [];
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(line);
      // a reply ends with "NNN " (space after the code)
      if (/^\d{3} /.test(line)) {
        const w = waiters.shift();
        const reply = lines; lines = [];
        if (w) w.resolve(reply);
      }
    }
  });
  const fail = (e) => { while (waiters.length) waiters.shift().reject(e); };
  sock.on('error', fail);
  sock.on('close', () => fail(new Error('control connection closed')));
  return (cmd) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('control timeout')), timeoutMs);
    waiters.push({ resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
    sock.write(cmd + '\r\n');
  });
}

function quote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

export async function publishOnion({ torControl, localPort, virtualPort, privateKey = null, timeoutMs = 10_000, log } = {}) {
  const L = normLog(log);
  if (!torControl || !localPort) return null;
  const host = torControl.host || '127.0.0.1';
  const port = Number(torControl.port || 9051);
  let sock;
  try {
    sock = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  } catch (e) {
    L.warn('onion: tor control port not reachable', { err: e.message });
    return null;
  }
  const send = controlSession(sock, timeoutMs);
  try {
    let auth;
    if (torControl.password != null) auth = 'AUTHENTICATE ' + quote(torControl.password);
    else {
      const info = await send('PROTOCOLINFO 1');
      if (!info[info.length - 1].startsWith('250')) throw new Error('protocolinfo refused');
      const methodsLine = info.find((l) => l.includes('METHODS=')) || '';
      const methods = (methodsLine.match(/METHODS=([A-Z0-9,]+)/) || [])[1]?.split(',') || [];
      const cookieFile = (methodsLine.match(/COOKIEFILE="((?:[^"\\]|\\.)*)"/) || [])[1];
      if (methods.includes('NULL')) auth = 'AUTHENTICATE';
      else if (methods.includes('COOKIE') && cookieFile) {
        const cookie = await readFile(cookieFile.replace(/\\(.)/g, '$1'));
        auth = 'AUTHENTICATE ' + cookie.toString('hex');
      } else throw new Error('no usable auth method (set torControl.password)');
    }
    const a = await send(auth);
    if (!a[a.length - 1].startsWith('250')) throw new Error('authentication failed');
    const keyArg = privateKey ? privateKey : 'NEW:ED25519-V3';
    const vport = Number(virtualPort || localPort);
    const add = () => send(`ADD_ONION ${keyArg} Flags=Detach Port=${vport},127.0.0.1:${Number(localPort)}`);
    let r = await add();
    // A detached service outlives the control connection that made it, so after a node restart the
    // same Tor still holds our address, pointing at the old local port: Tor answers "550 Onion
    // address collision" (seen against a real Tor). Remove that old mapping of OUR key and add it
    // again for the current port. Only an address derived from our own saved key is ever removed.
    if (privateKey && /^550 .*collision/i.test(r[r.length - 1])) {
      const own = serviceIdFromKey(privateKey);
      if (own) {
        const del = await send(`DEL_ONION ${own}`);
        if (del[del.length - 1].startsWith('250')) r = await add();
      }
    }
    if (!r[r.length - 1].startsWith('250')) throw new Error('ADD_ONION refused: ' + r[r.length - 1]);
    let serviceId = null, newKey = null;
    for (const line of r) {
      const m = line.match(/^250-ServiceID=([a-z2-7]{56})$/);
      if (m) serviceId = m[1];
      const k = line.match(/^250-PrivateKey=(\S+)$/);
      if (k) newKey = k[1];
    }
    if (!serviceId) throw new Error('no ServiceID in reply');
    try { await send('QUIT'); } catch { /* ignore */ }
    const out = { onion: serviceId + '.onion' };
    if (newKey && !privateKey) out.privateKey = newKey;
    L.info('onion: published', { onion: out.onion });
    return out;
  } catch (e) {
    L.warn('onion: publish failed', { err: e.message });
    return null;
  } finally {
    sock.destroy();
  }
}
