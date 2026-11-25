// Raydium LaunchLab: bonding curve (LaunchLab program) -> Raydium CPMM pool after graduation.
//
// Program ids, PDA seeds, account layouts, curve maths and the two claim instruction builders come
// from @raydium-io/raydium-sdk-v2 (see sdk.js). Decoded values leave this file as base58 strings
// and BigInts, never as SDK class instances. Every account read here is checked for its owner
// program and its Anchor discriminator before it is decoded.
//
// LaunchLab PoolState.status: 0 Fund (curve trading), 1 Migrate (target reached, waiting for the
// graduation crank), 2 Trade (migrated). migrate_type: 1 CPMM (every new launch), 0 legacy AMM v4.
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha2.js';
import { raydium as R, PROGRAM_IDS, NATIVE_MINT } from './sdk.js';
import { readTokenAmount } from './chain.js';

export const PLATFORM = 'raydium';
export const BUY_URL_BASE = 'https://raydium.io/launchpad/token/?mint=';
/** Raydium's own LaunchLab UI platform (raydium.io/launchpad), as the SDK names it. */
export const RAYDIUM_UI_PLATFORM = R.LAUNCHPAD_PLATFORM.toBase58();

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
/** Quote mints probed for a LaunchLab pool (one batched read): SOL first, then the two stables seen on LaunchLab. */
export const LAUNCHLAB_QUOTES = Object.freeze([NATIVE_MINT, USDC_MINT, USD1_MINT]);

const LAUNCHLAB = new PublicKey(PROGRAM_IDS.launchlab);
const CPMM = new PublicKey(PROGRAM_IDS.raydiumCpmm);
const CPMM_CONFIG_SCAN = 64; // AmmConfig PDAs probed when the platform's cp config does not hold the pool

const anchorDisc = (prefix, name) => Buffer.from(sha256(Buffer.from(`${prefix}:${name}`))).subarray(0, 8);
export const DISC = Object.freeze({
  launchPool: anchorDisc('account', 'PoolState'),
  globalConfig: anchorDisc('account', 'GlobalConfig'),
  platformConfig: anchorDisc('account', 'PlatformConfig'),
  cpmmPool: anchorDisc('account', 'PoolState'), // CPMM's state account is also named PoolState
  cpmmConfig: anchorDisc('account', 'AmmConfig'),
  claimCreatorFee: anchorDisc('global', 'claim_creator_fee'),
  collectCreatorFee: anchorDisc('global', 'collect_creator_fee'),
});

const b58 = (k) => (typeof k === 'string' ? k : k.toBase58());
const big = (v) => BigInt(v.toString());
const pk = (k) => new PublicKey(b58(k));

function decodeChecked(info, owner, disc, layout) {
  if (!info || info.owner.toBase58() !== owner) return null;
  const data = Buffer.from(info.data);
  if (data.length < layout.span || !data.subarray(0, 8).equals(disc)) return null;
  return layout.decode(data);
}

/** LaunchLab PoolState, or null when the account is not one. */
export function decodeLaunchPool(info) {
  const p = decodeChecked(info, PROGRAM_IDS.launchlab, DISC.launchPool, R.LaunchpadPool);
  if (!p) return null;
  return {
    status: p.status, migrateType: p.migrateType, decimalsA: p.mintDecimalsA, decimalsB: p.mintDecimalsB,
    supply: big(p.supply), totalSellA: big(p.totalSellA), virtualA: big(p.virtualA), virtualB: big(p.virtualB),
    realA: big(p.realA), realB: big(p.realB), totalFundRaisingB: big(p.totalFundRaisingB),
    protocolFee: big(p.protocolFee), platformFee: big(p.platformFee), migrateFee: big(p.migrateFee),
    lockedA: big(p.vestingSchedule.totalLockedAmount),
    configId: b58(p.configId), platformId: b58(p.platformId), mintA: b58(p.mintA), mintB: b58(p.mintB),
    vaultA: b58(p.vaultA), vaultB: b58(p.vaultB), creator: b58(p.creator),
    mintProgramFlag: p.mintProgramFlag, cpmmCreatorFeeOn: p.cpmmCreatorFeeOn,
  };
}

/** LaunchLab GlobalConfig (protocol level, one per curve type and index). */
export function decodeGlobalConfig(info) {
  const c = decodeChecked(info, PROGRAM_IDS.launchlab, DISC.globalConfig, R.LaunchpadConfig);
  if (!c) return null;
  return {
    curveType: c.curveType, index: c.index, migrateFee: big(c.migrateFee), tradeFeeRate: big(c.tradeFeeRate),
    maxShareFeeRate: big(c.maxShareFeeRate), mintB: b58(c.mintB), protocolFeeOwner: b58(c.protocolFeeOwner),
    migrateToCpmmWallet: b58(c.migrateToCpmmWallet),
  };
}

