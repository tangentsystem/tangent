// The self test's real checks, run here:
//   - stage 1 in-process parts for real: private internet over 3 paid relay hops, off grid mesh
//     and frame codec, key store insert only, storage transactions, prefix, Solana RPC (a LiteSVM
//     chain behind a real JSON-RPC endpoint), Tor probe, process driver machine
//   - stage 2 off grid group for real on LiteSVM: nonce account, durable payment through
//     O -> C1 -> C2 -> gateway, receipt, tip claim checked through the RPC and split
//   - Privacy Rings, price sources and token programs are fakes here (no outbound network)
//   - money rules: only the service's own wallets ever receive anything
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import { Connection, Keypair, SystemProgram, Transaction, PublicKey } from '@solana/web3.js';
import { createMemoryStore } from '../storage/index.js';
import { ensureKeys } from '../keys.js';
import { createMemoryLogger } from '../coord/log.js';
import { loadConfig } from '../config.js';
import { createRealWorld, fundingPlan, tipLamportsFor, buildVersion, AMOUNTS, PUMPFUN_FIXTURES, RAYDIUM_FIXTURES } from './world.js';
import { createSelfTest } from './runner.js';
import { createMoneyGuard, MoneyRuleError } from './guard.js';
import { STATUS } from './report.js';
import { startSvmRpc } from '../../test/e2e/support/svm-rpc.js';

function fakeRingsOps(wallet) {
  const calls = [];
  let registered = false;
  let priv = 0n;
  return {
    calls,
    isRegistered: async () => registered,
    ensureReady: async () => { calls.push('ensureReady'); registered = true; return { status: 'ready', signature: '5'.repeat(87) }; },
    privateBalance: async () => priv,
    depositToSelf: async ({ amount }) => { calls.push(['deposit', String(amount)]); priv += BigInt(amount); return { signature: '4'.repeat(87), privateBalance: priv }; },
    withdraw: async ({ to, amount }) => { calls.push(['withdraw', to, String(amount)]); assert.equal(to, wallet()); priv -= BigInt(amount); return { signature: '3'.repeat(87) }; },
  };
}

const fakes = (getWallet) => {
  const ops = fakeRingsOps(getWallet);
  return {
    ops,
    deps: {
      ringsOps: async () => ops,
      fromGecko: async () => 150.25,
      fromPyth: async () => 150.3,
      createToken: async ({ ca }) => {
        const pumpFx = Object.values(PUMPFUN_FIXTURES).find((f) => f.mint === ca);
        const rayFx = Object.values(RAYDIUM_FIXTURES).find((f) => f.mint === ca);
        const d = pumpFx
          ? { available: true, platform: 'pumpfun', stage: pumpFx === PUMPFUN_FIXTURES.curve ? 'curve' : 'graduated', pool: pumpFx.pool, symbol: 'FIX' }
          : rayFx
            ? { available: true, platform: 'raydium', stage: rayFx === RAYDIUM_FIXTURES.curve ? 'curve' : 'graduated', pool: rayFx.pool, symbol: 'FIX' }
            : { available: true, platform: 'meteora', stage: 'graduated', symbol: 'FIX' };
        return { detect: async () => d, stats: async () => ({ priceUsd: 0.01 }), buyUrl: () => 'https://jup.ag/tokens/x' };
      },
    },
  };
};

test('funding plan and tip arithmetic', () => {
  assert.equal(tipLamportsFor(0n, 890_880n), 890_880n, 'an empty tip account gets its rent exempt minimum');
  assert.equal(tipLamportsFor(890_880n, 890_880n), 10_000n);
  assert.equal(tipLamportsFor(885_000n, 890_880n), 10_000n);
  // mainnet rent as read live on 25 November 2026: rent(0) 650,240, rent(80) 1,056,640, rent(100) 1,158,240
  const p = fundingPlan({ rentEmpty: 650_240n, rentNonce: 1_056_640n, nonceExists: false, ringsRegistered: false, ringsRegistration: 1_158_240n + 10_000n, tipBalance: 0n });
  const sub = 650_240n + 1_168_240n + 1_000_000n + 1_056_640n + 650_240n + 130_000n;
  assert.equal(p.needLamports, sub + (sub * 2000n + 9999n) / 10000n);
  assert.equal(p.needLamports, 5_586_432n); // about 0.0056 SOL on a fresh database with an empty tip account
  const later = fundingPlan({ rentEmpty: 650_240n, rentNonce: 1_056_640n, nonceExists: true, ringsRegistered: true, ringsRegistration: 0n, tipBalance: 700_000n });
  assert.equal(later.needLamports, ((650_240n + 1_000_000n + 10_000n + 130_000n) * 12000n + 9999n) / 10000n);
  for (const b of p.breakdown) assert.ok(b.what && b.source && typeof b.lamports === 'bigint');
  assert.equal(buildVersion({ version: '0.1.0' }, { RAILWAY_GIT_COMMIT_SHA: 'ABCDEF1234567890' }), '0.1.0+abcdef123456');
  assert.equal(buildVersion({ version: '0.1.0' }, {}), '0.1.0');
});

