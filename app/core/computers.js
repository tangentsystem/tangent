// Sealed computers rented to the person (or their AI agent) by the second, through the
// repo's compute client (src/compute/client.js). Paid by the shared credit: each node is paid
// from its own throwaway account, and a running computer is topped up on the account that
// rented it, as `client.js rent` does.
import { createComputeClient, createAutopay } from '../../src/compute/client.js';
import { payerFor, createAutoTopUp, AUTO_TOP_UP_DEFAULT_LIMIT } from '../../src/node/credit.js';
import { solString } from './format.js';

export function computeBaseUrl(d) {
  if (!d || !d.host || !d.apiPort) return null;
  const host = d.host.includes(':') ? `[${d.host}]` : d.host;
  return `http://${host}:${d.apiPort}/api/compute`;
}

export function needsBalanceError() {
  const e = new Error('Add balance to your wallet to rent a computer.');
  e.code = 'NEEDS_BALANCE';
  return e;
}

export function createComputers({ coord, wallet, dataDir, log = () => {}, emit = () => {}, topUpLimitLamports = AUTO_TOP_UP_DEFAULT_LIMIT, fetch: f }) {
  const machines = new Map(); // machineId -> entry
  const offers = new Map(); // nodeId -> { descriptor, baseUrl }
  let auto = null;

  async function topUpper() {
    if (!auto) {
      const credit = await wallet.credit();
      // its own view of the credit, so its refusal listener never replaces the internet's
      const view = { has: (n) => credit.has(n), balanceOf: (n) => credit.balanceOf(n), topUp: (...a) => credit.topUp(...a), tokenLamports: () => credit.tokenLamports(), onShort() {} };
      auto = await createAutoTopUp({ credit: view, dir: dataDir, limitLamports: topUpLimitLamports, tokens: 1, fresh: false, log });
    }
    return auto;
  }

  // Nodes that rent computers, with their images and sizes (price per second included,
  // shown only at the confirm step).
  async function nodes() {
    const dir = await coord.directory({ role: 'compute' });
    const out = [];
    await Promise.all(dir.map(async (d) => {
      const baseUrl = computeBaseUrl(d);
      if (!baseUrl) return;
      try {
        const info = await createComputeClient({ baseUrl, fetch: f }).info();
        offers.set(d.id, { descriptor: d, baseUrl });
        const sizes = Object.entries(info.sizes || {}).map(([name, s]) => ({ name, cpus: s.cpus, memoryMb: s.memoryMb, diskMb: s.diskMb, priceLamportsPerSecond: String(s.priceLamportsPerSecond) }));
        out.push({ id: d.id, images: info.images || [], sizes, sealed: info.sealed === true, free: info.machines ? Math.max(0, info.machines.max - info.machines.running) : null });
      } catch (err) { log('warn', 'computers.info_failed', { node: d.id, reason: err.message }); }
    }));
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  function view(e) {
    return {
      id: e.machine.machineId, node: e.node, image: e.image, size: e.size, sealed: e.sealed, startedAt: e.startedAt,
      priceLamportsPerSecond: e.price, state: e.state, bill: e.bill, paid: e.paid, wallet: e.walletAddress,
    };
  }

  async function rent({ node, image, size } = {}) {
    let offer = offers.get(node);
    if (!offer) { await nodes(); offer = offers.get(node); }
    if (!offer) throw Object.assign(new Error('That node is not renting computers right now.'), { code: 'NO_NODE' });
    const credit = await wallet.credit();
    const bal = await wallet.balance().catch(() => null);
    if (!credit.has(node)) {
      if (!bal || !bal.canPay) throw needsBalanceError();
      await credit.fund([node], { tokensEach: 1 });
    }
    const a = await topUpper();
    await a.check([node], { fresh: false }).catch(() => {});
    if ((await credit.balanceOf(node)) <= 0n) throw needsBalanceError();
    const payer = payerFor(credit, node);
    const identity = payer.identityFor(node);
    const cc = createComputeClient({ baseUrl: offer.baseUrl, fetch: f });
    let machine;
    try { machine = await cc.rent({ payer: identity.id, image, size }); } catch (err) {
      const msg = err.status === 503 ? 'This node has no free computer right now.' : err.status === 400 ? 'That image or size is not offered here.' : 'The computer could not be started.';
      throw Object.assign(new Error(msg), { code: 'RENT_FAILED' });
    }
    const autopay = createAutopay({ machine, nodeId: node, payer, log: (e, d) => log('warn', e, d || {}) });
    const entry = {
      machine, autopay, node, image: machine.rent.image, size: machine.rent.size, sealed: machine.rent.sealed === true,
      price: String(machine.rent.priceLamportsPerSecond), startedAt: Date.now(), state: 'running', bill: null, paid: '0',
      walletAddress: machine.rent.wallet ? machine.rent.wallet.address : null, watch: null,
    };
    try { await autopay.payNow(); } catch (err) { log('warn', 'computers.first_payment_failed', { reason: err.message }); }
    autopay.start();
    entry.watch = setInterval(() => { a.check([node], { fresh: false }).catch(() => {}); }, 15_000);
    entry.watch.unref?.();
    machines.set(machine.machineId, entry);
    log('info', 'computers.rented', { machine: machine.machineId, node, image: entry.image, size: entry.size });
    emit('computers', list());
    return view(entry);
  }

  function get(id) {
    const e = machines.get(id);
    if (!e) throw Object.assign(new Error('That computer is not running.'), { code: 'NO_MACHINE' });
    return e;
  }

  // Runs a command; output arrives as 'output' events and the exit status is returned.
  async function exec(id, cmd, { timeoutMs = 120_000 } = {}) {
    const e = get(id);
    if (e.state !== 'running') throw Object.assign(new Error('That computer has stopped.'), { code: 'STOPPED' });
    const text = String(cmd || '');
    if (!text.trim() || text.length > 16_000) throw Object.assign(new Error('Type a command to run.'), { code: 'BAD_COMMAND' });
    // output streams as events; the answer says how many there were so the window can wait for all of them
    const run = (e.runs = (e.runs || 0) + 1);
    let n = 0;
    const out = (stream) => (b) => { n++; emit('output', { id, run, n, stream, text: b.toString('utf8') }); };
    try {
      const r = await e.machine.execStream(text, { timeoutMs, onStdout: out('stdout'), onStderr: out('stderr') });
      return { exitCode: r.exitCode, timedOut: r.timedOut === true, run, chunks: n };
    } catch (err) {
      if (err.status === 402) throw Object.assign(new Error('This computer is paused until its balance is topped up.'), { code: 'NEEDS_BALANCE' });
      if (err.status === 410 || err.status === 404) { e.state = 'stopped'; emit('computers', list()); throw Object.assign(new Error('That computer has stopped.'), { code: 'STOPPED' }); }
      throw Object.assign(new Error('The command could not run.'), { code: 'EXEC_FAILED' });
    }
  }

  async function stop(id) {
    const e = get(id);
    e.autopay.stop();
    clearInterval(e.watch);
    try { await e.autopay.payNow(); } catch { /* the bill shows what is owed */ }
    let fin;
    try { fin = await e.machine.stop(); } catch (err) { fin = err.body && err.body.usage ? err.body : null; }
    e.state = 'stopped';
    const last = e.autopay.last();
    e.paid = last ? String(last.cumulative) : '0';
    if (fin && fin.usage) {
      e.bill = {
        seconds: Math.round(Number(fin.usage.milliseconds) / 100) / 10,
        owedLamports: String(fin.usage.owedLamports),
        owed: solString(fin.usage.owedLamports),
        paidLamports: e.paid,
        walletKeptUntil: fin.wallet && fin.wallet.keyKeptUntil ? fin.wallet.keyKeptUntil : null,
      };
    }
    machines.delete(id);
    log('info', 'computers.stopped', { machine: id, owed: e.bill ? e.bill.owedLamports : null });
    emit('computers', list());
    return view(e);
  }

  function list() { return [...machines.values()].map(view); }

  return {
    nodes,
    rent,
    exec,
    stop,
    list,
    offer: (nodeId) => offers.get(nodeId) || null,
    async stopAll() { for (const id of [...machines.keys()]) await stop(id).catch(() => {}); if (auto) auto.stop(); },
  };
}
