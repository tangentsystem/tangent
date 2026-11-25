// Real Rings adapter on @heliuslabs/spr (0.9.0-alpha).
// The key is the
// network's Rings wallet key (config.ringsSeed), the deposit memo prefix is configurable (config.ringsMemoPrefix,
// default "tangent:"), and the throttle helper lives beside this file.
//
// The vault is the Rings private wallet of the network's Rings key:
//   ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed32)), Solana address = toSolanaSigner().address
// (the same base58 pubkey as keypairFromSeed(seed).publicKey). No key is generated or written anywhere.
//
// Nothing here talks to the network until the first listIncoming / sendPrivate / vaultBalance call.
//
// HOW THE SENDER OF AN INCOMING TRANSFER IS FOUND
// The SDK history row (wallet.privateTransactions()) of an inbound transfer has no sender field
// (`counterpartyViewingPublicKey` is only set on outbound rows). So the sender is read from data that is
// public on Solana, in this order:
//   1. owner tags of the transaction's output slots (fetchTransactionSlots; in the confidential ring a tag is
//      the owner's Solana pubkey) minus the vault's own tag, intersected with the transaction's required
//      signers (getTransaction -> message.accountKeys[0 .. numRequiredSignatures)). Exactly one match = sender.
//      If several match, the fee payer (signer 0) wins when it is one of them.
//   2. no signer matches but exactly one non vault tag exists -> that tag (owner authorised inside the proof,
//      a relayer paid the fee).
//   3. every tag is the vault's (sender kept no change) -> the fee payer, signer 0, unless it is the vault.
//   4. otherwise the sender is unknown (`from: null`) and the deposit sync only credits when the memo names a wallet.
//
// HOW THE MEMO IS FOUND
// A memo rides encrypted inside the recipient's UTXO (ProofOutputUtxo.withMemo on the sending side). After
// syncWallet decrypts the vault's UTXOs it is `walletUtxo.utxo.data.memo()`; the history row and the UTXO are
// matched by leaf index (row.id.index === walletUtxo.outputContext.leafIndex).
//
// EXACTLY ONCE SENDS
// The transfer is built and signed locally, so its signature is known BEFORE it is broadcast. The record
// kv('rings_send', idempotencyKey) = { status: 'submitted', signature, lastValidBlockHeight } is written before the
// broadcast. A later call with the same key first settles that record against Solana: landed -> return it,
// failed on chain or blockhash expired at finalized commitment -> safe to build a new one, anything else ->
// transient error (wait). The vault's own indexed history is checked for the recorded signature as well.
//
// withdrawPublic (unshield from the vault to a public Solana address, used by public withdrawals) goes through the same
// record and settle steps under its own idempotency key; it skips the recipient registration check.
//
// The marker used for that history check is the transaction signature, not a memo: the SDK's
// buildTransferTransaction takes no memo, and an outbound history row exposes no memo either (only asset,
// amount and the counterparty viewing key), so a memo on the recipient's UTXO could not be read back by the
// vault. The `memo` argument is kept in the send record for audit and is not put on chain.
import { address as toAddress, isAddress, getCompiledTransactionMessageDecoder, signTransactionWithSigners, assertIsTransactionWithBlockhashLifetime, getSignatureFromTransaction, sendTransactionWithoutConfirmingFactory, getBase64EncodedWireTransaction } from '@solana/kit';
import {
  createSprClient,
  initializePoseidon,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  Utxo,
  syncWallet,
  SOL_MINT,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  buildRegistrationTransaction,
  buildDepositTransaction,
  buildMergeTransaction,
  buildSetMergeEncryptionTransaction,
  SHIELDED_POOL_PROGRAM_ID,
  MergeEncryptionScheme,
} from '@heliuslabs/spr';
import { LocalKeys, SignedTeePolicy } from '@heliuslabs/spr/client';
import { AssetRegistry, LocalShieldedKeys } from '@heliuslabs/spr/transaction';
import { isWalletRegistered, fetchTransactionSlots, fetchUserRecord } from '@heliuslabs/spr/wallet';
import bs58 from 'bs58';
import { RingsError } from './errors.js';
import { DEFAULT_MEMO_PREFIX } from './memo.js';
import { makeThrottledFetch } from './throttle.js';

export { DEFAULT_MEMO_PREFIX };

export const KV_SEND = 'rings_send';
export const KV_REGISTRATION_KEY = 'vault-registration'; // in ns KV_SEND: the vault's own registration tx
// The user registry record is 100 bytes (version 1 + owner 32 + bump 1 + nullifier key 32 + viewing key 33 +
// merge scheme 1; the layout the SDK decodes in wallet/registry.js). Registering costs its rent exempt
// minimum plus the fee, and the paying wallet must itself stay rent exempt. The cost is read from the RPC;
// when that fails this conservative figure is used (rent(100) 1586880 + rent(0) 890880 + fees, rounded up).
// config.ringsRegisterLamports overrides both.
export const USER_RECORD_SIZE = 100;
export const DEFAULT_REGISTER_LAMPORTS = 3000000;
const REGISTER_FEE_MARGIN = 10000;
const DEFAULT_REWIND_SLOTS = 9000; // about one hour of slots re-read behind the cursor

