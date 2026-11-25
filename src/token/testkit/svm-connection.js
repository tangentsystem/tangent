// Test helper: a LiteSVM instance behind the subset of the @solana/web3.js Connection API that the
// pump.fun and Meteora SDKs (and this module) call. Real program execution, no network.
// Used by tests only. Not part of the service.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LiteSVM } from 'litesvm';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { address, getTransactionDecoder, lamports as kitLamports } from '@solana/kit';
import bs58 from 'bs58';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// SVM_PROGRAMS_DIR overrides the folder (used to run the same tests on program binaries dumped from mainnet).
export const PROGRAMS_DIR = process.env.SVM_PROGRAMS_DIR || path.join(HERE, '..', 'fixtures', 'programs');

const txDecoder = getTransactionDecoder();

function toInfo(acc) {
  if (!acc || !acc.exists) return null;
  return {
    data: Buffer.from(acc.data),
    executable: !!acc.executable,
    lamports: Number(acc.lamports),
    owner: new PublicKey(String(acc.programAddress)),
    rentEpoch: 0,
  };
}

function matches(data, filters = []) {
  for (const f of filters) {
    if (f.dataSize !== undefined && data.length !== f.dataSize) return false;
    if (f.memcmp) {
      const enc = f.memcmp.encoding || 'base58';
      const want = enc === 'base64' ? Buffer.from(f.memcmp.bytes, 'base64') : Buffer.from(bs58.decode(f.memcmp.bytes));
      const got = data.subarray(f.memcmp.offset, f.memcmp.offset + want.length);
      if (!Buffer.from(got).equals(want)) return false;
    }
  }
  return true;
}

/**
 * createSvmConnection({ programs: [{ id, file }] }) -> connection-like object with `.svm`.
 * `calls` records every method the code under test used, so tests can assert on it.
 */
