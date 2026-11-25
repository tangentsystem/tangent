// Raydium LaunchLab, offline, against REAL mainnet accounts (src/token/fixtures/mainnet, captured
// 25 November 2026 with testkit/capture-mainnet.js from the public RPC, read only):
//   HnGHZTZBMsq91L31uuD1qqb2F6rAXUXNtixx2EEdiray  CPTD, on its LaunchLab curve (Raydium's own platform)
//   8MohwPY3hm8SJfQGi4KuDfKTMeisGhcGiTa7yEFabray  ALNOOR, graduated to CPMM 8BELgBQ5..., creator fee on
//   9JK2U7aEkp3tWaFNuaJowWRgNys5DVaKGxWk73VT5ray  NUMMUS, graduated to CPMM AuQtgm4t... in May 2025, no creator fee
// Where a test needs a key it can sign with, it moves a real account's creator field to a test key
// (the bytes are otherwise the real ones). The LaunchLab and CPMM programs do not run here: claims
// are checked as built, guarded and signed transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BN from 'bn.js';
import { Keypair, PublicKey, Transaction, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createTransferInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { raydium as R, PROGRAM_IDS, NATIVE_MINT } from './sdk.js';
import { createToken, detectToken, buildClaims, guardClaimInstructions, buyUrlFor, ClaimError } from './index.js';
import * as RY from './raydium.js';
import { accountsOf, accountMapConnection } from './testkit/recorded-connection.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mainnet');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const quiet = { warn() {}, info() {}, error() {} };
const fixedSol = (v) => ({ get: async () => ({ solUsd: v, source: 'test', updatedAt: 0 }) });
const rel = (a, b) => Math.abs(a / b - 1);

const CURVE = 'HnGHZTZBMsq91L31uuD1qqb2F6rAXUXNtixx2EEdiray';
const GRAD = '8MohwPY3hm8SJfQGi4KuDfKTMeisGhcGiTa7yEFabray';
const OLD = '9JK2U7aEkp3tWaFNuaJowWRgNys5DVaKGxWk73VT5ray';
const RAYDIUM_PLATFORM = '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4';
const GLOBAL_CONFIG = '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX';
const CP_CONFIG = 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2';
const fixture = (m) => load(`${m}.json`);
const world = (m) => {
  const fx = fixture(m);
  const accounts = accountsOf(fx.calls);
  return { fx, accounts, conn: accountMapConnection(accounts) };
};
const withBytes = (info, edit) => { const data = Buffer.from(info.data); edit(data); return { ...info, data }; };

