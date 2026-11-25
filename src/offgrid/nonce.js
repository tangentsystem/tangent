// Sender side helpers: durable nonce transactions that do not expire while they travel.
//
// One time, while online: create a nonce account (buildCreateNonceAccountTx) and note its
// current nonce value (readNonceValue on the account data). From then on a wallet with no
// internet can build and sign transactions whose first instruction advances that nonce
// (buildDurableTx / buildDurableTransfer). Each landed transaction advances the nonce, so the
// wallet needs the new value (or a second nonce account) before preparing the next one.
import {
  SystemProgram, Transaction, TransactionMessage, VersionedTransaction, PublicKey,
  NonceAccount, NONCE_ACCOUNT_LENGTH,
} from '@solana/web3.js';

export { NONCE_ACCOUNT_LENGTH };
const pk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));

// Online step. Needs a recent blockhash and rent exempt lamports for NONCE_ACCOUNT_LENGTH bytes
// (connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)).
// payer and nonceAccount are Keypairs (both sign). Returns signed wire bytes.
export function buildCreateNonceAccountTx({ payer, nonceAccount, authority, lamports, recentBlockhash }) {
  const tx = new Transaction().add(...SystemProgram.createNonceAccount({
    fromPubkey: payer.publicKey, noncePubkey: nonceAccount.publicKey,
    authorizedPubkey: pk(authority ?? payer.publicKey), lamports: Number(lamports),
  }).instructions);
  tx.recentBlockhash = recentBlockhash; tx.feePayer = payer.publicKey;
  tx.sign(payer, nonceAccount);
  return new Uint8Array(tx.serialize());
}

// Decode a nonce account's data. Returns { nonce, authority, feeLamportsPerSignature }.
export function readNonceAccount(data) {
  const n = NonceAccount.fromAccountData(Buffer.from(data));
  return { nonce: n.nonce, authority: n.authorizedPubkey.toBase58(), feeLamportsPerSignature: n.feeCalculator?.lamportsPerSignature ?? null };
}
export function readNonceValue(data) { return readNonceAccount(data).nonce; }

// Offline step. instructions: web3.js TransactionInstruction[]. tip: { account, lamports } adds a
// transfer from feePayer to the network tip account. version 'legacy' or 0.
// signers: Keypairs (fee payer, nonce authority, and any other required signer).
// Returns signed wire bytes ready for offgrid.submit().
export function buildDurableTx({ feePayer, nonceAccount, nonceAuthority, nonceValue, instructions = [], tip = null, version = 'legacy', signers }) {
  const payerKey = pk(feePayer);
  const ixs = [SystemProgram.nonceAdvance({ noncePubkey: pk(nonceAccount), authorizedPubkey: pk(nonceAuthority ?? feePayer) }), ...instructions];
  if (tip && BigInt(tip.lamports) > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: pk(tip.account), lamports: BigInt(tip.lamports) }));
  if (version === 'legacy') {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = nonceValue; tx.feePayer = payerKey;
    tx.sign(...signers);
    return new Uint8Array(tx.serialize());
  }
  if (version !== 0) throw new Error('nonce: version must be legacy or 0');
  const msg = new TransactionMessage({ payerKey, recentBlockhash: nonceValue, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  return tx.serialize();
}

// Convenience: a durable nonce SOL transfer, signed by `from` (also the nonce authority unless given).
export function buildDurableTransfer({ from, to, lamports, nonceAccount, nonceValue, nonceAuthority = null, tip = null, version = 'legacy', extraSigners = [] }) {
  const authority = nonceAuthority ? nonceAuthority.publicKey : from.publicKey;
  const signers = [from, ...(nonceAuthority && !nonceAuthority.publicKey.equals(from.publicKey) ? [nonceAuthority] : []), ...extraSigners];
  return buildDurableTx({
    feePayer: from.publicKey, nonceAccount, nonceAuthority: authority, nonceValue, tip, version, signers,
    instructions: [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: pk(to), lamports: BigInt(lamports) })],
  });
}
