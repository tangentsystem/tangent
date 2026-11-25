// Price and market cap maths against hand computed fixtures, and the SOL/USD source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservePrice, sqrtPriceToPrice, uiString, uiAmount, computeStats, sdkPrice, quoteKind } from './stats.js';
import { createSolUsd, GECKO_URL, PYTH_SOL_USD_ID, PYTH_SOL_USD_ACCOUNT, PYTH_RECEIVER_PROGRAM, decodePythPriceUpdate } from './price.js';
import { PublicKey } from '@solana/web3.js';
import { buyUrlFor, explorerLinks } from './index.js';

const close = (a, b, rel = 1e-12) => Math.abs(a - b) <= Math.abs(b) * rel;

test('reserve price: decimals handled exactly', () => {
  // 30 SOL (9 dec) / 1,073,000,000 tokens (6 dec)
  assert.ok(close(reservePrice({ quoteReserve: 30_000_000_000n, baseReserve: 1_073_000_000_000_000n, baseDecimals: 6, quoteDecimals: 9 }), 30 / 1_073_000_000));
  // 1 USDC (6 dec) per 4 tokens (9 dec)
  assert.equal(reservePrice({ quoteReserve: 1_000_000n, baseReserve: 4_000_000_000n, baseDecimals: 9, quoteDecimals: 6 }), 0.25);
  assert.equal(reservePrice({ quoteReserve: 1n, baseReserve: 0n, baseDecimals: 6, quoteDecimals: 9 }), null);
});

test('sqrt price: Q64.64 to price, equal to both SDK helpers', () => {
  const ONE = 1n << 64n;
  // sqrt price 1.0 with 6 base / 9 quote decimals: 1 raw/raw = 0.001 SOL per token
  assert.ok(close(sqrtPriceToPrice(ONE, 6, 9), 0.001));
  // sqrt price 2.0 equal decimals: price 4
  assert.ok(close(sqrtPriceToPrice(2n * ONE, 9, 9), 4));
  // realistic tiny price
  const s = 4295048016n * 1000n;
  assert.ok(close(sqrtPriceToPrice(s, 6, 9), sdkPrice.dbc(s.toString(), 6, 9), 1e-9));
  assert.ok(close(sqrtPriceToPrice(s, 6, 9), sdkPrice.damm(s.toString(), 6, 9), 1e-9));
  assert.equal(sqrtPriceToPrice(0n, 6, 9), null);
});

test('amount formatting keeps every digit', () => {
  assert.equal(uiString(1_000_000_000_000_000n, 6), '1000000000');
  assert.equal(uiString(123_456_789n, 6), '123.456789');
  assert.equal(uiString(100n, 6), '0.0001');
  assert.equal(uiAmount(1_500_000n, 6), 1.5);
});

test('market cap: price times total supply in USD', () => {
  const s = computeStats({ priceQuote: 2e-8, quote: 'SOL', solUsd: 200, totalRaw: 10n ** 15n, circulatingRaw: 4n * 10n ** 14n, decimals: 6 });
  assert.equal(s.available, true);
  assert.ok(close(s.priceUsd, 4e-6));
  assert.ok(close(s.marketCapUsd, 4000));
  assert.equal(s.supply.circulating, '400000000');
  const usd = computeStats({ priceQuote: 0.5, quote: 'USD', solUsd: null, totalRaw: 10n ** 9n, circulatingRaw: 10n ** 9n, decimals: 6 });
  assert.equal(usd.priceUsd, 0.5);
  assert.equal(usd.marketCapUsd, 500);
  assert.equal(usd.priceSol, null);
});

