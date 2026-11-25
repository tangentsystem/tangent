// Captures real mainnet accounts for the token layer's offline fixtures.
//
//   node src/token/testkit/capture-mainnet.js <rpc url> <mint> [<mint> ...]
//
// For each mint it runs the real detect() and stats() through a recording connection and writes
// src/token/fixtures/mainnet/<mint>.json: every RPC answer it needed, plus what the code read
// (platform, stage, pool, symbol, price in SOL). Read only: it sends nothing. Tests only.
// For a Raydium coin it also builds (never sends) the creator fee claims for the launch creator and
// the CPMM pool creator, and reads the launch's GlobalConfig, PlatformConfig and the platform's
// CPMM AmmConfig, so those real accounts are in the fixture too.
// It also saves the Pyth SOL/USD feed account (pyth-sol-usd.json).
// Outbound HTTPS from a proxied shell needs NODE_USE_ENV_PROXY=1 (Node >= 22.21).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { createToken, detectToken, buildClaims } from '../index.js';
import { decodePlatformConfig } from '../raydium.js';
import { PYTH_SOL_USD_ACCOUNT } from '../price.js';
import { recordingConnection } from './recorded-connection.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mainnet');
const [rpc, ...mints] = process.argv.slice(2);
if (!rpc || !mints.length) { console.error('usage: capture-mainnet.js <rpc url> <mint> [...]'); process.exit(2); }
const real = new Connection(rpc, 'confirmed');
await fs.mkdir(OUT, { recursive: true });
const quiet = { warn() {}, info() {}, error() {} };
const j = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);

for (const mint of mints) {
  const rec = recordingConnection(real);
  const slot = await real.getSlot('confirmed');
  const tok = createToken({ connection: rec.connection, ca: mint, log: quiet, solUsd: { get: async () => ({ solUsd: 100, source: 'fixed', updatedAt: 0 }) } });
  const d = await tok.detect();
  const s = await tok.stats();
  const extra = {};
  if (d.platform === 'raydium') {
    const full = await detectToken({ connection: rec.connection, ca: mint });
    const L = full.state.launch;
    extra.launch = { creator: L.creator, configId: L.configId, platformId: L.platformId, cpmmCreator: full.cpmmCreator || null };
    extra.claims = {};
    for (const who of new Set([L.creator, full.cpmmCreator].filter(Boolean))) {
      const claims = await buildClaims(rec.connection, full, who);
      extra.claims[who] = claims.map((c) => ({ kind: c.kind, amounts: c.amounts }));
    }
    const plat = decodePlatformConfig(await rec.connection.getAccountInfo(new PublicKey(L.platformId)));
    await rec.connection.getAccountInfo(new PublicKey(L.configId));
    if (plat) await rec.connection.getAccountInfo(new PublicKey(plat.cpConfigId));
  }
  const doc = {
    mint, capturedAt: new Date().toISOString(), slot,
    read: { platform: d.platform, stage: d.stage, migrating: Boolean(d.migrating), pool: d.pool, symbol: d.symbol, name: d.name, priceSol: s.priceSol ?? null, supply: s.supply || null, reason: d.reason || s.reason || null },
    ...(Object.keys(extra).length ? { extra } : {}),
    calls: rec.calls(),
  };
  await fs.writeFile(path.join(OUT, `${mint}.json`), j(doc) + '\n');
  console.log(mint, j(doc.read).replace(/\s+/g, ' '));
  await new Promise((r) => setTimeout(r, 2000));
}
const pyth = await real.getAccountInfo(new PublicKey(PYTH_SOL_USD_ACCOUNT), 'confirmed');
await fs.writeFile(path.join(OUT, 'pyth-sol-usd.json'), j({ account: PYTH_SOL_USD_ACCOUNT, capturedAt: new Date().toISOString(), owner: pyth.owner.toBase58(), data: Buffer.from(pyth.data).toString('base64') }) + '\n');
console.log('pyth feed account saved');
