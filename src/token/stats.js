// Price, market cap and supply from the pool or curve the coin is on.
// Pure maths first (unit tested against hand computed fixtures), then the chain reads.
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { dbc, cpamm, SOL_LIKE_QUOTES, STABLE_QUOTES } from './sdk.js';
import { readMint, readTokenAmount } from './chain.js';
import { readRaydiumPrice, launchCurvePrice } from './raydium.js';

const SCALE = 10n ** 18n;

function big(v) {
  if (typeof v === 'bigint') return v;
  if (v && typeof v.toString === 'function') return BigInt(v.toString());
  return BigInt(v);
}

/** Price of one whole token in whole quote units, from raw reserves. Number, or null. */
export function reservePrice({ quoteReserve, baseReserve, baseDecimals, quoteDecimals }) {
  const q = big(quoteReserve);
  const b = big(baseReserve);
  if (b <= 0n || q < 0n) return null;
  const num = q * 10n ** BigInt(baseDecimals) * SCALE;
  const den = b * 10n ** BigInt(quoteDecimals);
  return Number(num / den) / 1e18 + Number(num % den) / Number(den) / 1e18;
}

/** Price of one whole base token in whole quote units from a Q64.64 sqrt price (DBC and DAMM v2). */
export function sqrtPriceToPrice(sqrtPrice, baseDecimals, quoteDecimals) {
  const s = big(sqrtPrice);
  if (s <= 0n) return null;
  // (s / 2^64)^2 * 10^(baseDec - quoteDec), done in BigInt then scaled down.
  const sq = s * s; // Q128
  const exp = baseDecimals - quoteDecimals;
  let num = sq * SCALE;
  let den = 1n << 128n;
  if (exp >= 0) num *= 10n ** BigInt(exp);
  else den *= 10n ** BigInt(-exp);
  return Number(num / den) / 1e18 + Number(num % den) / Number(den) / 1e18;
}

/** Whole-token amount as a Number for display maths. */
export function uiAmount(raw, decimals) {
  const r = big(raw);
  const d = 10n ** BigInt(decimals);
  return Number(r / d) + Number(r % d) / Number(d);
}