test('money guard: only own wallets receive; other programs and foreign transfers are refused', () => {
  const me = Keypair.generate();
  const tip = Keypair.generate().publicKey;
  const stranger = Keypair.generate().publicKey;
  const g = createMoneyGuard([me.publicKey.toBase58(), tip.toBase58()]);
  const tx = (ix) => { const t = new Transaction().add(ix); t.recentBlockhash = Keypair.generate().publicKey.toBase58(); t.feePayer = me.publicKey; t.sign(me); return t.serialize(); };
  assert.ok(g.assertTx(tx(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: tip, lamports: 5 }))));
  assert.throws(() => g.assertTx(tx(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: stranger, lamports: 5 }))), MoneyRuleError);
  assert.throws(() => g.assertOwn(stranger.toBase58()), MoneyRuleError);
  assert.throws(() => g.assertTx(tx({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('x') })), MoneyRuleError);
  assert.throws(() => g.assertTx(tx(SystemProgram.assign({ accountPubkey: me.publicKey, programId: stranger }))), MoneyRuleError);
});

test('stage 1 for real in process, then stage 2 off grid for real on LiteSVM; money only moves between own wallets', { timeout: 240_000 }, async (t) => {
  const svm = new LiteSVM();
  const rpc = await startSvmRpc(svm);
  t.after(() => rpc.close());
  const connection = new Connection(rpc.url, 'confirmed');
  const store = await createMemoryStore();
  const keys = await ensureKeys({ store });
  const config = loadConfig({});
  const log = createMemoryLogger(config);
  let walletAddress = null;
  const f = fakes(() => walletAddress);
  const world = await createRealWorld({
    config, store, keys, connection, log,
    deps: { ...f.deps, afterNonceCreate: async () => { svm.expireBlockhash(); } },
  });
  walletAddress = world.wallet.address;
  // the key is in the store, insert only, with its backup row
  const row = await store.collection('keys').get('selftest');
  assert.equal(row.publicKey, world.wallet.address);
  assert.ok(await store.collection('keys_backup').get(`selftest:${row.publicKey}`));

  // ---- stage 1 checks one by one (MongoDB itself is not here: memory store stands in)
  const results = {};
  for (const c of world.freeChecks) results[c.id] = await c.run();
  assert.equal(results['storage.mongo'].status, STATUS.FAIL, 'memory storage is reported, not hidden');
  for (const id of ['storage.transactions', 'storage.prefix', 'keys.insert_only', 'solana.rpc', 'rings.api', 'network.private_internet', 'offgrid.mesh']) {
    assert.equal(results[id].status, STATUS.PASS, `${id}: ${results[id].reason || ''}`);
  }
  assert.equal(results['network.private_internet'].data.hops.length, 3);
  for (const h of results['network.private_internet'].data.hops) assert.ok(BigInt(h.earnedLamports) > 0n);
  assert.equal(results['tor.control'].status, STATUS.NOT_TESTABLE, 'no Tor here, said plainly');
  assert.equal(results['compute.sealed_docker'].status, STATUS.NOT_TESTABLE);
  assert.equal(results['offgrid.radio'].status, STATUS.NOT_TESTABLE);
  assert.equal(results['relay.separate_machines'].status, STATUS.NOT_TESTABLE);
  assert.equal(results['token.ca'].status, STATUS.SKIPPED);
  assert.equal(results['token.pumpfun_fixture'].status, STATUS.PASS, results['token.pumpfun_fixture'].reason);
  assert.equal(results['token.raydium_fixture'].status, STATUS.PASS, results['token.raydium_fixture'].reason);
  assert.ok([STATUS.PASS, STATUS.FAIL].includes(results['compute.process_driver'].status));
  if (results['compute.process_driver'].status === STATUS.PASS) assert.match(results['compute.process_driver'].detail, /NOT sealed/);

  // ---- the runner end to end (storage.mongo replaced by a stand in, as said above)
  const checks = world.freeChecks.map((c) => (c.id === 'storage.mongo' ? { ...c, run: async () => ({ status: 'PASS', detail: 'memory store stands in for MongoDB in this test' }) } : c));
  const st = createSelfTest({ config, store, log, build: 'test-build', freeChecks: checks, funded: world.funded, timing: { pollMs: 50, stage2RetryMs: 0 } });
  let r = await st.tick();
  assert.equal(st.state, 'waiting_for_funds');
  assert.equal(st.clear(), false);
  assert.equal(rpc.calls.sendTransaction || 0, 0, 'nothing sent before funding');
  const need = BigInt(r.funding.needLamports);
  assert.ok(need > 5_000_000n && need < 20_000_000n, `need ${need}`);

  // the owner funds the self test wallet from his own wallet
  const owner = Keypair.generate();
  svm.airdrop(owner.publicKey.toBase58(), 1_000_000_000n);
  const fundTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: new PublicKey(world.wallet.address), lamports: Number(need) }));
  fundTx.recentBlockhash = svm.latestBlockhash(); fundTx.feePayer = owner.publicKey; fundTx.sign(owner);
  await connection.sendRawTransaction(fundTx.serialize());
  const ownerAfterFunding = svm.getBalance(owner.publicKey.toBase58());
  const tipBefore = svm.getBalance(keys.tip.address) ?? 0n;
  const sentBefore = new Set(rpc.txs.keys());

  r = await st.tick();
  assert.equal(st.state, 'passed', JSON.stringify(r.checks.filter((c) => c.status !== 'PASS'), null, 1));
  assert.equal(st.clear(), true);
  for (const id of ['offgrid.nonce_account', 'offgrid.landed', 'offgrid.receipt', 'offgrid.tip_claim', 'rings.register', 'rings.deposit', 'rings.withdraw']) {
    assert.equal(r.checks.find((c) => c.id === id).status, STATUS.PASS, id);
  }
  assert.deepEqual(f.ops.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['ensureReady', 'deposit', 'withdraw']);

  // money rules, checked on the chain itself
  assert.equal(svm.getBalance(owner.publicKey.toBase58()), ownerAfterFunding, 'nothing ever goes back to the funding wallet');
  const own = new Set([world.wallet.address, keys.tip.address, (await store.collection('keys').get('selftest_nonce')).publicKey]);
  for (const [sig, t] of rpc.txs) {
    if (sentBefore.has(sig)) continue;
    t.keys.forEach((k, i) => { if (t.post[i] > t.pre[i]) assert.ok(own.has(k), `only own accounts gain lamports (${k})`); });
  }
  const tipAfter = svm.getBalance(keys.tip.address);
  assert.equal(tipAfter - tipBefore, BigInt(r.checks.find((c) => c.id === 'offgrid.landed').data.tipLamports));
  for (const s of world.guard.sends()) assert.ok(own.has(s.to), `guard log: ${s.kind} to ${s.to}`);
  assert.ok(BigInt(r.wallet.balanceLamports) > 0n, 'leftover stays in the self test wallet and is reported');

  // a second run of the same build spends nothing
  const before = rpc.txs.size;
  const st2 = createSelfTest({ config, store, log, build: 'test-build', freeChecks: checks.filter((c) => c.id !== 'network.private_internet'), funded: world.funded });
  await st2.tick();
  assert.equal(st2.state, 'passed');
  assert.equal(rpc.txs.size, before);
});

