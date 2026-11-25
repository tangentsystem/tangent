import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createMemoryStore } from '../storage/memory.js';
import {
  ONION_LABEL, onionAddress, onionAddressFromSeed, hsSecretKeyFile, grindOnionKey,
  ensureSiteOnionKey, installHsKey, torrc, startSiteOnion,
} from './site-onion.js';
import { serviceIdFromKey } from '../relay/onion.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'site-onion-test-'));

test('address of a known key (the Tor spec example shape) and of a seed agree with the relay code', () => {
  const seed = Buffer.alloc(32, 7);
  const addr = onionAddressFromSeed(seed);
  assert.match(addr, /^[a-z2-7]{56}\.onion$/);
  assert.ok(addr.endsWith('d.onion'), 'a v3 address ends in d');
  // the same key, given to the relay code as Tor's expanded key, names the same service
  const expanded = hsSecretKeyFile(seed).subarray(32);
  assert.equal(serviceIdFromKey('ED25519-V3:' + expanded.toString('base64')) + '.onion', addr);
  assert.throws(() => onionAddress(Buffer.alloc(31)));
});

test('the key file is 96 bytes: the Tor header then the clamped expanded key', () => {
  const f = hsSecretKeyFile(Buffer.alloc(32, 9));
  assert.equal(f.length, 96);
  assert.equal(f.subarray(0, 29).toString('ascii'), '== ed25519v1-secret: type0 ==');
  assert.deepEqual([...f.subarray(29, 32)], [0, 0, 0]);
  assert.equal(f[32] & 7, 0);
  assert.equal(f[63] & 0xc0, 0x40);
});

test('grinding finds an address with the asked prefix', async () => {
  const k = await grindOnionKey({ prefix: 'ta' });
  assert.ok(k.address.startsWith('ta'));
  assert.equal(onionAddressFromSeed(k.seed), k.address);
  await assert.rejects(() => grindOnionKey({ prefix: 'TAN' }));
  await assert.rejects(() => grindOnionKey({ prefix: 'tangent1' }));
});

test('the key is made once, backed up, and the same on every later boot', async () => {
  const store = await createMemoryStore();
  const a = await ensureSiteOnionKey(store, { prefix: 't' });
  assert.equal(a.created, true);
  assert.ok(a.address.startsWith('t'));
  const b = await ensureSiteOnionKey(store, { prefix: 'zz' });
  assert.equal(b.created, false);
  assert.equal(b.address, a.address);
  assert.ok(b.seed.equals(a.seed));
  const row = await store.collection('keys').get(ONION_LABEL);
  assert.equal(row.publicKey, a.address);
  const backup = await store.collection('keys_backup').get(`${ONION_LABEL}:${a.address}`);
  assert.equal(backup.secret, row.secret);
});

test('the key on disk is never replaced by another key', () => {
  const dir = path.join(tmp(), 'hs');
  assert.equal(installHsKey(dir, Buffer.alloc(32, 1)), true);
  assert.equal(installHsKey(dir, Buffer.alloc(32, 1)), true);
  assert.equal(installHsKey(dir, Buffer.alloc(32, 2)), false);
  assert.ok(fs.readFileSync(path.join(dir, 'hs_ed25519_secret_key')).equals(hsSecretKeyFile(Buffer.alloc(32, 1))));
});

test('torrc carries the onion to the local http port and opens no proxy port', () => {
  const rc = torrc({ dataDir: '/d', hsDir: '/h', port: 8080 });
  assert.match(rc, /^HiddenServiceDir \/h$/m);
  assert.match(rc, /^HiddenServicePort 80 127\.0\.0\.1:8080$/m);
  assert.match(rc, /^SocksPort 0$/m);
});

test('the address is offered only once Tor is up, and a missing tor program is not an error', async () => {
  const store = await createMemoryStore();
  const lines = [];
  let child;
  const spawnFn = () => { child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('exit', 0, 'SIGTERM'); return child; };
  const h = await startSiteOnion({ store, port: 1234, log: null, dir: tmp(), prefix: 't', spawnFn, print: (l) => lines.push(l) });
  assert.match(h.known(), /^t[a-z2-7]{55}\.onion$/);
  assert.equal(h.address(), null);
  child.stdout.emit('data', 'Nov 25 [notice] Bootstrapped 50% (loading)\n');
  assert.equal(h.address(), null);
  child.stdout.emit('data', 'Nov 25 [notice] Bootstrapped 100% (done): Done\n');
  assert.equal(h.address(), h.known());
  assert.deepEqual(lines, [`SITE ONION  http://${h.known()}`]);
  await h.stop();
  assert.equal(h.address(), null);

  const gone = await startSiteOnion({ store, port: 1234, log: null, dir: tmp(), prefix: 't', spawnFn: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => c.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }))); return c; }, print: () => {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(gone.address(), null);
  assert.equal(gone.known(), h.known(), 'the same saved key');
  await gone.stop();
});

test('the site links its onion address and offers it to Tor Browser, only while Tor carries it', async () => {
  const { default: express } = await import('express');
  const { createWeb } = await import('../web/index.js');
  const addr = 'tan' + 'a'.repeat(52) + 'd.onion';
  let live = null;
  const app = express();
  app.use(createWeb({ token: null, onion: () => live }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(base + '/docs');
    let text = await r.text();
    assert.equal(r.headers.get('onion-location'), null);
    assert.ok(!text.includes('.onion'));
    live = addr;
    r = await fetch(base + '/docs');
    text = await r.text();
    assert.equal(r.headers.get('onion-location'), `http://${addr}/docs`);
    assert.equal(text.split(`href="http://${addr}"`).length - 1, 2, 'one link in the bar, one in the menu');
    // fetch does not let a test set the Host header, plain http does
    const http = await import('node:http');
    const viaOnion = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/docs', headers: { host: addr } }, (res) => { res.resume(); resolve(res.headers); }).on('error', reject);
    });
    assert.equal(viaOnion['onion-location'], undefined, 'a visitor already on the onion gets no redirect hint');
    live = 'not an address';
    r = await fetch(base + '/');
    assert.ok(!(await r.text()).includes('Onion'));
  } finally { server.close(); }
});
