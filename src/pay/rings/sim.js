// In-memory model of a Privacy Ring, used when config.ringsMode !== 'real' (tests, and a boot with no config).
// It models the EXTERNAL system (Solana + Rings), so its memory
// survives a simulated restart of the pay module as long as the same adapter object is reused. It writes nothing
// to storage and never touches the network.
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { createIdentity } from '../../core/identity.js';
import { isPubkey } from '../util.js';
import { DEFAULT_MEMO_PREFIX } from './memo.js';
import { RingsError } from './errors.js';

function seedBytes(seed) {
  if (seed === undefined || seed === null || seed === '') return null;
  if (typeof seed === 'string') return Buffer.from(bs58.decode(seed));
  return Buffer.from(seed);
}

function toBig(x) {
  try {
    if (typeof x === 'bigint') return x;
    if (typeof x === 'number' && Number.isSafeInteger(x)) return BigInt(x);
    if (typeof x === 'string' && /^[0-9]{1,31}$/.test(x)) return BigInt(x);
  } catch { /* fall through */ }
  throw new RingsError('INVALID_AMOUNT', 'amount must be a whole number', { permanent: true });
}

// The sim vault address. With a Rings seed it is the same Solana pubkey the real adapter uses.
// Without one (zero env boot) it is a fixed hash label; no key exists for it.
export function simVaultAddress(config) {
  const seed = seedBytes(config && config.ringsSeed);
  if (seed && (seed.length === 32 || seed.length === 64)) return createIdentity(seed.subarray(0, 32)).id;
  const label = (config && config.ringsSimLabel) || 'tangent';
  return bs58.encode(createHash('sha256').update('rings sim vault\n' + label).digest());
}

export const SIM_TX_PREFIX = 'simtx:';

export function parseSimDepositTx(tx) {
  if (typeof tx !== 'string' || !tx.startsWith(SIM_TX_PREFIX)) throw new RingsError('BAD_SIM_TX', 'not a sim deposit tx', { permanent: true });
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(tx.slice(SIM_TX_PREFIX.length), 'base64').toString('utf8'));
  } catch {
    throw new RingsError('BAD_SIM_TX', 'not a sim deposit tx', { permanent: true });
  }
  if (!parsed || parsed.sim !== 'rings-deposit' || !isPubkey(parsed.from) || !/^[1-9][0-9]{0,30}$/.test(String(parsed.amount)) || typeof parsed.nonce !== 'string') {
    throw new RingsError('BAD_SIM_TX', 'not a sim deposit tx', { permanent: true });
  }
  return parsed;
}

function fakeSignature(tag, n) {
  const a = createHash('sha256').update('rings-sim sig a\n' + tag + '\n' + n).digest();
  const b = createHash('sha256').update('rings-sim sig b\n' + tag + '\n' + n).digest();
  return bs58.encode(Buffer.concat([a, b]));
}