test('Rings deposit to self is exactly once: recorded before broadcast, never paid twice', async () => {
  const { createRingsOps, selftestKv } = await import('./world.js');
  const store = await createMemoryStore();
  const kv = selftestKv(store);
  let priv = 0n;
  let statuses = {};
  let height = 100;
  const broadcasts = [];
  const client = {
    solanaRpc: {
      getSignatureStatuses: ([sig]) => ({ send: async () => ({ value: [statuses[sig] || null] }) }),
      getBlockHeight: () => ({ send: async () => BigInt(height) }),
    },
    confirmTransaction: async () => 1,
  };
  const signer = { address: 'SelfAddr' };
  const rings = {
    vaultBalance: async () => priv,
    real: { client: async () => client, keypair: () => ({ toSolanaSigner: () => signer, shieldedAddress: () => 'shielded' }) },
  };
  let n = 0;
  let failBroadcast = true;
  let currentKey = 'deposit:b1';
  const sdk = {
    buildDepositTransaction: async (a) => { assert.equal(a.recipient, 'shielded'); assert.equal(a.depositor, 'SelfAddr'); return { a }; },
    sign: async () => ({ signed: { n: ++n }, signature: `sig${n}`, lastValidBlockHeight: '150' }),
    broadcast: async (_c, signed) => {
      const rec = await kv.kvGet('selftest_deposit', currentKey);
      assert.equal(rec.status, 'submitted', 'the record is written before the broadcast');
      broadcasts.push(signed.n);
      if (failBroadcast) throw new Error('network blip');
      priv += 1_000_000n;
    },
  };
  const ops = createRingsOps({ rings, kv, sdk, solMint: 'SOL' });
  await assert.rejects(ops.depositToSelf({ amount: 1_000_000n, key: 'deposit:b1' }), /network blip/);
  // the first one may still land: no second deposit while its blockhash is alive
  failBroadcast = false;
  await assert.rejects(ops.depositToSelf({ amount: 1_000_000n, key: 'deposit:b1' }), /may still land/);
  assert.deepEqual(broadcasts, [1]);
  // it landed after all: settled without paying again
  statuses.sig1 = { err: null, confirmationStatus: 'confirmed' };
  const r = await ops.depositToSelf({ amount: 1_000_000n, key: 'deposit:b1' });
  assert.equal(r.signature, 'sig1');
  assert.deepEqual(broadcasts, [1]);
  // a dead attempt (blockhash expired, never seen on chain) is replaced by exactly one new deposit
  currentKey = 'deposit:b2';
  failBroadcast = true;
  await assert.rejects(ops.depositToSelf({ amount: 1_000_000n, key: 'deposit:b2' }), /network blip/);
  failBroadcast = false;
  statuses = {};
  height = 200;
  const r2 = await ops.depositToSelf({ amount: 1_000_000n, key: 'deposit:b2' });
  assert.equal(r2.signature, 'sig3');
  assert.deepEqual(broadcasts, [1, 2, 3]);
  assert.equal(priv, 1_000_000n, 'only the deposit that landed counts');
});

