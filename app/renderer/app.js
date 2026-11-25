// The window. Talks to the app only through window.tangent (app/main/preload.cjs).
(function () {
  'use strict';
  const T = window.tangent;
  const $ = (id) => document.getElementById(id);
  const short = (id) => (id && id.length > 12 ? id.slice(0, 4) + '…' + id.slice(-4) : id || '');
  const ROLE_TEXT = { relay: 'private internet', exit: 'reaches the open web', compute: 'sealed computers', gateway: 'off grid payments' };

  const st = {
    view: 'internet', status: null, wallet: null, balance: null, token: null, apps: [], pairing: [], nodes: [],
    computeNodes: null, pick: { node: null, image: null, size: null }, machine: null, mcp: null, deposit: null,
    withdrawals: [], kind: 'rings', busy: false, coordinator: '', got: {},
  };

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const show = (node, on) => { node.hidden = !on; };
  let toastTimer = null;
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
  }
  async function call(name, args) { return T.call(name, args); }
  async function copy(text) { await call('copy', { text }); toast('Copied'); }
  function link(a, url) { a.href = '#'; a.onclick = (e) => { e.preventDefault(); call('openLink', { url }); }; }

  function fmtBytes(n) {
    if (!n) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  function fmtSince(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  function sol(lamports, digits = 6) {
    let v; try { v = BigInt(lamports); } catch { return null; }
    const w = v / 1000000000n; let f = (v % 1000000000n).toString().padStart(9, '0');
    let cut = f.slice(0, digits).replace(/0+$/, '');
    if (!cut && v > 0n && w === 0n) cut = f.replace(/0+$/, '');
    return w.toString() + (cut ? '.' + cut : '');
  }

  // ---------- views ----------
  function go(view) {
    if (!['internet', 'computers', 'wallet', 'network'].includes(view)) return;
    st.view = view;
    document.body.dataset.view = view;
    for (const b of document.querySelectorAll('.views button')) b.classList.toggle('cur', b.dataset.go === view);
    for (const s of document.querySelectorAll('.view')) s.classList.toggle('on', s.id === 'v-' + view);
    Scene.setView(view);
    if (view === 'wallet') refreshWallet();
    if (view === 'computers') loadComputers();
    if (view === 'network') loadNodes();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) { e.preventDefault(); go(b.dataset.go); if (b.dataset.go === 'wallet' && b.closest('.note')) openDeposit(); }
  });

  // ---------- internet ----------
  function renderStatus() {
    const s = st.status;
    if (!s) return;
    const on = s.connected, ing = s.connecting;
    $('in-title').textContent = on ? 'You are private' : 'Private internet';
    $('in-lede').textContent = on
      ? 'Three nodes stand between you and every site you open.'
      : 'Every page you open crosses three nodes. None of them sees both who you are and where you go.';
    const btn = $('in-toggle');
    btn.textContent = on ? 'Turn off' : ing ? 'Building your path' : 'Turn on';
    btn.disabled = ing;
    btn.classList.toggle('light', on);
    show($('in-window'), on);
    show($('in-balance'), on && s.needsBalance);
    show($('in-limit'), on && !s.needsBalance && s.limitReached);
    const err = $('in-error');
    err.textContent = !on && !ing && s.error ? s.error : '';
    show(err, !on && !ing && !!s.error);
    show($('in-facts'), on);
    show($('in-tech'), on);
    if (on && s.socks) $('in-tech').textContent = `Local proxy ${s.socks.host}:${s.socks.port}`;
    const path = $('in-path');
    path.replaceChildren();
    if (on && s.hops.length) {
      const names = ['First hop', 'Second hop', 'Last hop'];
      s.hops.forEach((h, i) => {
        if (i) path.append(el('li', { class: 'sep' }));
        path.append(el('li', {}, el('small', { text: names[i] || 'Hop' }), el('code', { text: short(h.id) })));
      });
    }
    show(path, on && s.hops.length > 0);
    tick();
    Scene.setPath(on ? s.hops.map((h) => h.id) : null);
  }
  function tick() {
    const s = st.status;
    if (!s || !s.connected) return;
    $('in-time').textContent = fmtSince(Date.now() - s.since);
    const used = (s.usage.bytesUp || 0) + (s.usage.bytesDown || 0);
    $('in-data').textContent = fmtBytes(used);
    show($('in-f-data'), used > 0);
  }
  $('in-toggle').onclick = async () => {
    const s = st.status;
    if (s && s.connected) st.status = await call('disconnect');
    else st.status = await call('connect');
    renderStatus();
  };
  $('in-window').onclick = async () => {
    const note = $('in-browser');
    try { const r = await call('openPrivateWindow'); note.textContent = `${r.browser} opened with the private internet.`; } catch (e) { note.textContent = e.message; }
    show(note, true);
    setTimeout(() => show(note, false), 6000);
  };
  setInterval(async () => {
    if (!st.status || !(st.status.connected || st.status.connecting)) return;
    try { st.status = await call('status'); renderStatus(); } catch { /* next tick */ }
  }, 1000);

  // ---------- connected apps and pairing ----------
  function renderApps() {
    show($('in-apps'), st.apps.length > 0);
    const list = $('apps-list');
    list.replaceChildren(...st.apps.map((a) => el('li', {},
      el('span', { text: a.client }),
      el('span', { class: 'r' }, el('button', { class: 'mini', text: 'Remove', onclick: async () => { await call('appsRemove', { id: a.id }); } })))));
    if (!st.apps.length) $('apps').hidden = true;
  }
  $('in-apps').onclick = () => { $('apps').hidden = false; };
  $('apps-close').onclick = () => { $('apps').hidden = true; };
  function renderPairing() {
    const p = st.pairing[0];
    $('pair').hidden = !p;
    if (p) $('pair-title').textContent = `Allow ${p.client} to control the private internet?`;
  }
  $('pair-allow').onclick = async () => { const p = st.pairing[0]; if (p) await call('pairAllow', { id: p.id }); };
  $('pair-deny').onclick = async () => { const p = st.pairing[0]; if (p) await call('pairDeny', { id: p.id }); };

  // ---------- token ----------
  function renderToken() {
    const t = st.token;
    show($('tok'), !!t);
    document.body.classList.toggle('has-tok', !!t);
    if (!t) return;
    $('tok-sym').textContent = '$' + t.symbol;
    const ca = $('tok-ca'); ca.textContent = short(t.ca); ca.title = t.ca; link(ca, t.explorer);
    $('tok-copy').onclick = () => copy(t.ca);
    const buy = $('tok-buy');
    show(buy, !!t.buyUrl);
    if (t.buyUrl) { buy.textContent = 'Buy $' + t.symbol; link(buy, t.buyUrl); }
  }

  // ---------- network ----------
  function rolesText(roles) {
    const parts = roles.map((r) => ROLE_TEXT[r]).filter(Boolean);
    if (!parts.length) return '';
    const s = parts.join(', ');
    return s[0].toUpperCase() + s.slice(1);
  }
  async function loadNodes() {
    try { st.nodes = await call('networkNodes'); } catch { return; }
    Scene.setNodes(st.nodes.map((n) => ({ id: n.id, roles: n.roles, roleText: n.region || null })));
    const n = st.nodes.length;
    $('nw-count').textContent = n === 1 ? 'One node online.' : n ? `${n} nodes online.` : '';
    show($('nw-count'), n > 0);
    $('nw-list').replaceChildren(...st.nodes.map((d) => {
      const a = el('a', { text: short(d.id), title: d.id }); link(a, d.link);
      return el('li', {}, a, el('span', { class: 'rg', text: d.region || '' }), el('span', { class: 'does', text: rolesText(d.roles) }));
    }));
    if (st.status) renderStatus();
  }

  // ---------- computers ----------
  async function loadComputers() {
    if (st.computeNodes === null || st.view === 'computers') {
      try { st.computeNodes = await call('computerNodes'); } catch { st.computeNodes = st.computeNodes || []; }
    }
    renderComputers();
  }
  function choiceRow(container, items, cur, onPick) {
    container.replaceChildren(...items.map((it) => {
      const b = el('button', { type: 'button', class: it.value === cur ? 'on' : '' }, it.label, it.sub ? el('small', { text: it.sub }) : null);
      b.onclick = () => onPick(it.value);
      return b;
    }));
  }
  function sizeSub(s) {
    const mem = s.memoryMb >= 1024 ? `${(s.memoryMb / 1024).toFixed(s.memoryMb % 1024 ? 1 : 0)} GB` : `${s.memoryMb} MB`;
    return `${s.cpus} CPU, ${mem}`;
  }
  function renderComputers() {
    const nodes = st.computeNodes || [];
    const m = st.machine;
    const running = m && m.state === 'running';
    show($('pc-run'), !!running);
    show($('pc-bill'), !!(m && m.state === 'stopped'));
    const picking = !m && !st.confirming;
    show($('pc-pick'), picking);
    show($('pc-confirm'), !m && !!st.confirming);
    show($('pc-none'), picking && st.computeNodes !== null && !nodes.length);
    show($('pc-form'), picking && nodes.length > 0);
    if (picking && nodes.length) {
      if (!st.pick.node || !nodes.some((n) => n.id === st.pick.node)) st.pick.node = nodes[0].id;
      const node = nodes.find((n) => n.id === st.pick.node);
      if (!node.images.includes(st.pick.image)) st.pick.image = node.images[0] || null;
      if (!node.sizes.some((s) => s.name === st.pick.size)) st.pick.size = (node.sizes.find((s) => s.name === 'small') || node.sizes[0] || {}).name || null;
      choiceRow($('pc-images'), node.images.map((i) => ({ value: i, label: i })), st.pick.image, (v) => { st.pick.image = v; renderComputers(); });
      choiceRow($('pc-sizes'), node.sizes.map((s) => ({ value: s.name, label: s.name[0].toUpperCase() + s.name.slice(1), sub: sizeSub(s) })), st.pick.size, (v) => { st.pick.size = v; renderComputers(); });
      show($('pc-node-field'), nodes.length > 1);
      if (nodes.length > 1) choiceRow($('pc-nodes'), nodes.map((n) => ({ value: n.id, label: short(n.id) })), st.pick.node, (v) => { st.pick.node = v; renderComputers(); });
      $('pc-next').disabled = !st.pick.image || !st.pick.size;
    }
    if (!m && st.confirming) {
      const node = nodes.find((n) => n.id === st.pick.node);
      const size = node && node.sizes.find((s) => s.name === st.pick.size);
      $('pc-summary').textContent = `${st.pick.image}, ${st.pick.size}${size ? ` (${sizeSub(size)})` : ''}, on node ${short(st.pick.node)}.`;
      if (size) {
        $('pc-price').textContent = `${sol(size.priceLamportsPerSecond, 9)} SOL a second`;
        $('pc-hour').textContent = `${sol(BigInt(size.priceLamportsPerSecond) * 3600n, 4)} SOL`;
      }
      const canPay = st.balance ? (st.balance.canPay || BigInt(st.balance.creditLamports || '0') > 0n) : true;
      show($('pc-need'), !canPay);
      $('pc-rent').disabled = st.busy || !canPay;
      $('pc-rent').textContent = st.busy ? 'Starting your computer' : 'Rent';
    }
    if (m) {
      $('pc-running').textContent = `${m.image}, ${m.size}, on node ${short(m.node)}`;
      if (m.state === 'stopped') {
        const b = m.bill;
        show($('pc-b-time'), !!(b && b.seconds));
        show($('pc-b-owed'), !!(b && b.owedLamports && b.owedLamports !== '0'));
        if (b) { $('pc-btime').textContent = b.seconds < 120 ? `${b.seconds} s` : fmtSince(b.seconds * 1000); $('pc-bowed').textContent = `${b.owed} SOL`; }
      }
    }
  }
  $('pc-next').onclick = async () => { st.confirming = true; st.balance = await call('walletBalance').catch(() => st.balance); renderComputers(); };
  $('pc-back').onclick = () => { st.confirming = false; show($('pc-err'), false); renderComputers(); };
  $('pc-rent').onclick = async () => {
    st.busy = true; show($('pc-err'), false); renderComputers();
    try {
      st.machine = await call('rent', { node: st.pick.node, image: st.pick.image, size: st.pick.size });
      st.confirming = false;
      $('pc-out').replaceChildren();
      setTimeout(() => $('pc-cmd').focus(), 50);
    } catch (e) {
      if (e.code === 'NEEDS_BALANCE') { st.balance = { canPay: false, creditLamports: '0' }; } else { $('pc-err').textContent = e.message; show($('pc-err'), true); }
    }
    st.busy = false;
    renderComputers();
  };
  function termLine(text, cls) {
    const out = $('pc-out');
    const last = out.lastElementChild;
    if (!cls && last && last.dataset.stream === 'stdout') last.textContent += text;
    else if (cls === 'err' && last && last.dataset.stream === 'stderr') last.textContent += text;
    else { const d = el('div', { class: cls || '', text }); d.dataset.stream = cls === 'err' ? 'stderr' : cls ? cls : 'stdout'; out.append(d); }
    out.scrollTop = out.scrollHeight;
  }
  $('pc-form-cmd').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('pc-cmd');
    const cmd = input.value;
    if (!cmd.trim() || !st.machine) return;
    input.value = '';
    termLine(cmd, 'cmd');
    try {
      const r = await call('exec', { id: st.machine.id, cmd });
      // the answer can overtake the last output events: wait for all of them first
      const end = Date.now() + 1500;
      while ((st.got[st.machine.id + ":" + r.run] || 0) < r.chunks && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
      if (r.exitCode !== 0) termLine(`exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}`, 'exit');
    } catch (err) { termLine(err.message, 'err'); }
  };
  $('pc-stop').onclick = async () => {
    $('pc-stop').disabled = true;
    try { st.machine = await call('stopComputer', { id: st.machine.id }); } catch (e) { termLine(e.message, 'err'); }
    $('pc-stop').disabled = false;
    renderComputers();
  };
  $('pc-again').onclick = () => { st.machine = null; renderComputers(); };

  // agent
  function renderMcp() {
    show($('ag-off'), !st.mcp);
    show($('ag-on'), !!st.mcp);
    if (st.mcp) $('ag-snippet').textContent = st.mcp.snippet;
  }
  $('ag-start').onclick = async () => {
    show($('ag-err'), false);
    try { st.mcp = await call('mcpStart'); } catch (e) { $('ag-err').textContent = e.message; show($('ag-err'), true); }
    renderMcp();
  };
  $('ag-stop').onclick = async () => { await call('mcpStop'); st.mcp = null; renderMcp(); };
  $('ag-copy').onclick = () => st.mcp && copy(st.mcp.snippet);

  // ---------- wallet ----------
  async function refreshWallet() {
    try { st.balance = await call('walletBalance'); } catch { /* keep the last one */ }
    renderWallet();
  }
  function renderWallet() {
    const w = st.wallet;
    if (w) {
      const a = $('wa-addr'); a.textContent = short(w.address); a.title = w.address; link(a, w.explorer);
    }
    const b = st.balance;
    const has = b && b.walletLamports && b.walletLamports !== '0';
    show($('wa-bal'), !!has);
    if (has) $('wa-sol').textContent = sol(b.walletLamports, 4);
    const credit = b && b.creditLamports && b.creditLamports !== '0';
    show($('wa-credit'), !!credit);
    if (credit) $('wa-credit').textContent = `${sol(b.creditLamports, 6)} SOL of credit on nodes`;
    show($('wa-out'), !!has);
    show($('wa-empty'), !!b && !has && !credit);
    const hist = $('wa-history');
    hist.replaceChildren(...st.withdrawals.slice(0, 4).map((x) => {
      const word = x.status === 'sent' ? 'Sent' : x.status === 'refunded' ? 'Back in your balance' : 'On its way';
      const r = el('span', { class: 'r' }, el('span', { text: word }));
      if (x.explorer) { const a = el('a', { text: 'View' }); link(a, x.explorer); r.append(a); }
      return el('li', {}, el('span', { text: `${x.amount} SOL to ${short(x.to)}` }), r);
    }));
    show(hist, st.withdrawals.length > 0);
  }
  $('wa-copy').onclick = () => st.wallet && copy(st.wallet.address);
  async function openDeposit() {
    show($('wa-wd'), false);
    try { st.deposit = await call('deposit'); } catch { st.deposit = { available: false }; }
    const d = st.deposit;
    show($('wa-dep'), !!(d && d.available));
    show($('wa-dep-closed'), !(d && d.available));
    if (d && d.available) {
      $('wa-vault').textContent = d.address || '';
      $('wa-memo').textContent = d.memo || '';
      show($('wa-memo-row'), !!d.memo);
    }
  }
  $('wa-add').onclick = openDeposit;
  $('wa-out').onclick = () => { show($('wa-dep'), false); show($('wa-dep-closed'), false); show($('wa-wd'), true); $('wd-to').focus(); };
  for (const b of document.querySelectorAll('[data-copy]')) b.onclick = () => copy($(b.dataset.copy).textContent);
  for (const b of document.querySelectorAll('#wd-kind button')) b.onclick = () => {
    st.kind = b.dataset.kind;
    for (const x of document.querySelectorAll('#wd-kind button')) x.classList.toggle('on', x === b);
  };
  $('wa-wd').onsubmit = async (e) => {
    e.preventDefault();
    show($('wd-err'), false);
    $('wd-go').disabled = true;
    try {
      await call('withdraw', { to: $('wd-to').value, amount: $('wd-amt').value, public: st.kind === 'public' });
      $('wd-to').value = ''; $('wd-amt').value = '';
      show($('wa-wd'), false);
      st.withdrawals = await call('withdrawals');
      refreshWallet();
    } catch (err) {
      const m = String(err.message || '');
      $('wd-err').textContent = /solana address/i.test(m) ? 'Enter a Solana address.' : /amount/i.test(m) && !/balance/i.test(m) ? 'Enter an amount like 0.1.' : m;
      show($('wd-err'), true);
    }
    $('wd-go').disabled = false;
  };

  // ---------- events from the app ----------
  T.on((name, p) => {
    if (name === 'status') { st.status = p; renderStatus(); }
    else if (name === 'wallet') { st.balance = p; renderWallet(); if (st.view === 'computers') renderComputers(); }
    else if (name === 'withdrawal') { call('withdrawals').then((w) => { st.withdrawals = w; renderWallet(); }); }
    else if (name === 'pairing') { st.pairing = p || []; renderPairing(); }
    else if (name === 'apps') { st.apps = p || []; renderApps(); }
    else if (name === 'open') { go(p && p.view); }
    else if (name === 'output') { if (st.machine && p.id === st.machine.id) { st.got[p.id + ":" + p.run] = (st.got[p.id + ":" + p.run] || 0) + 1; termLine(p.text, p.stream === 'stderr' ? 'err' : null); } }
    else if (name === 'mcp') { st.mcp = p; renderMcp(); }
    else if (name === 'computers') { /* the view keeps its own machine */ }
  });

  document.querySelectorAll('.views button').forEach((b) => { b.onclick = () => go(b.dataset.go); });

  // ---------- start ----------
  (async () => {
    if (T.platform === 'darwin') document.body.classList.add('mac'); else document.body.classList.add('overlay');
    const s = await call('snapshot');
    st.status = s.status; st.wallet = s.wallet; st.token = s.token; st.apps = s.apps; st.pairing = s.pairing; st.mcp = s.mcp;
    st.withdrawals = s.withdrawals || []; st.coordinator = s.coordinator;
    if (s.machines && s.machines.length) st.machine = s.machines[0];
    $('ver').textContent = `Tangent ${s.version}`;
    renderToken(); renderApps(); renderPairing(); renderMcp(); renderStatus(); renderWallet();
    go('internet');
    await loadNodes();
    call('walletBalance').then((b) => { st.balance = b; renderWallet(); }).catch(() => {});
    setInterval(loadNodes, 60_000);
    setInterval(() => { if (st.view === 'wallet') refreshWallet(); }, 15_000);
    setInterval(async () => { try { st.token = await call('token'); renderToken(); } catch { /* keep */ } }, 300_000);
    document.body.classList.add('ready');
  })();
})();
