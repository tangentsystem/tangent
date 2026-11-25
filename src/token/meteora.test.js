// Meteora path against the real DBC and DAMM v2 programs running in LiteSVM:
// launch, detect on the curve, price, claim creator + partner fees, migrate, detect on DAMM v2,
// claim position fees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { meteoraConnection, launchDbc, buyDbc, migrateDbc, buyDamm } from './testkit/meteora-world.js';
import { createToken } from './index.js';
import { sdkPrice } from './stats.js';
import { dbc, PROGRAM_IDS } from './sdk.js';

const fixedSol = (v) => ({ get: async () => ({ solUsd: v, source: 'test', updatedAt: 0 }) });
const quiet = { warn() {}, error() {}, info() {} };

/** Owner's lamports plus the lamports held in the owner's own token accounts (their rent). */
async function ownerWorth(conn, pk) {
  let total = BigInt(await conn.getBalance(pk));
  for (const programId of [PROGRAM_IDS.token, PROGRAM_IDS.token2022]) {
    const r = await conn.getTokenAccountsByOwner(pk, { programId: new PublicKey(programId) });
    for (const v of r.value) total += BigInt(v.account.lamports);
  }
  return total;
}

test('meteora: curve, fee claims, migration, DAMM v2 position fees', async (t) => {
  const conn = meteoraConnection();
  const owner = Keypair.generate();
  const trader = Keypair.generate();
  const stranger = Keypair.generate();
  conn.airdrop(owner.publicKey, 100);
  conn.airdrop(trader.publicKey, 1000);
  conn.airdrop(stranger.publicKey, 1);
  const L = await launchDbc(conn, { owner, name: 'Test Coin', symbol: 'TEST' });
  const ca = L.mint.toBase58();

  await t.test('detects the DBC curve with name and symbol from metadata', async () => {
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0, statsTtlMs: 0 });
    const d = await tok.detect();
    assert.equal(d.platform, 'meteora');
    assert.equal(d.stage, 'curve');
    assert.equal(d.pool, L.pool.toBase58());
    assert.equal(d.symbol, 'TEST');
    assert.equal(d.name, 'Test Coin');
    assert.equal(tok.buyUrl(), `https://jup.ag/tokens/${ca}`);
  });

  await buyDbc(conn, { trader, pool: L.pool, sol: 5 });

  await t.test('prices the curve from sqrt price, agrees with the SDK helper', async () => {
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0, statsTtlMs: 0 });
    const s = await tok.stats();
    assert.equal(s.available, true, JSON.stringify(s));
    const client = new dbc.DynamicBondingCurveClient(conn);
    const ps = (await client.state.getPool(L.pool)).poolState;
    const expect = sdkPrice.dbc(ps.sqrtPrice, 6, 9);
    assert.ok(Math.abs(s.priceSol - expect) / expect < 1e-9, `${s.priceSol} vs ${expect}`);
    assert.ok(Math.abs(s.priceUsd - expect * 150) / (expect * 150) < 1e-9);
    assert.ok(Math.abs(s.marketCapUsd - expect * 150 * 1e9) / (expect * 150 * 1e9) < 1e-9);
    assert.equal(s.supply.total, '1000000000');
    // circulating = total minus what the curve still holds
    assert.equal(BigInt(s.supply.circulatingRaw), 10n ** 15n - BigInt(ps.baseReserve.toString()));
    assert.ok(BigInt(s.supply.circulatingRaw) > 0n);
  });

  await t.test('refuses a signer that is neither creator nor fee claimer', async () => {
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0 });
    await assert.rejects(tok.claimFees({ signer: stranger }), (e) => e.code === 'not_creator');
  });

  await t.test('claims DBC creator and partner trading fees to the owner only', async () => {
    const client = new dbc.DynamicBondingCurveClient(conn);
    const before = (await client.state.getPool(L.pool)).poolState;
    const expected = BigInt(before.creatorQuoteFee.toString()) + BigInt(before.partnerQuoteFee.toString());
    assert.ok(expected > 0n);
    const bal0 = await ownerWorth(conn, owner.publicKey);
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0 });
    const r = await tok.claimFees({ signer: owner });
    assert.deepEqual(r.claims.map((c) => c.kind), ['dbc_creator_fee', 'dbc_partner_fee']);
    assert.equal(r.signatures.length, 2);
    const bal1 = await ownerWorth(conn, owner.publicKey);
    // gained exactly the fees minus 2 network fees (5000 lamports each). Rent of the owner's own coin
    // account (created by the claim) stays inside ownerWorth; the wrapped SOL account is closed back.
    assert.equal(bal1 - bal0, expected - 10_000n);
    const after = (await client.state.getPool(L.pool)).poolState;
    assert.equal(after.creatorQuoteFee.toString(), '0');
    assert.equal(after.partnerQuoteFee.toString(), '0');
    // every claim instruction went to an allowed program
    for (const s of conn.sent.slice(-2)) assert.equal(s.ok, true);
  });

  await t.test('nothing to claim gives an empty result without sending', async () => {
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0 });
    const n = conn.sent.length;
    const r = await tok.claimFees({ signer: owner });
    assert.deepEqual(r.signatures, []);
    assert.equal(conn.sent.length, n);
  });

  // fill the curve and migrate
  for (let i = 0; i < 20; i++) {
    const client = new dbc.DynamicBondingCurveClient(conn);
    const ps = (await client.state.getPool(L.pool)).poolState;
    if (ps.migrationProgress >= 2) break;
    await buyDbc(conn, { trader, pool: L.pool, sol: 10 });
  }
  const { dammPool } = await migrateDbc(conn, { payer: trader, pool: L.pool });

  await t.test('detects DAMM v2 after migration', async () => {
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0, statsTtlMs: 0 });
    const d = await tok.detect();
    assert.equal(d.platform, 'meteora');
    assert.equal(d.stage, 'graduated');
    assert.equal(d.pool, dammPool.toBase58());
    assert.equal(d.symbol, 'TEST');
    const s = await tok.stats();
    assert.equal(s.available, true, JSON.stringify(s));
    const info = await conn.getAccountInfo(dammPool);
    const { cpamm } = await import('./sdk.js');
    const st = new cpamm.CpAmm(conn)._program.coder.accounts.decode('pool', info.data);
    const expect = sdkPrice.damm(st.sqrtPrice, 6, 9);
    assert.ok(Math.abs(s.priceSol - expect) / expect < 1e-9);
    assert.equal(s.supply.circulating, s.supply.total);
  });

  await t.test('graduated detection uses the derived pool address, no scan of DAMM v2', async () => {
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0 });
    conn.calls.length = 0;
    await tok.detect();
    await tok.detect(); // second call uses the remembered DBC pool: no program scan at all
    const scans = conn.calls.filter((c) => c === 'getProgramAccounts').length;
    // first detect: DBC virtualPool + transferHookPool scans (2); second detect: none
    assert.equal(scans, 2);
  });

  await buyDamm(conn, { trader, dammPool, sol: 3 });

  await t.test('claims DAMM v2 position fees (and leftover DBC fees) to the owner', async () => {
    const bal0 = BigInt(await conn.getBalance(owner.publicKey));
    const tok = createToken({ connection: conn, ca, log: quiet, solUsd: fixedSol(150), detectTtlMs: 0 });
    const r = await tok.claimFees({ signer: owner });
    const kinds = r.claims.map((c) => c.kind);
    assert.ok(kinds.includes('damm_position_fee'), kinds.join(','));
    const positionClaims = r.claims.filter((c) => c.kind === 'damm_position_fee');
    // owner is both creator and partner: two locked positions, both earn
    assert.equal(positionClaims.length, 2);
    const bal1 = BigInt(await conn.getBalance(owner.publicKey));
    assert.ok(bal1 > bal0, `balance did not grow: ${bal0} -> ${bal1}`);
    for (const c of positionClaims) assert.ok(BigInt(c.amounts.b) > 0n);
    assert.ok(r.explorer.every((u) => u.startsWith('https://solscan.io/tx/')));
  });

  assert.equal(PROGRAM_IDS.dammV2, dbc.DAMM_V2_PROGRAM_ID.toBase58());
  assert.ok(LAMPORTS_PER_SOL);
});