export function createSvmConnection({ programs = [], svm = new LiteSVM().withNativeMints() } = {}) {
  for (const p of programs) svm.addProgramFromFile(address(String(p.id)), path.isAbsolute(p.file) ? p.file : path.join(PROGRAMS_DIR, p.file));
  const calls = [];
  const sent = [];
  const known = new Set(); // addresses we have written or that transactions touched, for getProgramAccounts

  function remember(keys) { for (const k of keys) known.add(String(k)); }

  const conn = {
    svm,
    calls,
    sent,
    commitment: 'confirmed',
    rpcEndpoint: 'litesvm://local',
    async getAccountInfo(pk) {
      calls.push('getAccountInfo');
      return toInfo(svm.getAccount(address(new PublicKey(pk).toBase58())));
    },
    async getAccountInfoAndContext(pk) {
      return { context: { slot: Number(svm.getClock().slot) }, value: await conn.getAccountInfo(pk) };
    },
    async getMultipleAccountsInfo(pks) {
      calls.push('getMultipleAccountsInfo');
      return pks.map((pk) => toInfo(svm.getAccount(address(new PublicKey(pk).toBase58()))));
    },
    async getMultipleAccountsInfoAndContext(pks) {
      return { context: { slot: Number(svm.getClock().slot) }, value: await conn.getMultipleAccountsInfo(pks) };
    },
    async getProgramAccounts(programId, cfg = {}) {
      calls.push('getProgramAccounts');
      const owner = new PublicKey(programId).toBase58();
      const filters = Array.isArray(cfg) ? [] : cfg.filters || [];
      const out = [];
      for (const k of known) {
        const acc = svm.getAccount(address(k));
        if (!acc || !acc.exists || String(acc.programAddress) !== owner) continue;
        const data = Buffer.from(acc.data);
        if (!matches(data, filters)) continue;
        out.push({ pubkey: new PublicKey(k), account: toInfo(acc) });
      }
      return out;
    },
    async getTokenAccountsByOwner(ownerPk, { programId }) {
      calls.push('getTokenAccountsByOwner');
      const owner = new PublicKey(ownerPk);
      const prog = new PublicKey(programId).toBase58();
      const value = [];
      for (const k of known) {
        const acc = svm.getAccount(address(k));
        if (!acc || !acc.exists || String(acc.programAddress) !== prog) continue;
        const data = Buffer.from(acc.data);
        if (data.length < 165) continue;
        if (!new PublicKey(data.subarray(32, 64)).equals(owner)) continue;
        if (data.length > 165 && data[165] !== 2) continue; // token-2022: account type byte must say Account
        value.push({ pubkey: new PublicKey(k), account: toInfo(acc) });
      }
      return { context: { slot: Number(svm.getClock().slot) }, value };
    },
    async getTokenAccountBalance(pk) {
      const info = await conn.getAccountInfo(pk);
      if (!info) throw new Error('could not find account');
      const amount = info.data.readBigUInt64LE(64);
      return { context: { slot: 0 }, value: { amount: amount.toString(), decimals: 0, uiAmount: null } };
    },
    async getMinimumBalanceForRentExemption(len) {
      return Number(svm.minimumBalanceForRentExemption(BigInt(len)));
    },
    async getLatestBlockhash() {
      return { blockhash: String(svm.latestBlockhash()), lastValidBlockHeight: Number(svm.getClock().slot) + 150 };
    },
    async getEpochInfo() {
      const c = svm.getClock();
      return { epoch: Number(c.epoch), slotIndex: 0, slotsInEpoch: 432000, absoluteSlot: Number(c.slot), blockHeight: Number(c.slot) };
    },
    async getSlot() { return Number(svm.getClock().slot); },
    async getBlockTime() { return Number(svm.getClock().unixTimestamp); },
    async getBalance(pk) {
      const b = svm.getBalance(address(new PublicKey(pk).toBase58()));
      return b === null ? 0 : Number(b);
    },
    async sendRawTransaction(bytes) {
      calls.push('sendRawTransaction');
      const r = conn.execute(bytes);
      if (!r.ok) {
        const e = new Error('transaction failed: ' + r.err + '\n' + r.logs.join('\n'));
        e.logs = r.logs;
        throw e;
      }
      return r.signature;
    },
    async sendTransaction(tx, signers = []) {
      if (tx instanceof Transaction) {
        if (!tx.recentBlockhash) tx.recentBlockhash = String(svm.latestBlockhash());
        if (signers.length) tx.sign(...signers);
        return conn.sendRawTransaction(tx.serialize());
      }
      return conn.sendRawTransaction(tx.serialize());
    },
    async confirmTransaction() { return { context: { slot: 0 }, value: { err: null } }; },
    async getSignatureStatuses(sigs) {
      return { context: { slot: 0 }, value: sigs.map(() => ({ confirmationStatus: 'confirmed', err: null, slot: 0, confirmations: 1 })) };
    },

    /** Executes serialized transaction bytes. Returns { ok, signature, logs, err }. */
    execute(bytes) {
      const raw = Buffer.from(bytes);
      let keys = [];
      try {
        const v = VersionedTransaction.deserialize(raw);
        keys = v.message.staticAccountKeys;
      } catch {
        keys = Transaction.from(raw).compileMessage().accountKeys;
      }
      remember(keys);
      const tx = txDecoder.decode(new Uint8Array(raw));
      const res = svm.sendTransaction(tx);
      const isFail = typeof res.err === 'function';
      const meta = isFail ? res.meta() : res;
      const logs = meta.logs();
      const signature = bs58.encode(meta.signature());
      sent.push({ signature, ok: !isFail, logs });
      svm.expireBlockhash(); // next transaction gets a fresh blockhash, so identical ones do not collide
      // learn addresses created by inner instructions too (logs do not list them; tests call remember() for those)
      return { ok: !isFail, signature, logs, err: isFail ? String(res.err()) : null };
    },
    /** Tell getProgramAccounts / getTokenAccountsByOwner about addresses. */
    remember(...pks) { remember(pks.flat().map((p) => new PublicKey(p).toBase58())); },
    /** Write a raw account. */
    setAccount(pk, { data, owner, lamports, executable = false }) {
      const a = new PublicKey(pk).toBase58();
      const d = Buffer.from(data || []);
      svm.setAccount({
        address: address(a),
        data: new Uint8Array(d),
        executable,
        lamports: kitLamports(BigInt(lamports ?? svm.minimumBalanceForRentExemption(BigInt(d.length)))),
        programAddress: address(new PublicKey(owner).toBase58()),
        space: BigInt(d.length),
      });
      known.add(a);
    },
    airdrop(pk, sol = 100) {
      svm.airdrop(address(new PublicKey(pk).toBase58()), kitLamports(BigInt(Math.round(sol * 1e9))));
    },
    warp(seconds) {
      const c = svm.getClock();
      c.unixTimestamp = c.unixTimestamp + BigInt(seconds);
      c.slot = c.slot + BigInt(Math.ceil(seconds / 0.4));
      svm.setClock(c);
      svm.expireBlockhash();
    },
  };
  return conn;
}
