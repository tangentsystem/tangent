// pump.fun path: accounts encoded with the pump SDKs' own coders, served by LiteSVM.
// The pump programs are not available as binaries, so claims are checked as built and signed
// transactions (program ids, account metas, signer), not executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createSvmConnection } from './testkit/svm-connection.js';
import { writePumpCurve, writePumpPool } from './testkit/pump-world.js';
import { createToken, guardClaimInstructions, buildClaims, detectToken } from './index.js';
import { pump, cjsWeb3, CjsBN, PROGRAM_IDS } from './sdk.js';

const quiet = { warn() {}, error() {}, info() {} };
const fixedSol = (v) => ({ get: async () => ({ solUsd: v, source: 'test', updatedAt: 0 }) });
const close = (a, b, rel = 1e-9) => Math.abs(a - b) <= Math.abs(b) * rel;

function capture(conn) {
  const raw = [];
  conn.sendRawTransaction = async (bytes) => {
    raw.push(Transaction.from(Buffer.from(bytes)));
    return 'sig' + raw.length;
  };
  return raw;
}

test('pump curve: detection, price, supply, buy link', async () => {
  const conn = createSvmConnection();
  const creator = Keypair.generate();
  const w = await writePumpCurve(conn, { creator: creator.publicKey, name: 'Pump Coin', symbol: 'PUMPC', curveHolds: 900_000_000_000_000n });
  const tok = createToken({ connection: conn, ca: w.mint.toBase58(), log: quiet, solUsd: fixedSol(150) });
  const d = await tok.detect();
  assert.deepEqual(
    { platform: d.platform, stage: d.stage, pool: d.pool, symbol: d.symbol, name: d.name },
    { platform: 'pumpfun', stage: 'curve', pool: w.curve.toBase58(), symbol: 'PUMPC', name: 'Pump Coin' },
  );
  assert.equal(tok.buyUrl(), `https://pump.fun/coin/${w.mint.toBase58()}`);
  const s = await tok.stats();
  assert.equal(s.available, true);
  // hand computed: 30 SOL / 1,073,000,000 tokens
  assert.ok(close(s.priceSol, 2.7958993476234855e-8), String(s.priceSol));
  assert.ok(close(s.priceUsd, 4.193849021435228e-6), String(s.priceUsd));
  assert.ok(close(s.marketCapUsd, 4193.849021435228), String(s.marketCapUsd));
  assert.equal(s.supply.total, '1000000000');
  assert.equal(s.supply.circulating, '100000000');
  assert.equal(s.quote, 'SOL');
  // pump market cap formula from the SDK gives the same SOL value
  const sdkMcap = pump.bondingCurveMarketCap({ mintSupply: new CjsBN('1000000000000000'), virtualQuoteReserves: new CjsBN('30000000000'), virtualTokenReserves: new CjsBN('1073000000000000') });
  assert.ok(close(s.marketCapUsd / 150, Number(sdkMcap.toString()) / 1e9, 1e-9));
});

test('pump graduated: PumpSwap pool with negative virtual quote reserves, Token-2022 metadata', async () => {
  const conn = createSvmConnection();
  const creator = Keypair.generate();
  const w = await writePumpPool(conn, { creator: creator.publicKey, virtualQuote: -990_000_000n });
  const tok = createToken({ connection: conn, ca: w.mint.toBase58(), log: quiet, solUsd: fixedSol(150) });
  const d = await tok.detect();
  assert.equal(d.platform, 'pumpfun');
  assert.equal(d.stage, 'graduated');
  assert.equal(d.pool, w.pool.toBase58());
  assert.equal(d.symbol, 'GRAD');
  assert.equal(d.name, 'Grad Coin');
  const s = await tok.stats();
  // effective quote = 84.99 - 0.99 = 84 SOL over 206,900,000 tokens
  assert.ok(close(s.priceSol, 84 / 206_900_000), String(s.priceSol));
  assert.ok(close(s.marketCapUsd, (84 / 206_900_000) * 1e9 * 150));
  assert.equal(s.supply.circulating, s.supply.total);
});

test('pump: complete curve without its pool yet reports migrating', async () => {
  const conn = createSvmConnection();
  const creator = Keypair.generate();
  const w = await writePumpCurve(conn, { creator: creator.publicKey, complete: true });
  const r = await detectToken({ connection: conn, ca: w.mint.toBase58() });
  assert.equal(r.ok, true);
  assert.equal(r.stage, 'graduated');
  assert.equal(r.migrating, true);
  assert.equal(r.pool, null);
});

