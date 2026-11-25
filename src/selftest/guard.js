// Money rules of the self test, enforced in code:
//   - SOL may only move between wallets this service created (the self test wallet, its
//     nonce account, the network tip account and the self test wallet's own Privacy Rings
//     balance). Anything else is refused before a transaction is signed.
//   - Nothing is sent before the self test wallet is funded (the runner only calls the
//     funded steps once the balance covers the plan).
//   - No sweeping or refunding: there is no code path that pays the funding address.
import { Transaction, VersionedTransaction, SystemProgram, SystemInstruction, PublicKey } from '@solana/web3.js';

export class MoneyRuleError extends Error {
  constructor(message) { super(message); this.name = 'MoneyRuleError'; this.code = 'MONEY_RULE'; }
}

export function createMoneyGuard(own = []) {
  const set = new Set(own.map(String));
  const sends = [];
  return {
    own: () => [...set],
    isOwn: (a) => set.has(String(a)),
    // Throws unless `address` is one of the service's own wallets.
    assertOwn(address, what = 'destination') {
      if (!set.has(String(address))) throw new MoneyRuleError(`self test refused: ${what} ${address} is not a wallet this service created`);
      return true;
    },
    // Checks every instruction of a signed transaction (legacy or v0, web3.js wire bytes):
    // only the System program, and every account that receives or is created is one of ours.
    assertTx(bytes, what = 'transaction') {
      const ixs = decodeInstructions(bytes);
      for (const ix of ixs) {
        if (!ix.programId.equals(SystemProgram.programId)) throw new MoneyRuleError(`self test refused: ${what} calls a program other than System`);
        let type;
        try { type = SystemInstruction.decodeInstructionType(ix); } catch { throw new MoneyRuleError(`self test refused: ${what} has an unknown System instruction`); }
        if (type === 'Transfer') this.assertOwn(SystemInstruction.decodeTransfer(ix).toPubkey.toBase58(), `${what} transfer to`);
        else if (type === 'Create') this.assertOwn(SystemInstruction.decodeCreateAccount(ix).newAccountPubkey.toBase58(), `${what} creates`);
        else if (type === 'InitializeNonceAccount' || type === 'AdvanceNonceAccount') { /* moves nothing */ }
        else throw new MoneyRuleError(`self test refused: ${what} has a ${type} instruction`);
      }
      return true;
    },
    record(entry) { sends.push({ ...entry, at: Date.now() }); },
    sends: () => sends.slice(),
  };
}

function decodeInstructions(bytes) {
  const buf = Buffer.from(bytes);
  try {
    const vt = VersionedTransaction.deserialize(buf);
    if (vt.version === 'legacy') return Transaction.from(buf).instructions;
    const keys = vt.message.staticAccountKeys;
    if (vt.message.addressTableLookups && vt.message.addressTableLookups.length) throw new MoneyRuleError('self test refused: lookup tables are not used by the self test');
    return vt.message.compiledInstructions.map((ix) => ({
      programId: keys[ix.programIdIndex],
      keys: ix.accountKeyIndexes.map((i) => ({ pubkey: new PublicKey(keys[i]), isSigner: vt.message.isAccountSigner(i), isWritable: vt.message.isAccountWritable(i) })),
      data: Buffer.from(ix.data),
    }));
  } catch (err) {
    if (err instanceof MoneyRuleError) throw err;
    return Transaction.from(buf).instructions;
  }
}