const cstr = (bytes) => { const b = Buffer.from(bytes); const end = b.indexOf(0); return (end === -1 ? b : b.subarray(0, end)).toString('utf8'); };

/** LaunchLab PlatformConfig (per launch platform). */
export function decodePlatformConfig(info) {
  const c = decodeChecked(info, PROGRAM_IDS.launchlab, DISC.platformConfig, R.PlatformConfig);
  if (!c) return null;
  return {
    name: cstr(c.name), web: cstr(c.web), feeRate: big(c.feeRate), creatorFeeRate: big(c.creatorFeeRate),
    platformScale: big(c.platformScale), creatorScale: big(c.creatorScale), burnScale: big(c.burnScale),
    cpConfigId: b58(c.cpConfigId), platformCpCreator: b58(c.platformCpCreator),
    platformClaimFeeWallet: b58(c.platformClaimFeeWallet), platformLockNftWallet: b58(c.platformLockNftWallet),
  };
}

/** Raydium CPMM PoolState. */
export function decodeCpmmPool(info) {
  const p = decodeChecked(info, PROGRAM_IDS.raydiumCpmm, DISC.cpmmPool, R.CpmmPoolInfoLayout);
  if (!p) return null;
  return {
    configId: b58(p.configId), poolCreator: b58(p.poolCreator), vaultA: b58(p.vaultA), vaultB: b58(p.vaultB),
    mintA: b58(p.mintA), mintB: b58(p.mintB), mintProgramA: b58(p.mintProgramA), mintProgramB: b58(p.mintProgramB),
    decimalsA: p.mintDecimalA, decimalsB: p.mintDecimalB, status: p.status,
    protocolFeesA: big(p.protocolFeesMintA), protocolFeesB: big(p.protocolFeesMintB),
    fundFeesA: big(p.fundFeesMintA), fundFeesB: big(p.fundFeesMintB),
    creatorFeesA: big(p.creatorFeesMintA), creatorFeesB: big(p.creatorFeesMintB),
    enableCreatorFee: Boolean(p.enableCreatorFee), creatorFeeOn: p.feeOn,
  };
}

/** Raydium CPMM AmmConfig (fee tier). Rates are over 1,000,000. */
export function decodeCpmmConfig(info) {
  const c = decodeChecked(info, PROGRAM_IDS.raydiumCpmm, DISC.cpmmConfig, R.CpmmConfigInfoLayout);
  if (!c) return null;
  return {
    index: c.index, tradeFeeRate: big(c.tradeFeeRate), protocolFeeRate: big(c.protocolFeeRate), fundFeeRate: big(c.fundFeeRate),
    creatorFeeRate: big(c.creatorFeeRate), creatorFeeShareRate: big(c.creatorFeeShareRate), disableCreatePool: Boolean(c.disableCreatePool),
  };
}