test('program ids, account and instruction discriminators: SDK, IDL and Raydium docs agree', () => {
  assert.equal(PROGRAM_IDS.launchlab, 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
  assert.equal(PROGRAM_IDS.raydiumCpmm, 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
  assert.equal(RY.RAYDIUM_UI_PLATFORM, RAYDIUM_PLATFORM);
  const k = Keypair.generate().publicKey;
  const claim = R.claimCreatorFee(R.LAUNCHPAD_PROGRAM, k, k, k, k, k, k);
  assert.deepEqual(Buffer.from(claim.data), RY.DISC.claimCreatorFee);
  const collect = R.makeCollectCreatorFeeInstruction(R.CREATE_CPMM_POOL_PROGRAM, k, k, k, k, k, k, k, k, k, k, k, k);
  assert.deepEqual(Buffer.from(collect.data), RY.DISC.collectCreatorFee);
  const idl = load('launchlab-idl-excerpt.json');
  assert.equal(idl.source.program, PROGRAM_IDS.launchlab);
  const ix = idl.instructions.find((i) => i.name === 'claim_creator_fee');
  assert.deepEqual(Buffer.from(ix.discriminator), RY.DISC.claimCreatorFee);
});

test('buy URL: Raydium LaunchLab token page, both stages', () => {
  assert.equal(buyUrlFor('raydium', CURVE), `https://raydium.io/launchpad/token/?mint=${CURVE}`);
  assert.equal(buyUrlFor('raydium', null), null);
});

test('detection on real bytes: curve, graduated with creator fee, graduated before creator fees', async () => {
  const c = world(CURVE);
  const d = await detectToken({ connection: c.conn, ca: CURVE });
  assert.equal(d.ok, true);
  assert.deepEqual({ platform: d.platform, stage: d.stage, pool: d.pool, symbol: d.symbol, name: d.name, quote: d.quoteMint, creator: d.creator },
    { platform: 'raydium', stage: 'curve', pool: '7BzVSZxyuppehQ6P3hYN2UUukJbmi8zs5XELuyZNhTcM', symbol: 'CPTD', name: 'CptDrkGltch', quote: NATIVE_MINT, creator: 'DXw8aPftpz12JvEysgbQXG6sjM6tdKqP25uaF8AvpJpG' });
  assert.equal(d.state.launch.platformId, RAYDIUM_PLATFORM);

  const g = world(GRAD);
  const dg = await detectToken({ connection: g.conn, ca: GRAD });
  assert.equal(dg.stage, 'graduated');
  assert.equal(dg.pool, '8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX');
  assert.equal(dg.symbol, 'ALNOOR');
  assert.equal(dg.creator, '6BqoRgxrVqkPyM62TsRMRKYrkvaFL3ZQurZigPNB672X');
  assert.equal(dg.cpmmCreator, dg.creator, 'Raydium platform leaves platform_cp_creator unset: the launch creator is the pool creator');
  assert.equal(dg.state.cpmm.enableCreatorFee, true);
  assert.equal(dg.state.cpmm.configId, CP_CONFIG);
  assert.ok(!dg.migrating);

  const o = world(OLD);
  const dold = await detectToken({ connection: o.conn, ca: OLD });
  assert.equal(dold.pool, 'AuQtgm4tzdJSsZNGxrM1F69hxbyvMpNM95496pUuSBQg');
  assert.equal(dold.state.cpmm.enableCreatorFee, false);
  assert.equal(dold.cpmmCreator, R.LAUNCHPAD_AUTH.toBase58(), 'May 2025 migrations recorded the LaunchLab authority as pool creator');
});

test('migrating, missing pool, legacy AMM v4 and the config scan fallback', async () => {
  const statusAt = R.LaunchpadPool.offsetOf('status');
  const migrateTypeAt = R.LaunchpadPool.offsetOf('migrateType');
  const g = world(GRAD);
  const launchAddr = RY.launchPoolAddress(GRAD, NATIVE_MINT);
  const real = g.accounts.get(launchAddr);

  // status 1: target reached, waiting for the graduation crank
  g.accounts.set(launchAddr, withBytes(real, (b) => { b[statusAt] = 1; }));
  let d = await detectToken({ connection: g.conn, ca: GRAD });
  assert.deepEqual({ stage: d.stage, migrating: d.migrating, pool: d.pool }, { stage: 'graduated', migrating: true, pool: null });

  // status 2 but no CPMM pool on chain yet
  g.accounts.set(launchAddr, real);
  const pool = g.accounts.get('8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX');
  g.accounts.delete('8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX');
  d = await detectToken({ connection: g.conn, ca: GRAD });
  assert.deepEqual({ stage: d.stage, migrating: d.migrating, pool: d.pool }, { stage: 'graduated', migrating: true, pool: null });
  g.accounts.set('8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX', pool);

  // platform config unreadable: the pool is found by trying the CPMM config PDAs (index 0 is D4FPEr...)
  assert.equal(RY.cpmmConfigAddress(0), CP_CONFIG);
  const plat = g.accounts.get(RAYDIUM_PLATFORM);
  g.accounts.delete(RAYDIUM_PLATFORM);
  d = await detectToken({ connection: g.conn, ca: GRAD });
  assert.equal(d.pool, '8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX');
  g.accounts.set(RAYDIUM_PLATFORM, plat);

  // legacy AMM v4 graduation: graduated, no pool, no price, never invented
  g.accounts.set(launchAddr, withBytes(real, (b) => { b[migrateTypeAt] = 0; }));
  const tok = createToken({ connection: g.conn, ca: GRAD, log: quiet, solUsd: fixedSol(100) });
  const det = await tok.detect();
  assert.deepEqual({ stage: det.stage, pool: det.pool, migrating: det.migrating }, { stage: 'graduated', pool: null, migrating: undefined });
  const s = await tok.stats();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'no_price');

  // an account at the pool address owned by another program, or with another discriminator, is not a LaunchLab pool
  g.accounts.set(launchAddr, { ...real, owner: new PublicKey(PROGRAM_IDS.raydiumCpmm) });
  assert.equal(RY.decodeLaunchPool(g.accounts.get(launchAddr)), null);
  g.accounts.set(launchAddr, withBytes(real, (b) => { b[0] ^= 1; }));
  assert.equal(RY.decodeLaunchPool(g.accounts.get(launchAddr)), null);
});

test('curve price: BigInt maths equal the SDK Curve.getPrice on the real pool and on every curve type', async () => {
  const c = world(CURVE);
  const launchInfo = c.accounts.get('7BzVSZxyuppehQ6P3hYN2UUukJbmi8zs5XELuyZNhTcM');
  const sdkPool = R.LaunchpadPool.decode(launchInfo.data);
  const cfg = RY.decodeGlobalConfig(c.accounts.get(GLOBAL_CONFIG));
  assert.equal(cfg.curveType, 0);
  const L = RY.decodeLaunchPool(launchInfo);
  const ours = RY.launchCurvePrice({ curveType: 0, ...L });
  const sdk = R.Curve.getPrice({ poolInfo: sdkPool, curveType: 0, decimalA: 6, decimalB: 9 }).toNumber();
  assert.ok(rel(ours, sdk) < 1e-12, `${ours} vs ${sdk}`);
  // hand check: (virtualB + realB) / (virtualA - realA) * 10^(6 - 9)
  const hand = (Number(L.virtualB + L.realB) / Number(L.virtualA - L.realA)) * 1e-3;
  assert.ok(rel(ours, hand) < 1e-12);

  // fixed price and linear curves, against the SDK's own formulas
  const synth = { virtualA: new BN('793100000000000'), virtualB: new BN('30000000000'), realA: new BN('123456789000000'), realB: new BN('4567000000') };
  for (const curveType of [0, 1, 2]) {
    const s = R.Curve.getPrice({ poolInfo: synth, curveType, decimalA: 6, decimalB: 9 }).toNumber();
    const o = RY.launchCurvePrice({ curveType, virtualA: synth.virtualA, virtualB: synth.virtualB, realA: synth.realA, realB: synth.realB, decimalsA: 6, decimalsB: 9 });
    assert.ok(rel(o, s) < 1e-12, `curve ${curveType}: ${o} vs ${s}`);
  }
  assert.equal(RY.launchCurvePrice({ curveType: 9, ...L }), null);

  // the token layer's stats use the same number; circulating = supply minus what the base vault holds
  const tok = createToken({ connection: c.conn, ca: CURVE, log: quiet, solUsd: fixedSol(100) });
  const st = await tok.stats();
  assert.equal(st.available, true);
  assert.equal(st.priceSol, ours);
  assert.equal(st.priceSol, c.fx.read.priceSol);
  const vaultHeld = 999999999999200n - BigInt(st.supply.circulatingRaw);
  assert.equal(vaultHeld, 991925743680568n);
  assert.ok(Math.abs(st.marketCapUsd - ours * 100 * 999999999.9992) < 1e-6);
});

test('CPMM price: vault balances minus fee counters, the SDK formula, and independent quotes', async () => {
  for (const [mint, poolAddr] of [[GRAD, '8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX'], [OLD, 'AuQtgm4tzdJSsZNGxrM1F69hxbyvMpNM95496pUuSBQg']]) {
    const w = world(mint);
    const sdkPool = R.CpmmPoolInfoLayout.decode(w.accounts.get(poolAddr).data);
    const amt = (k) => w.accounts.get(k.toBase58()).data.readBigUInt64LE(64);
    const vA = amt(sdkPool.vaultA);
    const vB = amt(sdkPool.vaultB);
    // the SDK's getRpcPoolInfos: reserve = vault - protocol - fund - creator fees, price = B per A
    const resA = new BN(vA.toString()).sub(sdkPool.protocolFeesMintA).sub(sdkPool.fundFeesMintA).sub(sdkPool.creatorFeesMintA);
    const resB = new BN(vB.toString()).sub(sdkPool.protocolFeesMintB).sub(sdkPool.fundFeesMintB).sub(sdkPool.creatorFeesMintB);
    const baseIsA = sdkPool.mintA.toBase58() === mint;
    assert.equal(baseIsA, false, 'WSOL sorts first in both pools');
    // price of the coin (mint B here) in SOL (mint A) = resA / resB with decimals
    const sdkPrice = (Number(resA.toString()) / 10 ** sdkPool.mintDecimalA) / (Number(resB.toString()) / 10 ** sdkPool.mintDecimalB);
    const tok = createToken({ connection: w.conn, ca: mint, log: quiet, solUsd: fixedSol(100) });
    const st = await tok.stats();
    assert.equal(st.available, true);
    assert.ok(rel(st.priceSol, sdkPrice) < 1e-12, `${st.priceSol} vs ${sdkPrice}`);
    assert.equal(st.supply.circulatingRaw, st.supply.totalRaw);
  }
  // Independent quotes taken at capture time (25 Nov 2026, about 11:49 UTC). Recorded here, not fetched.
  //   DexScreener NUMMUS, same CPMM pool AuQtgm4t...: priceNative 0.00009684 SOL
  //   DexScreener ALNOOR, its top pair is another Raydium pool (6ipSysvp...): 0.0001186 SOL
  //   Jupiter price v3 (USD, divided by Jupiter's SOL 67.65253118506725): ALNOOR 0.000120322, NUMMUS 0.000097073
  const nummus = fixture(OLD).read.priceSol;
  const alnoor = fixture(GRAD).read.priceSol;
  assert.ok(rel(nummus, 0.00009684) < 0.001, 'NUMMUS within 0.1% of DexScreener on the same pool');
  assert.ok(rel(alnoor, 0.0001186) < 0.005, 'ALNOOR within 0.5% of DexScreener (different pool)');
  assert.ok(rel(nummus, 0.000097073) < 0.01 && rel(alnoor, 0.000120322) < 0.02, 'within 1% and 2% of Jupiter\'s routed price');
});

test('claims on real bytes: the curve creator fee vault, shaped as the on-chain IDL says', async () => {
  const c = world(CURVE);
  const d = await detectToken({ connection: c.conn, ca: CURVE });
  const creator = d.creator;
  const claims = await buildClaims(c.conn, d, creator);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'launchlab_creator_fee');
  assert.deepEqual(claims[0].amounts, { quote: '1189422', vault: 'BwVV4nqpCXGQYgytsUD2BVR7evCbS2Zf8Dqcy3rAFKqt' });
  const [ata, claim, close] = claims[0].instructions;
  assert.equal(ata.programId.toBase58(), PROGRAM_IDS.ata);
  assert.equal(close.programId.toBase58(), PROGRAM_IDS.token);
  assert.equal(claim.programId.toBase58(), PROGRAM_IDS.launchlab);
  const idl = load('launchlab-idl-excerpt.json').instructions.find((i) => i.name === 'claim_creator_fee');
  assert.deepEqual(claim.keys.map((k) => [k.isSigner, k.isWritable]), idl.accounts.map((a) => [Boolean(a.signer), Boolean(a.writable)]));
  const me = new PublicKey(creator);
  const recipient = getAssociatedTokenAddressSync(new PublicKey(NATIVE_MINT), me, false, TOKEN_PROGRAM_ID);
  assert.deepEqual(claim.keys.map((k) => k.pubkey.toBase58()), [
    creator,
    PublicKey.findProgramAddressSync([Buffer.from('creator_fee_vault_auth_seed')], R.LAUNCHPAD_PROGRAM)[0].toBase58(),
    PublicKey.findProgramAddressSync([me.toBuffer(), new PublicKey(NATIVE_MINT).toBuffer()], R.LAUNCHPAD_PROGRAM)[0].toBase58(),
    recipient.toBase58(), NATIVE_MINT, PROGRAM_IDS.token, PROGRAM_IDS.system, PROGRAM_IDS.ata,
  ]);
  assert.equal(claims[0].amounts.vault, claim.keys[2].pubkey.toBase58());
  assert.ok(guardClaimInstructions(claims[0].instructions, creator));
  const tx = new Transaction({ feePayer: me, recentBlockhash: '11111111111111111111111111111111' }).add(...claims[0].instructions);
  const msg = tx.compileMessage();
  assert.equal(msg.header.numRequiredSignatures, 1);
  assert.equal(msg.accountKeys[0].toBase58(), creator);
});

