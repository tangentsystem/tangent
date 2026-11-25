// The app bundle swaps node:crypto for core/crypto-shim.js inside src/relay/crypto.js, because
// Electron has no chacha20-poly1305. The fallback must produce the same bytes as Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { _nobleForTests, nativeChacha } from '../../core/crypto-shim.js';

test('the fallback matches Node chacha20-poly1305 byte for byte', () => {
  assert.equal(nativeChacha, true, 'plain Node has it natively');
  for (let i = 0; i < 200; i++) {
    const key = randomBytes(32), iv = randomBytes(12), pt = randomBytes(i * 7);
    const n = createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
    const ct = n.update(pt); n.final(); const tag = n.getAuthTag();
    const s = _nobleForTests(false, key, iv);
    const ct2 = s.update(pt); s.final();
    assert.deepEqual(ct2, ct);
    assert.deepEqual(s.getAuthTag(), tag);
    const d = _nobleForTests(true, key, iv); d.setAuthTag(tag);
    assert.deepEqual(d.update(ct), pt);
    const dn = createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 }); dn.setAuthTag(s.getAuthTag());
    assert.deepEqual(dn.update(ct2), pt);
    dn.final();
  }
});

test('a wrong tag is refused, as Node refuses it', () => {
  const key = randomBytes(32), iv = randomBytes(12);
  const s = _nobleForTests(false, key, iv);
  const ct = s.update(Buffer.from('cell')); s.final();
  const bad = Buffer.from(s.getAuthTag()); bad[0] ^= 1;
  const d = _nobleForTests(true, key, iv); d.setAuthTag(bad);
  assert.throws(() => d.update(ct));
});

test('the relay crypto works with the fallback in place', async () => {
  // load src/relay/crypto.js with node:crypto replaced by the shim forced into fallback mode
  const { register } = await import('node:module');
  const url = new URL('./support/force-shim-loader.mjs', import.meta.url).href;
  register(url);
  const relay = await import('../../../src/relay/crypto.js?forced-shim');
  const key = randomBytes(32);
  const { ct, tag } = relay.seal(key, 7n, Buffer.from('one cell of data'));
  assert.equal(relay.open(key, 7n, ct, tag).toString(), 'one cell of data');
  assert.equal(relay.open(key, 8n, ct, tag), null, 'a wrong counter fails');
  // and Node's own implementation reads what the fallback sealed
  const n = createDecipheriv('chacha20-poly1305', key, Buffer.concat([Buffer.alloc(4), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(7n); return b; })()]), { authTagLength: 16 });
  n.setAuthTag(tag);
  assert.equal(Buffer.concat([n.update(ct), n.final()]).toString(), 'one cell of data');
  assert.equal(globalThis.__tgShimUsed > 0, true, 'the fallback was used');
});