export function seedFromConfig(config) {
  const raw = config && config.ringsSeed;
  if (raw === undefined || raw === null || raw === '') throw new RingsError('MISSING_RINGS_KEY', 'the Rings wallet key (config.ringsSeed) is required for the real Rings adapter');
  const bytes = typeof raw === 'string' ? bs58.decode(raw) : Uint8Array.from(raw);
  if (bytes.length !== 32 && bytes.length !== 64) throw new RingsError('BAD_RINGS_KEY', 'Rings wallet key must be a 32 byte seed or a 64 byte Solana secret key');
  return Uint8Array.from(bytes.subarray(0, 32));
}

export function endpointFromConfig(config) {
  if (config.ringsEndpoint) return String(config.ringsEndpoint);
  if (!config.heliusApiKey) throw new RingsError('MISSING_HELIUS_KEY', 'set HELIUS_API_KEY or a Rings endpoint');
  // config.ringsNetwork defaults to mainnet (SPEC addendum A); only an explicit "devnet" picks the devnet host.
  const network = config.ringsNetwork === 'devnet' ? 'devnet' : 'mainnet';
  return 'https://' + network + '.helius-rpc.com/?api-key=' + encodeURIComponent(config.heliusApiKey);
}

// Which TEE policy the prover must attest to. Taken from the endpoint host like the SDK example does.
export function networkFromEndpoint(endpoint, fallback) {
  let host = '';
  try {
    host = new URL(endpoint).hostname;
  } catch {
    host = '';
  }
  if (host === 'mainnet.helius-rpc.com') return 'mainnet';
  if (host === 'devnet.helius-rpc.com') return 'devnet';
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return undefined; // local stack: no TEE policy
  return fallback === 'mainnet' || fallback === 'devnet' ? fallback : undefined;
}

export function clientConfigFrom(config) {
  const ringsRpc = endpointFromConfig(config);
  const network = networkFromEndpoint(ringsRpc, config.ringsNetwork);
  // When a separate Solana RPC is set (Alchemy), plain RPC goes there and only the
  // Rings indexer and prover stay on the Helius /v1/spr gateway.
  let split = {};
  if (!config.ringsEndpoint && config.solanaRpcUrl && !/helius-rpc\.com/.test(String(config.solanaRpcUrl))) {
    const spr = new URL(ringsRpc);
    spr.pathname = '/v1/spr';
    split = { indexerUrl: spr.toString(), proverUrl: spr.toString() };
  }
  const solanaRpcUrl = split.indexerUrl ? String(config.solanaRpcUrl) : ringsRpc;
  return {
    solanaRpcUrl,
    ...split,
    fetch: makeThrottledFetch(config),
    proofDataSource: 'prover',
    ...(network ? { proverTee: SignedTeePolicy.forNetwork(network) } : {}),
  };
}

// Asset name <-> Rings mint address. "SOL" is the SDK's SOL_MINT, anything else is an SPL mint in base58.
export function assetToMint(asset) {
  if (asset === 'SOL') return SOL_MINT;
  if (typeof asset !== 'string' || !isAddress(asset)) throw new RingsError('UNSUPPORTED_ASSET', 'asset is not SOL or a mint address', { permanent: true });
  return toAddress(asset);
}
export function mintToAsset(mint) {
  return String(mint) === String(SOL_MINT) ? 'SOL' : String(mint);
}

export function rowId(row) {
  return String(row.id.signature) + ':' + row.id.index.toString();
}

function compareRows(a, b) {
  if (a.id.slot !== b.id.slot) return a.id.slot < b.id.slot ? -1 : 1;
  const sa = String(a.id.signature);
  const sb = String(b.id.signature);
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (a.id.index !== b.id.index) return a.id.index < b.id.index ? -1 : 1;
  return 0;
}

export function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return { slot: -1, ids: new Set() };
  try {
    const parsed = typeof cursor === 'string' ? JSON.parse(cursor) : cursor;
    const slot = Number(parsed.s);
    if (!Number.isSafeInteger(slot)) throw new Error('slot');
    return { slot, ids: new Set(Array.isArray(parsed.ids) ? parsed.ids.map(String) : []) };
  } catch {
    throw new RingsError('BAD_CURSOR', 'bad rings cursor');
  }
}

