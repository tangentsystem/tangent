// Per machine Solana wallet. The keypair is created in the node process when the
// machine is rented. It is never sent to the machine, never returned by the machine
// API and never logged. destroy() zeroes this in-memory copy when the machine ends.
// The node keeps an encrypted backup of the key (src/node/machine-wallets.js) for 30
// days after the machine ends, so the renter can recover it by signing with the payer
// identity that rented the machine; then the node deletes the backup.
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

export const explorerAccount = (addr) => `https://solscan.io/account/${addr}`;
export const explorerTx = (sig) => `https://solscan.io/tx/${sig}`;

// backup: when given it receives a copy of the 64 byte secret key once, at creation, so the
// node can keep its backup (every node passes one; see src/compute/index.js walletVault).
export function createMachineWallet({ backup = null } = {}) {
  let kp = Keypair.generate();
  const address = kp.publicKey.toBase58();
  if (typeof backup === 'function') backup({ address, secretKey: Uint8Array.from(kp.secretKey) });
  const alive = () => { if (!kp) throw new Error('wallet destroyed'); return kp; };
  const wallet = {
    address,
    signMessage(bytes) {
      const k = alive();
      return bs58.encode(ed25519.sign(Uint8Array.from(bytes), k.secretKey.subarray(0, 32)));
    },
    // tx: Buffer of a serialized (possibly partially signed) transaction, legacy or v0.
    signTransaction(raw) {
      const k = alive();
      const buf = Buffer.from(raw);
      let versioned = null;
      try { versioned = VersionedTransaction.deserialize(buf); } catch { versioned = null; }
      if (versioned && versioned.version !== 'legacy') {
        const signers = versioned.message.staticAccountKeys.slice(0, versioned.message.header.numRequiredSignatures);
        const idx = signers.findIndex((p) => p.equals(k.publicKey));
        if (idx < 0) throw new Error('this wallet is not a required signer of the transaction');
        versioned.sign([k]);
        return { transaction: Buffer.from(versioned.serialize()), signature: bs58.encode(versioned.signatures[idx]) };
      }
      const tx = Transaction.from(buf);
      const needed = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures);
      if (!needed.some((p) => p.equals(k.publicKey))) throw new Error('this wallet is not a required signer of the transaction');
      tx.partialSign(k);
      const sig = tx.signatures.find((s) => s.publicKey.equals(k.publicKey)).signature;
      return { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), signature: bs58.encode(sig) };
    },
    destroy() { if (kp) { kp.secretKey.fill(0); kp = null; } },
    get destroyed() { return kp === null; },
    toJSON() { return { address }; },
  };
  // keep util.inspect / console.log from ever printing internals
  Object.defineProperty(wallet, Symbol.for('nodejs.util.inspect.custom'), { value: () => `MachineWallet(${address})` });
  return wallet;
}
