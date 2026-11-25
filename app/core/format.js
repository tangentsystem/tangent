// Amounts are lamports as strings everywhere in the core; these helpers are shared with tests.
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function solString(lamports, { maxDecimals = 6 } = {}) {
  let v;
  try { v = BigInt(lamports); } catch { return null; }
  const neg = v < 0n; if (neg) v = -v;
  const whole = v / LAMPORTS_PER_SOL;
  let frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, maxDecimals).replace(/0+$/, '');
  if (!frac && whole === 0n && v > 0n) frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

// "0.25" -> 250000000n. Throws on anything that is not a plain positive amount.
export function parseSol(text) {
  const s = String(text ?? '').trim();
  if (!/^[0-9]{1,9}(\.[0-9]{1,9})?$/.test(s)) throw new Error('enter an amount like 0.1');
  const [w, f = ''] = s.split('.');
  const v = BigInt(w) * LAMPORTS_PER_SOL + BigInt((f + '000000000').slice(0, 9));
  if (v <= 0n) throw new Error('enter an amount above 0');
  return v;
}