/** Decimal string of a raw amount (no float rounding). */
export function uiString(raw, decimals) {
  const r = big(raw);
  const neg = r < 0n;
  const a = neg ? -r : r;
  const d = 10n ** BigInt(decimals);
  const whole = (a / d).toString();
  if (!decimals) return (neg ? '-' : '') + whole;
  const frac = (a % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

export function quoteKind(quoteMint) {
  if (SOL_LIKE_QUOTES.has(quoteMint)) return 'SOL';
  if (STABLE_QUOTES.has(quoteMint)) return 'USD';
  return null;
}

/**
 * From a priced detection build the display numbers.
 * input: { priceQuote, quote: 'SOL'|'USD'|null, solUsd: number|null, totalRaw, circulatingRaw, decimals }
 */
export function computeStats({ priceQuote, quote, solUsd, totalRaw, circulatingRaw, decimals }) {
  const supply = {
    total: uiString(totalRaw, decimals),
    circulating: uiString(circulatingRaw, decimals),
    totalRaw: big(totalRaw).toString(),
    circulatingRaw: big(circulatingRaw).toString(),
    decimals,
  };
  if (priceQuote === null || !Number.isFinite(priceQuote)) return { available: false, reason: 'no_price', supply };
  if (!quote) return { available: false, reason: 'unsupported_quote', supply };
  const priceSol = quote === 'SOL' ? priceQuote : null;
  let priceUsd = null;
  if (quote === 'USD') priceUsd = priceQuote;
  else if (solUsd !== null && solUsd !== undefined) priceUsd = priceQuote * solUsd;
  if (priceUsd === null) return { available: false, reason: 'sol_usd_unavailable', priceSol, supply };
  const marketCapUsd = priceUsd * uiAmount(totalRaw, decimals);
  return { available: true, priceSol, priceUsd, marketCapUsd, solUsd: quote === 'SOL' ? solUsd : null, supply };
}

async function quoteDecimals(connection, quoteMint) {
  if (SOL_LIKE_QUOTES.has(quoteMint)) return 9;
  const info = await connection.getAccountInfo(new PublicKey(quoteMint));
  const m = readMint(quoteMint, info);
  if (!m) throw new Error('quote mint not readable');
  return m.decimals;
}

/**
 * Reads what the detected stage needs and returns { priceQuote, circulatingRaw }.
 * `d` is a successful detectToken() result.
 */
export async function readPrice(connection, d) {
  const { state, mint, ca } = d;
  const baseDec = mint.decimals;
  const qDec = await quoteDecimals(connection, d.quoteMint);
  const total = big(mint.supply);

  if (state.kind === 'pump-curve' || state.kind === 'pump-migrating') {
    const c = state.curve;
    const priceQuote = reservePrice({ quoteReserve: c.virtualQuoteReserves, baseReserve: c.virtualTokenReserves, baseDecimals: baseDec, quoteDecimals: qDec });
    const curveAta = getAssociatedTokenAddressSync(new PublicKey(ca), new PublicKey(state.curveAddr), true, new PublicKey(mint.tokenProgram));
    const held = readTokenAmount(curveAta, await connection.getAccountInfo(curveAta));
    const circulatingRaw = held === null ? total : total - held;
    return { priceQuote, circulatingRaw, quoteDecimals: qDec };
  }
  if (state.kind === 'pump-pool') {
    const p = state.pool;
    const [bInfo, qInfo] = await connection.getMultipleAccountsInfo([
      new PublicKey(p.poolBaseTokenAccount.toBase58()),
      new PublicKey(p.poolQuoteTokenAccount.toBase58()),
    ]);
    const baseRes = readTokenAmount(p.poolBaseTokenAccount.toBase58(), bInfo);
    const quoteRes = readTokenAmount(p.poolQuoteTokenAccount.toBase58(), qInfo);
    if (baseRes === null || quoteRes === null) return { priceQuote: null, circulatingRaw: total, quoteDecimals: qDec };
    // PumpSwap prices against effective quote = vault balance + virtual quote reserves (signed i128).
    const effQuote = quoteRes + big(p.virtualQuoteReserves || 0);
    const priceQuote = reservePrice({ quoteReserve: effQuote, baseReserve: baseRes, baseDecimals: baseDec, quoteDecimals: qDec });
    return { priceQuote, circulatingRaw: total, quoteDecimals: qDec };
  }
  if (state.kind === 'dbc' || state.kind === 'dbc-migrating') {
    const priceQuote = sqrtPriceToPrice(state.dbc.sqrtPrice, baseDec, qDec);
    const circulatingRaw = state.kind === 'dbc' ? total - big(state.dbc.baseReserve) : total;
    return { priceQuote, circulatingRaw: circulatingRaw < 0n ? 0n : circulatingRaw, quoteDecimals: qDec };
  }
  if (d.platform === 'raydium') {
    // LaunchLab curve (curve type from its GlobalConfig, same formulas as the SDK's Curve.getPrice)
    // or the graduated CPMM pool (vault balances minus the fee counters, as the SDK prices it).
    const r = await readRaydiumPrice(connection, d, total);
    return { priceQuote: r.priceQuote, circulatingRaw: r.circulatingRaw, quoteDecimals: qDec };
  }
  if (state.kind === 'damm') {
    const s = state.damm;
    const aIsBase = s.tokenAMint.toBase58() === ca;
    let priceQuote;
    if (aIsBase) priceQuote = sqrtPriceToPrice(s.sqrtPrice, baseDec, qDec);
    else {
      const inv = sqrtPriceToPrice(s.sqrtPrice, qDec, baseDec);
      priceQuote = inv ? 1 / inv : null;
    }
    return { priceQuote, circulatingRaw: total, quoteDecimals: qDec };
  }
  return { priceQuote: null, circulatingRaw: total, quoteDecimals: qDec };
}

// The SDK helpers, re-exported so tests can cross check the BigInt maths against them.
export const sdkPrice = {
  launchlab: (args) => launchCurvePrice(args),
  dbc: (sqrtPrice, baseDec, quoteDec) => Number(dbc.getPriceFromSqrtPrice(sqrtPrice, baseDec, quoteDec).toString()),
  damm: (sqrtPrice, aDec, bDec) => Number(cpamm.getPriceFromSqrtPrice(sqrtPrice, aDec, bDec).toString()),
};