test('the self test applies only with MongoDB and a Helius key', async () => {
  const { selftestApplies, createServiceSelfTest } = await import('./index.js');
  const store = await createMemoryStore();
  assert.equal(selftestApplies(loadConfig({}), store), false);
  assert.equal(selftestApplies(loadConfig({ HELIUS_API_KEY: 'abcd1234key' }), store), false);
  assert.equal(await createServiceSelfTest({ config: loadConfig({}), store, keys: await ensureKeys({ store }), connection: null, log: createMemoryLogger() }), null);
  assert.equal(selftestApplies(loadConfig({ HELIUS_API_KEY: 'abcd1234key', MONGO_URI: 'mongodb://h/x' }), { kind: 'mongo' }), true);
});

test('token.ca and token.raydium_fixture through the real token layer, on recorded mainnet accounts of LaunchLab coins', async () => {
  const { createToken } = await import('../token/index.js');
  const { accountsOf, accountMapConnection } = await import('../token/testkit/recorded-connection.js');
  const fs = await import('node:fs');
  const accounts = new Map();
  for (const f of Object.values(RAYDIUM_FIXTURES)) {
    const fx = JSON.parse(fs.readFileSync(new URL(`../token/fixtures/mainnet/${f.mint}.json`, import.meta.url), 'utf8'));
    for (const [k, v] of accountsOf(fx.calls)) accounts.set(k, v);
  }
  const chain = accountMapConnection(accounts);
  const store = await createMemoryStore();
  const keys = await ensureKeys({ store });
  const config = loadConfig({ TOKEN_CA: RAYDIUM_FIXTURES.curve.mint });
  const world = await createRealWorld({
    config, store, keys, connection: chain, log: null,
    deps: { ringsOps: async () => ({}), createToken: async ({ ca, log }) => createToken({ connection: chain, ca, log, solUsd: { get: async () => ({ solUsd: 100, source: 'test', updatedAt: 0 }) } }) },
  });
  const run = async (id) => world.freeChecks.find((c) => c.id === id).run();
  const ca = await run('token.ca');
  assert.equal(ca.status, STATUS.PASS, ca.reason);
  assert.match(ca.detail, /^raydium curve, CPTD, market cap [0-9.]+ USD, buy link https:\/\/raydium\.io\/launchpad\/token\/\?mint=HnGHZTZBMsq91L31uuD1qqb2F6rAXUXNtixx2EEdiray$/);
  const fx = await run('token.raydium_fixture');
  assert.equal(fx.status, STATUS.PASS, fx.reason);
  assert.match(fx.detail, /CPMM coin ALNOOR graduated, pool found/);
  assert.match(fx.detail, /curve coin CPTD on its LaunchLab curve/);
});
