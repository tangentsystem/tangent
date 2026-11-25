// Test only helpers: a LiteSVM chain with a funded wallet and durable nonce accounts.
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { LiteSVM } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { createLiteSvmConnection } from './litesvm-connection.js';
import { buildCreateNonceAccountTx, readNonceValue, NONCE_ACCOUNT_LENGTH } from '../nonce.js';

export const FAST = Object.freeze({
  tickMs: 20, gossipIntervalMs: 100, helloIntervalMs: 200, wantRetryMs: 250, nackAfterMs: 80,
  pollMs: 10, retryMs: 50, confirmTimeoutMs: 2000,
});

export function makeChain() {
  const svm = new LiteSVM();
  const conn = createLiteSvmConnection(svm);
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey.toBase58(), BigInt(20 * LAMPORTS_PER_SOL));
  const decoder = getTransactionDecoder();
  // The one online step: create a nonce account. Done straight on the chain, not through the mesh.
  function createNonce(authority = payer) {
    const nonce = Keypair.generate();
    const rent = svm.minimumBalanceForRentExemption(BigInt(NONCE_ACCOUNT_LENGTH));
    const bytes = buildCreateNonceAccountTx({ payer, nonceAccount: nonce, authority: authority.publicKey, lamports: rent, recentBlockhash: svm.latestBlockhash() });
    const res = svm.sendTransaction(decoder.decode(bytes));
    if (typeof res.err === 'function') throw new Error('nonce create failed ' + res.toString());
    svm.expireBlockhash(); // the stored nonce must differ from the live blockhash before it can be advanced
    return { nonce, value: nonceValue(nonce.publicKey) };
  }
  function nonceValue(pubkey) { return readNonceValue(svm.getAccount(pubkey.toBase58()).data); }
  const balance = (pubkey) => svm.getBalance(typeof pubkey === 'string' ? pubkey : pubkey.toBase58()) ?? 0n;
  return { svm, conn, payer, createNonce, nonceValue, balance };
}

export async function waitFor(fn, { timeout = 10_000, every = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, every));
  }
}
