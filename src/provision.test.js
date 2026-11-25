import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './storage/index.js';
import { ensureKeys } from './keys.js';
import { createProvisioner, formatSol, walletList } from './provision.js';
import { createMemoryLogger } from './coord/log.js';
import { loadConfig } from './config.js';
import * as provisionModule from './provision.js';

async function setup({ ephemeral = false, env = {} } = {}) {
  const store = await createMemoryStore();
  const k = await ensureKeys({ store });
  const keys = { ...k, ephemeral };
  const config = loadConfig(env);
  const log = createMemoryLogger(config);
  return { keys, config, log };
}

test('provision: formatSol rounds the way the log lines need', () => {
  assert.equal(formatSol(50_000_000n), '0.05');
  assert.equal(formatSol(1n, { roundUp: true }), '0.0001');
  assert.equal(formatSol(1n), '0');
  assert.equal(formatSol(1_234_500_000n), '1.2345');
});

test('provision: boot block lists every wallet with purpose, need and solscan link', async () => {
  const { keys, config, log } = await setup();
  const p = createProvisioner({ config, keys, log });
  p.start();
  const text = log.lines.join('\n');
  assert.match(log.lines[0], /^WALLETS$/);
  for (const a of [keys.coordinator.id, keys.tip.address, keys.rings.address]) {
    assert.ok(text.includes(a));
    assert.ok(text.includes(`https://solscan.io/account/${a}`));
  }
  assert.match(text, /rings wallet .* needs 0\.05 SOL/);
  assert.match(text, /Balances are not checked/);
  assert.equal(p.status().watching, false);
  await p.stop();
});

test('provision: memory storage says do not fund and never polls', async () => {
  const { keys, config, log } = await setup({ ephemeral: true });
  let calls = 0;
  const p = createProvisioner({ config, keys, log, getBalance: async () => { calls++; return 0n; } });
  p.start();
  await p.tick();
  assert.equal(calls, 0);
  assert.match(log.lines.join('\n'), /NO DATABASE: .*Do not send funds/);
  await p.stop();
});

test('provision: asks for funding, then carries on by itself once funded', async () => {
  const { keys, config, log } = await setup();
  let balance = 10_000_000n;
  let t = 1_000_000;
  const funded = [];
  const p = createProvisioner({ config, keys, log, getBalance: async () => balance, onFunded: (l) => funded.push(l), now: () => t });
  await p.tick();
  // the tip account needs only its rent exempt minimum, which this balance already covers
  const rings = (prefix) => log.lines.filter((l) => l.startsWith(prefix) && l.includes('rings wallet'));
  let lines = rings('FUND THIS WALLET');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`rings wallet  ${keys.rings.address}  needs 0\\.04 SOL more  has 0\\.01 SOL`));
  assert.ok(lines[0].includes(`https://solscan.io/account/${keys.rings.address}`));
  await p.tick(); // same balance, inside 5 minutes: no repeat
  assert.equal(rings('FUND THIS WALLET').length, 1);
  t += 6 * 60 * 1000;
  await p.tick();
  assert.equal(rings('FUND THIS WALLET').length, 2);
  balance = 60_000_000n;
  await p.tick();
  assert.deepEqual(funded, ['tip', 'rings']);
  assert.equal(rings('FUNDED').length, 1);
  assert.equal(p.status().wallets.find((w) => w.label === 'rings').funded, true);
  await p.tick();
  assert.deepEqual(funded, ['tip', 'rings']);
  balance = 1_000_000n; // drops under a quarter
  await p.tick();
  assert.equal(rings('LOW BALANCE').length, 1);
  await p.tick();
  assert.equal(rings('LOW BALANCE').length, 1);
});

test('provision: an unreadable balance is logged without secrets and retried', async () => {
  const { keys, config, log } = await setup({ env: { HELIUS_API_KEY: 'abcd1234-secret-key' } });
  const p = createProvisioner({ config, keys, log, getBalance: async () => { throw new Error(`fetch failed ${config.solanaRpcUrl}`); } });
  await p.tick();
  const text = log.lines.join('\n');
  assert.match(text, /provision.balance_unreadable/);
  assert.ok(!text.includes('abcd1234-secret-key'));
  assert.equal(p.status().wallets.find((w) => w.label === 'rings').balanceLamports, null);
});

test('provision: holds no signer and exports nothing that sends funds', async () => {
  const exported = Object.keys(provisionModule).sort();
  assert.deepEqual(exported, ['createProvisioner', 'formatSol', 'walletList']);
  const { keys, config, log } = await setup();
  const p = createProvisioner({ config, keys, log });
  assert.deepEqual(Object.keys(p).sort(), ['start', 'status', 'stop', 'tick', 'wallets']);
  const src = await (await import('node:fs/promises')).readFile(new URL('./provision.js', import.meta.url), 'utf8');
  assert.ok(!/sendTransaction|sendRawTransaction|SystemProgram|transfer\(/.test(src));
  assert.equal(walletList({ keys, config }).length, 3);
});
