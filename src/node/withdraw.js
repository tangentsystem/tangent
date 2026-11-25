// Withdraw unused wallet balance (client CLI `withdraw`).
//
//   checkWithdrawArgs   checks the options before anything is signed
//   requestWithdrawal   one time challenge, request signed by the wallet identity
//                       (src/pay/client.js withdrawRequest), POST /api/pay/withdraw
//   followWithdrawal    reads GET /api/pay/withdraw/:id until it is sent or refunded
//
// The pay module does the money side (docs/pay.md): the amount leaves the wallet balance
// when the request is accepted, is sent once (idempotency key per withdrawal), and goes back
// to the balance if it cannot be sent.
import { withdrawRequest } from '../pay/client.js';
import { isPubkey } from '../pay/util.js';

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.usage = true; }
}

const WITHDRAWAL_ID = /^[A-Za-z0-9_-]{8,64}$/;

// values: parsed CLI options. -> { follow: id } or { to, amount, public }
export function checkWithdrawArgs(values = {}) {
  if (values.id !== undefined) {
    if (!WITHDRAWAL_ID.test(values.id)) throw new UsageError('--id must be a withdrawal id');
    if (values.to !== undefined || values.lamports !== undefined) throw new UsageError('--id follows an earlier withdrawal; leave out --to and --lamports');
    return { follow: values.id };
  }
  if (!values.to) throw new UsageError('--to is required');
  if (!isPubkey(values.to)) throw new UsageError('--to must be a Solana address');
  if (!values.lamports) throw new UsageError('--lamports is required');
  if (!/^[0-9]{1,19}$/.test(values.lamports) || BigInt(values.lamports) <= 0n) throw new UsageError('--lamports must be a whole number above 0');
  return { to: values.to, amount: BigInt(values.lamports).toString(), public: values.public === true };
}

export async function requestWithdrawal({ coord, wallet, to, amount, public: isPublic = false }) {
  if (!coord || !wallet) throw new Error('withdraw: coord and wallet are required');
  const { challenge } = await coord.pay.challenge(wallet.id);
  return coord.pay.withdraw(withdrawRequest(wallet, { challenge, to, amount: String(amount), public: isPublic === true }));
}

// -> { done, withdrawal } ; done is false when it is still pending after timeoutMs
export async function followWithdrawal({ coord, id, timeoutMs = 120_000, everyMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, onUpdate = () => {} }) {
  const end = now() + timeoutMs;
  let last = null;
  for (;;) {
    let w;
    try { w = await coord.pay.withdrawal(id); } catch (err) {
      if (!err || !err.transient) throw err; // only a network hiccup is retried
      w = undefined;
    }
    if (w === null) throw new Error(`no withdrawal ${id}`);
    if (w) {
      if (!last || last.status !== w.status) onUpdate(w);
      last = w;
      if (w.status !== 'pending') return { done: true, withdrawal: w };
    }
    if (now() >= end) return { done: false, withdrawal: last };
    await sleep(everyMs);
  }
}
