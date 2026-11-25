// Test helper: drives the real Meteora Dynamic Bonding Curve and DAMM v2 programs inside LiteSVM
// (program binaries from the DBC SDK repository test fixtures, see fixtures/programs/README.md).
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import { dbc, cpamm } from '../sdk.js';
import { createSvmConnection } from './svm-connection.js';

export const METEORA_PROGRAMS = [
  { id: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID, file: 'dynamic_bonding_curve.so' },
  { id: dbc.METAPLEX_PROGRAM_ID, file: 'metaplex.so' },
  { id: dbc.DAMM_V2_PROGRAM_ID, file: 'cp_amm.so' },
];

export function meteoraConnection() {
  return createSvmConnection({ programs: METEORA_PROGRAMS });
}

/** Curve settings a test launch uses: 1B supply, 6 decimals, SOL quote, migrates to DAMM v2. */
export function testCurve({ initialMarketCap = 30, migrationMarketCap = 120, feeBps = 100, creatorTradingFeePercentage = 50 } = {}) {
  return dbc.buildCurveWithMarketCap({
    token: { tokenType: 0, tokenBaseDecimal: 6, tokenQuoteDecimal: 9, tokenAuthorityOption: 1, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: {
      baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: 0, creatorTradingFeePercentage, poolCreationFee: 0, enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: 1, migrationFeeOption: 6, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 100 },
    },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: 1, initialMarketCap, migrationMarketCap,
  });
}

async function send(conn, ixs, signers) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const r = conn.execute(tx.serialize());
  if (!r.ok) throw new Error('svm tx failed: ' + r.err + '\n' + r.logs.slice(-12).join('\n'));
  return r;
}

/** Creates config + pool (no first buy, the launch tool tests cover that path). */
export async function launchDbc(conn, { owner, name = 'Test Coin', symbol = 'TEST', curve = testCurve() } = {}) {
  const configKp = Keypair.generate();
  const mintKp = Keypair.generate();
  const client = new dbc.DynamicBondingCurveClient(conn, 'confirmed');
  const { createConfigTx, createPoolWithFirstBuyTx } = await client.partner.createConfigAndPoolWithFirstBuy({
    ...curve, payer: owner.publicKey, config: configKp.publicKey, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey, quoteMint: NATIVE_MINT,
    preCreatePoolParam: { baseMint: mintKp.publicKey, name, symbol, uri: 'https://example.com/m.json', poolCreator: owner.publicKey },
  });
  await send(conn, createConfigTx.instructions, [owner, configKp]);
  await send(conn, createPoolWithFirstBuyTx.instructions, [owner, mintKp]);
  const pool = dbc.deriveDbcPoolAddress(NATIVE_MINT, mintKp.publicKey, configKp.publicKey);
  conn.remember(pool, configKp.publicKey, mintKp.publicKey);
  return { mint: mintKp.publicKey, config: configKp.publicKey, pool };
}

/** Buys with `sol`; partial fill so a buy past the migration threshold fills up to the curve end. */
export async function buyDbc(conn, { trader, pool, sol }) {
  const client = new dbc.DynamicBondingCurveClient(conn, 'confirmed');
  const tx = await client.pool.swap2({
    owner: trader.publicKey, pool, amountIn: new BN(Math.round(sol * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0),
    swapBaseForQuote: false, referralTokenAccount: null, payer: trader.publicKey, swapMode: 1,
  });
  return send(conn, tx.instructions, [trader]);
}

/**
 * Writes a DAMM v2 Config account at the address the DBC program migrates into for this config's
 * migration fee option. The real one exists on mainnet; here it is encoded with the cp-amm coder.
 */
export async function writeDammConfig(conn, migrationFeeOption) {
  const cp = new cpamm.CpAmm(conn);
  const addr = dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  const zeroFee = {
    baseFee: { data: new Array(32).fill(0) },
    dynamicFee: { initialized: 0, padding: new Array(7).fill(0), maxVolatilityAccumulator: 0, variableFeeControl: 0, binStep: 0, filterPeriod: 0, decayPeriod: 0, reductionFactor: 0, padding1: new Array(8).fill(0), binStepU128: new BN(0) },
    protocolFeePercent: 20, padding0: 0, referralFeePercent: 20, padding1: [0, 0, 0], compoundingFeeBps: 0, padding2: [new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)],
  };
  const data = await cp._program.coder.accounts.encode('config', {
    vaultConfigKey: PublicKey.default,
    poolCreatorAuthority: dbc.deriveDbcPoolAuthority(),
    poolFees: zeroFee,
    activationType: 1, collectFeeMode: 0, configType: 1, padding0: [0, 0, 0, 0, 0],
    index: new BN(0), sqrtMinPrice: new BN(cpamm.MIN_SQRT_PRICE.toString()), sqrtMaxPrice: new BN(cpamm.MAX_SQRT_PRICE.toString()),
    permission: new BN(0), padding1: new Array(8).fill(new BN(0)),
  });
  conn.setAccount(addr, { data, owner: dbc.DAMM_V2_PROGRAM_ID });
  return addr;
}

export async function migrateDbc(conn, { payer, pool }) {
  const client = new dbc.DynamicBondingCurveClient(conn, 'confirmed');
  const { poolConfig } = await client.state.getPoolConfigWithKind((await client.state.getPool(pool)).poolState.config);
  const dammConfig = await writeDammConfig(conn, Number(poolConfig.migrationFeeOption));
  // On mainnet the DBC pool authority holds SOL and pays the DAMM v2 account rent during migration.
  conn.airdrop(dbc.deriveDbcPoolAuthority(), 1);
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({ pool, dammConfig, payer: payer.publicKey });
  const r = await send(conn, transaction.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)), [payer, firstPositionNftKeypair, secondPositionNftKeypair]);
  const vp = (await client.state.getPool(pool)).poolState;
  const dammPool = dbc.deriveDammV2PoolAddress(dammConfig, vp.baseMint, NATIVE_MINT);
  conn.remember(dammPool, firstPositionNftKeypair.publicKey, secondPositionNftKeypair.publicKey);
  return { dammPool, r };
}

/** Buys the coin on the DAMM v2 pool with `sol` (generates position fees). */
export async function buyDamm(conn, { trader, dammPool, sol }) {
  const cp = new cpamm.CpAmm(conn);
  const ps = await cp.fetchPoolState(dammPool);
  const tx = await cp.swap({
    payer: trader.publicKey, pool: dammPool, inputTokenMint: ps.tokenBMint, outputTokenMint: ps.tokenAMint,
    amountIn: new BN(Math.round(sol * LAMPORTS_PER_SOL)), minimumAmountOut: new BN(0),
    tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault, tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint,
    tokenAProgram: cpamm.getTokenProgram(ps.tokenAFlag), tokenBProgram: cpamm.getTokenProgram(ps.tokenBFlag), referralTokenAccount: null,
  });
  return send(conn, tx.instructions, [trader]);
}
