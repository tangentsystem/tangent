// Creator fee claims for whichever platform and stage the coin is on.
//   pump.fun : pump creator vault (curve) + PumpSwap coin creator vault (after graduation), one tx
//   Meteora  : DBC creator trading fee and DBC partner (fee claimer) trading fee, then DAMM v2
//              position fees for the signer's positions after migration
//   Raydium  : LaunchLab creator fee vault (curve fees) and the CPMM pool's creator fee after
//              graduation when the signer is the pool's recorded creator (raydium.js)
// Every instruction is built by the SDKs. Before signing, guardClaimInstructions() refuses any
// transaction that could move funds anywhere but back to the signer.
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { pump, dbc, cpamm, cjsWeb3, PROGRAM_IDS, SOL_LIKE_QUOTES, NATIVE_MINT } from './sdk.js';
import { TOKEN_PROGRAMS } from './chain.js';
import { buildRaydiumClaims, guardRaydiumInstruction } from './raydium.js';

export class ClaimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const CLAIM_PROGRAMS = new Set([
  PROGRAM_IDS.pump, PROGRAM_IDS.pumpAmm, PROGRAM_IDS.dbc, PROGRAM_IDS.dammV2, PROGRAM_IDS.launchlab, PROGRAM_IDS.raydiumCpmm,
  PROGRAM_IDS.token, PROGRAM_IDS.token2022, PROGRAM_IDS.ata, PROGRAM_IDS.computeBudget,
]);
// SPL token instruction tags allowed inside a claim: CloseAccount (9) and SyncNative (17).
const TOKEN_CLOSE = 9;
const TOKEN_SYNC_NATIVE = 17;

/** Converts an instruction built with the CommonJS web3.js copy into the ESM one. */
export function toEsmInstruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId.toBase58()),
    keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey.toBase58()), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data),
  });
}

/**
 * Throws unless every instruction is a claim, an idempotent account create, an unwrap of the
 * signer's own wrapped SOL, or a compute budget setting. No system transfers at all. The signer
 * is the only account any instruction asks to sign.
 */
export function guardClaimInstructions(instructions, owner) {
  const me = new PublicKey(owner).toBase58();
  const fail = (msg) => { throw new ClaimError('guard', msg); };
  for (const ix of instructions) {
    const pid = ix.programId.toBase58();
    if (!CLAIM_PROGRAMS.has(pid)) throw new ClaimError('guard', `claim refused: unexpected program ${pid}`);
    for (const k of ix.keys) {
      if (k.isSigner && k.pubkey.toBase58() !== me) fail('claim refused: an instruction needs another signer');
    }
    if (pid === PROGRAM_IDS.launchlab || pid === PROGRAM_IDS.raydiumCpmm) {
      guardRaydiumInstruction(ix, me, fail);
      continue;
    }
    if (TOKEN_PROGRAMS.has(pid)) {
      const tag = ix.data[0];
      if (tag === TOKEN_SYNC_NATIVE) continue;
      if (tag === TOKEN_CLOSE) {
        const dest = ix.keys[1].pubkey.toBase58();
        const auth = ix.keys[2].pubkey.toBase58();
        if (dest !== me || auth !== me) throw new ClaimError('guard', 'claim refused: account close pays someone else');
        continue;
      }
      throw new ClaimError('guard', `claim refused: token instruction ${tag}`);
    }
    if (pid === PROGRAM_IDS.ata) {
      // create / create idempotent: [payer, ata, wallet, mint, system, token]
      const payer = ix.keys[0].pubkey.toBase58();
      const wallet = ix.keys[2].pubkey;
      if (payer !== me) throw new ClaimError('guard', 'claim refused: account create paid by another wallet');
      if (wallet.toBase58() !== me && PublicKey.isOnCurve(wallet.toBytes())) {
        throw new ClaimError('guard', 'claim refused: account create for another wallet');
      }
    }
  }
  return true;
}

