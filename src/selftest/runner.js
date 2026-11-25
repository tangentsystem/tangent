// Self test runner: the state machine, persistence, the money gate and the log block.
//
// The paid stage 2 runs ONCE EVER for this database, not
// once per build. Once every required check has passed together, the gate is stored as open
// (selftest/gate) and stays open across restarts and new pushes: later boots never spend SOL and
// never wait for funds again. Stage 1 (free) still runs on every boot for the report; a later
// stage 1 failure is reported loudly (logs, /api/health, /api/selftest) but does not close an
// already opened gate.
//
//   boot ──> load the stored gate (open forever once opened)
//        ──> stage 1 (free checks, every boot, failures retried every stage1RetryMs)
//              │ required check failed and the gate never opened ──> stage1_failed (money closed)
//              │ required check failed and the gate is open ──> stage1_failed, gate stays open,
//              │                                                ATTENTION lines in the log
//              v
//            stage 2 passed before (any build)? ──> passed
//              │ no
//              v
//            self test wallet balance < plan ──> waiting_for_funds (nothing is sent)
//              v
//            stage 2 (funded groups) ──> passed, or stage2_failed (failed groups re-run after
//                                         stage2RetryMs while the balance still covers the plan)
//
// The gate opens the first time every required stage 1 check (this boot) and every required stage
// 2 check (stored) pass. NOT_TESTABLE checks are never required. The runner holds no keys and sends
// nothing itself; the funded groups do, through the guard in guard.js.
import { STATUS, countOf, blockers, formatBlock, summaryOf, cleanText } from './report.js';

export const STAGE2_DOC = 'stage2'; // one document for the database: stage 2 runs once ever
export const GATE_DOC = 'gate'; // { openedAt, build } once the gate has opened; never closed again

export const SELFTEST_DEFAULTS = Object.freeze({
  pollMs: 60_000,
  stage1RetryMs: 5 * 60_000,
  stage2RetryMs: 10 * 60_000,
  fundLogEveryMs: 5 * 60_000,
  checkTimeoutMs: 3 * 60_000,
  groupTimeoutMs: 15 * 60_000,
});

const isStatus = (s) => Object.values(STATUS).includes(s);

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