test('claims on real bytes: the CPMM creator fee for the recorded pool creator', async () => {
  const g = world(GRAD);
  const d = await detectToken({ connection: g.conn, ca: GRAD });
  const claims = await buildClaims(g.conn, d, d.cpmmCreator);
  assert.deepEqual(claims.map((c) => c.kind), ['cpmm_creator_fee'], 'the launch creator\'s LaunchLab vault is empty, the CPMM fee is not');
  assert.deepEqual(claims[0].amounts, { a: '7327914012', b: '0' });
  const ixs = claims[0].instructions;
  assert.deepEqual(ixs.map((i) => i.programId.toBase58()), [PROGRAM_IDS.ata, PROGRAM_IDS.ata, PROGRAM_IDS.raydiumCpmm, PROGRAM_IDS.token]);
  const col = ixs[2];
  const me = new PublicKey(d.cpmmCreator);
  const p = d.state.cpmm;
  const ataA = getAssociatedTokenAddressSync(new PublicKey(p.mintA), me, false, new PublicKey(p.mintProgramA));
  const ataB = getAssociatedTokenAddressSync(new PublicKey(p.mintB), me, false, new PublicKey(p.mintProgramB));
  // CollectCreatorFee account order per Raydium's CPMM docs, creator_fee_share appended at 15 (2026-09-19)
  assert.deepEqual(col.keys.map((k) => k.pubkey.toBase58()), [
    me.toBase58(), R.getPdaPoolAuthority(R.CREATE_CPMM_POOL_PROGRAM).publicKey.toBase58(), d.pool, CP_CONFIG,
    p.vaultA, p.vaultB, p.mintA, p.mintB, ataA.toBase58(), ataB.toBase58(), p.mintProgramA, p.mintProgramB,
    PROGRAM_IDS.ata, PROGRAM_IDS.system,
    PublicKey.findProgramAddressSync([Buffer.from('creator_fee_share'), me.toBuffer(), new PublicKey(CP_CONFIG).toBuffer()], R.CREATE_CPMM_POOL_PROGRAM)[0].toBase58(),
  ]);
  assert.deepEqual(col.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()), [me.toBase58()]);
  assert.equal(ixs[3].keys[0].pubkey.toBase58(), ataA.toBase58(), 'the WSOL side is unwrapped to the creator');
  assert.ok(guardClaimInstructions(ixs, me));
});