// Pure cursor step over history rows, exported for tests.
// Rows at most `rewind` slots behind the cursor are looked at again on every call, so a transfer the indexer
// reports late is still picked up; the ids already handed out inside that window travel in the cursor.
export function selectIncoming(rows, cursor, { rewind = DEFAULT_REWIND_SLOTS, limit = 200, acceptPublicDeposits = true } = {}) {
  const cur = parseCursor(cursor);
  const inbound = rows
    .filter((r) => r.direction === 'inbound' && (r.kind === 'privateTransfer' || (acceptPublicDeposits && r.kind === 'deposit')))
    .sort(compareRows);
  const floor = cur.slot - rewind;
  const fresh = inbound.filter((r) => Number(r.id.slot) > floor && !cur.ids.has(rowId(r)));
  const picked = fresh.slice(0, limit > 0 ? limit : fresh.length);
  let newSlot = cur.slot;
  for (const r of picked) newSlot = Math.max(newSlot, Number(r.id.slot));
  const handedOut = new Set([...cur.ids, ...picked.map(rowId)]);
  const ids = inbound.filter((r) => handedOut.has(rowId(r)) && Number(r.id.slot) > newSlot - rewind).map(rowId);
  return { picked, cursor: JSON.stringify({ s: newSlot, ids }) };
}

// Pure sender rule, exported for tests. See the header comment.
export function inferSender({ ownerTags, signers, vault }) {
  const tags = [...new Set((ownerTags || []).map(String))].filter((t) => t !== vault);
  const signerList = (signers || []).map(String);
  const signing = tags.filter((t) => signerList.includes(t));
  if (signing.length === 1) return { from: signing[0], rule: 'tag+signer' };
  if (signing.length > 1) {
    return signing.includes(signerList[0]) ? { from: signerList[0], rule: 'tag+feepayer' } : { from: null, rule: 'ambiguous' };
  }
  if (tags.length === 1) return { from: tags[0], rule: 'tag-only' };
  if (tags.length === 0 && signerList.length > 0 && signerList[0] !== vault) return { from: signerList[0], rule: 'feepayer' };
  return { from: null, rule: 'unknown' };
}

// SDK error -> RingsError. Only errors that prove nothing was sent may be permanent.
export function classifySdkError(err) {
  if (err instanceof RingsError) return err;
  const codes = [err && err.code, err && err.causeCode, ...((err && err.causeCodes) || [])].filter(Boolean).map(String);
  const has = (c) => codes.includes(c);
  if (has('WALLET_RECIPIENT_NOT_REGISTERED') || has('WALLET_USER_REGISTRY_RECORD_NOT_FOUND')) {
    return new RingsError('RECIPIENT_NOT_REGISTERED', 'recipient has no registered private wallet', { permanent: true, cause: err });
  }
  if (has('WALLET_INVALID_ADDRESS')) return new RingsError('INVALID_ADDRESS', 'recipient address is invalid', { permanent: true, cause: err });
  if (has('WALLET_INVALID_AMOUNT')) return new RingsError('INVALID_AMOUNT', 'amount is invalid', { permanent: true, cause: err });
  if (has('WALLET_TOO_MANY_INPUTS') || has('WALLET_MULTIPLE_INPUT_TREES')) {
    return new RingsError('TOO_MANY_NOTES', 'payout needs too many vault notes at once', { cause: err });
  }
  if (has('WALLET_INSUFFICIENT_BALANCE')) {
    const d = (err && err.details) || {};
    const extra = d.requested !== undefined ? ' (requested ' + d.requested + ', available ' + d.available + ')' : '';
    return new RingsError('INSUFFICIENT_VAULT_BALANCE', 'vault private balance too low' + extra, { cause: err });
  }
  return new RingsError(codes[0] || 'RINGS_SDK_ERROR', String((err && err.message) || err), { cause: err });
}

export function liftMemoNotes(w, memoCache = new Map()) {
  const state = w._state();
  let changed = false;
  const utxos = state.utxos.map((e) => {
    if (e.spent || !e.utxo || !e.utxo.data || e.utxo.data.isEmpty()) return e;
    if (e.utxo.ringProgramId !== undefined || e.dataHash !== undefined || e.ringDataHash !== undefined) return e;
    const records = e.utxo.data.records();
    if (!records.every((r) => r.kind === 'memo')) return e;
    const memo = e.utxo.data.memo();
    if (memo) memoCache.set(String(e.outputContext.leafIndex), memo);
    changed = true;
    const u = e.utxo;
    return {
      ...e,
      utxo: new Utxo({ owner: u.owner, asset: u.asset, ...(u.mint === undefined ? {} : { mint: u.mint }), amount: u.amount, blinding: u.blinding }),
    };
  });
  if (changed) w._replace({ utxos, transactions: state.transactions, nullifiers: state.nullifiers });
  return w;
}

