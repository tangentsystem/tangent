// Token layer: one contract address (TOKEN_CA), works for pump.fun, Raydium LaunchLab and Meteora
// coins, before and after graduation.
//
// createToken({ connection, ca, log, fetch, now }) -> { detect(), stats(), buyUrl(), claimFees({ signer }), router }
// With no CA every call returns { configured: false } and the router says nothing else.
import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { detectToken } from './detect.js';
import { readPrice, computeStats, quoteKind } from './stats.js';
import { createSolUsd } from './price.js';
import { claimAll, ClaimError } from './claim.js';
import { BUY_URL_BASE as RAYDIUM_BUY_URL_BASE } from './raydium.js';

export { detectToken } from './detect.js';
export { guardClaimInstructions, buildClaims, ClaimError } from './claim.js';
export { reservePrice, sqrtPriceToPrice, computeStats } from './stats.js';
export { createSolUsd } from './price.js';
export { detectRaydium, launchCurvePrice, RAYDIUM_UI_PLATFORM } from './raydium.js';

export const SOLSCAN = 'https://solscan.io';

export function buyUrlFor(platform, ca) {
  if (!ca) return null;
  if (platform === 'pumpfun') return `https://pump.fun/coin/${ca}`;
  if (platform === 'meteora') return `https://jup.ag/tokens/${ca}`;
  // Raydium's LaunchLab token page; after graduation the same page trades through Raydium's swap
  // routing, so the link does not change with the stage.
  if (platform === 'raydium') return `${RAYDIUM_BUY_URL_BASE}${ca}`;
  return null;
}

export function explorerLinks(ca, pool) {
  const out = { token: `${SOLSCAN}/token/${ca}` };
  if (pool) out.pool = `${SOLSCAN}/account/${pool}`;
  return out;
}

function validCa(ca) {
  if (!ca) return null;
  try {
    return new PublicKey(String(ca).trim()).toBase58();
  } catch {
    return null;
  }
}

export function createToken({ connection, ca, log = console, fetch: fetchFn = globalThis.fetch, now = Date.now, solUsd = null, detectTtlMs = 15_000, statsTtlMs = 15_000 } = {}) {
  const raw = ca ? String(ca).trim() : '';
  const mintCa = validCa(raw);
  const configured = raw !== '';
  const price = solUsd || createSolUsd({ fetch: fetchFn, connection, now, log });
  let hint = null; // { platform, dbcPool } learned once, saves the program scan later
  let detCache = null; // { at, value }
  let statsCache = null;

  function notConfigured() {
    return { configured: false };
  }

  async function detectFull() {
    if (!configured) return null;
    if (!mintCa) return { ok: false, reason: 'invalid_ca' };
    if (!connection) return { ok: false, reason: 'no_connection' };
    if (detCache && now() - detCache.at < detectTtlMs) return detCache.value;
    let value;
    try {
      value = await detectToken({ connection, ca: mintCa, hint });
    } catch (err) {
      if (log && log.warn) log.warn('[token] detection failed: ' + (err && err.message));
      value = { ok: false, reason: 'rpc_error' };
    }
    if (value.ok) hint = { platform: value.platform, dbcPool: value.state && value.state.dbcAddr ? value.state.dbcAddr : null };
    detCache = { at: now(), value };
    return value;
  }

  function publicDetection(d) {
    if (!d.ok) return { configured: true, ca: mintCa || raw, available: false, reason: d.reason };
    const out = { configured: true, ca: mintCa, available: true, platform: d.platform, stage: d.stage, pool: d.pool, symbol: d.symbol, name: d.name };
    if (d.migrating) out.migrating = true;
    return out;
  }

  async function detect() {
    if (!configured) return notConfigured();
    return publicDetection(await detectFull());
  }

  async function stats() {
    if (!configured) return notConfigured();
    if (statsCache && now() - statsCache.at < statsTtlMs) return statsCache.value;
    const d = await detectFull();
    let value;
    if (!d.ok) value = { configured: true, available: false, reason: d.reason };
    else {
      // who the coin is, for the site's token block (symbol and buy link), also when no price is available
      const id = { symbol: d.symbol, name: d.name, pool: d.pool, buyUrl: buyUrlFor(d.platform, mintCa) };
      try {
        const p = await readPrice(connection, d);
        const quote = quoteKind(d.quoteMint);
        const sol = quote === 'SOL' ? await price.get() : null;
        const s = computeStats({
          priceQuote: p.priceQuote, quote, solUsd: sol ? sol.solUsd : null,
          totalRaw: d.mint.supply, circulatingRaw: p.circulatingRaw, decimals: d.mint.decimals,
        });
        value = { configured: true, platform: d.platform, stage: d.stage, ...id, quote, ...s, updatedAt: new Date(now()).toISOString() };
      } catch (err) {
        if (log && log.warn) log.warn('[token] stats failed: ' + (err && err.message));
        value = { configured: true, platform: d.platform, stage: d.stage, ...id, available: false, reason: 'rpc_error' };
      }
    }
    statsCache = { at: now(), value };
    return value;
  }

  function buyUrl() {
    if (!configured || !mintCa) return null;
    const platform = detCache && detCache.value.ok ? detCache.value.platform : hint && hint.platform;
    return buyUrlFor(platform, mintCa);
  }

  async function claimFees({ signer } = {}) {
    if (!configured) return notConfigured();
    if (!signer || !signer.publicKey) throw new ClaimError('signer', 'claimFees needs { signer }');
    detCache = null; // claim against fresh state
    const d = await detectFull();
    if (!d.ok) throw new ClaimError(d.reason, 'token not detected: ' + d.reason);
    const res = await claimAll(connection, d, signer);
    statsCache = null;
    return { configured: true, platform: d.platform, stage: d.stage, ...res, explorer: res.signatures.map((s) => `${SOLSCAN}/tx/${s}`) };
  }

  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', async (req, res) => {
    if (!configured) return res.json({ configured: false });
    const d = await detectFull();
    const det = publicDetection(d);
    const body = {
      configured: true,
      ca: det.ca,
      available: det.available,
      platform: det.platform || null,
      stage: det.stage || null,
      symbol: det.symbol || null,
      name: det.name || null,
      priceUsd: null,
      marketCapUsd: null,
      buyUrl: d.ok ? buyUrlFor(d.platform, mintCa) : null,
      explorer: mintCa ? explorerLinks(mintCa, d.ok ? d.pool : null) : null,
    };
    if (det.migrating) body.migrating = true;
    if (!d.ok) body.reason = d.reason;
    else {
      const s = await stats();
      if (s.available) {
        body.priceUsd = s.priceUsd;
        body.marketCapUsd = s.marketCapUsd;
      } else body.priceReason = s.reason;
    }
    res.json(body);
  });

  return { configured, ca: mintCa, detect, stats, buyUrl, claimFees, router };
}