test('claims: anyone else is refused; a pool with nothing to claim gives an empty list', async () => {
  const g = world(GRAD);
  const d = await detectToken({ connection: g.conn, ca: GRAD });
  await assert.rejects(buildClaims(g.conn, d, Keypair.generate().publicKey), (e) => e instanceof ClaimError && e.code === 'not_creator');
  const o = world(OLD);
  const dold = await detectToken({ connection: o.conn, ca: OLD });
  assert.deepEqual(await buildClaims(o.conn, dold, dold.creator), []);
});

test('guard refuses tampered Raydium claims', async () => {
  const c = world(CURVE);
  const d = await detectToken({ connection: c.conn, ca: CURVE });
  const me = d.creator;
  const [ata, claim] = (await buildClaims(c.conn, d, me))[0].instructions;
  const stranger = Keypair.generate().publicKey;
  const swapKey = (ix, i, key, extra = {}) => new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((k, j) => (j === i ? { ...k, pubkey: key, ...extra } : k)) });
  const refuse = (ixs, re) => assert.throws(() => guardClaimInstructions(ixs, me), (e) => e instanceof ClaimError && e.code === 'guard' && re.test(e.message));
  // fee to someone else's token account
  refuse([ata, swapKey(claim, 3, getAssociatedTokenAddressSync(new PublicKey(NATIVE_MINT), stranger))], /another account/);
  // another LaunchLab instruction (a buy) with the same accounts
  refuse([new TransactionInstruction({ programId: claim.programId, keys: claim.keys, data: Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]) })], /other than ClaimCreatorFee/);
  // a second signer
  refuse([ata, swapKey(claim, 1, stranger, { isSigner: true })], /another signer/);
  // stray transfers of any kind
  refuse([ata, claim, SystemProgram.transfer({ fromPubkey: new PublicKey(me), toPubkey: stranger, lamports: 1 })], /unexpected program/);
  refuse([ata, claim, createTransferInstruction(getAssociatedTokenAddressSync(new PublicKey(NATIVE_MINT), new PublicKey(me)), stranger, new PublicKey(me), 1)], /token instruction 3/);
  // CPMM collect into someone else's account
  const g = world(GRAD);
  const dg = await detectToken({ connection: g.conn, ca: GRAD });
  const ixs = (await buildClaims(g.conn, dg, dg.cpmmCreator))[0].instructions;
  assert.throws(() => guardClaimInstructions([swapKey(ixs[2], 8, getAssociatedTokenAddressSync(new PublicKey(NATIVE_MINT), stranger))], dg.cpmmCreator), /another account/);
  assert.throws(() => guardClaimInstructions(ixs, stranger), /not signed by the signer|another signer/);
});