export const launchPoolAddress = (mint, quoteMint) => R.getPdaLaunchpadPoolId(LAUNCHLAB, pk(mint), pk(quoteMint)).publicKey.toBase58();
export const cpmmConfigAddress = (index) => R.getCpmmPdaAmmConfigId(CPMM, index).publicKey.toBase58();
/** CPMM pool PDA: [pool, config, token0, token1] with the two mints in byte order. */
export function cpmmPoolAddress(configId, mintX, mintY) {
  const [a, b] = [pk(mintX), pk(mintY)];
  const [m0, m1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  return R.getCpmmPdaPoolId(CPMM, pk(configId), m0, m1).publicKey.toBase58();
}
export const creatorFeeVaultAddress = (creator, quoteMint) => R.getPdaCreatorVault(LAUNCHLAB, pk(creator), pk(quoteMint)).publicKey.toBase58();

// ---------------------------------------------------------------- price maths (BigInt, then Number)

const SCALE = 10n ** 18n;
function ratio(num, den) {
  if (den <= 0n || num < 0n) return null;
  const n = num * SCALE;
  return Number(n / den) / 1e18 + Number(n % den) / Number(den) / 1e18;
}
function withDecimals(num, den, decA, decB) {
  // price of one whole base (A) token in whole quote (B) tokens = raw ratio * 10^(decA - decB)
  const e = decA - decB;
  return e >= 0 ? ratio(num * 10n ** BigInt(e), den) : ratio(num, den * 10n ** BigInt(-e));
}

/**
 * Spot price on a LaunchLab curve, whole quote per whole base token, the same formulas as the SDK's
 * Curve.getPrice: 0 constant product (vB + rB) / (vA - rA); 1 fixed price vB / vA; 2 linear
 * price vA * rA / 2^64 (vA holds the slope as Q64.64).
 */
export function launchCurvePrice({ curveType, virtualA, virtualB, realA, realB, decimalsA, decimalsB }) {
  const [vA, vB, rA, rB] = [virtualA, virtualB, realA, realB].map(big);
  if (curveType === 0) return withDecimals(vB + rB, vA - rA, decimalsA, decimalsB);
  if (curveType === 1) return withDecimals(vB, vA, decimalsA, decimalsB);
  if (curveType === 2) return withDecimals(vA * rA, 1n << 64n, decimalsA, decimalsB);
  return null;
}

/** CPMM reserves the curve trades against: vault balances minus the fee counters still in them. */
export function cpmmReserves(pool, vaultAAmount, vaultBAmount) {
  return {
    a: big(vaultAAmount) - pool.protocolFeesA - pool.fundFeesA - pool.creatorFeesA,
    b: big(vaultBAmount) - pool.protocolFeesB - pool.fundFeesB - pool.creatorFeesB,
  };
}

// ---------------------------------------------------------------- detection

function cpmmPoolFor(info, address, ca, quoteMint) {
  const p = decodeCpmmPool(info);
  if (!p) return null;
  const mints = new Set([p.mintA, p.mintB]);
  return mints.has(ca) && mints.has(quoteMint) ? { address, pool: p } : null;
}

/** Finds the CPMM pool a graduated launch migrated into. */
export async function findCpmmPool(connection, launch) {
  const ca = launch.mintA;
  const quote = launch.mintB;
  // 1. The platform names the CPMM config its launches migrate into.
  const platInfo = await connection.getAccountInfo(pk(launch.platformId));
  const plat = decodePlatformConfig(platInfo);
  if (plat) {
    const addr = cpmmPoolAddress(plat.cpConfigId, ca, quote);
    const hit = cpmmPoolFor(await connection.getAccountInfo(pk(addr)), addr, ca, quote);
    if (hit) return { ...hit, platform: plat };
  }
  // 2. The platform may have changed its config since: try every CPMM config index (two batched reads).
  const cfgs = Array.from({ length: CPMM_CONFIG_SCAN }, (_, i) => cpmmConfigAddress(i));
  const cfgInfos = await connection.getMultipleAccountsInfo(cfgs.map(pk));
  const live = cfgs.filter((c, i) => decodeCpmmConfig(cfgInfos[i]));
  if (!live.length) return null;
  const pools = live.map((c) => cpmmPoolAddress(c, ca, quote));
  const poolInfos = await connection.getMultipleAccountsInfo(pools.map(pk));
  for (let i = 0; i < pools.length; i++) {
    const hit = cpmmPoolFor(poolInfos[i], pools[i], ca, quote);
    if (hit) return { ...hit, platform: plat };
  }
  return null;
}

/**
 * detectRaydium(connection, ca) -> found (same shape as the other platforms) | null.
 * One batched read of the LaunchLab pool PDA for each quote in LAUNCHLAB_QUOTES.
 */
export async function detectRaydium(connection, ca) {
  const addrs = LAUNCHLAB_QUOTES.map((q) => launchPoolAddress(ca, q));
  const infos = await connection.getMultipleAccountsInfo(addrs.map(pk));
  let launch = null;
  let poolAddr = null;
  for (let i = 0; i < addrs.length; i++) {
    const p = decodeLaunchPool(infos[i]);
    if (p && p.mintA === ca && p.mintB === LAUNCHLAB_QUOTES[i]) { launch = p; poolAddr = addrs[i]; break; }
  }
  if (!launch) return null;
  const base = { platform: PLATFORM, quoteMint: launch.mintB, creator: launch.creator, launchPool: poolAddr };
  if (launch.status === 0) {
    return { ...base, stage: 'curve', pool: poolAddr, state: { kind: 'raydium-curve', launchAddr: poolAddr, launch } };
  }
  if (launch.status === 1) {
    return { ...base, stage: 'graduated', pool: null, migrating: true, state: { kind: 'raydium-migrating', launchAddr: poolAddr, launch } };
  }
  if (launch.migrateType === 0) {
    // Legacy AMM v4 graduation (only launches created before CPMM became mandatory). Not priced here.
    return { ...base, stage: 'graduated', pool: null, state: { kind: 'raydium-amm-v4', launchAddr: poolAddr, launch } };
  }
  const found = await findCpmmPool(connection, launch);
  if (!found) {
    return { ...base, stage: 'graduated', pool: null, migrating: true, state: { kind: 'raydium-migrating', launchAddr: poolAddr, launch } };
  }
  return {
    ...base, stage: 'graduated', pool: found.address, cpmmCreator: found.pool.poolCreator,
    state: { kind: 'raydium-cpmm', launchAddr: poolAddr, launch, cpmmAddr: found.address, cpmm: found.pool },
  };
}

// ---------------------------------------------------------------- price reads

/** { priceQuote, circulatingRaw } for a detected Raydium coin. */
export async function readRaydiumPrice(connection, d, total) {
  const st = d.state;
  const baseDec = d.mint.decimals;
  if (st.kind === 'raydium-curve' || st.kind === 'raydium-migrating') {
    const L = st.launch;
    const [cfgInfo, vaultInfo] = await connection.getMultipleAccountsInfo([pk(L.configId), pk(L.vaultA)]);
    const cfg = decodeGlobalConfig(cfgInfo);
    const priceQuote = cfg ? launchCurvePrice({ curveType: cfg.curveType, ...L, decimalsA: baseDec, decimalsB: L.decimalsB }) : null;
    const held = st.kind === 'raydium-curve' ? readTokenAmount(L.vaultA, vaultInfo) : null;
    const circulatingRaw = held === null ? total : total - held;
    return { priceQuote, circulatingRaw: circulatingRaw < 0n ? 0n : circulatingRaw, quoteDecimals: L.decimalsB, curveType: cfg ? cfg.curveType : null };
  }
  if (st.kind === 'raydium-cpmm') {
    const p = st.cpmm;
    const [aInfo, bInfo] = await connection.getMultipleAccountsInfo([pk(p.vaultA), pk(p.vaultB)]);
    const va = readTokenAmount(p.vaultA, aInfo);
    const vb = readTokenAmount(p.vaultB, bInfo);
    if (va === null || vb === null) return { priceQuote: null, circulatingRaw: total };
    const r = cpmmReserves(p, va, vb);
    const baseIsA = p.mintA === d.ca;
    const [baseRes, quoteRes] = baseIsA ? [r.a, r.b] : [r.b, r.a];
    const [bDec, qDec] = baseIsA ? [p.decimalsA, p.decimalsB] : [p.decimalsB, p.decimalsA];
    return { priceQuote: withDecimals(quoteRes, baseRes, bDec, qDec), circulatingRaw: total, quoteDecimals: qDec };
  }
  return { priceQuote: null, circulatingRaw: total };
}

// ---------------------------------------------------------------- claims

const TOKEN_PROGRAM_IDS = [PROGRAM_IDS.token, PROGRAM_IDS.token2022];
const toEsm = (ix) => new TransactionInstruction({
  programId: new PublicKey(ix.programId.toBase58()),
  keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey.toBase58()), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data),
});

