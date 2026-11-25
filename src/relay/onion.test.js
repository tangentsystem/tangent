import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { publishOnion } from './onion.js';

const SERVICE_ID = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx'; // 56 base32 chars

// Speaks enough of the Tor control protocol (control-spec.txt) for ADD_ONION.
function fakeTor({ password = null, methods = 'HASHEDPASSWORD', cookie = null, cookieFile = null, refuseAdd = false, collide = null } = {}) {
  let held = collide; // a service id this Tor still holds from an earlier run (detached)
  const seen = [];
  const srv = net.createServer((s) => {
    let authed = false, buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        seen.push(line);
        if (line.startsWith('PROTOCOLINFO')) {
          s.write(`250-PROTOCOLINFO 1\r\n250-AUTH METHODS=${methods}${cookieFile ? ` COOKIEFILE="${cookieFile}"` : ''}\r\n250-VERSION Tor="0.4.8.0"\r\n250 OK\r\n`);
        } else if (line.startsWith('AUTHENTICATE')) {
          const arg = line.slice('AUTHENTICATE'.length).trim();
          let ok = false;
          if (methods.includes('NULL')) ok = true;
          else if (password != null) ok = arg.startsWith('"') && arg.slice(1, -1).replace(/\\(.)/g, '$1') === password;
          else if (cookie) ok = arg.toLowerCase() === cookie.toString('hex');
          if (ok) { authed = true; s.write('250 OK\r\n'); } else s.write('515 Authentication failed: Password did not match\r\n');
        } else if (line.startsWith('ADD_ONION')) {
          if (!authed) s.write('514 Authentication required.\r\n');
          else if (refuseAdd) s.write('512 Bad arguments to ADD_ONION\r\n');
          else if (held && !line.includes('NEW:')) s.write('550 Onion address collision\r\n');
          else {
            const newKey = line.includes('NEW:ED25519-V3');
            s.write(`250-ServiceID=${SERVICE_ID}\r\n${newKey ? '250-PrivateKey=ED25519-V3:' + Buffer.alloc(64, 9).toString('base64') + '\r\n' : ''}250 OK\r\n`);
          }
        } else if (line.startsWith('DEL_ONION')) {
          if (held && line === `DEL_ONION ${held}`) { held = null; s.write('250 OK\r\n'); } else s.write('552 Unknown Onion Service id\r\n');
        } else if (line === 'QUIT') { s.end('250 closing connection\r\n'); }
        else s.write('510 Unrecognized command\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, seen, close: () => new Promise((c) => srv.close(() => c())) })));
}

test('publishOnion with password auth adds a detached v3 service and returns the new key', async () => {
  const tor = await fakeTor({ password: 'pw "x"' });
  try {
    const r = await publishOnion({ torControl: { host: '127.0.0.1', port: tor.port, password: 'pw "x"' }, localPort: 9101 });
    assert.equal(r.onion, SERVICE_ID + '.onion');
    assert.match(r.privateKey, /^ED25519-V3:/);
    const add = tor.seen.find((l) => l.startsWith('ADD_ONION'));
    assert.equal(add, 'ADD_ONION NEW:ED25519-V3 Flags=Detach Port=9101,127.0.0.1:9101');
    assert.ok(tor.seen.includes('AUTHENTICATE "pw \\"x\\""'));
  } finally { await tor.close(); }
});

test('publishOnion reuses a stored key and does not hand a key back', async () => {
  const tor = await fakeTor({ password: 'p' });
  try {
    const key = 'ED25519-V3:' + Buffer.alloc(64, 3).toString('base64');
    const r = await publishOnion({ torControl: { port: tor.port, password: 'p' }, localPort: 9101, virtualPort: 443, privateKey: key });
    assert.deepEqual(r, { onion: SERVICE_ID + '.onion' });
    assert.equal(tor.seen.find((l) => l.startsWith('ADD_ONION')), `ADD_ONION ${key} Flags=Detach Port=443,127.0.0.1:9101`);
  } finally { await tor.close(); }
});

test('publishOnion uses NULL and cookie auth from PROTOCOLINFO', async () => {
  const t1 = await fakeTor({ methods: 'NULL' });
  try {
    const r = await publishOnion({ torControl: { port: t1.port }, localPort: 9200 });
    assert.equal(r.onion, SERVICE_ID + '.onion');
    assert.ok(t1.seen.includes('AUTHENTICATE'));
  } finally { await t1.close(); }

  const dir = await mkdtemp(join(tmpdir(), 'onion-test-'));
  const cookie = randomBytes(32);
  const file = join(dir, 'control_auth_cookie');
  await writeFile(file, cookie);
  const t2 = await fakeTor({ methods: 'COOKIE,SAFECOOKIE', cookie, cookieFile: file });
  try {
    const r = await publishOnion({ torControl: { port: t2.port }, localPort: 9200 });
    assert.equal(r.onion, SERVICE_ID + '.onion');
  } finally { await t2.close(); await rm(dir, { recursive: true, force: true }); }
});

test('publishOnion returns null on bad password, refusal, or no Tor', async () => {
  const tor = await fakeTor({ password: 'right' });
  try {
    assert.equal(await publishOnion({ torControl: { port: tor.port, password: 'wrong' }, localPort: 9101 }), null);
    assert.ok(!tor.seen.some((l) => l.startsWith('ADD_ONION')));
  } finally { await tor.close(); }
  const refusing = await fakeTor({ password: 'p', refuseAdd: true });
  try {
    assert.equal(await publishOnion({ torControl: { port: refusing.port, password: 'p' }, localPort: 9101 }), null);
  } finally { await refusing.close(); }
  // nothing listening
  const probe = net.createServer();
  const freePort = await new Promise((r) => probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => r(p)); }));
  assert.equal(await publishOnion({ torControl: { port: freePort, password: 'p' }, localPort: 9101, timeoutMs: 2000 }), null);
  assert.equal(await publishOnion({ torControl: null, localPort: 9101 }), null);
});

