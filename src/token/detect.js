// Works out from chain data where the coin lives:
//   pump.fun  : bonding curve (pump program)  -> PumpSwap canonical pool after graduation
//   Raydium   : LaunchLab bonding curve       -> Raydium CPMM pool after graduation (raydium.js)
//   Meteora   : Dynamic Bonding Curve pool    -> DAMM v2 pool after migration
// Every program id, PDA and account layout comes from the installed SDKs.
// pump.fun and Raydium are found from PDAs of the mint (cheap reads); Meteora needs a program
// account scan, so it is tried last unless an earlier detection said the coin is on Meteora.
import { PublicKey } from '@solana/web3.js';
import { pump, pumpSwap, dbc, cpamm, cjsWeb3, PROGRAM_IDS, NATIVE_MINT } from './sdk.js';
import { readMint, metaplexMetadataPda, readMetaplexMetadata, readToken2022Metadata } from './chain.js';
import { detectRaydium } from './raydium.js';

const ZERO_KEY = '11111111111111111111111111111111';

function cjsKey(k) {
  return new cjsWeb3.PublicKey(typeof k === 'string' ? k : k.toBase58());
}
function b58(k) {
  return typeof k === 'string' ? k : k.toBase58();
}

/** Normalises a pump quote mint: the default (all zero) key on older curves means SOL. */
export function pumpQuoteMint(q) {
  const s = b58(q);
  return s === ZERO_KEY ? NATIVE_MINT : s;
}

async function readNameSymbol(connection, mintAddr, mint) {
  const fromExt = readToken2022Metadata(mint);
  if (fromExt) return fromExt;
  const info = await connection.getAccountInfo(metaplexMetadataPda(mintAddr));
  return readMetaplexMetadata(info) || { name: null, symbol: null, uri: '' };
}

async function detectPump(connection, ca) {
  const curveAddr = pump.bondingCurvePda(ca).toBase58();
  const curveInfo = await connection.getAccountInfo(new PublicKey(curveAddr));
  let curve = null;
  if (curveInfo && curveInfo.owner.toBase58() === PROGRAM_IDS.pump) {
    curve = pump.PUMP_SDK.decodeBondingCurve({ ...curveInfo, data: Buffer.from(curveInfo.data) });
  }
  const quoteMint = curve ? pumpQuoteMint(curve.quoteMint) : NATIVE_MINT;
  const poolAddr = pump.canonicalPumpPoolPdaWithQuote(cjsKey(ca), cjsKey(quoteMint)).toBase58();

  if (curve && !curve.complete) {
    return {
      platform: 'pumpfun', stage: 'curve', pool: curveAddr, quoteMint,
      creator: curve.creator.toBase58(),
      state: { kind: 'pump-curve', curveAddr, curve },
    };
  }
  // Curve complete (or no curve account at all): look for the PumpSwap canonical pool.
  const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddr));
  if (poolInfo && poolInfo.owner.toBase58() === PROGRAM_IDS.pumpAmm) {
    const pool = pumpSwap.PUMP_AMM_SDK.decodePool({ ...poolInfo, data: Buffer.from(poolInfo.data) });
    if (pool.baseMint.toBase58() === ca) {
      return {
        platform: 'pumpfun', stage: 'graduated', pool: poolAddr, quoteMint: pool.quoteMint.toBase58(),
        creator: pool.coinCreator.toBase58(),
        state: { kind: 'pump-pool', poolAddr, pool, curveAddr: curve ? curveAddr : null, curve },
      };
    }
  }
  if (curve) {
    // Complete curve whose pool is not there yet: the short window while it migrates.
    return {
      platform: 'pumpfun', stage: 'graduated', pool: null, migrating: true, quoteMint,
      creator: curve.creator.toBase58(),
      state: { kind: 'pump-migrating', curveAddr, curve },
    };
  }
  return null;
}

function dammPoolCandidates(config, baseMint, quoteMint) {
  const list = dbc.DAMM_V2_MIGRATION_FEE_ADDRESS;
  const idx = Number(config.migrationFeeOption);
  const order = Number.isInteger(idx) && list[idx] ? [list[idx], ...list.filter((_, i) => i !== idx)] : list;
  return order.map((cfg) => dbc.deriveDammV2PoolAddress(cfg, new PublicKey(baseMint), new PublicKey(quoteMint)));
}

