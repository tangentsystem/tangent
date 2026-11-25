// The real outside world for the self test: the free checks (stage 1) and the funded groups
// (stage 2), wired to MongoDB, Solana through Helius, Privacy Rings, the token programs, the
// price sources and the in-process network. Everything that touches the outside is a dependency
// (deps) so the runner and these steps can be unit tested with fakes.
//
// Keys: the self test wallet ("selftest") and its durable nonce account ("selftest_nonce") are
// created with ensureKey (src/keys.js): random, insert only, backup row first, never rewritten.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ensureKey } from '../keys.js';
import { unb58, createIdentity, createMeter } from '../core/index.js';
import { solscan, solscanTx } from '../config.js';
import { STATUS } from './report.js';
import { createMoneyGuard } from './guard.js';

export const METEORA_FIXTURE = 'Gfcr8eAkCEvqPfTLqG6HTumNZtBzHNB9dKTwhrFpook';
// pump.fun coins verified on mainnet from the build workspace on 25 November 2026 (public RPC, read
// only, prices cross checked against Jupiter): one graduated to its canonical PumpSwap pool in
// March 2025, one still on its bonding curve (Token-2022 mint). Their real account bytes are also
// offline fixtures (src/token/fixtures/mainnet).
export const PUMPFUN_FIXTURES = Object.freeze({
  graduated: { mint: 'GMk6j2defJhS7F194toqmJNFNhAkbDXhYJo5oR3Rpump', pool: 'FDtu6W24K2iyW9Ce9NsTyVSmSGjxj2hHrTkKc2xFTxSL' },
  curve: { mint: 'CM3o3JYwVQ3gPAMjGnGWBkkPZjbd652MGhfMkbaRpump', pool: 'AbwsPbZsEM7km968oD7BNc6GR92c43PiiMdjdjdUCfbU' },
});
// Raydium LaunchLab coins verified on mainnet from the build workspace on 25 November 2026 (public
// RPC, read only, prices cross checked against DexScreener and Jupiter), both launched on Raydium's
// own LaunchLab platform: one on its bonding curve since November 2025, one graduated to its CPMM
// pool (the pool Raydium's LaunchLab API names as its migration pool). Also offline fixtures.
export const RAYDIUM_FIXTURES = Object.freeze({
  graduated: { mint: '8MohwPY3hm8SJfQGi4KuDfKTMeisGhcGiTa7yEFabray', pool: '8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX' },
  curve: { mint: 'HnGHZTZBMsq91L31uuD1qqb2F6rAXUXNtixx2EEdiray', pool: '7BzVSZxyuppehQ6P3hYN2UUukJbmi8zs5XELuyZNhTcM' },
});
export const AMOUNTS = Object.freeze({
  depositLamports: 1_000_000n, // 0.001 SOL: the pay module's smallest credit token and minimum withdrawal
  withdrawLamports: 500_000n, // half of it back to the self test wallet's public address
  minTipLamports: 10_000n, // splits into 5000 for the gateway and 2500 for each of two carriers
  signatureFeeLamports: 5_000n,
  feeSignatures: 6n, // nonce account create (2), durable payment (1), Rings registration, deposit, withdrawal (1 each)
  ringsFeeCushionLamports: 100_000n, // Rings transactions may carry a priority fee; not documented, so a cushion
  marginBps: 2_000n, // 20 % on top of everything
});
const NONCE_ACCOUNT_LENGTH = 80;

// The codes along an SDK error's cause chain, for a log line (never a message body or a key).
export function errorCodes(err) {
  const out = [];
  for (let c = err; c && out.length < 6; c = c.cause) out.push(String(c.code || c.name || 'error'));
  return out.join(' <- ');
}

const pass = (detail, data) => ({ status: STATUS.PASS, detail, ...(data ? { data } : {}) });
const fail = (reason, data) => ({ status: STATUS.FAIL, reason, ...(data ? { data } : {}) });
const notTestable = (reason) => ({ status: STATUS.NOT_TESTABLE, reason });
const skipped = (reason) => ({ status: STATUS.SKIPPED, reason });

// The build this boot runs: the package version plus Railway's commit id when Railway provides it
// (RAILWAY_GIT_COMMIT_SHA is set by Railway itself; nothing for the owner to set).
export function buildVersion(config, env = process.env) {
  const sha = String((env && env.RAILWAY_GIT_COMMIT_SHA) || '').trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? `${config.version}+${sha.slice(0, 12).toLowerCase()}` : String(config.version);
}

// Tip that lands even when the tip account is still empty (a transfer below the rent exempt
// minimum into an empty account fails on chain).
export function tipLamportsFor(tipBalance, rentExemptEmpty, min = AMOUNTS.minTipLamports) {
  const b = BigInt(tipBalance), r = BigInt(rentExemptEmpty);
  const fill = b < r ? r - b : 0n;
  return fill > min ? fill : min;
}

