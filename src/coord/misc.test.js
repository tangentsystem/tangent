import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost } from './net.js';
import { createRateLimiter } from './ratelimit.js';
import { createMemoryLogger, redact } from './log.js';
import { loadConfig } from '../config.js';

test('net: private, local and malformed hosts are refused; public ones pass', () => {
  for (const h of ['127.0.0.1', '127.1', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.100.100.100',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'localhost', 'LOCALHOST', 'foo.localhost', 'nas.local', 'db.internal', 'router.lan', 'singlelabel', '', 'bad_host.example.org', 'x..y', '203.0.113.9']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', 'relay.example.org', 'node-1.example.net', '2a00:1450:4001::1', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});

test('ratelimit: fixed window per key, resets after the window', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.take('a').ok, true);
  assert.equal(rl.take('a').ok, true);
  assert.equal(rl.take('a').ok, false);
  assert.equal(rl.take('b').ok, true);
  t = 1001;
  assert.equal(rl.take('a').ok, true);
  const big = createRateLimiter({ max: 1, windowMs: 1000, maxKeys: 10, now: () => t });
  for (let i = 0; i < 50; i++) big.take('k' + i);
  assert.ok(big.size() <= 11);
});

test('log: structured lines with secrets redacted', () => {
  const config = loadConfig({ MONGO_URI: 'mongodb+srv://u:TopSecretPw@c.example.net/db', HELIUS_API_KEY: 'heliusKEY12345' });
  const log = createMemoryLogger(config);
  log.info('x', { uri: config.mongoUri, rpc: config.solanaRpcUrl, n: 5n, err: new Error('failed at https://a.b/?api-key=OtherKey99') });
  log.line(`connecting to mongodb://someone:pw@elsewhere/x with heliusKEY12345`);
  const text = log.lines.join('\n');
  for (const s of ['TopSecretPw', 'heliusKEY12345', 'OtherKey99', 'someone:pw']) assert.ok(!text.includes(s), s);
  const j = JSON.parse(log.lines[0]);
  assert.equal(j.level, 'info');
  assert.equal(j.event, 'x');
  assert.equal(j.n, '5');
  assert.equal(redact('a\nb'), 'a b');
});