test('no invented numbers: missing SOL/USD or unsupported quote is unavailable', () => {
  const a = computeStats({ priceQuote: 2e-8, quote: 'SOL', solUsd: null, totalRaw: 1n, circulatingRaw: 1n, decimals: 0 });
  assert.equal(a.available, false);
  assert.equal(a.reason, 'sol_usd_unavailable');
  assert.equal(a.priceUsd, undefined);
  assert.equal(a.priceSol, 2e-8);
  const b = computeStats({ priceQuote: 1, quote: null, solUsd: 100, totalRaw: 1n, circulatingRaw: 1n, decimals: 0 });
  assert.equal(b.reason, 'unsupported_quote');
  assert.equal(quoteKind('So11111111111111111111111111111111111111112'), 'SOL');
  assert.equal(quoteKind('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'USD');
});

function fakeFetch(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const v = map[url];
    if (v instanceof Error) throw v;
    if (!v) return { ok: false, status: 500 };
    return { ok: true, json: async () => v };
  };
  fn.calls = calls;
  return fn;
}

function fakePythConnection({ price, expo, publishTime, feed = PYTH_SOL_USD_ID, level = 1, owner = PYTH_RECEIVER_PROGRAM }) {
  const b = Buffer.alloc(134);
  let o = 8 + 32;
  b[o++] = level; if (level === 0) b[o++] = 3;
  Buffer.from(feed, 'hex').copy(b, o); o += 32;
  b.writeBigInt64LE(price, o); o += 8; b.writeBigUInt64LE(1000n, o); o += 8; b.writeInt32LE(expo, o); o += 4; b.writeBigInt64LE(BigInt(publishTime), o);
  return { getAccountInfo: async (k) => (k.toBase58() === PYTH_SOL_USD_ACCOUNT ? { owner: new PublicKey(owner), data: b } : null) };
}

test('pyth PriceUpdateV2 decoding (full and partial verification)', () => {
  const c = fakePythConnection({ price: 6774664365n, expo: -8, publishTime: 1795000000 });
  return c.getAccountInfo(new PublicKey(PYTH_SOL_USD_ACCOUNT)).then((info) => {
    const u = decodePythPriceUpdate(info.data);
    assert.deepEqual({ ...u, price: String(u.price), conf: String(u.conf) }, { verification: 'full', feedId: PYTH_SOL_USD_ID, price: '6774664365', conf: '1000', exponent: -8, publishTime: 1795000000 });
  });
});

test('SOL/USD: CoinGecko first, Pyth fallback, cache, staleness limit', async () => {
  let t = 1_000_000;
  const now = () => t;
  const f1 = fakeFetch({ [GECKO_URL]: { solana: { usd: 151.5 } } });
  const p1 = createSolUsd({ fetch: f1, now, log: null });
  assert.equal((await p1.get()).solUsd, 151.5);
  await p1.get();
  assert.equal(f1.calls.length, 1); // cached

  // CoinGecko down: Pyth's on-chain feed account (PriceUpdateV2 layout as read live on mainnet)
  const f2 = fakeFetch({ [GECKO_URL]: new Error('down') });
  const pyth = (o = {}) => fakePythConnection({ price: 14250000000n, expo: -8, publishTime: Math.floor(t / 1000) - 5, ...o });
  const p2 = createSolUsd({ fetch: f2, connection: pyth(), now, log: null });
  const v = await p2.get();
  assert.equal(v.source, 'pyth');
  assert.ok(close(v.solUsd, 142.5));
  // a stale, foreign or partly verified Pyth account is never used
  for (const bad of [{ publishTime: Math.floor(t / 1000) - 3600 }, { feed: 'ab'.repeat(32) }, { level: 0 }, { owner: PYTH_SOL_USD_ACCOUNT }]) {
    assert.equal(await createSolUsd({ fetch: f2, connection: pyth(bad), now, log: null }).get(), null, JSON.stringify(bad));
  }
  // no connection: CoinGecko only
  assert.equal(await createSolUsd({ fetch: f2, now, log: null }).get(), null);

  // both down from the start: null, never a made up number
  const p3 = createSolUsd({ fetch: fakeFetch({}), now, log: null });
  assert.equal(await p3.get(), null);

  // good value, then sources fail: last value served until it is too old
  let up = true;
  const f4 = async (url) => (up && url === GECKO_URL ? { ok: true, json: async () => ({ solana: { usd: 100 } }) } : { ok: false, status: 503 });
  const p4 = createSolUsd({ fetch: f4, now, ttlMs: 1000, maxStaleMs: 5000, log: null });
  assert.equal((await p4.get()).solUsd, 100);
  up = false;
  t += 2000;
  assert.equal((await p4.get()).solUsd, 100);
  t += 10_000;
  assert.equal(await p4.get(), null);

  // nonsense values rejected
  const p5 = createSolUsd({ fetch: fakeFetch({ [GECKO_URL]: { solana: { usd: -3 } } }), now, log: null });
  assert.equal(await p5.get(), null);
});

test('buy links and explorer links', () => {
  const ca = 'So11111111111111111111111111111111111111112';
  assert.equal(buyUrlFor('pumpfun', ca), `https://pump.fun/coin/${ca}`);
  assert.equal(buyUrlFor('meteora', ca), `https://jup.ag/tokens/${ca}`);
  assert.equal(buyUrlFor(undefined, ca), null);
  assert.deepEqual(explorerLinks(ca, 'P1'), { token: `https://solscan.io/token/${ca}`, pool: 'https://solscan.io/account/P1' });
});