export function createSelfTest({
  config = {}, store, log, build, product = 'Tangent Systems',
  freeChecks = [], funded = null, timing = {}, now = Date.now,
} = {}) {
  if (!store || typeof store.collection !== 'function') throw new Error('selftest: store is required');
  if (!build) throw new Error('selftest: build is required');
  const t = { ...SELFTEST_DEFAULTS, ...timing };
  const coll = store.collection('selftest');
  const say = (line) => { try { log && log.line ? log.line(line) : null; } catch { /* never stop on logging */ } };
  const clean = (s) => cleanText(s, config);

  const stage1 = new Map(); // id -> result
  for (const c of freeChecks) stage1.set(c.id, { status: STATUS.PENDING });
  let stage1Ran = false;
  let stage1At = 0;
  let state = 'idle';
  let stage2 = null; // persisted doc { _id, steps: { id: result }, passedAt }
  let funding = null;
  let wallet = null;
  let stage2FailedAt = 0;
  let lastFundLogAt = 0;
  let lastFundBalance = null;
  let latest = null;
  let timer = null;
  let stopped = false;
  let running = null;
  let lastBlockKey = '';

  let gate = null; // stored { openedAt, build } once opened
  let gateLoaded = false;
  const fundedSteps = () => (funded ? funded.groups.flatMap((g) => g.steps.map((s) => ({ ...s, group: g.id }))) : []);

  function normalise(r, fallbackReason) {
    if (!r || !isStatus(r.status)) return { status: STATUS.FAIL, reason: clean(fallbackReason || 'check returned no status') };
    const out = { status: r.status };
    if (r.detail) out.detail = clean(r.detail);
    if (r.reason) out.reason = clean(r.reason);
    if (r.status === STATUS.FAIL && !out.reason) out.reason = 'failed';
    if (r.data && typeof r.data === 'object') out.data = JSON.parse(JSON.stringify(r.data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    out.at = new Date(now()).toISOString();
    return out;
  }

  async function runStage1() {
    for (const c of freeChecks) {
      let r;
      try { r = await withTimeout(Promise.resolve().then(() => c.run()), c.timeoutMs || t.checkTimeoutMs, c.id); } catch (err) { r = { status: STATUS.FAIL, reason: (err && err.message) || String(err) }; }
      stage1.set(c.id, normalise(r));
    }
    stage1Ran = true;
    stage1At = now();
  }

  const stage1Ok = () => stage1Ran && freeChecks.every((c) => !c.required || stage1.get(c.id).status === STATUS.PASS);
  const stage2Ok = () => Boolean(funded) && Boolean(stage2) && fundedSteps().every((s) => !s.required || (stage2.steps[s.id] && stage2.steps[s.id].status === STATUS.PASS));

  async function loadGate() {
    if (gateLoaded) return gate;
    const doc = await coll.get(GATE_DOC);
    gate = doc && doc.openedAt ? { openedAt: doc.openedAt, build: doc.build || null } : null;
    gateLoaded = true;
    return gate;
  }
  // Insert only: the first opening is kept as it was; a second insert is a no op.
  async function openGate() {
    if (gate) return gate;
    const doc = { _id: GATE_DOC, openedAt: new Date(now()).toISOString(), build };
    await coll.insert(doc);
    const saved = await coll.get(GATE_DOC);
    gate = saved && saved.openedAt ? { openedAt: saved.openedAt, build: saved.build || null } : { openedAt: doc.openedAt, build };
    return gate;
  }

  async function loadStage2() {
    if (stage2) return stage2;
    // stored as a list: check ids contain dots, which MongoDB field names may not
    const doc = await coll.get(STAGE2_DOC);
    const steps = {};
    for (const s of (doc && Array.isArray(doc.steps) ? doc.steps : [])) if (s && typeof s.id === 'string') { const { id, ...r } = s; steps[id] = r; }
    stage2 = { build: doc ? doc.build || build : build, steps, passedAt: doc ? doc.passedAt || null : null };
    return stage2;
  }
  async function saveStage2() {
    const steps = Object.entries(stage2.steps).map(([id, r]) => ({ id, ...r }));
    await coll.put(STAGE2_DOC, { build: stage2.build, steps, passedAt: stage2.passedAt || null, updatedAt: new Date(now()).toISOString() });
  }

  async function refreshFunding() {
    if (!funded) return null;
    const [plan, balance] = await Promise.all([funded.plan(), funded.balance()]);
    const need = BigInt(plan.needLamports);
    const bal = BigInt(balance);
    const send = need > bal ? need - bal : 0n;
    wallet = { address: funded.wallet.address, link: funded.wallet.link, balanceLamports: bal.toString() };
    funding = {
      address: funded.wallet.address, link: funded.wallet.link,
      balanceLamports: bal.toString(), needLamports: need.toString(), sendLamports: send.toString(),
      breakdown: plan.breakdown.map((b) => ({ what: b.what, lamports: BigInt(b.lamports).toString(), ...(b.source ? { source: b.source } : {}) })),
    };
    return { need, bal, send };
  }

  async function runStage2() {
    stage2.build = build; // the build that ran (or finished) stage 2
    for (const g of funded.groups) {
      const done = g.steps.every((s) => stage2.steps[s.id] && stage2.steps[s.id].status === STATUS.PASS);
      if (done) continue;
      const prev = Object.fromEntries(g.steps.map((s) => [s.id, stage2.steps[s.id] || null]));
      let results = {};
      try {
        // build is passed for idempotency keys; stage 2 runs once ever, so it is the build that ran it
        results = (await withTimeout(Promise.resolve().then(() => g.run({ previous: prev, build })), g.timeoutMs || t.groupTimeoutMs, g.id)) || {};
      } catch (err) {
        const reason = (err && err.message) || String(err);
        // steps the group did not report on fail with the group's error
        for (const s of g.steps) if (!results[s.id]) results[s.id] = { status: STATUS.FAIL, reason };
      }
      for (const s of g.steps) {
        stage2.steps[s.id] = normalise(results[s.id], 'the group did not report this step');
      }
      await saveStage2();
    }
    if (stage2Ok()) stage2.passedAt = new Date(now()).toISOString();
    await saveStage2();
  }

  function buildReport() {
    const checks = [];
    for (const c of freeChecks) checks.push({ id: c.id, title: c.title, stage: 1, required: Boolean(c.required), ...stage1.get(c.id) });
    for (const s of fundedSteps()) {
      let r = stage2 && stage2.steps[s.id] ? stage2.steps[s.id] : null;
      if (!r || r.status === STATUS.PENDING || r.status === STATUS.WAITING_FOR_FUNDS) {
        if (state === 'waiting_for_funds') r = { status: STATUS.WAITING_FOR_FUNDS, reason: `needs SOL in the self test wallet ${funded.wallet.address}` };
        else if (!r) r = { status: STATUS.PENDING, detail: stage1Ok() ? 'runs once the self test wallet is funded' : 'runs after the required free checks pass' };
      }
      checks.push({ id: s.id, title: s.title, stage: 2, required: Boolean(s.required), ...r });
    }
    const clear = Boolean(gate);
    const failing = stage1Ran ? freeChecks.filter((c) => c.required && stage1.get(c.id).status !== STATUS.PASS).map((c) => ({ id: c.id, status: stage1.get(c.id).status, reason: stage1.get(c.id).reason || null })) : [];
    const phase = {
      idle: 'starting', stage1: 'stage 1 (free checks)', stage1_failed: 'stage 1 failed, retrying',
      waiting_for_funds: 'waiting for funds', stage2: 'stage 2 (funded checks)', stage2_failed: 'stage 2 failed, retrying',
      passed: 'passed', no_funded_stage: 'stage 1 only',
    }[state] || state;
    return {
      v: 2, product, build, state, phase, clear,
      // the gate stays open once opened; these required free checks fail on this boot
      attention: clear && failing.length ? failing : [],
      gateOpenedAt: gate ? gate.openedAt : null,
      gateOpenedBuild: gate ? gate.build : null,
      stage2Build: stage2 && stage2.passedAt ? stage2.build : null,
      finishedAt: new Date(now()).toISOString(),
      stage1At: stage1At ? new Date(stage1At).toISOString() : null,
      stage2PassedAt: stage2 && stage2.passedAt ? stage2.passedAt : null,
      checks, counts: countOf(checks), blockers: blockers(checks),
      wallet, funding: state === 'waiting_for_funds' ? funding : null,
      gate: {
        open: clear,
        stays: 'open for good once opened: later boots and new pushes do not spend SOL and do not close it',
        gates: 'deposits, deposit addresses, credit token issue and redeem, withdrawals, voucher redemption and off grid claims',
        requiredChecks: checks.filter((c) => c.required).map((c) => c.id),
      },
    };
  }

  async function publish({ force = false } = {}) {
    latest = buildReport();
    try { await coll.put('latest', { report: JSON.parse(JSON.stringify(latest)) }); } catch (err) { log && log.warn && log.warn('selftest.save_failed', { reason: clean(err && err.message) }); }
    const key = JSON.stringify({ s: latest.state, c: latest.checks.map((c) => [c.id, c.status]) });
    if (force || key !== lastBlockKey) {
      lastBlockKey = key;
      for (const line of formatBlock(latest)) say(line);
    }
    return latest;
  }

  // One pass of the state machine. Safe to call again and again; calls never overlap.
  async function tick() {
    if (running) return running;
    running = (async () => {
      await loadGate();
      if (!stage1Ran || (!stage1Ok() && now() - stage1At >= t.stage1RetryMs)) {
        state = 'stage1';
        await runStage1();
      }
      if (!stage1Ok()) {
        state = 'stage1_failed';
        if (gate) {
          // loud, but the gate stays open
          const failing = freeChecks.filter((c) => c.required && stage1.get(c.id).status !== STATUS.PASS).map((c) => c.id);
          log && log.error && log.error('selftest.required_check_failing', { checks: failing, gate: 'stays open', note: 'a required free check fails on this boot; money actions stay open because the self test passed before' });
        }
        return publish();
      }
      if (!funded) { state = 'no_funded_stage'; return publish(); }
      await loadStage2();
      if (stage2Ok()) {
        if (!gate) await openGate();
        state = 'passed';
        try { await refreshFunding(); } catch { /* the balance is only shown */ }
        return publish();
      }
      if (gate) {
        // opened before with every check passing; a later change to the funded steps (for example a
        // new required step in a new version) is not run again and never spends: stage 2 is once ever
        state = 'passed';
        return publish();
      }
      if (state === 'stage2_failed' && now() - stage2FailedAt < t.stage2RetryMs) return latest || publish();
      let f;
      try { f = await refreshFunding(); } catch (err) {
        state = 'waiting_for_funds';
        funding = funding || null;
        log && log.warn && log.warn('selftest.balance_failed', { reason: clean(err && err.message) });
        return publish();
      }
      if (f.bal < f.need) {
        state = 'waiting_for_funds';
        const changed = lastFundBalance === null || lastFundBalance !== f.bal;
        const due = now() - lastFundLogAt >= t.fundLogEveryMs;
        const r = await publish({ force: changed || due });
        if (changed || due) { lastFundLogAt = now(); lastFundBalance = f.bal; }
        return r;
      }
      state = 'stage2';
      await publish();
      await runStage2();
      if (stage2Ok()) { state = 'passed'; await openGate(); } else { state = 'stage2_failed'; stage2FailedAt = now(); }
      try { await refreshFunding(); } catch { /* shown only */ }
      return publish({ force: true });
    })().finally(() => { running = null; });
    return running;
  }

  function nextDelay() {
    if (state === 'passed' || state === 'no_funded_stage') return null;
    if (state === 'stage1_failed') return t.stage1RetryMs;
    if (state === 'stage2_failed') return t.stage2RetryMs;
    return t.pollMs;
  }

  function schedule() {
    if (stopped) return;
    const d = nextDelay();
    if (d === null) return;
    timer = setTimeout(async () => {
      try { await tick(); } catch (err) { log && log.warn && log.warn('selftest.tick_failed', { reason: clean(err && err.message) }); }
      schedule();
    }, d);
    timer.unref?.();
  }

  return {
    build,
    get state() { return state; },
    async start() {
      stopped = false;
      // the stored gate first, so a restart answers with money open before stage 1 finishes
      try { await loadGate(); } catch (err) { log && log.warn && log.warn('selftest.gate_load_failed', { reason: clean(err && err.message) }); }
      try { await tick(); } catch (err) { log && log.warn && log.warn('selftest.tick_failed', { reason: clean(err && err.message) }); }
      schedule();
      return latest;
    },
    async stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; if (running) await running.catch(() => {}); },
    tick,
    clear: () => Boolean(gate),
    report: () => latest,
    summary: () => summaryOf(latest),
  };
}