const defaultDeps = {
  createSprClient,
  initializePoseidon,
  syncWallet,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  buildRegistrationTransaction,
  buildDepositTransaction,
  isWalletRegistered,
  fetchTransactionSlots,
  fetchUserRecord,
  buildMergeTransaction,
  buildSetMergeEncryptionTransaction,
  proofKeys: (keypair, c) => LocalKeys.fromKeypair(keypair, c.proofService),
  // Signs with the vault key. The signature is known here, before anything is broadcast.
  async sign(signer, unsigned) {
    const signed = await signTransactionWithSigners([signer], unsigned);
    assertIsTransactionWithBlockhashLifetime(signed);
    return { signed, signature: String(getSignatureFromTransaction(signed)), lastValidBlockHeight: signed.lifetimeConstraint.lastValidBlockHeight.toString() };
  },
  async broadcast(c, signed) {
    await sendTransactionWithoutConfirmingFactory({ rpc: c.solanaRpc })(signed, { commitment: 'confirmed' });
  },
};

// Checks a deposit message before it is signed for depositFrom (owner rule: SOL only moves between wallets this
// service created). messageBytes: the compiled message (version 1 or legacy/v0). The depositing wallet must be the
// fee payer and the ONLY signer, and the only programs called are the Rings shielded pool and System (no compute
// budget instruction is needed: version 1 carries the budget in the message). Throws RingsError, never signs.
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export function checkDepositMessage(messageBytes, from, { pool = String(SHIELDED_POOL_PROGRAM_ID) } = {}) {
  let m;
  try {
    m = getCompiledTransactionMessageDecoder().decode(messageBytes);
  } catch (err) {
    throw new RingsError('DEPOSIT_REFUSED', 'the deposit message does not decode', { permanent: true, cause: err });
  }
  const keys = (m.staticAccounts || []).map(String);
  if (keys[0] !== String(from)) throw new RingsError('DEPOSIT_REFUSED', 'the depositing wallet is not the fee payer', { permanent: true });
  if (Number(m.header.numSignerAccounts) !== 1) throw new RingsError('DEPOSIT_REFUSED', 'the deposit needs a signer other than the depositing wallet', { permanent: true });
  if (m.addressTableLookups && m.addressTableLookups.length) throw new RingsError('DEPOSIT_REFUSED', 'the deposit uses a lookup table', { permanent: true });
  for (const ix of m.instructions || []) {
    const prog = keys[ix.programAddressIndex];
    if (prog !== pool && prog !== SYSTEM_PROGRAM_ID) throw new RingsError('DEPOSIT_REFUSED', 'the deposit calls a program other than the Rings pool: ' + prog, { permanent: true });
  }
  return true;
}