async function sendInstructions(connection, signer, instructions) {
  const owner = signer.publicKey;
  guardClaimInstructions(instructions, owner);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  tx.add(...instructions);
  let signed = tx;
  if (signer.secretKey) tx.sign(signer);
  else if (typeof signer.signTransaction === 'function') signed = await signer.signTransaction(tx);
  else throw new ClaimError('signer', 'signer must be a Keypair or have signTransaction()');
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

// ---------------------------------------------------------------- pump.fun

/** Instructions for the pump creator vault + PumpSwap creator vault, as ESM instructions. */
export async function buildPumpClaim(connection, d, owner) {
  const me = new PublicKey(owner).toBase58();
  if (pump.hasCoinCreatorMigratedToSharingConfig({ mint: new cjsWeb3.PublicKey(d.ca), creator: new cjsWeb3.PublicKey(d.creator) })) {
    throw new ClaimError('sharing_config', 'this coin pays its creator fees through a fee sharing config; claim through the pump fee program instead');
  }
  if (d.creator !== me) throw new ClaimError('not_creator', `signer ${me} is not the coin creator ${d.creator}`);
  const quoteMint = d.quoteMint || NATIVE_MINT;
  const quoteInfo = SOL_LIKE_QUOTES.has(quoteMint) ? null : await connection.getAccountInfo(new PublicKey(quoteMint));
  const quoteProgram = quoteInfo ? quoteInfo.owner.toBase58() : PROGRAM_IDS.token;
  const sdk = new pump.OnlinePumpSdk(connection);
  const ixs = await sdk.collectCoinCreatorFeeV2Instructions(
    new cjsWeb3.PublicKey(me),
    new cjsWeb3.PublicKey(SOL_LIKE_QUOTES.has(quoteMint) ? NATIVE_MINT : quoteMint),
    new cjsWeb3.PublicKey(quoteProgram),
    new cjsWeb3.PublicKey(me),
  );
  return ixs.map(toEsmInstruction);
}

// ---------------------------------------------------------------- Meteora

/** DBC claim transactions (creator share and partner share) for the signer, as instruction lists. */
export async function buildDbcClaims(connection, d, owner) {
  const me = new PublicKey(owner);
  const st = d.state;
  if (!st.dbcAddr || !st.dbc) return [];
  const client = new dbc.DynamicBondingCurveClient(connection, 'confirmed');
  const pool = new PublicKey(st.dbcAddr);
  const fresh = await client.state.getPool(pool);
  const ps = fresh ? fresh.poolState : st.dbc;
  const out = [];
  const isCreator = ps.creator.toBase58() === me.toBase58();
  const isPartner = st.config && st.config.feeClaimer.toBase58() === me.toBase58();
  if (isCreator && (!ps.creatorBaseFee.isZero() || !ps.creatorQuoteFee.isZero())) {
    const tx = await client.creator.claimCreatorTradingFee({
      creator: me, payer: me, pool, maxBaseAmount: new BN(ps.creatorBaseFee.toString()), maxQuoteAmount: new BN(ps.creatorQuoteFee.toString()),
    });
    out.push({ kind: 'dbc_creator_fee', instructions: tx.instructions, amounts: { base: ps.creatorBaseFee.toString(), quote: ps.creatorQuoteFee.toString() } });
  }
  if (isPartner && (!ps.partnerBaseFee.isZero() || !ps.partnerQuoteFee.isZero())) {
    const tx = await client.partner.claimPartnerTradingFee({
      feeClaimer: me, payer: me, pool, maxBaseAmount: new BN(ps.partnerBaseFee.toString()), maxQuoteAmount: new BN(ps.partnerQuoteFee.toString()),
    });
    out.push({ kind: 'dbc_partner_fee', instructions: tx.instructions, amounts: { base: ps.partnerBaseFee.toString(), quote: ps.partnerQuoteFee.toString() } });
  }
  return out;
}

/** DAMM v2 position fee claims for every position of the signer in the pool. */
export async function buildDammClaims(connection, d, owner) {
  const me = new PublicKey(owner);
  const st = d.state;
  if (st.kind !== 'damm') return [];
  const cp = new cpamm.CpAmm(connection);
  const poolKey = new PublicKey(st.dammAddr);
  const poolState = await cp.fetchPoolState(poolKey);
  const positions = await cp.getUserPositionByPool(poolKey, me);
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const p of positions) {
    const fees = cpamm.getUnClaimLpFee(poolState, p.positionState, new BN(now));
    if (fees.feeTokenA.isZero() && fees.feeTokenB.isZero()) continue;
    const tx = await cp.claimPositionFee({
      owner: me,
      pool: poolKey,
      position: p.position,
      positionNftAccount: p.positionNftAccount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: cpamm.getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: cpamm.getTokenProgram(poolState.tokenBFlag),
    });
    out.push({ kind: 'damm_position_fee', position: p.position.toBase58(), instructions: tx.instructions, amounts: { a: fees.feeTokenA.toString(), b: fees.feeTokenB.toString() } });
  }
  return out;
}

/** Everything claimable for this signer, without sending. [{ kind, instructions, amounts? }] */
export async function buildClaims(connection, d, owner) {
  const me = new PublicKey(owner).toBase58();
  if (d.platform === 'pumpfun') {
    return [{ kind: 'pump_creator_fee', instructions: await buildPumpClaim(connection, d, me) }];
  }
  if (d.platform === 'meteora') {
    const st = d.state;
    const known = new Set([d.creator, d.feeClaimer].filter(Boolean));
    if (st.kind === 'damm' && !st.dbcAddr) known.add(me); // position owners are found by lookup
    if (!known.has(me)) throw new ClaimError('not_creator', `signer ${me} is neither the pool creator nor the fee claimer`);
    return [...(await buildDbcClaims(connection, d, me)), ...(await buildDammClaims(connection, d, me))];
  }
  if (d.platform === 'raydium') {
    return buildRaydiumClaims(connection, d, me, (code, msg) => new ClaimError(code, msg));
  }
  throw new ClaimError('unknown_platform', 'coin platform not detected');
}

/** Builds, guards, signs and sends every claim. Returns { signatures, claims }. */
export async function claimAll(connection, d, signer) {
  const claims = await buildClaims(connection, d, signer.publicKey);
  for (const c of claims) guardClaimInstructions(c.instructions, signer.publicKey);
  const done = [];
  for (const c of claims) {
    const signature = await sendInstructions(connection, signer, c.instructions);
    done.push({ kind: c.kind, signature, amounts: c.amounts || null, position: c.position || null });
  }
  return { signatures: done.map((x) => x.signature), claims: done };
}