// The funding plan, from live minimums. -> { needLamports, breakdown: [{ what, lamports, source }] }
export function fundingPlan({ rentEmpty, rentNonce, nonceExists, ringsRegistered, ringsRegistration, tipBalance, amounts = AMOUNTS }) {
  const items = [];
  items.push({ what: 'self test wallet keeps the rent exempt minimum', lamports: BigInt(rentEmpty), source: 'getMinimumBalanceForRentExemption(0)' });
  if (!ringsRegistered) items.push({ what: 'Privacy Rings registration of the self test wallet (one time, a registry record)', lamports: BigInt(ringsRegistration), source: 'getMinimumBalanceForRentExemption(100) for the registry record + 10,000 for the fee (the SDK sets no priority fee)' });
  items.push({ what: 'Privacy Rings deposit into the self test wallet\'s own private balance', lamports: amounts.depositLamports, source: '0.001 SOL, the pay module\'s smallest token; no Rings minimum is documented' });
  if (!nonceExists) items.push({ what: 'durable nonce account rent (one time, stays in the nonce account)', lamports: BigInt(rentNonce), source: 'getMinimumBalanceForRentExemption(80)' });
  items.push({ what: 'off grid tip to the network tip account', lamports: tipLamportsFor(tipBalance, rentEmpty, amounts.minTipLamports), source: BigInt(tipBalance) < BigInt(rentEmpty) ? 'the tip account is below its rent exempt minimum, so the tip fills it' : 'smallest tip that still splits between the gateway and two carriers' });
  items.push({ what: 'network fees', lamports: amounts.signatureFeeLamports * amounts.feeSignatures + amounts.ringsFeeCushionLamports, source: `${amounts.feeSignatures} signatures x 5000 lamports + 0.0001 SOL cushion for Rings priority fees` });
  const subtotal = items.reduce((s, x) => s + x.lamports, 0n);
  const margin = (subtotal * amounts.marginBps + 9_999n) / 10_000n;
  items.push({ what: 'safety margin', lamports: margin, source: '20 % of the above' });
  return { needLamports: subtotal + margin, breakdown: items };
}

// Kv for the self test's own Rings adapter, in its own collection (never the pay module's).
export function selftestKv(store) {
  const c = store.collection('selftest_rings_kv');
  const id = (ns, key) => `${String(ns)}:${String(key)}`.replace(/[^A-Za-z0-9:_.+-]/g, '_').slice(0, 200);
  return {
    async kvGet(ns, key) { const d = await c.get(id(ns, key)); return d ? d.v : null; },
    async kvSet(ns, key, value) { await c.put(id(ns, key), { v: JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) }); },
  };
}

// ---- free checks --------------------------------------------------------------------------