test('serviceIdFromKey derives the v3 address from an expanded ed25519 key', async () => {
  const { serviceIdFromKey } = await import('./onion.js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  // Tor's expanded key from a seed: clamp(SHA512(seed)[0..32]) || SHA512(seed)[32..64]
  const seed = Buffer.alloc(32, 7);
  const h = Buffer.from(sha512(seed));
  h[0] &= 248; h[31] &= 127; h[31] |= 64;
  const id = serviceIdFromKey('ED25519-V3:' + h.toString('base64'));
  assert.match(id, /^[a-z2-7]{55}d$/, 'v3 ids end in d (version 3)');
  const pub = ed25519.getPublicKey(seed);
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, v = 0, prefix = '';
  for (const b of pub.subarray(0, 30)) { v = (v << 8) | b; bits += 8; while (bits >= 5) { prefix += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  assert.equal(id.slice(0, 48), prefix, 'the address carries the public key of the seed');
  assert.equal(serviceIdFromKey('ED25519-V3:' + Buffer.alloc(10).toString('base64')), null);
  assert.equal(serviceIdFromKey('RSA1024:abc'), null);
});

test('publishOnion with a saved key: an address collision (our own detached service from an earlier run) is removed and added again for the new port', async () => {
  const { serviceIdFromKey } = await import('./onion.js');
  const key = 'ED25519-V3:' + Buffer.alloc(64, 3).toString('base64');
  const own = serviceIdFromKey(key);
  const tor = await fakeTor({ password: 'p', collide: own });
  try {
    const r = await publishOnion({ torControl: { port: tor.port, password: 'p' }, localPort: 9102, virtualPort: 443, privateKey: key });
    assert.deepEqual(r, { onion: SERVICE_ID + '.onion' });
    const cmds = tor.seen.filter((l) => /^(ADD|DEL)_ONION/.test(l));
    assert.deepEqual(cmds, [`ADD_ONION ${key} Flags=Detach Port=443,127.0.0.1:9102`, `DEL_ONION ${own}`, `ADD_ONION ${key} Flags=Detach Port=443,127.0.0.1:9102`]);
  } finally { await tor.close(); }
  // a collision with a service that is not derived from our key is never deleted
  const tor2 = await fakeTor({ password: 'p', collide: 'z'.repeat(56) });
  try {
    assert.equal(await publishOnion({ torControl: { port: tor2.port, password: 'p' }, localPort: 9102, privateKey: key }), null);
    assert.ok(!tor2.seen.some((l) => l === `DEL_ONION ${'z'.repeat(56)}`));
  } finally { await tor2.close(); }
});
