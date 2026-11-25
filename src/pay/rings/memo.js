// How a Rings deposit is bound to the wallet it credits.
//
// A public deposit (rings.buildPublicDeposit, the user signs it from their own wallet) carries the memo
// `<prefix><wallet>` encrypted inside the vault's note; the memo names the wallet to credit.
// A confidential transfer from the user's own Rings private wallet carries no memo (the SDK's transfer builder
// takes none); the adapter reads the sender from public transaction data (see real.js header) and that sender is
// credited. Memo first, sender second.
import { isPubkey } from '../util.js';

export const DEFAULT_MEMO_PREFIX = 'tangent:';
// Memo of an off grid tip sweep (the network tip account depositing its tips into the vault).
// The tips it carries were credited to node earnings when each tip was claimed, so a sweep credits no wallet.
export const TIP_SWEEP_MEMO_SUFFIX = 'tipsweep';
export const tipSweepMemo = (prefix = DEFAULT_MEMO_PREFIX) => prefix + TIP_SWEEP_MEMO_SUFFIX;

export function memoTarget(memo, prefix = DEFAULT_MEMO_PREFIX) {
  if (typeof memo !== 'string') return null;
  const trimmed = memo.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const candidate = trimmed.slice(prefix.length);
  return isPubkey(candidate) ? candidate : null;
}

// Pure: what one incoming Rings item does. -> { action: 'credit', wallet, amount, by } | { action: 'ignore', reason }
// sweepFrom: the network tip account. An item from it with the sweep memo is a tip sweep: recorded, never credited.
export function planDeposit(item, { assets = ['SOL'], prefix = DEFAULT_MEMO_PREFIX, sweepFrom = null } = {}) {
  if (!item || typeof item.id !== 'string' || item.id.length === 0) return { action: 'ignore', reason: 'bad_item' };
  if (sweepFrom && item.from === sweepFrom && typeof item.memo === 'string' && item.memo.trim() === tipSweepMemo(prefix)) return { action: 'ignore', reason: 'tip_sweep' };
  if (!assets.includes(item.asset)) return { action: 'ignore', reason: 'asset_not_allowed' };
  let amount;
  try {
    amount = BigInt(item.amount);
  } catch {
    return { action: 'ignore', reason: 'bad_amount' };
  }
  if (amount <= 0n) return { action: 'ignore', reason: 'zero_amount' };
  const fromMemo = memoTarget(item.memo, prefix);
  const wallet = fromMemo || (isPubkey(item.from) ? item.from : null);
  if (!wallet) return { action: 'ignore', reason: 'no_sender' };
  return { action: 'credit', wallet, amount, by: fromMemo ? 'memo' : 'sender' };
}
