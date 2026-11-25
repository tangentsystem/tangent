// Self test report: statuses, the log block people read, and redaction.
//
// Every check ends in exactly one status:
//   PASS               it ran against the real thing and did what it should
//   FAIL               it ran and did not (the reason is given)
//   NOT_TESTABLE       this container cannot test it (said plainly, never counted as passed)
//   WAITING_FOR_FUNDS  it needs SOL in the self test wallet first
//   SKIPPED            nothing to test yet (for example TOKEN_CA is not set)
//   PENDING            not run yet
import { redact } from '../coord/log.js';

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_TESTABLE: 'NOT_TESTABLE',
  WAITING_FOR_FUNDS: 'WAITING_FOR_FUNDS',
  SKIPPED: 'SKIPPED',
  PENDING: 'PENDING',
});

const LABEL = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_TESTABLE: 'NOT TESTABLE HERE',
  WAITING_FOR_FUNDS: 'WAITING FOR FUNDS',
  SKIPPED: 'SKIPPED',
  PENDING: 'PENDING',
});

const LAMPORTS_PER_SOL = 1_000_000_000n;

// Lamports as SOL text, rounded up to 0.0001 SOL when asked (amounts people must send).
export function sol(lamports, { roundUp = false } = {}) {
  let v = typeof lamports === 'bigint' ? lamports : BigInt(lamports || 0);
  if (v < 0n) v = 0n;
  const unit = LAMPORTS_PER_SOL / 10_000n;
  let units = v / unit;
  if (roundUp && v % unit !== 0n) units += 1n;
  const whole = units / 10_000n;
  const frac = (units % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// Strip anything secret out of free text (RPC urls with keys, Mongo URIs, long base58 blobs
// that could be a secret key), then cut it short.
export function cleanText(text, config = {}, max = 300) {
  let s = redact(String(text ?? ''), config);
  s = s.replace(/https?:\/\/[^\s"']*helius[^\s"']*/gi, '[rpc]');
  s = s.replace(/\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, '[hidden]'); // 64 byte keys in base58 are ~88 chars
  s = s.replace(/\[(?:\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g, '[hidden]'); // byte arrays
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export function emptyCounts() {
  return { PASS: 0, FAIL: 0, NOT_TESTABLE: 0, WAITING_FOR_FUNDS: 0, SKIPPED: 0, PENDING: 0 };
}

export function countOf(checks) {
  const c = emptyCounts();
  for (const x of checks) c[x.status] = (c[x.status] || 0) + 1;
  return c;
}

// Required checks that are not PASS, with why.
export function blockers(checks) {
  return checks.filter((c) => c.required && c.status !== STATUS.PASS).map((c) => ({ id: c.id, status: c.status, reason: c.reason || null }));
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// The block printed in the logs. Plain lines, one per check.
export function formatBlock(report) {
  const out = [];
  out.push(`SELF TEST  ${report.product} ${report.build}  ${report.phase}`);
  for (const c of report.checks) {
    const tail = c.status === STATUS.PASS || c.status === STATUS.PENDING ? (c.detail || '') : (c.reason || c.detail || '');
    out.push(`  ${pad(LABEL[c.status] || c.status, 18)} ${pad(c.id, 26)} ${c.required ? 'required ' : 'optional '} ${tail}`.trimEnd());
  }
  const k = report.counts;
  out.push(`SELF TEST RESULT  ${k.PASS} pass, ${k.FAIL} fail, ${k.NOT_TESTABLE} not testable here, ${k.WAITING_FOR_FUNDS} waiting for funds, ${k.SKIPPED} skipped, ${k.PENDING} pending`);
  if (report.funding && report.funding.sendLamports && BigInt(report.funding.sendLamports) > 0n) {
    const f = report.funding;
    out.push(`FUND THE SELF TEST WALLET  ${f.address}  send ${sol(BigInt(f.sendLamports), { roundUp: true })} SOL  ${f.link}`);
    out.push(`  it holds ${sol(BigInt(f.balanceLamports))} SOL and needs ${sol(BigInt(f.needLamports), { roundUp: true })} SOL:`);
    for (const b of f.breakdown) out.push(`    ${pad(sol(BigInt(b.lamports), { roundUp: true }) + ' SOL', 14)} ${b.what}${b.source ? ` (${b.source})` : ''}`);
    out.push('  the self test only moves SOL between wallets this service created. Leftover SOL stays in the self test wallet.');
  }
  if (report.clear) {
    const when = report.gateOpenedBuild && report.gateOpenedBuild !== report.build ? ` (passed once with build ${report.gateOpenedBuild}; the paid stage never runs again)` : '';
    out.push(`CLEAR TO GO LIVE  every required check passed${when}. Money actions are open. You can set TOKEN_CA now.`);
    for (const a of report.attention || []) {
      out.push(`ATTENTION  required check ${a.id} is ${LABEL[a.status] || a.status} on this boot${a.reason ? `: ${a.reason}` : ''}. Money actions stay open because the self test passed before; fix this.`);
    }
  } else {
    const b = report.blockers.map((x) => `${x.id} (${LABEL[x.status] || x.status})`).join(', ');
    out.push(`NOT CLEAR YET  money actions stay closed until these pass: ${b || 'the self test has not finished'}`);
  }
  return out;
}

// What /api/health shows: short, no reasons.
export function summaryOf(report) {
  if (!report) return { state: 'off' };
  return {
    state: report.state,
    build: report.build,
    clear: Boolean(report.clear),
    counts: report.counts,
    finishedAt: report.finishedAt || null,
    ...(report.gateOpenedAt ? { gateOpenedAt: report.gateOpenedAt } : {}),
    ...(report.attention && report.attention.length ? { attention: report.attention.map((a) => ({ id: a.id, status: a.status })) } : {}),
    ...(report.funding && report.funding.sendLamports && BigInt(report.funding.sendLamports) > 0n ? { waitingForFunds: { address: report.funding.address, sendSol: sol(BigInt(report.funding.sendLamports), { roundUp: true }) } } : {}),
  };
}