test('claimFees end to end with a test key in the creator seats: guarded, signed by that key only, sent', async () => {
  const kp = Keypair.generate();
  // curve: the real pool with its creator field moved to the test key, and the real vault account at the test key's vault
  const c = world(CURVE);
  const launchAddr = '7BzVSZxyuppehQ6P3hYN2UUukJbmi8zs5XELuyZNhTcM';
  const at = R.LaunchpadPool.offsetOf('creator');
  c.accounts.set(launchAddr, withBytes(c.accounts.get(launchAddr), (b) => kp.publicKey.toBuffer().copy(b, at)));
  c.accounts.set(RY.creatorFeeVaultAddress(kp.publicKey.toBase58(), NATIVE_MINT), c.accounts.get('BwVV4nqpCXGQYgytsUD2BVR7evCbS2Zf8Dqcy3rAFKqt'));
  const tok = createToken({ connection: c.conn, ca: CURVE, log: quiet, solUsd: fixedSol(100) });
  await assert.rejects(tok.claimFees({ signer: Keypair.generate() }), (e) => e.code === 'not_creator');
  const r = await tok.claimFees({ signer: kp });
  assert.equal(r.platform, 'raydium');
  assert.deepEqual(r.claims.map((x) => x.kind), ['launchlab_creator_fee']);
  assert.equal(c.conn.sent.length, 1);
  const tx = Transaction.from(c.conn.sent[0]);
  assert.ok(tx.verifySignatures());
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.feePayer.toBase58(), kp.publicKey.toBase58());
  assert.deepEqual(tx.instructions.map((i) => i.programId.toBase58()), [PROGRAM_IDS.ata, PROGRAM_IDS.launchlab, PROGRAM_IDS.token]);
  assert.equal(r.explorer[0], `https://solscan.io/tx/${r.signatures[0]}`);

  // graduated: the real CPMM pool with its pool creator moved to the test key
  const g = world(GRAD);
  const poolAddr = '8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX';
  const pc = R.CpmmPoolInfoLayout.offsetOf('poolCreator');
  g.accounts.set(poolAddr, withBytes(g.accounts.get(poolAddr), (b) => kp.publicKey.toBuffer().copy(b, pc)));
  const gt = createToken({ connection: g.conn, ca: GRAD, log: quiet, solUsd: fixedSol(100) });
  const rg = await gt.claimFees({ signer: kp });
  assert.deepEqual(rg.claims.map((x) => [x.kind, x.amounts.a]), [['cpmm_creator_fee', '7327914012']]);
  const tg = Transaction.from(g.conn.sent[0]);
  assert.ok(tg.verifySignatures());
  assert.equal(tg.signatures.length, 1);
  assert.equal(tg.instructions[2].programId.toBase58(), PROGRAM_IDS.raydiumCpmm);
});

