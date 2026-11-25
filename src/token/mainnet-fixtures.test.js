// The token layer against REAL mainnet account bytes, offline.
//
// src/token/fixtures/mainnet/*.json were captured from Solana mainnet (public RPC, read only) with
// src/token/testkit/capture-mainnet.js on 25 November 2026. Each file holds every RPC answer that
// detect() and stats() needed for one coin, and what the code read at capture time. Here the same
// code runs again on those recorded bytes with no network, so a change that breaks decoding of the
// real program accounts (pump bonding curve, PumpSwap pool, Meteora DBC and DAMM v2, Raydium
// LaunchLab and CPMM, Token-2022 and Metaplex metadata, the Pyth feed account) fails this test.
// All files were captured again on 25 November 2026 when Raydium detection was added (it adds one
// batched read to every detection that is not pump.fun).
//
// The coins (verified on chain and cross checked against Jupiter's price API at capture time):
//   Gfcr8eAkCEvqPfTLqG6HTumNZtBzHNB9dKTwhrFpook  Meteora, graduated (DBC -> DAMM v2 pool RdcDer...)
//   GMk6j2defJhS7F194toqmJNFNhAkbDXhYJo5oR3Rpump  pump.fun, graduated to PumpSwap (canonical pool FDtu6W...)
//   CM3o3JYwVQ3gPAMjGnGWBkkPZjbd652MGhfMkbaRpump  pump.fun, still on the bonding curve (Token-2022 mint)
//   HnGHZTZBMsq91L31uuD1qqb2F6rAXUXNtixx2EEdiray  Raydium LaunchLab, on its curve since 24 Nov 2025
//   8MohwPY3hm8SJfQGi4KuDfKTMeisGhcGiTa7yEFabray  Raydium LaunchLab, graduated to CPMM (creator fee on)
//   9JK2U7aEkp3tWaFNuaJowWRgNys5DVaKGxWk73VT5ray  Raydium LaunchLab, graduated to CPMM in May 2025 (no creator fee)
// All three Raydium coins were launched on Raydium's own LaunchLab platform (4Bu96Xj...); their CPMM
// pools match the migrateAmmId Raydium's LaunchLab API reports for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToken } from './index.js';
import { decodePythPriceUpdate, PYTH_SOL_USD_ID, PYTH_RECEIVER_PROGRAM } from './price.js';
import { replayConnection } from './testkit/recorded-connection.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mainnet');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const quiet = { warn() {}, info() {}, error() {} };

const EXPECT = {
  Gfcr8eAkCEvqPfTLqG6HTumNZtBzHNB9dKTwhrFpook: { platform: 'meteora', stage: 'graduated', pool: 'RdcDerQ22sC6K5zb2B2CidhjJktAoXAAXvBcAv1PQYc', symbol: 'POOK' },
  GMk6j2defJhS7F194toqmJNFNhAkbDXhYJo5oR3Rpump: { platform: 'pumpfun', stage: 'graduated', pool: 'FDtu6W24K2iyW9Ce9NsTyVSmSGjxj2hHrTkKc2xFTxSL', symbol: 'Pumpswap' },
  CM3o3JYwVQ3gPAMjGnGWBkkPZjbd652MGhfMkbaRpump: { platform: 'pumpfun', stage: 'curve', pool: 'AbwsPbZsEM7km968oD7BNc6GR92c43PiiMdjdjdUCfbU', symbol: 'pokex' },
  HnGHZTZBMsq91L31uuD1qqb2F6rAXUXNtixx2EEdiray: { platform: 'raydium', stage: 'curve', pool: '7BzVSZxyuppehQ6P3hYN2UUukJbmi8zs5XELuyZNhTcM', symbol: 'CPTD' },
  '8MohwPY3hm8SJfQGi4KuDfKTMeisGhcGiTa7yEFabray': { platform: 'raydium', stage: 'graduated', pool: '8BELgBQ5vSDvBnUAyQ79qqijZ8Hcp6MGjEAD93dKC7GX', symbol: 'ALNOOR' },
  '9JK2U7aEkp3tWaFNuaJowWRgNys5DVaKGxWk73VT5ray': { platform: 'raydium', stage: 'graduated', pool: 'AuQtgm4tzdJSsZNGxrM1F69hxbyvMpNM95496pUuSBQg', symbol: 'NUMMUS' },
};
const BUY = {
  pumpfun: (m) => `https://pump.fun/coin/${m}`,
  meteora: (m) => `https://jup.ag/tokens/${m}`,
  raydium: (m) => `https://raydium.io/launchpad/token/?mint=${m}`,
};

for (const [mint, want] of Object.entries(EXPECT)) {
  test(`mainnet bytes: ${want.platform} ${want.stage} ${mint}`, async () => {
    const fx = load(`${mint}.json`);
    const { connection, missing } = replayConnection(fx.calls);
    const tok = createToken({ connection, ca: mint, log: quiet, solUsd: { get: async () => ({ solUsd: 100, source: 'fixed', updatedAt: 0 }) } });
    const d = await tok.detect();
    assert.deepEqual(missing, []);
    assert.equal(d.available, true, d.reason);
    assert.equal(d.platform, want.platform);
    assert.equal(d.stage, want.stage);
    assert.equal(d.pool, want.pool);
    assert.equal(d.symbol, want.symbol);
    assert.ok(!d.migrating);
    const s = await tok.stats();
    assert.equal(s.available, true, s.reason);
    assert.equal(s.priceSol, fx.read.priceSol);
    assert.ok(Math.abs(s.priceUsd - s.priceSol * 100) < 1e-12);
    assert.deepEqual(s.supply, fx.read.supply);
    assert.equal(tok.buyUrl(), BUY[want.platform](mint));
  });
}

test('mainnet bytes: Pyth SOL/USD feed account decodes', () => {
  const fx = load('pyth-sol-usd.json');
  assert.equal(fx.owner, PYTH_RECEIVER_PROGRAM);
  const u = decodePythPriceUpdate(Buffer.from(fx.data, 'base64'));
  assert.equal(u.feedId, PYTH_SOL_USD_ID);
  assert.equal(u.verification, 'full');
  assert.equal(u.exponent, -8);
  const usd = Number(u.price) * 10 ** u.exponent;
  assert.ok(usd > 1 && usd < 10_000, String(usd));
  assert.ok(Math.abs(u.publishTime * 1000 - Date.parse(fx.capturedAt)) < 10 * 60_000);
});
