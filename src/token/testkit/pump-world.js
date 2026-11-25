// Test helper: writes pump.fun accounts into LiteSVM, encoded with the pump SDKs' own Anchor
// coders (bonding curve, PumpSwap pool) and the SPL layouts (mints, token accounts, metadata).
// The pump programs themselves are not public binaries, so these accounts are data only.
import { PublicKey, Keypair } from '@solana/web3.js';
import { MintLayout, AccountLayout, MINT_SIZE, ACCOUNT_SIZE, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';
import { pump, cjsWeb3, PROGRAM_IDS } from '../sdk.js';
import { metaplexMetadataPda } from '../chain.js';

const offline = new cjsWeb3.Connection('http://127.0.0.1:1');
const pumpProgram = pump.getPumpProgram(offline);
const ammProgram = pump.getPumpAmmProgram(offline);
const cjs = (k) => new cjsWeb3.PublicKey(new PublicKey(k).toBase58());

function borshStr(s, padTo = 0) {
  const b = Buffer.from(s.padEnd(padTo, '\0'), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

export function encodeMint({ supply, decimals, mintAuthority = null }) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({
    mintAuthorityOption: mintAuthority ? 1 : 0, mintAuthority: mintAuthority || PublicKey.default,
    supply: BigInt(supply), decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, data);
  return data;
}

/** Token-2022 mint carrying a TokenMetadata extension (type 19), the way newer pump coins are created. */
export function encodeMint2022WithMetadata({ supply, decimals, mint, name, symbol, uri }) {
  const base = Buffer.alloc(165);
  encodeMint({ supply, decimals }).copy(base, 0);
  const meta = Buffer.concat([
    PublicKey.default.toBuffer(), new PublicKey(mint).toBuffer(),
    borshStr(name), borshStr(symbol), borshStr(uri), Buffer.from([0, 0, 0, 0]),
  ]);
  const tlv = Buffer.alloc(4);
  tlv.writeUInt16LE(19, 0);
  tlv.writeUInt16LE(meta.length, 2);
  return Buffer.concat([base, Buffer.from([1]), tlv, meta]);
}

export function encodeTokenAccount({ mint, owner, amount, tokenProgram = PROGRAM_IDS.token }) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint: new PublicKey(mint), owner: new PublicKey(owner), amount: BigInt(amount), delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  if (tokenProgram === PROGRAM_IDS.token2022) return Buffer.concat([data, Buffer.from([2])]);
  return data;
}

/** Metaplex Metadata v1 account bytes (key 4), fixed padded strings like the program writes. */
export function encodeMetaplex({ mint, name, symbol, uri }) {
  return Buffer.concat([
    Buffer.from([4]), PublicKey.default.toBuffer(), new PublicKey(mint).toBuffer(),
    borshStr(name, 32), borshStr(symbol, 10), borshStr(uri, 200), Buffer.alloc(64),
  ]);
}

export async function encodeBondingCurve(fields) {
  const full = {
    virtualTokenReserves: new BN(0), virtualQuoteReserves: new BN(0), realTokenReserves: new BN(0), realQuoteReserves: new BN(0),
    tokenTotalSupply: new BN(0), complete: false, creator: cjsWeb3.PublicKey.default, isMayhemMode: false, isCashbackCoin: false,
    quoteMint: cjsWeb3.PublicKey.default, creatorFeeBps: new BN(0), canEditCreatorFee: false, isHolderReward: false,
    creatorFee: new BN(0), protocolFees: new BN(0), depth: 0, initialVirtualQuoteReserves: new BN(0),
    postCompleteBaseOut: new BN(0), postCompleteQuoteIn: new BN(0), ...fields,
  };
  return pumpProgram.coder.accounts.encode('bondingCurve', full);
}

export async function encodePool(fields) {
  const full = {
    poolBump: 255, index: 0, creator: cjsWeb3.PublicKey.default, baseMint: cjsWeb3.PublicKey.default, quoteMint: cjsWeb3.PublicKey.default,
    lpMint: cjsWeb3.PublicKey.default, poolBaseTokenAccount: cjsWeb3.PublicKey.default, poolQuoteTokenAccount: cjsWeb3.PublicKey.default,
    lpSupply: new BN(0), coinCreator: cjsWeb3.PublicKey.default, isMayhemMode: false, isCashbackCoin: false,
    virtualQuoteReserves: new BN(0), creatorFeeBps: new BN(0), canEditCreatorFee: false, isHolderReward: false,
    protocolFees: new BN(0), creatorFees: new BN(0), ...fields,
  };
  return ammProgram.coder.accounts.encode('pool', full);
}

/**
 * Writes a pump coin on its bonding curve.
 * Default reserves are the pump.fun launch values: 1,073,000,000 tokens virtual, 30 SOL virtual.
 */
export async function writePumpCurve(conn, {
  creator, name = 'Pump Coin', symbol = 'PUMPC',
  virtualTokenReserves = 1_073_000_000_000_000n, virtualQuoteReserves = 30_000_000_000n,
  realTokenReserves = 793_100_000_000_000n, curveHolds = 1_000_000_000_000_000n - 0n, complete = false,
} = {}) {
  const mint = Keypair.generate().publicKey;
  conn.setAccount(mint, { data: encodeMint({ supply: 10n ** 15n, decimals: 6 }), owner: PROGRAM_IDS.token });
  conn.setAccount(metaplexMetadataPda(mint), { data: encodeMetaplex({ mint, name, symbol, uri: 'https://example.com/p.json' }), owner: PROGRAM_IDS.metaplex });
  const curve = new PublicKey(pump.bondingCurvePda(mint.toBase58()).toBase58());
  conn.setAccount(curve, {
    owner: PROGRAM_IDS.pump,
    data: await encodeBondingCurve({
      virtualTokenReserves: new BN(virtualTokenReserves.toString()), virtualQuoteReserves: new BN(virtualQuoteReserves.toString()),
      realTokenReserves: new BN(realTokenReserves.toString()), tokenTotalSupply: new BN((10n ** 15n).toString()),
      complete, creator: cjs(creator),
    }),
  });
  const curveAta = getAssociatedTokenAddressSync(mint, curve, true);
  conn.setAccount(curveAta, { data: encodeTokenAccount({ mint, owner: curve, amount: curveHolds }), owner: PROGRAM_IDS.token });
  return { mint, curve, curveAta };
}

/** Writes a graduated pump coin: complete curve + PumpSwap canonical pool with its two vaults. */
export async function writePumpPool(conn, {
  creator, name = 'Grad Coin', symbol = 'GRAD', baseReserve = 206_900_000_000_000n, quoteReserve = 84_990_000_000n,
  virtualQuote = 0n, withCreatorVault = 0n,
} = {}) {
  const mint = Keypair.generate().publicKey;
  conn.setAccount(mint, {
    data: encodeMint2022WithMetadata({ supply: 10n ** 15n, decimals: 6, mint, name, symbol, uri: 'https://example.com/g.json' }),
    owner: PROGRAM_IDS.token2022,
  });
  const curve = new PublicKey(pump.bondingCurvePda(mint.toBase58()).toBase58());
  conn.setAccount(curve, { owner: PROGRAM_IDS.pump, data: await encodeBondingCurve({ complete: true, creator: cjs(creator), virtualTokenReserves: new BN(1), virtualQuoteReserves: new BN(1) }) });
  const pool = new PublicKey(pump.canonicalPumpPoolPdaWithQuote(cjs(mint), cjs(NATIVE_MINT)).toBase58());
  const authority = new PublicKey(pump.pumpPoolAuthorityPda(cjs(mint)).toBase58());
  const baseVault = getAssociatedTokenAddressSync(mint, pool, true, new PublicKey(PROGRAM_IDS.token2022));
  const quoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, pool, true);
  conn.setAccount(baseVault, { data: encodeTokenAccount({ mint, owner: pool, amount: baseReserve, tokenProgram: PROGRAM_IDS.token2022 }), owner: PROGRAM_IDS.token2022 });
  conn.setAccount(quoteVault, { data: encodeTokenAccount({ mint: NATIVE_MINT, owner: pool, amount: quoteReserve }), owner: PROGRAM_IDS.token });
  conn.setAccount(pool, {
    owner: PROGRAM_IDS.pumpAmm,
    data: await encodePool({
      creator: cjs(authority), baseMint: cjs(mint), quoteMint: cjs(NATIVE_MINT), poolBaseTokenAccount: cjs(baseVault), poolQuoteTokenAccount: cjs(quoteVault),
      coinCreator: cjs(creator), virtualQuoteReserves: new BN(virtualQuote.toString()),
    }),
  });
  let creatorVaultAta = null;
  if (withCreatorVault > 0n) {
    const vaultAuth = new PublicKey(pump.ammCreatorVaultPda(cjs(creator)).toBase58());
    creatorVaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
    conn.setAccount(creatorVaultAta, { data: encodeTokenAccount({ mint: NATIVE_MINT, owner: vaultAuth, amount: withCreatorVault }), owner: PROGRAM_IDS.token });
  }
  return { mint, curve, pool, baseVault, quoteVault, creatorVaultAta };
}