test('Raydium\'s own LaunchLab platform: the fee settings docs/token.md states, from the recorded mainnet accounts', () => {
  const g = world(GRAD).accounts;
  const plat = RY.decodePlatformConfig(g.get(RAYDIUM_PLATFORM));
  assert.equal(plat.name, 'Raydium');
  assert.deepEqual(
    { feeRate: plat.feeRate, creatorFeeRate: plat.creatorFeeRate, platformScale: plat.platformScale, creatorScale: plat.creatorScale, burnScale: plat.burnScale, cpConfigId: plat.cpConfigId, platformCpCreator: plat.platformCpCreator },
    { feeRate: 7500n, creatorFeeRate: 500n, platformScale: 0n, creatorScale: 100000n, burnScale: 900000n, cpConfigId: CP_CONFIG, platformCpCreator: PROGRAM_IDS.system },
  );
  const glob = RY.decodeGlobalConfig(g.get(GLOBAL_CONFIG));
  assert.deepEqual({ curveType: glob.curveType, index: glob.index, tradeFeeRate: glob.tradeFeeRate, migrateFee: glob.migrateFee, maxShareFeeRate: glob.maxShareFeeRate, quote: glob.mintB },
    { curveType: 0, index: 0, tradeFeeRate: 2500n, migrateFee: 0n, maxShareFeeRate: 10000n, quote: NATIVE_MINT });
  const cp = RY.decodeCpmmConfig(g.get(CP_CONFIG));
  assert.deepEqual({ index: cp.index, tradeFeeRate: cp.tradeFeeRate, creatorFeeRate: cp.creatorFeeRate, creatorFeeShareRate: cp.creatorFeeShareRate, protocolFeeRate: cp.protocolFeeRate, fundFeeRate: cp.fundFeeRate },
    { index: 0, tradeFeeRate: 2500n, creatorFeeRate: 500n, creatorFeeShareRate: 50000n, protocolFeeRate: 120000n, fundFeeRate: 40000n });
  // the three coins' launches all use this platform and config
  for (const m of [CURVE, GRAD, OLD]) assert.equal(fixture(m).extra.launch.platformId, RAYDIUM_PLATFORM);
});