// `deps` exists so the send state machine can be tested offline with a fake client. Production passes none.
export function createRealRings(config = {}, { storage, deps: depOverrides } = {}) {
  const deps = { ...defaultDeps, ...(depOverrides || {}) };
  if (!storage || typeof storage.kvGet !== 'function' || typeof storage.kvSet !== 'function') {
    throw new RingsError('MISSING_STORAGE', 'the real Rings adapter needs storage for its send records');
  }
  const seed = seedFromConfig(config);
  const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed));
  seed.fill(0);
  const signer = keypair.toSolanaSigner();
  const vault = String(signer.address);
  const clientConfig = clientConfigFrom(config); // validates the endpoint now, connects later
  const rewind = config.ringsRewindSlots || DEFAULT_REWIND_SLOTS;
  const acceptPublicDeposits = config.ringsAcceptPublicDeposits !== false;
  const memoPrefix = typeof config.ringsMemoPrefix === 'string' && config.ringsMemoPrefix ? config.ringsMemoPrefix : DEFAULT_MEMO_PREFIX;

  let clientPromise = null;
  let wallet = null;
  let syncKeys = null;
  let proofKeys = null;
  const senderCache = new Map();
  const memoCache = new Map(); // leafIndex -> memo bytes, kept when a memo is lifted off a note to spend it

  async function client() {
    if (!clientPromise) {
      clientPromise = (async () => {
        await deps.initializePoseidon();
        return deps.createSprClient(clientConfig);
      })();
      clientPromise.catch(() => {
        clientPromise = null;
      });
    }
    return clientPromise;
  }

  function freshWallet() {
    wallet = new Wallet({ identity: keypair.shieldedAddress(), registry: new AssetRegistry() });
    return wallet;
  }

  async function sync() {
    const c = await client();
    if (!wallet) freshWallet();
    if (!syncKeys) syncKeys = LocalShieldedKeys.fromKeypair(keypair);
    try {
      await deps.syncWallet({ wallet, keys: syncKeys, client: c });
    } catch (err) {
      throw classifySdkError(err);
    }
    return wallet;
  }

  async function txSigners(c, signature) {
    let lastErr = null;
    for (const maxSupportedTransactionVersion of [1, 0]) {
      try {
        const tx = await c.solanaRpc.getTransaction(signature, { encoding: 'json', commitment: c.commitment === 'processed' ? 'confirmed' : c.commitment, maxSupportedTransactionVersion }).send();
        if (!tx) return null;
        const message = tx.transaction.message;
        const n = Number(message.header.numRequiredSignatures);
        return message.accountKeys.slice(0, n).map(String);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new RingsError('RPC_GET_TRANSACTION', String((lastErr && lastErr.message) || lastErr), { cause: lastErr });
  }

  async function senderOf(c, row) {
    const key = rowId(row);
    if (senderCache.has(key)) return senderCache.get(key);
    const slots = await deps.fetchTransactionSlots({ rpc: c, signature: row.id.signature, leafIndex: row.id.index });
    const signers = (await txSigners(c, row.id.signature)) || [];
    const found = inferSender({ ownerTags: [...slots.ownerTags.values()], signers, vault });
    senderCache.set(key, found);
    return found;
  }

  // A deposit note carries its `<prefix><wallet>` memo inside utxo.data. The memo only rides in the note's ciphertext and is
  // not part of its commitment (the hash folds dataHash, which a memo never sets), yet the SDK's coin selection skips
  // any note whose data is not empty. So before a send, notes whose only data is a memo get that memo lifted off in
  // the wallet's local copy (same hash, same nullifier), which makes them spendable. The memo is kept in memoCache
  // so the deposit watcher still reads it.
  const liftMemos = (w) => liftMemoNotes(w, memoCache);

  function memoOf(w, row) {
    const entry = w.utxos().find((u) => u.outputContext.leafIndex === row.id.index);
    const cached = memoCache.get(String(row.id.index));
    const bytes = cached || (entry && entry.utxo && entry.utxo.data ? entry.utxo.data.memo() : undefined);
    if (!bytes || bytes.length === 0) return '';
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return '';
    }
  }

  async function listIncoming({ cursor, limit } = {}) {
    const c = await client();
    const w = await sync();
    const { picked, cursor: next } = selectIncoming(w.privateTransactions(), cursor, { rewind, limit: limit || 200, acceptPublicDeposits });
    const items = [];
    for (const row of picked) {
      const sender = await senderOf(c, row);
      items.push({
        id: rowId(row),
        from: sender.from,
        asset: mintToAsset(row.asset),
        amount: row.amount,
        memo: memoOf(w, row),
        slot: Number(row.id.slot),
        signature: String(row.id.signature),
      });
    }
    return { items, cursor: next };
  }

  // Settles an earlier 'submitted' record. -> { landed: {signature, slot} } | { retry: true } | throws transient.
  async function settle(c, rec) {
    const statuses = await c.solanaRpc.getSignatureStatuses([rec.signature], { searchTransactionHistory: true }).send();
    const status = statuses && statuses.value ? statuses.value[0] : null;
    if (status) {
      if (status.err) return { retry: true }; // failed on chain: the whole transfer reverted, nothing moved
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { landed: { signature: rec.signature, slot: Number(status.slot) } };
      }
      throw new RingsError('SEND_PENDING', 'earlier transfer is still being confirmed');
    }
    // Not visible to the RPC. It is only dead once its blockhash expired on the finalized chain.
    const height = await c.solanaRpc.getBlockHeight({ commitment: 'finalized' }).send();
    if (BigInt(height) <= BigInt(rec.lastValidBlockHeight)) throw new RingsError('SEND_PENDING', 'earlier transfer may still land');
    // Belt and braces: the indexer's view of the vault's own outgoing history.
    const w = await sync();
    const row = w.privateTransactions().find((r) => String(r.id.signature) === rec.signature);
    if (row) return { landed: { signature: rec.signature, slot: Number(row.id.slot) } };
    return { retry: true };
  }

  // Folds up to 24 of the vault's small SOL notes into one (the SDK's merge), so a large payout fits in one proof.
  // Sets the vault's merge encryption first if its registry record has none. At most one run every 2 minutes.
  let lastMergeAt = 0;
  async function consolidate(c) {
    if (Date.now() - lastMergeAt < 120000) return;
    lastMergeAt = Date.now();
    try {
      const record = await deps.fetchUserRecord({ rpc: c, owner: signer.address });
      if (record && record.mergeEncryption !== MergeEncryptionScheme.PoseidonCtrV1) {
        const setTx = await deps.buildSetMergeEncryptionTransaction({ client: c, owner: signer.address, scheme: MergeEncryptionScheme.PoseidonCtrV1 });
        const setSigned = await deps.sign(signer, setTx);
        await deps.broadcast(c, setSigned.signed);
        await c.confirmTransaction(setSigned.signature);
      }
      const w = liftMemos(await sync());
      if (!proofKeys) proofKeys = deps.proofKeys(keypair, c);
      const unsigned = await deps.buildMergeTransaction({ client: c, wallet: w, keys: proofKeys, feePayer: signer.address, asset: SOL_MINT });
      const signed = await deps.sign(signer, unsigned);
      await deps.broadcast(c, signed.signed);
      await c.confirmTransaction(signed.signature);
    } catch (err) {
      throw new RingsError('MERGE_FAILED', 'could not merge vault notes: ' + String((err && err.message) || err), { cause: err });
    } finally {
      wallet = null; // resync so the merged note is seen
    }
  }

  async function sendPrivate(args = {}) {
    return sendOnce('transfer', args);
  }

  // Unshields `amount` of `asset` from the vault to a PUBLIC Solana address (used by public withdrawals to move
  // SOL to a public address). Same exactly-once record as sendPrivate, under its own key.
  async function withdrawPublic(args = {}) {
    return sendOnce('withdrawal', args);
  }

  // kind: 'transfer' (private wallet to private wallet) | 'withdrawal' (private vault to a public address).
  async function sendOnce(kind, { to, asset, amount, memo, idempotencyKey } = {}) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new RingsError('MISSING_IDEMPOTENCY_KEY', 'idempotencyKey is required');
    const c = await client();

    // 1. an earlier attempt with this key decides everything, before any validation
    const rec = await storage.kvGet(KV_SEND, idempotencyKey);
    if (rec && rec.status === 'confirmed') return { signature: rec.signature, slot: rec.slot };
    let attempt = 1;
    if (rec && rec.status === 'submitted') {
      const outcome = await settle(c, rec);
      if (outcome.landed) {
        await storage.kvSet(KV_SEND, idempotencyKey, { ...rec, status: 'confirmed', slot: outcome.landed.slot });
        return outcome.landed;
      }
      attempt = (rec.attempt || 1) + 1;
      wallet = null; // drop note reservations of the dead attempt, resync from scratch
    }

    // 2. checks that prove nothing can be sent
    if (typeof to !== 'string' || !isAddress(to)) throw new RingsError('INVALID_ADDRESS', 'recipient is not a Solana address', { permanent: true });
    const mint = assetToMint(asset);
    let value;
    try {
      value = BigInt(amount);
    } catch {
      value = 0n;
    }
    if (value <= 0n) throw new RingsError('INVALID_AMOUNT', 'amount must be positive', { permanent: true });
    const recipient = toAddress(to);
    if (kind === 'transfer') {
      let registered;
      try {
        registered = await deps.isWalletRegistered({ rpc: c, owner: recipient });
      } catch (err) {
        throw classifySdkError(err);
      }
      if (!registered) throw new RingsError('RECIPIENT_NOT_REGISTERED', 'recipient has no registered private wallet', { permanent: true });
    }

    // 3. build + prove + sign locally
    let signed;
    try {
      const w = liftMemos(await sync());
      if (!proofKeys) proofKeys = deps.proofKeys(keypair, c);
      const build = kind === 'withdrawal' ? deps.buildWithdrawalTransaction : deps.buildTransferTransaction;
      const unsigned = await build({ client: c, wallet: w, keys: proofKeys, feePayer: signer.address, recipient, asset: mint, amount: value });
      signed = await deps.sign(signer, unsigned);
    } catch (err) {
      wallet = null;
      const e = classifySdkError(err);
      if (e.code === 'TOO_MANY_NOTES') {
        // Many small deposits: fold them into one note first, then the next retry pays in one go.
        await consolidate(c);
        throw new RingsError('NOTES_MERGED', 'vault notes merged, payout retries next pass');
      }
      throw e;
    }
    const signature = signed.signature;

    // 4. record BEFORE broadcasting
    const record = {
      status: 'submitted',
      kind,
      signature,
      lastValidBlockHeight: signed.lastValidBlockHeight,
      to,
      asset,
      amount: value.toString(),
      memo: memo === undefined || memo === null ? '' : String(memo),
      attempt,
      previous: rec && rec.signature ? [...((rec && rec.previous) || []), rec.signature] : [],
    };
    await storage.kvSet(KV_SEND, idempotencyKey, record);

    // 5. broadcast and confirm. Any failure from here on is transient: the record settles it next time.
    let slot;
    try {
      await deps.broadcast(c, signed.signed);
      slot = Number(await c.confirmTransaction(signature));
    } catch (err) {
      wallet = null;
      throw new RingsError('SEND_UNCONFIRMED', 'transfer broadcast but not confirmed yet: ' + String((err && err.message) || err), { cause: err });
    }
    await storage.kvSet(KV_SEND, idempotencyKey, { ...record, status: 'confirmed', slot });
    return { signature, slot };
  }

  // Unsigned public deposit: plain SOL from `from`'s public wallet straight into the VAULT's private balance.
  // `from` is fee payer, depositor and only signer; the user signs and sends it from their own wallet.
  // The recipient is passed as the vault's ShieldedAddress, so the SDK does no registry lookup for it, and the
  // memo `<prefix><wallet>` rides encrypted in the vault's UTXO. The watcher sees an inbound `deposit` row whose only
  // signer (fee payer) is `from`, and credits `from` (memo first, sender rule as backup) once per row id.
  // `creditTo` (optional): the wallet named in the memo instead of `from`.
  async function buildPublicDeposit({ from, amount, creditTo } = {}) {
    if (typeof from !== 'string' || !isAddress(from)) throw new RingsError('INVALID_ADDRESS', 'depositor is not a Solana address', { permanent: true });
    let value;
    try {
      value = BigInt(amount);
    } catch {
      value = 0n;
    }
    if (value <= 0n) throw new RingsError('INVALID_AMOUNT', 'amount must be positive', { permanent: true });
    const c = await client();
    const payer = toAddress(from);
    let unsigned;
    try {
      unsigned = await deps.buildDepositTransaction({
        client: c,
        feePayer: payer,
        depositor: payer,
        recipient: keypair.shieldedAddress(),
        asset: SOL_MINT,
        amount: value,
        memo: new TextEncoder().encode(memoPrefix + (typeof creditTo === 'string' && creditTo ? creditTo : from)),
      });
    } catch (err) {
      throw classifySdkError(err);
    }
    const life = unsigned.lifetimeConstraint || {};
    return {
      tx: getBase64EncodedWireTransaction(unsigned),
      blockhash: life.blockhash === undefined ? null : String(life.blockhash),
      lastValidBlockHeight: life.lastValidBlockHeight === undefined ? null : String(life.lastValidBlockHeight),
    };
  }

  // Deposits SOL from ANOTHER wallet of this service (fromSeed: its 32 byte seed) into the vault's private balance,
  // exactly once per idempotencyKey: the record { status: 'submitted', signature } is written BEFORE the broadcast
  // and a later call with the same key settles it first (landed -> returned; failed on chain or blockhash dead ->
  // a new attempt, never two live ones). Used by the off grid tip sweep. The message is checked
  // with checkDepositMessage before signing. -> { signature, slot }
  async function depositFrom({ fromSeed, amount, memo, idempotencyKey } = {}) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new RingsError('MISSING_IDEMPOTENCY_KEY', 'idempotencyKey is required');
    const seedBytes = Uint8Array.from(fromSeed || []);
    if (seedBytes.length !== 32) throw new RingsError('BAD_KEY', 'depositFrom needs the 32 byte seed of the depositing wallet', { permanent: true });
    const fromSigner = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seedBytes)).toSolanaSigner();
    seedBytes.fill(0);
    const from = String(fromSigner.address);
    if (from === vault) throw new RingsError('DEPOSIT_REFUSED', 'the vault does not deposit to itself', { permanent: true });
    const c = await client();
    const rec = await storage.kvGet(KV_SEND, idempotencyKey);
    if (rec && rec.status === 'confirmed') return { signature: rec.signature, slot: rec.slot };
    let attempt = 1;
    let value;
    try { value = BigInt(amount); } catch { value = 0n; }
    if (rec && rec.status === 'submitted') {
      const outcome = await settle(c, rec);
      if (outcome.landed) {
        await storage.kvSet(KV_SEND, idempotencyKey, { ...rec, status: 'confirmed', slot: outcome.landed.slot });
        return outcome.landed;
      }
      attempt = (rec.attempt || 1) + 1;
      value = BigInt(rec.amount); // a retry moves exactly what was recorded
    }
    if (value <= 0n) throw new RingsError('INVALID_AMOUNT', 'amount must be positive', { permanent: true });
    let unsigned;
    try {
      unsigned = await deps.buildDepositTransaction({
        client: c, feePayer: fromSigner.address, depositor: fromSigner.address, recipient: keypair.shieldedAddress(),
        asset: SOL_MINT, amount: value, ...(memo ? { memo: new TextEncoder().encode(String(memo)) } : {}),
      });
    } catch (err) {
      throw classifySdkError(err);
    }
    checkDepositMessage(unsigned.messageBytes, from);
    const signed = await deps.sign(fromSigner, unsigned);
    const record = { status: 'submitted', kind: 'deposit', from, signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight, amount: value.toString(), memo: memo ? String(memo) : '', attempt, previous: rec && rec.signature ? [...(rec.previous || []), rec.signature] : [] };
    await storage.kvSet(KV_SEND, idempotencyKey, record);
    let slot;
    try {
      await deps.broadcast(c, signed.signed);
      slot = Number(await c.confirmTransaction(signed.signature));
    } catch (err) {
      throw new RingsError('SEND_UNCONFIRMED', 'deposit broadcast but not confirmed yet: ' + String((err && err.message) || err), { cause: err });
    }
    await storage.kvSet(KV_SEND, idempotencyKey, { ...record, status: 'confirmed', slot });
    wallet = null; // the vault holds a new note: resync
    return { signature: signed.signature, slot };
  }

  async function vaultBalance(asset) {
    const mint = assetToMint(asset);
    const w = await sync();
    try {
      return w.balance(mint).amount;
    } catch {
      return 0n; // a mint the wallet has never seen
    }
  }

  // ---- readiness (SPEC addendum A3) ----
  let readyDone = false;
  let readyInFlight = null;

  async function registrationCost(c) {
    const override = Number(config.ringsRegisterLamports);
    if (Number.isSafeInteger(override) && override > 0) return override;
    try {
      const record = await c.solanaRpc.getMinimumBalanceForRentExemption(BigInt(USER_RECORD_SIZE)).send();
      const wallet = await c.solanaRpc.getMinimumBalanceForRentExemption(0n).send();
      return Number(record) + Number(wallet) + REGISTER_FEE_MARGIN;
    } catch {
      return DEFAULT_REGISTER_LAMPORTS;
    }
  }

  async function readyOnce() {
    const c = await client();
    if (await deps.isWalletRegistered({ rpc: c, owner: signer.address })) {
      readyDone = true;
      return { status: 'ready' };
    }

    // A registration tx sent earlier (this process or a previous one) whose outcome is not known yet.
    const pending = await storage.kvGet(KV_SEND, KV_REGISTRATION_KEY);
    if (pending && pending.status === 'submitted') {
      const statuses = await c.solanaRpc.getSignatureStatuses([pending.signature], { searchTransactionHistory: true }).send();
      const status = statuses && statuses.value ? statuses.value[0] : null;
      if (status && !status.err) return { status: 'error', message: 'registration ' + pending.signature + ' is still confirming' };
      if (!status) {
        const height = await c.solanaRpc.getBlockHeight({ commitment: 'finalized' }).send();
        if (BigInt(height) <= BigInt(pending.lastValidBlockHeight)) {
          return { status: 'error', message: 'registration ' + pending.signature + ' is still confirming' };
        }
      }
      // failed on chain, or its blockhash is dead: a new one is safe
    }

    const have = Number(await c.getBalance(signer.address));
    const need = await registrationCost(c);
    if (have < need) return { status: 'needs_funding', address: vault, haveLamports: have, needLamports: need };

    const unsigned = await deps.buildRegistrationTransaction({ client: c, owner: signer.address, address: keypair.shieldedAddress() });
    if (!unsigned) {
      readyDone = true; // the record already holds this wallet
      return { status: 'ready' };
    }
    const signed = await deps.sign(signer, unsigned);
    await storage.kvSet(KV_SEND, KV_REGISTRATION_KEY, { status: 'submitted', signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight });
    await deps.broadcast(c, signed.signed);
    await c.confirmTransaction(signed.signature);
    await storage.kvSet(KV_SEND, KV_REGISTRATION_KEY, { status: 'confirmed', signature: signed.signature });
    readyDone = true;
    return { status: 'ready', signature: signed.signature };
  }

  // -> { status: 'ready' } | { status: 'needs_funding', address, haveLamports, needLamports } | { status: 'error', message }
  // Never throws. Registers the vault private wallet (same address as the Rings key) once it can pay for it.
  // Safe to call again and again: once ready it answers from memory, concurrent calls share one run, a
  // registration that was sent but not confirmed is settled before another is built, and the registry program
  // itself refuses a second record for the same owner.
  function ensureReady() {
    if (readyDone) return Promise.resolve({ status: 'ready' });
    if (!readyInFlight) {
      readyInFlight = readyOnce()
        .catch((err) => ({ status: 'error', message: String((err && (err.message || err.code)) || err) }))
        .finally(() => {
          readyInFlight = null;
        });
    }
    return readyInFlight;
  }

  return {
    mode: 'real',
    vaultAddress: () => vault,
    listIncoming,
    sendPrivate,
    withdrawPublic,
    buildPublicDeposit,
    depositFrom,
    vaultBalance,
    ensureReady,
    // Outside the spec interface, the counterpart of the sim's `adapter.sim`: operator helpers for the smoke script.
    real: {
      isRegistered: async (owner) => deps.isWalletRegistered({ rpc: await client(), owner: toAddress(owner) }),
      client,
      keypair: () => keypair,
      // What the watcher would see for one row, with the rule that picked the sender.
      explainSender: async (signature, index) => senderOf(await client(), { id: { signature, index: BigInt(index) } }),
    },
  };
}
export { defaultDeps as sdkDeps };
