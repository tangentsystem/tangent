// One place that loads the launchpad SDKs (pump.fun, Meteora, Raydium).
//
// The pump.fun SDKs only work through their CommonJS builds (the ESM build of @pump-fun/pump-sdk
// fails to import named exports from @coral-xyz/anchor), so the pump side, together with the
// web3.js and spl-token copies it uses, is loaded with require(). The Meteora SDKs are ESM.
// @raydium-io/raydium-sdk-v2 has no "exports" map, so Node loads its CommonJS main build
// (lib/index.js); its own ESM file (lib/index.mjs) does not load in Node (named import from bn.js).
// Only its layouts, PDA helpers, program ids, curve maths and instruction builders are used here.
// Values cross between the two sides as base58 strings, never as class instances.
import { createRequire } from 'node:module';
import * as dbc from '@meteora-ag/dynamic-bonding-curve-sdk';
import * as cpamm from '@meteora-ag/cp-amm-sdk';
import * as raydium from '@raydium-io/raydium-sdk-v2';
import * as web3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';

const require = createRequire(import.meta.url);

export const pump = require('@pump-fun/pump-sdk');
export const pumpSwap = require('@pump-fun/pump-swap-sdk');
/** web3.js / spl-token as the pump SDKs see them (CommonJS copies). */
export const cjsWeb3 = require('@solana/web3.js');
export const cjsSplToken = require('@solana/spl-token');
export const CjsBN = require('bn.js');

export { dbc, cpamm, raydium, web3, splToken };

/** Program ids, all taken from the SDKs. Base58 strings. */
export const PROGRAM_IDS = Object.freeze({
  pump: pump.PUMP_PROGRAM_ID.toBase58(),
  pumpAmm: pump.PUMP_AMM_PROGRAM_ID.toBase58(),
  pumpFees: pump.PUMP_FEE_PROGRAM_ID.toBase58(),
  dbc: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
  dammV2: cpamm.CP_AMM_PROGRAM_ID.toBase58(),
  // Raydium LaunchLab (the SDK calls it "launchpad") and Raydium CPMM (CP-Swap), mainnet ids
  launchlab: raydium.LAUNCHPAD_PROGRAM.toBase58(),
  raydiumCpmm: raydium.CREATE_CPMM_POOL_PROGRAM.toBase58(),
  metaplex: dbc.METAPLEX_PROGRAM_ID.toBase58(),
  token: splToken.TOKEN_PROGRAM_ID.toBase58(),
  token2022: splToken.TOKEN_2022_PROGRAM_ID.toBase58(),
  ata: splToken.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  system: web3.SystemProgram.programId.toBase58(),
  computeBudget: web3.ComputeBudgetProgram.programId.toBase58(),
});

if (cpamm.CP_AMM_PROGRAM_ID.toBase58() !== dbc.DAMM_V2_PROGRAM_ID.toBase58()) {
  // The DBC SDK migrates into the DAMM v2 program the cp-amm SDK talks to. If a future SDK pair
  // ever disagrees, fail loudly instead of reading the wrong program.
  throw new Error('token: DAMM v2 program id differs between the DBC and cp-amm SDKs');
}

/** Quote mints the token layer can price. SOL-like ones need SOL/USD, stable ones are 1 USD. */
export const SOL_LIKE_QUOTES = new Set(pump.SOL_LIKE_QUOTE_MINTS.map((k) => k.toBase58()));
export const STABLE_QUOTES = new Set([
  ...pump.STABLE_QUOTE_MINTS.map((k) => k.toBase58()),
  ...pumpSwap.STABLE_QUOTE_MINTS.map((k) => k.toBase58()),
]);
export const NATIVE_MINT = splToken.NATIVE_MINT.toBase58();