test('CreatePlatformConfig is permissionless: only the new platform\'s own admin signs (on-chain IDL and SDK builder)', () => {
  const idl = load('launchlab-idl-excerpt.json').instructions.find((i) => i.name === 'create_platform_config');
  assert.deepEqual(idl.accounts.filter((a) => a.signer).map((a) => a.name), ['platform_admin']);
  const pc = idl.accounts.find((a) => a.name === 'platform_config');
  assert.equal(Buffer.from(pc.pda.seeds[0].value).toString(), 'platform_config');
  assert.deepEqual(pc.pda.seeds[1], { kind: 'account', path: 'platform_admin' });
  const admin = Keypair.generate().publicKey;
  const pid = R.getPdaPlatformId(R.LAUNCHPAD_PROGRAM, admin).publicKey;
  const ix = R.createPlatformConfig(R.LAUNCHPAD_PROGRAM, admin, admin, admin, admin, pid, new PublicKey(CP_CONFIG), PublicKey.default,
    { platformScale: new BN(0), creatorScale: new BN(0), burnScale: new BN(1_000_000) }, new BN(0), new BN(0), 'x', 'x', 'x', new BN(0));
  assert.deepEqual(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()), [admin.toBase58()]);
  assert.equal(ix.keys[3].pubkey.toBase58(), pid.toBase58(), 'the platform config is the PDA of the signing admin');
});

test('stats() carries symbol, name, pool and buy link, which the site\'s token block reads', async () => {
  const c = world(CURVE);
  const tok = createToken({ connection: c.conn, ca: CURVE, log: quiet, solUsd: { get: async () => null } });
  const s = await tok.stats();
  assert.equal(s.available, false, 'no SOL/USD here');
  assert.deepEqual({ symbol: s.symbol, name: s.name, pool: s.pool, buyUrl: s.buyUrl, platform: s.platform, stage: s.stage },
    { symbol: 'CPTD', name: 'CptDrkGltch', pool: '7BzVSZxyuppehQ6P3hYN2UUukJbmi8zs5XELuyZNhTcM', buyUrl: `https://raydium.io/launchpad/token/?mint=${CURVE}`, platform: 'raydium', stage: 'curve' });
});