function quoteProgramOf(launch) {
  return TOKEN_PROGRAM_IDS[(launch.mintProgramFlag >> 1) & 1];
}

/** LaunchLab ClaimCreatorFee for `me` on the launch's quote mint: ATA create, claim, unwrap when SOL. */
export function launchCreatorFeeInstructions(me, quoteMint, quoteProgram) {
  const owner = pk(me);
  const mint = pk(quoteMint);
  const prog = pk(quoteProgram);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, prog);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, prog),
    toEsm(R.claimCreatorFee(LAUNCHLAB, owner, R.getPdaCreatorFeeVaultAuth(LAUNCHLAB).publicKey,
      R.getPdaCreatorVault(LAUNCHLAB, owner, mint).publicKey, ata, mint, prog)),
  ];
  if (quoteMint === NATIVE_MINT) ixs.push(createCloseAccountInstruction(ata, owner, owner, [], prog));
  return ixs;
}

/** CPMM CollectCreatorFee for the pool creator `me`: both ATAs, collect, unwrap any SOL side. */
export function cpmmCreatorFeeInstructions(me, poolAddr, pool) {
  const owner = pk(me);
  const [mintA, mintB, progA, progB] = [pool.mintA, pool.mintB, pool.mintProgramA, pool.mintProgramB].map(pk);
  const ataA = getAssociatedTokenAddressSync(mintA, owner, false, progA);
  const ataB = getAssociatedTokenAddressSync(mintB, owner, false, progB);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ataA, owner, mintA, progA),
    createAssociatedTokenAccountIdempotentInstruction(owner, ataB, owner, mintB, progB),
    toEsm(R.makeCollectCreatorFeeInstruction(CPMM, owner, R.getPdaPoolAuthority(CPMM).publicKey, pk(poolAddr), pk(pool.configId),
      pk(pool.vaultA), pk(pool.vaultB), mintA, mintB, ataA, ataB, progA, progB)),
  ];
  if (pool.mintA === NATIVE_MINT) ixs.push(createCloseAccountInstruction(ataA, owner, owner, [], progA));
  if (pool.mintB === NATIVE_MINT) ixs.push(createCloseAccountInstruction(ataB, owner, owner, [], progB));
  return ixs;
}