test('pump curve claim: creator vault sweep built by the SDK, signed by the creator only', async () => {
  const conn = createSvmConnection();
  const creator = Keypair.generate();
  const w = await writePumpCurve(conn, { creator: creator.publicKey });
  const d = await detectToken({ connection: conn, ca: w.mint.toBase58() });
  const [claim] = await buildClaims(conn, d, creator.publicKey);
  const ixs = claim.instructions;
  assert.deepEqual(ixs.map((i) => i.programId.toBase58()), [PROGRAM_IDS.ata, PROGRAM_IDS.pump]);
  const collect = ixs[1];
  const creatorVault = pump.creatorVaultPda(new cjsWeb3.PublicKey(creator.publicKey.toBase58())).toBase58();
  // collect_creator_fee_v2 account order per the pump docs: creator, creator ATA, vault, vault ATA, quote mint, ...
  assert.equal(collect.keys[0].pubkey.toBase58(), creator.publicKey.toBase58());
  assert.equal(collect.keys[0].isWritable, true);
  assert.equal(collect.keys[1].pubkey.toBase58(), getAssociatedTokenAddressSync(NATIVE_MINT, creator.publicKey, true).toBase58());
  assert.equal(collect.keys[2].pubkey.toBase58(), creatorVault);
  assert.equal(collect.keys[4].pubkey.toBase58(), NATIVE_MINT.toBase58());
  assert.ok(collect.keys.every((k) => !k.isSigner || k.pubkey.equals(creator.publicKey)));
  assert.equal(guardClaimInstructions(ixs, creator.publicKey), true);

  // full claimFees: one transaction, fee payer and only signer is the creator
  const raw = capture(conn);
  const tok = createToken({ connection: conn, ca: w.mint.toBase58(), log: quiet, solUsd: fixedSol(150) });
  const r = await tok.claimFees({ signer: creator });
  assert.deepEqual(r.signatures, ['sig1']);
  assert.equal(raw.length, 1);
  const tx = raw[0];
  assert.equal(tx.feePayer.toBase58(), creator.publicKey.toBase58());
  assert.equal(tx.signatures.length, 1);
  assert.ok(tx.verifySignatures());
  assert.deepEqual(tx.instructions.map((i) => i.programId.toBase58()), [PROGRAM_IDS.ata, PROGRAM_IDS.pump]);
});

test('pump graduated claim: PumpSwap creator vault leg then the curve vault leg', async () => {
  const conn = createSvmConnection();
  const creator = Keypair.generate();
  const w = await writePumpPool(conn, { creator: creator.publicKey, withCreatorVault: 5_000_000n });
  const d = await detectToken({ connection: conn, ca: w.mint.toBase58() });
  const [claim] = await buildClaims(conn, d, creator.publicKey);
  const progs = claim.instructions.map((i) => i.programId.toBase58());
  // ATA create for the creator's WSOL, pump collect_creator_fee_v2, PumpSwap collect_coin_creator_fee, close WSOL to creator
  assert.deepEqual(progs, [PROGRAM_IDS.ata, PROGRAM_IDS.pump, PROGRAM_IDS.pumpAmm, PROGRAM_IDS.token]);
  const amm = claim.instructions[2];
  const vaultAuth = pump.ammCreatorVaultPda(new cjsWeb3.PublicKey(creator.publicKey.toBase58())).toBase58();
  assert.equal(amm.keys[2].pubkey.toBase58(), creator.publicKey.toBase58());
  assert.equal(amm.keys[3].pubkey.toBase58(), vaultAuth);
  assert.equal(amm.keys[4].pubkey.toBase58(), w.creatorVaultAta.toBase58());
  const closeIx = claim.instructions[3];
  assert.equal(closeIx.data[0], 9);
  assert.equal(closeIx.keys[1].pubkey.toBase58(), creator.publicKey.toBase58());
  assert.equal(guardClaimInstructions(claim.instructions, creator.publicKey), true);
});

test('pump claim refuses a signer that is not the coin creator', async () => {
  const conn = createSvmConnection();
  const creator = Keypair.generate();
  const other = Keypair.generate();
  const w = await writePumpCurve(conn, { creator: creator.publicKey });
  capture(conn);
  const tok = createToken({ connection: conn, ca: w.mint.toBase58(), log: quiet, solUsd: fixedSol(150) });
  await assert.rejects(tok.claimFees({ signer: other }), (e) => e.code === 'not_creator');
});

test('claim guard refuses anything that could pay someone else', () => {
  const me = Keypair.generate().publicKey;
  const thief = Keypair.generate().publicKey;
  assert.throws(() => guardClaimInstructions([SystemProgram.transfer({ fromPubkey: me, toPubkey: thief, lamports: 1 })], me), /unexpected program/);
  const closeToThief = { programId: new PublicKey(PROGRAM_IDS.token), keys: [{ pubkey: thief }, { pubkey: thief }, { pubkey: me }], data: Buffer.from([9]) };
  assert.throws(() => guardClaimInstructions([closeToThief], me), /close pays someone else/);
  const transferTok = { programId: new PublicKey(PROGRAM_IDS.token), keys: [], data: Buffer.from([3]) };
  assert.throws(() => guardClaimInstructions([transferTok], me), /token instruction 3/);
  const ataForOther = { programId: new PublicKey(PROGRAM_IDS.ata), keys: [{ pubkey: me }, { pubkey: thief }, { pubkey: thief }], data: Buffer.from([1]) };
  assert.throws(() => guardClaimInstructions([ataForOther], me), /for another wallet/);
});

test('unknown token and non mint are reported, never guessed', async () => {
  const conn = createSvmConnection();
  const missing = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(await detectToken({ connection: conn, ca: missing }), { ok: false, reason: 'mint_not_found' });
  const plain = Keypair.generate().publicKey;
  conn.setAccount(plain, { data: Buffer.alloc(10), owner: PROGRAM_IDS.system });
  assert.equal((await detectToken({ connection: conn, ca: plain.toBase58() })).reason, 'not_a_mint');
  // a real mint that is on neither platform
  const { encodeMint } = await import('./testkit/pump-world.js');
  const lone = Keypair.generate().publicKey;
  conn.setAccount(lone, { data: encodeMint({ supply: 5n, decimals: 6 }), owner: PROGRAM_IDS.token });
  assert.equal((await detectToken({ connection: conn, ca: lone.toBase58() })).reason, 'unknown_platform');
  const tok = createToken({ connection: conn, ca: lone.toBase58(), log: quiet, solUsd: fixedSol(150) });
  const s = await tok.stats();
  assert.deepEqual(s, { configured: true, available: false, reason: 'unknown_platform' });
  assert.equal(tok.buyUrl(), null);
});