export function freeChecks({ config, store, keys, connection, wallet, deps }) {
  const quietLog = { info() {}, warn() {}, error() {}, line() {} };
  return [
    {
      id: 'storage.mongo', title: 'MongoDB reachable', required: true,
      async run() {
        if (store.kind !== 'mongo') return fail(`storage is ${store.kind}, not MongoDB`);
        await store.ping();
        return pass('MongoDB answers');
      },
    },
    {
      id: 'storage.transactions', title: 'MongoDB multi document transactions', required: true,
      async run() {
        if (!store.capabilities || !store.capabilities.transactions) return fail('this MongoDB has no transactions (standalone server); run it as a replica set before real money flows');
        const c = store.collection('selftest_probe');
        const run = `run:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        try {
          await store.transaction(async (s) => {
            const t = s.collection('selftest_probe');
            await t.insert({ _id: `${run}:a`, run, n: 1 });
            await t.insert({ _id: `${run}:b`, run, n: 2 });
          });
          const both = (await c.get(`${run}:a`)) && (await c.get(`${run}:b`));
          if (!both) return fail('a committed transaction did not keep both documents');
          let threw = false;
          try {
            await store.transaction(async (s) => {
              await s.collection('selftest_probe').insert({ _id: `${run}:c`, run, n: 3 });
              throw new Error('selftest rollback');
            });
          } catch (err) { threw = /selftest rollback/.test(String(err && err.message)); }
          if (!threw) return fail('a failing transaction did not report its error');
          if (await c.get(`${run}:c`)) return fail('a failed transaction left a document behind (no rollback)');
          return pass('commit kept two documents, a failed unit rolled back');
        } finally {
          await c.deleteMany({ run }).catch(() => {});
        }
      },
    },
    {
      id: 'storage.prefix', title: 'collections prefixed tangent_ only', required: true,
      async run() {
        const names = ['nodes', 'stats', 'keys', 'keys_backup', 'selftest', 'pay_wallets'].map((n) => store.collection(n).name);
        const bad = names.filter((n) => !n.startsWith('tangent_'));
        if (!String(store.prefix || '').startsWith('tangent_') || bad.length) return fail(`collection names do not start with tangent_: ${bad.join(', ') || store.prefix}`);
        return pass(`every collection is ${store.prefix}<name>`);
      },
    },
    {
      id: 'keys.insert_only', title: 'key store refuses overwrites', required: true,
      async run() {
        // Every write other than insert on the key collections must be refused before it reaches
        // the database. The attempts carry the saved row unchanged, so even a broken guard could
        // not change a key; the check then fails.
        const keysColl = store.collection('keys');
        const backups = store.collection('keys_backup');
        const row = await keysColl.get('selftest');
        if (!row) return fail('the self test wallet key is missing');
        const backupId = `selftest:${row.publicKey}`;
        const brow = await backups.get(backupId);
        if (!brow || brow.secret !== row.secret) return fail('the self test wallet key has no matching backup row');
        const { _id, ...fields } = row;
        const attempts = [
          ['put', () => keysColl.put(_id, fields)],
          ['upsert', () => keysColl.upsert(_id, { publicKey: row.publicKey })],
          ['update', () => keysColl.update(_id, { where: { publicKey: row.publicKey }, set: { publicKey: row.publicKey } })],
          ['cas', () => keysColl.cas(_id, 'publicKey', row.publicKey, row.publicKey)],
          ['delete', () => keysColl.delete(_id, { publicKey: '__never__' })],
          ['backup put', () => backups.put(backupId, (({ _id: _x, ...b }) => b)(brow))],
          ['backup delete', () => backups.delete(backupId, { publicKey: '__never__' })],
        ];
        const allowed = [];
        for (const [what, fn] of attempts) {
          try { await fn(); allowed.push(what); } catch (err) { if (!(err && err.code === 'INSERT_ONLY')) allowed.push(`${what} (${err && err.code})`); }
        }
        const dup = await keysColl.insert({ ...row, secret: 'x'.repeat(44) });
        const after = await keysColl.get('selftest');
        if (allowed.length) return fail(`these writes were not refused: ${allowed.join(', ')}`);
        if (dup) return fail('a second insert under the same label was accepted');
        if (!after || after.secret !== row.secret) return fail('the saved key changed');
        return pass('put, upsert, update, cas and delete refused on keys and keys_backup; a duplicate insert was refused; the key is unchanged');
      },
    },
    {
      id: 'solana.rpc', title: 'Solana RPC through Helius', required: true,
      async run() {
        if (!connection) return fail('no Solana connection');
        const slot = await connection.getSlot('confirmed');
        const bh = await connection.getLatestBlockhash('confirmed');
        if (!(slot > 0) || !bh || !bh.blockhash) return fail('the RPC answered without a slot or blockhash');
        return pass(`slot ${slot}, blockhash ${bh.blockhash.slice(0, 8)}...`);
      },
    },
    {
      id: 'rings.api', title: 'Helius Privacy Rings reachable (no funds)', required: true,
      async run() {
        // The registry lookup is an on-chain read through the Solana RPC; it answers even with a
        // wrong Helius key (seen live). The indexer sync goes to Helius' Rings gateway with the key,
        // so only that part proves HELIUS_API_KEY is accepted by Privacy Rings.
        const ops = await deps.ringsOps();
        const registered = await ops.isRegistered(wallet.address);
        let priv;
        try { priv = await ops.privateBalance(); } catch (err) {
          return fail(`the Rings registry answered, but the Helius Rings indexer refused the wallet sync (${errorCodes(err)}); check HELIUS_API_KEY`);
        }
        return pass(`the Rings registry answered (self test wallet registered: ${registered ? 'yes' : 'not yet'}) and the Helius Rings indexer synced the wallet (private balance ${priv} lamports)`);
      },
    },
    {
      id: 'network.private_internet', title: 'HTTP through 3 in-process relay hops, each hop paid', required: true,
      async run() {
        const r = await deps.runRelayNetwork();
        return pass(`${r.bytes} bytes through ${r.hops.length} hops, ${r.throwawayAccounts} throwaway accounts, every hop's vouchers redeemed and credited`, r);
      },
    },
    {
      id: 'offgrid.mesh', title: 'off grid bundle, 200 byte frames, gossip over 4 in-process nodes', required: true,
      async run() {
        const r = await deps.runOffgridMesh({ tipAccount: keys.tip.address });
        return pass(`bundle in ${r.frames} frames (largest ${r.frameBytesMax} bytes) crossed ${r.nodes} nodes; a tampered bundle was refused`, r);
      },
    },
    {
      id: 'price.coingecko', title: 'SOL/USD from CoinGecko', required: false,
      async run() { const v = await deps.fromGecko(); return pass(`SOL/USD ${v}`); },
    },
    {
      id: 'price.pyth', title: 'SOL/USD from Pyth (on-chain feed account)', required: false,
      async run() { const v = await deps.fromPyth(connection); return pass(`SOL/USD ${v} from the Pyth feed account on chain`); },
    },
    {
      id: 'token.meteora_fixture', title: 'token layer reads a live Meteora coin', required: false,
      async run() {
        if (!connection) return fail('no Solana connection');
        const token = await deps.createToken({ connection, ca: METEORA_FIXTURE, log: quietLog });
        const d = await token.detect();
        if (!d.available) return fail(`not detected: ${d.reason}`);
        if (d.platform !== 'meteora') return fail(`detected as ${d.platform}, expected meteora`);
        const s = await token.stats();
        return pass(`${d.platform} ${d.stage}${d.migrating ? ' (migrating)' : ''}, ${d.symbol || 'no symbol'}, price ${s.priceUsd ?? 'n/a'} USD${s.available === false ? ` (${s.reason})` : ''}`);
      },
    },
    {
      id: 'token.pumpfun_fixture', title: 'token layer reads a live pump.fun coin', required: false,
      async run() {
        if (!connection) return fail('no Solana connection');
        const g = await (await deps.createToken({ connection, ca: PUMPFUN_FIXTURES.graduated.mint, log: quietLog })).detect();
        if (!g.available) return fail(`graduated coin not detected: ${g.reason}`);
        if (g.platform !== 'pumpfun' || g.stage !== 'graduated' || g.pool !== PUMPFUN_FIXTURES.graduated.pool) return fail(`graduated coin read as ${g.platform} ${g.stage} pool ${g.pool}, expected pumpfun graduated pool ${PUMPFUN_FIXTURES.graduated.pool}`);
        const ct = await deps.createToken({ connection, ca: PUMPFUN_FIXTURES.curve.mint, log: quietLog });
        const c = await ct.detect();
        if (!c.available) return fail(`curve coin not detected: ${c.reason}`);
        if (c.platform !== 'pumpfun') return fail(`curve coin read as ${c.platform}, expected pumpfun`);
        if (c.stage === 'curve' && c.pool !== PUMPFUN_FIXTURES.curve.pool) return fail(`curve coin read with curve ${c.pool}, expected ${PUMPFUN_FIXTURES.curve.pool}`);
        const s = await ct.stats();
        return pass(`PumpSwap coin ${g.symbol || ''} graduated, pool found; curve coin ${c.symbol || ''} ${c.stage === 'curve' ? 'on its bonding curve' : `now ${c.stage} (it left the curve after it was pinned)`}, price ${s.priceUsd ?? 'n/a'} USD${s.available === false ? ` (${s.reason})` : ''}`);
      },
    },
    {
      id: 'token.raydium_fixture', title: 'token layer reads a live Raydium LaunchLab coin', required: false,
      async run() {
        if (!connection) return fail('no Solana connection');
        const gt = await deps.createToken({ connection, ca: RAYDIUM_FIXTURES.graduated.mint, log: quietLog });
        const g = await gt.detect();
        if (!g.available) return fail(`graduated coin not detected: ${g.reason}`);
        if (g.platform !== 'raydium' || g.stage !== 'graduated' || g.pool !== RAYDIUM_FIXTURES.graduated.pool) return fail(`graduated coin read as ${g.platform} ${g.stage} pool ${g.pool}, expected raydium graduated pool ${RAYDIUM_FIXTURES.graduated.pool}`);
        const ct = await deps.createToken({ connection, ca: RAYDIUM_FIXTURES.curve.mint, log: quietLog });
        const c = await ct.detect();
        if (!c.available) return fail(`curve coin not detected: ${c.reason}`);
        if (c.platform !== 'raydium') return fail(`curve coin read as ${c.platform}, expected raydium`);
        if (c.stage === 'curve' && c.pool !== RAYDIUM_FIXTURES.curve.pool) return fail(`curve coin read with LaunchLab pool ${c.pool}, expected ${RAYDIUM_FIXTURES.curve.pool}`);
        const gs = await gt.stats();
        const s = await ct.stats();
        return pass(`CPMM coin ${g.symbol || ''} graduated, pool found, price ${gs.priceUsd ?? 'n/a'} USD${gs.available === false ? ` (${gs.reason})` : ''}; curve coin ${c.symbol || ''} ${c.stage === 'curve' ? 'on its LaunchLab curve' : `now ${c.stage} (it left the curve after it was pinned)`}, price ${s.priceUsd ?? 'n/a'} USD${s.available === false ? ` (${s.reason})` : ''}; buy link ${gt.buyUrl()}`);
      },
    },
    {
      id: 'token.ca', title: 'token layer reads TOKEN_CA', required: false,
      async run() {
        if (!config.tokenCa) return skipped('TOKEN_CA is not set yet');
        if (!connection) return fail('no Solana connection');
        const token = await deps.createToken({ connection, ca: config.tokenCa, log: quietLog });
        const d = await token.detect();
        if (!d.available) return fail(`not detected: ${d.reason}`);
        const s = await token.stats();
        return pass(`${d.platform} ${d.stage}${d.migrating ? ' (migrating)' : ''}, ${d.symbol || 'no symbol'}, market cap ${s.marketCapUsd ?? 'n/a'} USD, buy link ${token.buyUrl()}`);
      },
    },
    {
      id: 'tor.control', title: 'Tor control port', required: false,
      async run() { return deps.torProbe(); },
    },
    {
      id: 'compute.process_driver', title: 'agent computer on the process driver (NOT sealed)', required: false,
      async run() { return deps.computeProbe(); },
    },
    {
      id: 'compute.sealed_docker', title: 'sealed Docker agent computers', required: false,
      async run() { return notTestable('Railway containers cannot run Docker; agent computers are exercised with the process driver only, which is not sealed'); },
    },
    {
      id: 'offgrid.radio', title: 'off grid over real radio hardware', required: false,
      async run() { return notTestable('no radio hardware here; the serial transport is tested only over an in memory port pair'); },
    },
    {
      id: 'relay.separate_machines', title: 'relays on separate machines', required: false,
      async run() { return notTestable('every relay in the self test runs inside this one container; NAT, latency and loss between real machines are not tested'); },
    },
  ];
}