/**
 * Raydium claims for `me`, without sending. [{ kind, instructions, amounts }]
 * - LaunchLab creator fee vault (seeds [creator, quote mint]): only the launch creator; it pools
 *   the creator fees of every launch by that creator on that quote mint, and the claim takes all.
 * - CPMM creator fee of the graduated pool: only the pool's recorded creator, only when the pool
 *   charges a creator fee and has some accrued. The CPMM program keeps its creator fee share
 *   (AmmConfig.creator_fee_share_rate or a CreatorFeeShare PDA) when the fee is collected, so the
 *   amounts here are what has accrued, not what arrives.
 * Throws a { code: 'not_creator' } error (via makeError) when `me` holds neither role.
 */
export async function buildRaydiumClaims(connection, d, me, makeError) {
  const L = d.state.launch;
  const cp = d.state.kind === 'raydium-cpmm' ? d.state.cpmm : null;
  const isLaunchCreator = L.creator === me;
  const isPoolCreator = Boolean(cp && cp.poolCreator === me);
  if (!isLaunchCreator && !isPoolCreator) {
    throw makeError('not_creator', `signer ${me} is neither the launch creator ${L.creator}${cp ? ` nor the pool creator ${cp.poolCreator}` : ''}`);
  }
  const out = [];
  if (isLaunchCreator) {
    const vault = creatorFeeVaultAddress(me, L.mintB);
    const held = readTokenAmount(vault, await connection.getAccountInfo(pk(vault)));
    if (held !== null && held > 0n) {
      out.push({ kind: 'launchlab_creator_fee', instructions: launchCreatorFeeInstructions(me, L.mintB, quoteProgramOf(L)), amounts: { quote: held.toString(), vault } });
    }
  }
  if (isPoolCreator) {
    const fresh = decodeCpmmPool(await connection.getAccountInfo(pk(d.state.cpmmAddr))) || cp;
    if (fresh.enableCreatorFee && (fresh.creatorFeesA > 0n || fresh.creatorFeesB > 0n)) {
      out.push({ kind: 'cpmm_creator_fee', instructions: cpmmCreatorFeeInstructions(me, d.state.cpmmAddr, fresh), amounts: { a: fresh.creatorFeesA.toString(), b: fresh.creatorFeesB.toString() } });
    }
  }
  return out;
}

/**
 * Extra pre-signing checks for the two Raydium programs (called by guardClaimInstructions):
 * only ClaimCreatorFee / CollectCreatorFee, the signer is the claiming creator, and the fees go to
 * the signer's own associated token accounts.
 */
export function guardRaydiumInstruction(ix, me, fail) {
  const pid = ix.programId.toBase58();
  const data = Buffer.from(ix.data);
  const key = (i) => (ix.keys[i] ? ix.keys[i].pubkey.toBase58() : null);
  const ataOf = (mintIdx, progIdx) => {
    const mint = key(mintIdx);
    const prog = key(progIdx);
    if (!mint || !TOKEN_PROGRAM_IDS.includes(prog)) return null;
    return getAssociatedTokenAddressSync(pk(mint), pk(me), false, pk(prog)).toBase58();
  };
  if (pid === PROGRAM_IDS.launchlab) {
    if (!data.equals(DISC.claimCreatorFee)) fail('claim refused: LaunchLab instruction other than ClaimCreatorFee');
    if (key(0) !== me || !ix.keys[0].isSigner) fail('claim refused: LaunchLab claim not signed by the signer as creator');
    if (key(3) !== ataOf(4, 5)) fail('claim refused: LaunchLab creator fee would go to another account');
    return;
  }
  if (pid === PROGRAM_IDS.raydiumCpmm) {
    if (!data.equals(DISC.collectCreatorFee)) fail('claim refused: CPMM instruction other than CollectCreatorFee');
    if (key(0) !== me || !ix.keys[0].isSigner) fail('claim refused: CPMM collect not signed by the signer as creator');
    if (key(8) !== ataOf(6, 10) || key(9) !== ataOf(7, 11)) fail('claim refused: CPMM creator fee would go to another account');
  }
}