async function findDammPool(connection, cp, ca, quoteMint, config) {
  const cands = config ? dammPoolCandidates(config, ca, quoteMint) : [];
  if (cands.length) {
    const infos = await connection.getMultipleAccountsInfo(cands);
    for (let i = 0; i < cands.length; i++) {
      const info = infos[i];
      if (!info || info.owner.toBase58() !== PROGRAM_IDS.dammV2) continue;
      const state = cp._program.coder.accounts.decode('pool', Buffer.from(info.data));
      return { address: cands[i].toBase58(), state };
    }
  }
  // Fallback: scan DAMM v2 pools whose token A is this mint and token B the quote.
  const found = await cp.fetchPoolStatesByTokenAMint(new PublicKey(ca));
  const hit = found.find((p) => p.account.tokenBMint.toBase58() === quoteMint) || found[0];
  return hit ? { address: hit.publicKey.toBase58(), state: hit.account } : null;
}

async function detectMeteora(connection, ca, hint) {
  const client = new dbc.DynamicBondingCurveClient(connection, 'confirmed');
  let poolAddr = hint && hint.dbcPool;
  let poolState = null;
  if (poolAddr) {
    const p = await client.state.getPool(poolAddr);
    poolState = p ? p.poolState : null;
  }
  if (!poolState) {
    const found = await client.state.getPoolByBaseMint(new PublicKey(ca));
    if (found) {
      poolAddr = found.publicKey.toBase58();
      poolState = found.account.poolState;
    }
  }
  const cp = new cpamm.CpAmm(connection);
  if (!poolState) {
    // No DBC pool: a DAMM v2 pool against SOL may still exist (coin launched straight on DAMM v2).
    const damm = await findDammPool(connection, cp, ca, NATIVE_MINT, null);
    if (!damm) return null;
    return {
      platform: 'meteora', stage: 'graduated', pool: damm.address, quoteMint: damm.state.tokenBMint.toBase58(),
      creator: damm.state.creator.toBase58(),
      state: { kind: 'damm', dammAddr: damm.address, damm: damm.state, dbcAddr: null, dbc: null, config: null },
    };
  }
  if (poolState.baseMint.toBase58() !== ca) return null;
  const config = await client.state.getPoolConfig(poolState.config);
  if (!config) return null;
  const quoteMint = config.quoteMint.toBase58();
  const base = { platform: 'meteora', quoteMint, creator: poolState.creator.toBase58(), feeClaimer: config.feeClaimer.toBase58() };
  if (Number(poolState.isMigrated) === 0) {
    return { ...base, stage: 'curve', pool: poolAddr, state: { kind: 'dbc', dbcAddr: poolAddr, dbc: poolState, config } };
  }
  const damm = await findDammPool(connection, cp, ca, quoteMint, config);
  if (!damm) {
    return { ...base, stage: 'graduated', pool: null, migrating: true, state: { kind: 'dbc-migrating', dbcAddr: poolAddr, dbc: poolState, config } };
  }
  return {
    ...base, stage: 'graduated', pool: damm.address,
    state: { kind: 'damm', dammAddr: damm.address, damm: damm.state, dbcAddr: poolAddr, dbc: poolState, config },
  };
}

/**
 * detectToken({ connection, ca, hint }) -> { ok: true, platform, stage, pool, symbol, name, ... }
 *                                         | { ok: false, reason }
 * hint: { platform, dbcPool } from an earlier detection: that platform is tried first, and a known
 * DBC pool skips the Meteora program scan.
 */
export async function detectToken({ connection, ca, hint = null }) {
  let mintKey;
  try {
    mintKey = new PublicKey(ca);
  } catch {
    return { ok: false, reason: 'invalid_ca' };
  }
  const mintInfo = await connection.getAccountInfo(mintKey);
  if (!mintInfo) return { ok: false, reason: 'mint_not_found' };
  const mint = readMint(ca, mintInfo);
  if (!mint) return { ok: false, reason: 'not_a_mint' };

  const finders = { pumpfun: () => detectPump(connection, ca), raydium: () => detectRaydium(connection, ca), meteora: () => detectMeteora(connection, ca, hint) };
  const order = ['pumpfun', 'raydium', 'meteora'];
  if (hint && finders[hint.platform]) order.sort((a, b) => (b === hint.platform) - (a === hint.platform));
  let found = null;
  for (const p of order) {
    found = await finders[p]();
    if (found) break;
  }
  if (!found) return { ok: false, reason: 'unknown_platform' };

  const meta = await readNameSymbol(connection, ca, mint);
  return {
    ok: true,
    ...found,
    ca,
    name: meta.name,
    symbol: meta.symbol,
    mint: { supply: mint.supply, decimals: mint.decimals, tokenProgram: mint.tokenProgram },
  };
}