export function createSimRings(config = {}) {
  const vault = simVaultAddress(config);
  const memoPrefix = typeof config.ringsMemoPrefix === 'string' && config.ringsMemoPrefix ? config.ringsMemoPrefix : DEFAULT_MEMO_PREFIX;
  const balances = new Map(); // owner -> Map(asset -> BigInt)
  const unregistered = new Set();
  const incoming = []; // stable order, index + 1 is the cursor position
  const outgoing = [];
  const sends = new Map(); // idempotencyKey -> { signature, slot }
  const publicSends = new Map(); // idempotencyKey -> { signature, slot } for withdrawPublic
  const publicBalances = new Map(); // `${address}:${asset}` -> BigInt, what the vault unshielded to public addresses
  const publicOut = [];
  const publicListeners = [];
  let slot = 1000;
  let sigCounter = 0;
  let pendingFault = null;
  const submittedDeposits = new Map(); // sim tx nonce -> incoming item
  const simDeposits = new Map(); // depositFrom idempotencyKey -> { status, signature, slot, amount }
  let depositNonce = 0;

  function bal(owner, asset) {
    const m = balances.get(owner);
    return m ? m.get(asset) || 0n : 0n;
  }
  function setBal(owner, asset, value) {
    let m = balances.get(owner);
    if (!m) balances.set(owner, (m = new Map()));
    if (value === 0n) m.delete(asset);
    else m.set(asset, value);
  }
  function positive(amount) {
    const v = toBig(amount);
    if (v <= 0n) throw new RingsError('INVALID_AMOUNT', 'amount must be positive', { permanent: true });
    return v;
  }
  function parseCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    const n = Number(cursor);
    if (!Number.isSafeInteger(n) || n < 0) throw new RingsError('BAD_CURSOR', 'bad cursor ' + cursor);
    return Math.min(n, incoming.length);
  }

  const sim = {
    // Gives a user a private balance inside the ring (stands in for a public deposit or an onramp).
    fund(user, asset, amount) {
      if (!isPubkey(user)) throw new RingsError('INVALID_ADDRESS', 'bad user address', { permanent: true });
      setBal(user, asset, bal(user, asset) + positive(amount));
    },
    // A confidential transfer from the user's private balance to the vault's private wallet.
    userSendToVault(user, asset, amount, memo) {
      if (!isPubkey(user)) throw new RingsError('INVALID_ADDRESS', 'bad user address', { permanent: true });
      const v = positive(amount);
      if (bal(user, asset) < v) throw new RingsError('INSUFFICIENT_BALANCE', 'user private balance too low');
      setBal(user, asset, bal(user, asset) - v);
      setBal(vault, asset, bal(vault, asset) + v);
      slot += 1;
      sigCounter += 1;
      const signature = fakeSignature('in', sigCounter);
      const item = {
        id: signature + ':0',
        from: user,
        asset,
        amount: v,
        memo: memo === undefined || memo === null ? '' : String(memo),
        slot,
        signature,
      };
      incoming.push(item);
      return { ...item };
    },
    // A public deposit: plain SOL from `from`'s public wallet straight into the vault's private balance,
    // signed by `from`. Lands as an incoming item whose sender is the depositor.
    publicDeposit(from, asset, amount, creditTo) {
      if (!isPubkey(from)) throw new RingsError('INVALID_ADDRESS', 'bad depositor address', { permanent: true });
      const v = positive(amount);
      setBal(vault, asset, bal(vault, asset) + v);
      slot += 1;
      sigCounter += 1;
      const signature = fakeSignature('deposit', sigCounter);
      const item = { id: signature + ':0', from, asset, amount: v, memo: memoPrefix + (creditTo || from), slot, signature, kind: 'deposit' };
      incoming.push(item);
      return { ...item };
    },
    // Lands a tx made by buildPublicDeposit. The same tx lands once: a second submit returns the first signature.
    submitPublicDeposit(tx) {
      const parsed = parseSimDepositTx(tx);
      const prior = submittedDeposits.get(parsed.nonce);
      if (prior) return { signature: prior.signature, duplicate: true };
      const item = sim.publicDeposit(parsed.from, 'SOL', parsed.amount, parsed.creditTo);
      submittedDeposits.set(parsed.nonce, item);
      return { signature: item.signature, duplicate: false };
    },
    balanceOf(user, asset) {
      return bal(user, asset);
    },
    // Next sendPrivate fails. Options:
    //   { permanent: true, code }  -> permanent error, nothing is sent
    //   { afterSend: true }        -> the payment IS made and recorded under its idempotency key, then the call
    //                                 throws. Models "sent, but the process died before recording the result".
    //   default                    -> transient error, nothing is sent
    failNextSend(options = {}) {
      pendingFault = { permanent: Boolean(options.permanent), afterSend: Boolean(options.afterSend), code: options.code };
    },
    crashAfterNextSend() {
      pendingFault = { permanent: false, afterSend: true };
    },
    setRegistered(user, registered) {
      if (registered) unregistered.delete(user);
      else unregistered.add(user);
    },
    isRegistered(user) {
      return isPubkey(user) && !unregistered.has(user);
    },
    outgoing() {
      return outgoing.map((o) => ({ ...o }));
    },
    incoming() {
      return incoming.map((o) => ({ ...o }));
    },
    sendCount() {
      return outgoing.length;
    },
    publicBalanceOf(address, asset = 'SOL') {
      return publicBalances.get(address + ':' + asset) || 0n;
    },
    publicWithdrawals() {
      return publicOut.map((o) => ({ ...o }));
    },
    onPublicWithdraw(fn) {
      if (typeof fn === 'function') publicListeners.push(fn);
    },
  };

  return {
    mode: 'sim',
    vaultAddress() {
      return vault;
    },
    async listIncoming({ cursor, limit } = {}) {
      const start = parseCursor(cursor);
      const end = limit && limit > 0 ? Math.min(incoming.length, start + limit) : incoming.length;
      return { items: incoming.slice(start, end).map((i) => ({ ...i })), cursor: String(end) };
    },
    async sendPrivate({ to, asset, amount, memo, idempotencyKey } = {}) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        throw new RingsError('MISSING_IDEMPOTENCY_KEY', 'idempotencyKey is required');
      }
      // A key that already paid always returns the first result, before any other check or fault.
      const prior = sends.get(idempotencyKey);
      if (prior) return { ...prior };

      const fault = pendingFault;
      pendingFault = null;
      if (fault && !fault.afterSend) {
        if (fault.permanent) throw new RingsError(fault.code || 'RECIPIENT_NOT_REGISTERED', 'simulated permanent failure', { permanent: true });
        throw new RingsError(fault.code || 'SIM_SEND_FAILED', 'simulated transient failure');
      }
      if (!isPubkey(to)) throw new RingsError('INVALID_ADDRESS', 'recipient is not a Solana address', { permanent: true });
      if (unregistered.has(to)) throw new RingsError('RECIPIENT_NOT_REGISTERED', 'recipient has no private wallet', { permanent: true });
      if (typeof asset !== 'string' || asset.length === 0) throw new RingsError('UNSUPPORTED_ASSET', 'bad asset', { permanent: true });
      const v = positive(amount);
      if (bal(vault, asset) < v) throw new RingsError('INSUFFICIENT_VAULT_BALANCE', 'vault private balance too low');

      setBal(vault, asset, bal(vault, asset) - v);
      setBal(to, asset, bal(to, asset) + v);
      slot += 1;
      sigCounter += 1;
      const result = { signature: fakeSignature('out', sigCounter), slot };
      sends.set(idempotencyKey, result);
      outgoing.push({ ...result, to, asset, amount: v, memo: memo === undefined || memo === null ? '' : String(memo), idempotencyKey });
      if (fault && fault.afterSend) throw new RingsError('SIM_CRASH_AFTER_SEND', 'simulated crash after the payment landed');
      return { ...result };
    },
    // Unshield from the vault to a PUBLIC Solana address (public withdrawals). Exactly once per idempotencyKey,
    // same fault options as sendPrivate. The public side is modelled by `sim.publicBalanceOf` and the
    // optional `sim.onPublicWithdraw(fn)` hook.
    async withdrawPublic({ to, asset, amount, idempotencyKey } = {}) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        throw new RingsError('MISSING_IDEMPOTENCY_KEY', 'idempotencyKey is required');
      }
      const prior = publicSends.get(idempotencyKey);
      if (prior) return { ...prior };
      const fault = pendingFault;
      pendingFault = null;
      if (fault && !fault.afterSend) {
        if (fault.permanent) throw new RingsError(fault.code || 'INVALID_ADDRESS', 'simulated permanent failure', { permanent: true });
        throw new RingsError(fault.code || 'SIM_SEND_FAILED', 'simulated transient failure');
      }
      if (!isPubkey(to)) throw new RingsError('INVALID_ADDRESS', 'recipient is not a Solana address', { permanent: true });
      if (typeof asset !== 'string' || asset.length === 0) throw new RingsError('UNSUPPORTED_ASSET', 'bad asset', { permanent: true });
      const v = positive(amount);
      if (bal(vault, asset) < v) throw new RingsError('INSUFFICIENT_VAULT_BALANCE', 'vault private balance too low');
      setBal(vault, asset, bal(vault, asset) - v);
      const key = to + ':' + asset;
      publicBalances.set(key, (publicBalances.get(key) || 0n) + v);
      slot += 1;
      sigCounter += 1;
      const result = { signature: fakeSignature('unshield', sigCounter), slot };
      publicSends.set(idempotencyKey, result);
      publicOut.push({ ...result, to, asset, amount: v, idempotencyKey });
      for (const fn of publicListeners) {
        try { fn({ to, asset, amount: v }); } catch { /* a listener must not break the ring */ }
      }
      if (fault && fault.afterSend) throw new RingsError('SIM_CRASH_AFTER_SEND', 'simulated crash after the withdrawal landed');
      return { ...result };
    },
    // Same contract as the real adapter's depositFrom: another wallet of the service deposits SOL into the vault's
    // private balance, exactly once per idempotencyKey. With `connection` (a web3.js Connection, for example a
    // LiteSVM chain behind JSON-RPC in tests) the SOL really leaves `from` on that chain: a System transfer to the
    // vault's public address, signed with fromSeed. The sim then books it as an incoming deposit item.
    async depositFrom({ fromSeed, amount, memo, idempotencyKey, connection = null } = {}) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new RingsError('MISSING_IDEMPOTENCY_KEY', 'idempotencyKey is required');
      const prior = simDeposits.get(idempotencyKey);
      if (prior && prior.status === 'confirmed') return { signature: prior.signature, slot: prior.slot };
      const seedBuf = Buffer.from(fromSeed || []);
      if (seedBuf.length !== 32) throw new RingsError('BAD_KEY', 'depositFrom needs the 32 byte seed of the depositing wallet', { permanent: true });
      const from = createIdentity(seedBuf).id;
      if (from === vault) throw new RingsError('DEPOSIT_REFUSED', 'the vault does not deposit to itself', { permanent: true });
      const v = prior ? BigInt(prior.amount) : positive(amount);
      let signature = prior ? prior.signature : null;
      if (connection) {
        const web3 = await import('@solana/web3.js');
        const kp = web3.Keypair.fromSeed(seedBuf);
        if (!prior) {
          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          const tx = new web3.Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(web3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new web3.PublicKey(vault), lamports: v }));
          tx.sign(kp);
          signature = bs58.encode(tx.signature);
          simDeposits.set(idempotencyKey, { status: 'submitted', signature, amount: v.toString() }); // recorded before broadcast
          try {
            await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
          } catch (err) {
            // refused at preflight: nothing was sent, so the record goes and a retry builds a new one
            simDeposits.delete(idempotencyKey);
            throw new RingsError('SEND_FAILED', 'deposit refused before it was sent: ' + String((err && err.message) || err).slice(0, 160));
          }
        }
        const end = Date.now() + 30_000;
        for (;;) {
          const st = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          const x = st && st.value ? st.value[0] : null;
          if (x && x.err) { simDeposits.delete(idempotencyKey); throw new RingsError('DEPOSIT_FAILED', 'the deposit failed on chain', { permanent: true }); }
          if (x && (x.confirmationStatus === 'confirmed' || x.confirmationStatus === 'finalized')) break;
          if (Date.now() > end) throw new RingsError('SEND_UNCONFIRMED', 'deposit broadcast but not confirmed yet');
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      setBal(vault, 'SOL', bal(vault, 'SOL') + v);
      slot += 1;
      sigCounter += 1;
      signature = signature || fakeSignature('deposit-from', sigCounter);
      incoming.push({ id: signature + ':0', from, asset: 'SOL', amount: v, memo: memo === undefined || memo === null ? '' : String(memo), slot, signature, kind: 'deposit' });
      simDeposits.set(idempotencyKey, { status: 'confirmed', signature, slot, amount: v.toString() });
      return { signature, slot };
    },
    async vaultBalance(asset) {
      return bal(vault, asset);
    },
    // Sim counterpart of the real buildPublicDeposit: an unsigned "tx" the sim can land via sim.submitPublicDeposit.
    async buildPublicDeposit({ from, amount, creditTo } = {}) {
      if (!isPubkey(from)) throw new RingsError('INVALID_ADDRESS', 'depositor is not a Solana address', { permanent: true });
      const v = positive(amount);
      depositNonce += 1;
      const payload = { sim: 'rings-deposit', from, amount: v.toString(), nonce: vault.slice(0, 8) + ':' + depositNonce + ':' + Date.now() };
      if (typeof creditTo === 'string' && creditTo) payload.creditTo = creditTo;
      return { tx: SIM_TX_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64'), blockhash: 'sim', lastValidBlockHeight: '0', sim: true };
    },
    // Nothing to set up in the sim (SPEC addendum A3).
    async ensureReady() {
      return { status: 'ready' };
    },
    sim,
  };
}