// ---- funded groups ------------------------------------------------------------------------

export function fundedGroups({ config, store, keys, connection, wallet, guard, deps, amounts = AMOUNTS }) {
  const rings = {
    id: 'rings',
    steps: [
      { id: 'rings.register', title: 'Privacy Rings registration of the self test wallet', required: true },
      { id: 'rings.deposit', title: 'real Privacy Rings deposit (public to private, same wallet)', required: true },
      { id: 'rings.withdraw', title: 'real Privacy Rings withdrawal (private back to public, same wallet)', required: true },
    ],
    // stage 2 runs once ever, so the exactly once keys do not depend on the build
    async run({ previous }) {
      const out = {};
      const ops = await deps.ringsOps();
      const ready = await ops.ensureReady();
      if (ready.status !== 'ready') {
        const why = ready.status === 'needs_funding' ? `needs ${ready.needLamports} lamports, holds ${ready.haveLamports}` : (ready.message || ready.status);
        out['rings.register'] = fail(`registration did not complete: ${why}`);
        return out;
      }
      out['rings.register'] = pass(ready.signature ? `registered, ${solscanTx(ready.signature, config)}` : 'registered');
      if (previous['rings.deposit'] && previous['rings.deposit'].status === STATUS.PASS) {
        out['rings.deposit'] = previous['rings.deposit'];
      } else {
        guard.assertOwn(wallet.address, 'Rings deposit recipient');
        const d = await ops.depositToSelf({ amount: amounts.depositLamports, key: 'deposit:once' });
        guard.record({ kind: 'rings.deposit', from: wallet.address, to: wallet.address, lamports: amounts.depositLamports.toString(), signature: d.signature });
        out['rings.deposit'] = pass(`${amounts.depositLamports} lamports into the private balance, ${solscanTx(d.signature, config)}`, { signature: d.signature, privateBalance: String(d.privateBalance) });
      }
      guard.assertOwn(wallet.address, 'Rings withdrawal recipient');
      const w = await ops.withdraw({ to: wallet.address, amount: amounts.withdrawLamports, idempotencyKey: 'selftest:once:withdraw' });
      guard.record({ kind: 'rings.withdraw', from: wallet.address, to: wallet.address, lamports: amounts.withdrawLamports.toString(), signature: w.signature });
      const left = await ops.privateBalance().catch(() => null);
      out['rings.withdraw'] = pass(`${amounts.withdrawLamports} lamports back to the public address, ${solscanTx(w.signature, config)}${left !== null ? `; private balance left ${left} lamports` : ''}`, { signature: w.signature, privateBalanceLeft: left === null ? null : String(left) });
      return out;
    },
  };

  const offgrid = {
    id: 'offgrid',
    steps: [
      { id: 'offgrid.nonce_account', title: 'durable nonce account of the self test wallet', required: true },
      { id: 'offgrid.landed', title: 'durable nonce payment carried O -> C1 -> C2 -> gateway, landed on mainnet', required: true },
      { id: 'offgrid.receipt', title: 'signed gateway receipt back at the sender', required: true },
      { id: 'offgrid.tip_claim', title: 'tip claim checked on chain and split (gateway + 2 carriers)', required: true },
    ],
    async run() {
      const out = {};
      const { buildCreateNonceAccountTx, buildDurableTx, readNonceAccount, checkReceipt } = await import('../offgrid/index.js');
      const payer = wallet.keypair();
      const nonceKp = await deps.nonceKeypair();
      const noncePub = nonceKp.publicKey;
      guard.assertOwn(noncePub.toBase58(), 'nonce account');
      let info = await connection.getAccountInfo(noncePub, 'confirmed');
      let created = null;
      if (!info) {
        const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const bytes = buildCreateNonceAccountTx({ payer, nonceAccount: nonceKp, authority: payer.publicKey, lamports: rent, recentBlockhash: blockhash });
        guard.assertTx(bytes, 'nonce account creation');
        created = await connection.sendRawTransaction(bytes, { preflightCommitment: 'confirmed' });
        await confirmSignature(connection, created, { lastValidBlockHeight });
        guard.record({ kind: 'nonce.create', from: wallet.address, to: noncePub.toBase58(), lamports: String(rent), signature: created });
        info = await deps.waitFor(() => connection.getAccountInfo(noncePub, 'confirmed'), { timeoutMs: 60_000, every: 1000, what: 'the nonce account' });
        // the stored nonce must differ from the live blockhash before it can be advanced
        await (deps.afterNonceCreate ? deps.afterNonceCreate() : new Promise((r) => setTimeout(r, 2000)));
      }
      const nonce = readNonceAccount(info.data);
      if (nonce.authority !== wallet.address) { out['offgrid.nonce_account'] = fail('the nonce account names another authority'); return out; }
      out['offgrid.nonce_account'] = pass(created ? `created, ${solscanTx(created, config)}` : `exists, ${solscan(noncePub.toBase58(), config)}`);

      const rentEmpty = await connection.getMinimumBalanceForRentExemption(0);
      const tipPub = new PublicKey(keys.tip.address);
      const tip = tipLamportsFor(await connection.getBalance(tipPub, 'confirmed'), rentEmpty, amounts.minTipLamports);
      guard.assertOwn(keys.tip.address, 'tip account');
      const txBytes = buildDurableTx({ feePayer: payer.publicKey, nonceAccount: noncePub, nonceAuthority: payer.publicKey, nonceValue: nonce.nonce, instructions: [], tip: { account: tipPub, lamports: tip }, signers: [payer] });
      guard.assertTx(txBytes, 'off grid payment');
      const r = await deps.runOffgridOnChain({ txBytes, tipAccount: keys.tip.address, connection });
      if (!r.receipt) { out['offgrid.landed'] = fail('no receipt'); return out; }
      if (r.receipt.status !== 'landed') { out['offgrid.landed'] = fail(`the gateway reported ${r.receipt.status}: ${r.receipt.reason || ''}`); return out; }
      guard.record({ kind: 'offgrid.tip', from: wallet.address, to: keys.tip.address, lamports: tip.toString(), signature: r.receipt.signature });
      out['offgrid.landed'] = pass(`slot ${r.receipt.slot}, ${solscanTx(r.receipt.signature, config)}`, { signature: r.receipt.signature, tipLamports: tip.toString() });
      const rc = checkReceipt(r.receipt, { origin: null });
      const trail = (r.receipt.trail || []).map((e) => e.node);
      if (!rc.ok) out['offgrid.receipt'] = fail(`receipt did not verify: ${rc.reason}`);
      else if (r.receipt.gateway !== r.gateway || trail.join(',') !== r.carriers.join(',')) out['offgrid.receipt'] = fail('the receipt names other carriers or another gateway');
      else out['offgrid.receipt'] = pass(`signed by the gateway, trail of ${trail.length} carriers`);
      if (!r.claim) { out['offgrid.tip_claim'] = fail(`claim refused: ${r.claimError || 'no answer'}`); return out; }
      const credits = r.claim.credits || [];
      const sum = credits.reduce((s, c) => s + BigInt(c.lamports), 0n);
      const parties = new Set(credits.map((c) => c.node));
      if (BigInt(r.claim.tipLamports) !== tip) out['offgrid.tip_claim'] = fail(`the coordinator read a tip of ${r.claim.tipLamports}, expected ${tip}`);
      else if (sum !== tip || !parties.has(r.gateway) || !r.carriers.every((c) => parties.has(c))) out['offgrid.tip_claim'] = fail('the tip split does not add up or misses a party');
      else out['offgrid.tip_claim'] = pass(`tip ${tip} lamports read on chain, split ${credits.map((c) => `${c.role} ${c.lamports}`).join(', ')}`);
      return out;
    },
  };
  return [rings, offgrid];
}

