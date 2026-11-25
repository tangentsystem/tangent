import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, DEFAULTS, secretsOf, solscan } from './config.js';

const CA = 'So11111111111111111111111111111111111111112';

test('config: empty env boots on memory with every default and nothing switched on', () => {
  const c = loadConfig({});
  assert.equal(c.storageKind, 'memory');
  assert.equal(c.mongoUri, '');
  assert.equal(c.heliusApiKey, '');
  assert.equal(c.tokenCa, '');
  assert.equal(c.solanaRpcUrl, '');
  assert.deepEqual({ ...c.flags }, { mongo: false, helius: false, token: false, rpc: false });
  assert.equal(c.port, DEFAULTS.port);
  assert.equal(c.storePrefix, 'tangent_');
  assert.equal(c.mongoDb, 'tangent');
  assert.equal(c.livenessMs, DEFAULTS.livenessMs);
  assert.equal(c.allowPrivateHosts, false);
  assert.equal(typeof c.ringsFundingLamports, 'bigint');
  assert.equal(loadConfig(null).storageKind, 'memory');
});

test('config: each of the three values on its own', () => {
  const m = loadConfig({ MONGO_URI: 'mongodb+srv://user:pw@cluster0.example.net/db' });
  assert.equal(m.storageKind, 'mongo');
  assert.equal(m.flags.mongo, true);
  assert.equal(m.flags.helius, false);
  const h = loadConfig({ HELIUS_API_KEY: 'abcd1234-efgh-5678' });
  assert.equal(h.flags.helius, true);
  assert.equal(h.flags.rpc, true);
  assert.match(h.solanaRpcUrl, /^https:\/\/mainnet\.helius-rpc\.com\/\?api-key=/);
  const d = loadConfig({ HELIUS_API_KEY: 'abcd1234-efgh-5678', SOLANA_CLUSTER: 'devnet' });
  assert.match(d.solanaRpcUrl, /^https:\/\/devnet\.helius-rpc\.com/);
  assert.equal(solscan('x', d), 'https://solscan.io/account/x?cluster=devnet');
  const t = loadConfig({ TOKEN_CA: CA });
  assert.equal(t.tokenCa, CA);
  assert.equal(t.flags.token, true);
  assert.equal(loadConfig({ MONGO_URI: '  ' }).storageKind, 'memory');
});

test('config: optional overrides are read and checked', () => {
  const c = loadConfig({ PORT: '8080', TRUST_PROXY: 'false', ALLOW_PRIVATE_HOSTS: 'true', HEARTBEAT_INTERVAL_MS: '120000', RINGS_FUNDING_LAMPORTS: '7' });
  assert.equal(c.port, 8080);
  assert.equal(c.trustProxy, false);
  assert.equal(c.allowPrivateHosts, true);
  assert.equal(c.livenessMs, 360000); // follows 3 heartbeats when not set
  assert.equal(c.ringsFundingLamports, 7n);
});

const SECRET_URI = 'mongodb+srv://admin:SuperSecretPw99@c.example.net';
const cases = [
  ['MONGO_URI', 'postgres://SuperSecretPw99@host/db'],
  ['HELIUS_API_KEY', 'has spaces SuperSecretPw99 !!'],
  ['TOKEN_CA', 'SuperSecretPw99notAnAddress'],
  ['TOKEN_CA', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
  ['PORT', '70000'],
  ['PORT', 'abc'],
  ['TRUST_PROXY', 'maybe'],
  ['ALLOW_PRIVATE_HOSTS', 'yes'],
  ['SOLANA_CLUSTER', 'testnet'],
  ['SOLANA_RPC_URL', 'ftp://SuperSecretPw99@x'],
  ['STORE_PREFIX', 'Bad-Prefix'],
  ['MONGO_DB', 'has space'],
  ['RINGS_FUNDING_LAMPORTS', '-5'],
  ['LIVENESS_MS', '1000'],
];
for (const [name, value] of cases) {
  test(`config: malformed ${name} names the variable and does not echo the value`, () => {
    assert.throws(() => loadConfig({ [name]: value }), (err) => {
      assert.equal(err.code, 'BAD_CONFIG');
      assert.equal(err.variable, name);
      assert.ok(err.message.includes(name));
      assert.ok(!err.message.includes(value), 'echoed the value');
      assert.ok(!err.message.includes('SuperSecretPw99'));
      return true;
    });
  });
}

test('config: secretsOf lists the uri, key and rpc url', () => {
  const c = loadConfig({ MONGO_URI: SECRET_URI, HELIUS_API_KEY: 'abcd1234-efgh-5678' });
  const s = secretsOf(c);
  assert.ok(s.includes(SECRET_URI));
  assert.ok(s.includes('abcd1234-efgh-5678'));
  assert.ok(s.includes(c.solanaRpcUrl));
});
