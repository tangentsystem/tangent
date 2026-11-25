// Test only: a thin adapter that gives LiteSVM the small slice of the web3.js Connection API the
// gateway uses (sendRawTransaction, getSignatureStatuses, getAccountInfo, confirmTransaction).
// Error messages copy the strings a real RPC node returns on preflight failure so the gateway's
// error handling is exercised the same way. litesvm is a devDependency: never import this from
// runtime code.
import { LiteSVM } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import bs58 from 'bs58';

export function createLiteSvmConnection(svm = new LiteSVM()) {
  const statuses = new Map(); // signature -> { slot, err }
  const calls = { sendRawTransaction: 0, getSignatureStatuses: 0, getAccountInfo: 0 };
  const decoder = getTransactionDecoder();
  const toAddr = (k) => (typeof k === 'string' ? k : k.toBase58());
  return {
    svm, calls, statuses,
    async sendRawTransaction(bytes) {
      calls.sendRawTransaction++;
      const tx = decoder.decode(Uint8Array.from(bytes));
      const res = svm.sendTransaction(tx);
      if (res.constructor.name === 'FailedTransactionMetadata' || typeof res.err === 'function') {
        const err = res.err();
        const text = typeof err === 'number' || typeof err === 'string' ? String(err) : res.toString();
        if (/AlreadyProcessed/.test(res.toString())) throw new Error('failed to send transaction: Transaction simulation failed: This transaction has already been processed');
        if (/BlockhashNotFound/.test(res.toString())) throw new Error('failed to send transaction: Transaction simulation failed: Blockhash not found');
        throw new Error('failed to send transaction: Transaction simulation failed: ' + text.slice(0, 200));
      }
      const sig = bs58.encode(res.signature());
      statuses.set(sig, { slot: Number(svm.getClock().slot), err: null });
      svm.warpToSlot(svm.getClock().slot + 1n);
      return sig;
    },
    async getSignatureStatuses(sigs) {
      calls.getSignatureStatuses++;
      return {
        context: { slot: Number(svm.getClock().slot) },
        value: sigs.map((s) => { const x = statuses.get(s); return x ? { slot: x.slot, confirmations: 0, err: x.err, confirmationStatus: 'confirmed' } : null; }),
      };
    },
    async getAccountInfo(pubkey) {
      calls.getAccountInfo++;
      const a = svm.getAccount(toAddr(pubkey));
      if (!a || !a.exists) return null;
      return { data: Buffer.from(a.data), lamports: Number(a.lamports), owner: a.programAddress, executable: a.executable };
    },
    async confirmTransaction({ signature }) {
      const x = statuses.get(signature);
      return { context: { slot: Number(svm.getClock().slot) }, value: { err: x ? x.err : 'not found' } };
    },
    async getMinimumBalanceForRentExemption(len) { return Number(svm.minimumBalanceForRentExemption(BigInt(len))); },
    async getLatestBlockhash() { return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0 }; },
  };
}