// Poll the signature status (no websocket needed). Throws on an on chain error or expiry.
export async function confirmSignature(connection, signature, { lastValidBlockHeight = null, timeoutMs = 90_000, every = 1000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = st && st.value ? st.value[0] : null;
    if (s && s.err) throw new Error(`transaction ${signature} failed on chain: ${JSON.stringify(s.err).slice(0, 120)}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s.slot;
    if (lastValidBlockHeight !== null && !s) {
      const h = await connection.getBlockHeight('confirmed').catch(() => null);
      if (h !== null && h > lastValidBlockHeight) throw new Error(`transaction ${signature} expired before it landed`);
    }
    if (Date.now() > end) throw new Error(`transaction ${signature} not confirmed in time`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---- real dependencies ---------------------------------------------------------------------

// Rings operations for the self test wallet on the real adapter (its own kv collection).
export function createRingsOps({ rings, kv, sdk, solMint }) {
  return {
    ensureReady: () => rings.ensureReady(),
    isRegistered: (address) => rings.real.isRegistered(address),
    privateBalance: () => rings.vaultBalance('SOL'),
    withdraw: ({ to, amount, idempotencyKey }) => rings.withdrawPublic({ to, asset: 'SOL', amount: String(amount), idempotencyKey }),
    // Public SOL of the wallet into its own private balance. Recorded before broadcast; a later
    // call with the same key settles the earlier one instead of paying twice.
    async depositToSelf({ amount, key }) {
      const c = await rings.real.client();
      const kp = rings.real.keypair();
      const signer = kp.toSolanaSigner();
      const before = await rings.vaultBalance('SOL');
      const rec = await kv.kvGet('selftest_deposit', key);
      if (rec && rec.status === 'confirmed') return { signature: rec.signature, privateBalance: before };
      if (rec && rec.status === 'submitted') {
        const st = await c.solanaRpc.getSignatureStatuses([rec.signature], { searchTransactionHistory: true }).send();
        const s = st && st.value ? st.value[0] : null;
        if (s && !s.err) { await kv.kvSet('selftest_deposit', key, { ...rec, status: 'confirmed' }); return { signature: rec.signature, privateBalance: before }; }
        if (!s) {
          const height = await c.solanaRpc.getBlockHeight({ commitment: 'finalized' }).send();
          if (BigInt(height) <= BigInt(rec.lastValidBlockHeight)) throw new Error('an earlier self test deposit may still land; retrying later');
        }
      }
      const unsigned = await sdk.buildDepositTransaction({ client: c, feePayer: signer.address, depositor: signer.address, recipient: kp.shieldedAddress(), asset: solMint, amount: BigInt(amount) });
      const signed = await sdk.sign(signer, unsigned);
      await kv.kvSet('selftest_deposit', key, { status: 'submitted', signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight });
      await sdk.broadcast(c, signed.signed);
      await c.confirmTransaction(signed.signature);
      await kv.kvSet('selftest_deposit', key, { status: 'confirmed', signature: signed.signature });
      // the indexer has to show it in the private balance
      const end = Date.now() + 180_000;
      let bal = before;
      while (Date.now() < end) {
        bal = await rings.vaultBalance('SOL');
        if (BigInt(bal) >= BigInt(before) + BigInt(amount)) return { signature: signed.signature, privateBalance: bal };
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error(`deposit ${signed.signature} confirmed but the private balance did not show it within 3 minutes`);
    },
  };
}

export async function torProbe({ host = '127.0.0.1', port = 9051, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let buf = '';
    const done = (r) => { s.destroy(); resolve(r); };
    const t = setTimeout(() => done(notTestable(`no Tor control port in this container (${host}:${port} did not answer); onion publishing is not testable here`)), timeoutMs);
    s.on('error', () => { clearTimeout(t); done(notTestable(`no Tor control port in this container (${host}:${port} refused); onion publishing is not testable here`)); });
    s.on('connect', () => s.write('PROTOCOLINFO 1\r\n'));
    s.on('data', (d) => {
      buf += d;
      if (/\r\n250 OK\r\n/.test(buf) || buf.startsWith('250')) { clearTimeout(t); done(pass(`Tor control port answers at ${host}:${port}; the self test does not publish an onion service`)); }
      else if (/^[45]\d\d/.test(buf)) { clearTimeout(t); done(fail('Tor control port refused PROTOCOLINFO')); }
    });
  });
}

// Agent computer on the process driver: rent, run a command, billed, stop. NOT sealed.
export async function computeProbe() {
  const express = (await import('express')).default;
  const { createCompute, createProcessDriver, createComputeClient } = await import('../compute/index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tangent-selftest-compute-'));
  const driver = createProcessDriver({ dev: true, rootDir: dir });
  const compute = createCompute({ identity: createIdentity(), driver, meter: createMeter(), onVoucher: async () => ({ ok: true }), log: () => {} });
  await compute.start();
  const app = express();
  app.use('/api/compute', compute.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const client = createComputeClient({ baseUrl: `http://127.0.0.1:${server.address().port}/api/compute/` });
    const m = await client.rent({ payer: createIdentity().id, size: 'small' });
    const r = await m.exec('echo selftest-ok');
    await new Promise((res) => setTimeout(res, 1100));
    const st = await m.status();
    await m.stop();
    if (r.exitCode !== 0 || !/selftest-ok/.test(r.stdout)) return fail(`the command did not run (exit ${r.exitCode})`);
    const ms = Number(st.usage && st.usage.milliseconds);
    if (!(ms > 0)) return fail('the machine was not billed');
    return pass(`rented, ran a command, billed ${ms} ms on the process driver, which is NOT sealed`);
  } finally {
    await compute.stop().catch(() => {});
    await new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Everything the real world needs, built once. -> { wallet, freeChecks, funded }
export async function createRealWorld({ config, store, keys, connection, log, deps: overrides = {} }) {
  const k = await ensureKey(store, 'selftest');
  const seed = unb58(k.secret);
  const walletKp = Keypair.fromSeed(seed);
  const wallet = {
    address: k.publicKey,
    link: solscan(k.publicKey, config),
    keypair: () => walletKp,
  };
  if (walletKp.publicKey.toBase58() !== wallet.address) throw new Error('selftest: the wallet key does not match its address');
  let nonceKp = null;
  const kv = selftestKv(store);
  let ringsOps = null;
  const inproc = await import('./inprocess.js');
  const deps = {
    waitFor: inproc.waitFor,
    runRelayNetwork: inproc.runRelayNetwork,
    runOffgridMesh: inproc.runOffgridMesh,
    runOffgridOnChain: inproc.runOffgridOnChain,
    async createToken(o) { const { createToken } = await import('../token/index.js'); return createToken(o); },
    async fromGecko() { const { fromGecko } = await import('../token/price.js'); return fromGecko(globalThis.fetch, 6000); },
    async fromPyth(conn) { const { fromPyth } = await import('../token/price.js'); return fromPyth(conn); },
    torProbe: () => torProbe(),
    computeProbe: () => computeProbe(),
    async nonceKeypair() {
      if (!nonceKp) { const n = await ensureKey(store, 'selftest_nonce'); nonceKp = Keypair.fromSeed(unb58(n.secret)); }
      return nonceKp;
    },
    async ringsOps() {
      if (ringsOps) return ringsOps;
      const { createRealRings, sdkDeps } = await import('../pay/rings/real.js');
      const { SOL_MINT } = await import('@heliuslabs/spr');
      const rings = createRealRings({ ...config, ringsMode: 'real', ringsSeed: Uint8Array.from(seed), ringsNetwork: config.solanaCluster === 'devnet' ? 'devnet' : 'mainnet' }, { storage: kv });
      ringsOps = createRingsOps({ rings, kv, sdk: sdkDeps, solMint: SOL_MINT });
      return ringsOps;
    },
    ...overrides,
  };
  const own = [wallet.address, keys.tip.address];
  const guard = createMoneyGuard(own);
  // the nonce account joins the own set once its key exists (created on first funded run)
  const guardWithNonce = {
    ...guard,
    assertOwn: (a, what) => (nonceKp && String(a) === nonceKp.publicKey.toBase58() ? true : guard.assertOwn(a, what)),
    assertTx(bytes, what) {
      const g = createMoneyGuard([...own, ...(nonceKp ? [nonceKp.publicKey.toBase58()] : [])]);
      return g.assertTx(bytes, what);
    },
  };

  async function plan() {
    const nk = await deps.nonceKeypair();
    const [rentEmpty, rentNonce, nonceInfo, tipBalance, registered] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(0),
      connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH),
      connection.getAccountInfo(nk.publicKey, 'confirmed'),
      connection.getBalance(new PublicKey(keys.tip.address), 'confirmed'),
      deps.ringsOps().then((o) => o.isRegistered(wallet.address)),
    ]);
    // The registry record's rent plus the fee and a margin. The wallet's own rent exempt minimum is
    // the plan's first item already, so it is not counted twice (the Rings adapter's readiness check
    // asks for record + wallet minimum + 10,000 in the balance, which the whole plan covers).
    const ringsRegistration = BigInt(await connection.getMinimumBalanceForRentExemption(100)) + 10_000n;
    return fundingPlan({ rentEmpty, rentNonce, nonceExists: Boolean(nonceInfo), ringsRegistered: registered, ringsRegistration, tipBalance });
  }

  return {
    wallet,
    guard: guardWithNonce,
    freeChecks: freeChecks({ config, store, keys, connection, wallet, deps }),
    funded: {
      wallet: { address: wallet.address, link: wallet.link },
      plan,
      balance: async () => BigInt(await connection.getBalance(walletKp.publicKey, 'confirmed')),
      groups: fundedGroups({ config, store, keys, connection, wallet, guard: guardWithNonce, deps }),
    },
  };
}
