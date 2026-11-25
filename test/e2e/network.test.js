// End to end: one coordinator (memory store, simulated Rings, a LiteSVM chain behind a
// local JSON-RPC endpoint), four nodes as separate processes (bin/node.js) and the
// client CLI (bin/client.js) as separate processes. Real code paths everywhere; the only
// stand ins are the chain (LiteSVM) and Privacy Rings (the pay module's sim adapter).
//
// Proves:
//   (a) HTTP through the client's SOCKS port crosses 3 hops; every hop is paid by voucher,
//       the coordinator accepts each redemption and credits that node's earnings
//   (b) an off grid bundle travels client -> N1 -> N2 -> N3 -> N4 (gateway); no carrier
//       links to the gateway except N3; it lands in LiteSVM, the signed receipt returns
//       to the sender, and the claim is accepted with the tip split
//   (c) with Docker (DOCKER_HOST set): rent a sealed machine, run a command, billed by the
//       second, the node's earnings go up
//   (d) directory, map, stats and health show the real network
//   (a2) a client whose credit ran out on its hops tops up by itself (fresh throwaway accounts,
//       within its 24 hour limit) and its traffic carries on
//   (e) the CLI withdraw is accepted by pay, sent by the sim adapter, followed to `sent`
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LiteSVM } from 'litesvm';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getTransactionDecoder } from '@solana/kit';
import { SocksClient } from 'socks';
import bs58 from 'bs58';
import { startService } from '../../src/coord/service.js';
import { verifyObject, signVoucher, createIdentity, unb58 } from '../../src/core/index.js';
import { createKeystore } from '../../src/node/keystore.js';
import { buildCreateNonceAccountTx, readNonceValue, NONCE_ACCOUNT_LENGTH } from '../../src/offgrid/index.js';
import { startSvmRpc } from './support/svm-rpc.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE_BIN = path.join(ROOT, 'bin', 'node.js');
const CLIENT_BIN = path.join(ROOT, 'bin', 'client.js');
const DOCKER = Boolean(process.env.DOCKER_HOST);

function lines(stream, onLine) {
  let buf = '';
  stream.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
}

// Start a long running process and wait for the JSON line `event`.
function startProc(bin, args, readyEvent, { timeoutMs = 60_000, env = {} } = {}) {
  const proc = spawn(process.execPath, [bin, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${path.basename(bin)} not ready in time:\n${log.slice(-15).join('\n')}`)), timeoutMs);
    const on = (l) => {
      log.push(l);
      let j; try { j = JSON.parse(l); } catch { return; }
      if (j.event === readyEvent) { clearTimeout(t); resolve(j); }
    };
    lines(proc.stdout, on);
    lines(proc.stderr, on);
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`${path.basename(bin)} exited ${code}:\n${log.slice(-15).join('\n')}`)); });
  });
  return { proc, log, ready };
}

// Run a CLI command to the end. -> parsed last JSON line of stdout
function runCli(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLIENT_BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('client timed out: ' + err.slice(-2000))); }, timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`client ${args[0]} exited ${code}: ${err.slice(-2000)}`));
      const last = out.trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch { reject(new Error('client printed no JSON: ' + out.slice(-500))); }
    });
  });
}

async function stopProc(p) {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill('SIGTERM');
  const t = setTimeout(() => p.kill('SIGKILL'), 20_000);
  await done;
  clearTimeout(t);
}

async function waitFor(fn, { timeoutMs = 60_000, every = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// GET through a SOCKS5 proxy with a raw HTTP/1.0 request. -> Buffer body
async function socksGet(socksPort, port, pathName) {
  const { socket } = await SocksClient.createConnection({ proxy: { host: '127.0.0.1', port: socksPort, type: 5 }, command: 'connect', destination: { host: '127.0.0.1', port }, timeout: 30_000 });
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const all = Buffer.concat(chunks);
      const i = all.indexOf('\r\n\r\n');
      if (i < 0) return reject(new Error('no HTTP response'));
      resolve({ head: all.subarray(0, i).toString(), body: all.subarray(i + 4) });
    });
    socket.write(`GET ${pathName} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
  });
}

test('end to end: coordinator, 4 node processes, client CLI', { timeout: 600_000 }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tangent-e2e-'));
  const procs = [];
  let svc = null; let rpc = null; let dest = null;
  try {
    // ---- local chain behind a JSON-RPC endpoint
    const svm = new LiteSVM();
    rpc = await startSvmRpc(svm);

    // ---- destination web server for traffic through the network
    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    dest = http.createServer((req, res) => {
      if (req.url === '/big') { res.writeHead(200, { 'content-length': big.length }); res.end(big); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello through three hops');
    });
    await new Promise((r) => dest.listen(0, '127.0.0.1', r));
    const destPort = dest.address().port;

    // ---- coordinator (the real service boot, memory store, simulated Rings)
    const coordLog = [];
    svc = await startService({
      env: {
        PORT: '0', ALLOW_PRIVATE_HOSTS: 'true', PAY_DEV_SIM: 'true', PAY_DEV_SIM_ROUTES: 'true', SOLANA_RPC_URL: rpc.url, TRUST_PROXY: 'false',
        HEARTBEAT_INTERVAL_MS: '2000', PAY_TICK_MS: '500', RATE_LIMIT_PER_MIN: '100000', HEARTBEAT_LIMIT_PER_MIN: '100000',
        REDEEM_LIMIT_PER_MIN: '100000', CLAIM_LIMIT_PER_MIN: '10000', REGISTER_LIMIT_PER_HOUR: '1000',
        // the tip sweep runs by itself; here its timer is far off and part (b2) calls one pass directly
        OFFGRID_SWEEP_MIN_LAMPORTS: '10000', OFFGRID_SWEEP_INTERVAL_MS: '86400000',
      },
      sink: (l) => coordLog.push(l),
    });
    const coordUrl = `http://127.0.0.1:${svc.server.address().port}`;
    const api = async (p) => { const r = await fetch(coordUrl + p); assert.equal(r.headers.get('cache-control'), 'no-store'); return r.json(); };
    const health0 = await api('/api/health');
    assert.equal(health0.ok, true);
    assert.equal(health0.modules.pay, true);
    assert.equal(health0.modules.paySimulated, true);
    assert.deepEqual(await api('/api/stats'), {}, 'an empty network reports nothing');
    assert.deepEqual((await api('/api/map')).nodes, []);

    // ---- four nodes as separate processes. Off grid links: N1 - N2 - N3 - N4 (gateway)
    const common = ['--coordinator', coordUrl, '--host', '127.0.0.1', '--bind', '127.0.0.1', '--relay-port', '0', '--api-port', '0', '--offgrid-port', '0', '--dev-allow-private', '--region', 'test-local'];
    const startNode = async (name, extra) => {
      const p = startProc(NODE_BIN, [...common, '--data', path.join(tmp, name), ...extra], 'node.ready', { timeoutMs: 120_000 });
      procs.push(p.proc);
      const info = await p.ready;
      return { name, ...info, log: p.log, proc: p.proc };
    };
    const n4 = await startNode('n4', ['--exit', '--gateway', '--rpc-url', rpc.url]);
    const n3 = await startNode('n3', ['--exit', '--peer', `127.0.0.1:${n4.offgridPort}`]);
    const n2 = await startNode('n2', ['--peer', `127.0.0.1:${n3.offgridPort}`]);
    const n1 = await startNode('n1', ['--peer', `127.0.0.1:${n2.offgridPort}`, ...(DOCKER ? ['--compute'] : [])]);
    const nodes = [n1, n2, n3, n4];
    assert.deepEqual(n4.roles, ['relay', 'exit', 'gateway']);
    if (DOCKER) assert.ok(n1.roles.includes('compute'));
    for (const n of nodes) {
      // keys were created insert only with a backup copy
      const keys = await fs.readdir(path.join(tmp, n.name, 'keys'));
      const backups = await fs.readdir(path.join(tmp, n.name, 'backups'));
      for (const k of ['identity', 'kx', 'payout']) {
        assert.ok(keys.includes(`${k}.json`));
        assert.ok(backups.some((b) => b.startsWith(`${k}-`)));
      }
      assert.ok(n.log.some((l) => l.includes('payout.not_registered')), 'a node with no RPC says plainly its payout wallet is not registered');
    }

    // ---- (d) directory: signed by the coordinator, all four nodes
    const dirBody = await waitFor(async () => { const b = await api('/api/directory'); return b.directory.nodes.length === 4 ? b : null; }, { what: 'four nodes in the directory' });
    assert.ok(verifyObject(health0.network.coordinator, dirBody.directory, dirBody.sig));
    const ids = new Set(dirBody.directory.nodes.map((x) => x.descriptor.id));
    for (const n of nodes) assert.ok(ids.has(n.id));

    // ---- client wallet, funded through (simulated) Privacy Rings
    const cdir = path.join(tmp, 'client');
    const w = await runCli(['wallet', '--coordinator', coordUrl, '--data', cdir]);
    svc.modules.rings.sim.fund(w.wallet, 'SOL', 100_000_000n);
    svc.modules.rings.sim.userSendToVault(w.wallet, 'SOL', 100_000_000n);
    await waitFor(async () => {
      const b = await runCli(['balance', '--coordinator', coordUrl, '--data', cdir]);
      return b.walletBalance && BigInt(b.walletBalance.balance ?? b.walletBalance.lamports ?? 0) > 0n;
    }, { what: 'deposit credited to the wallet', timeoutMs: 30_000, every: 500 });

    const earnings = async (id) => {
      const e = await api(`/api/nodes/${id}/earnings`);
      return e.earnings ? BigInt(e.earnings.earned) : 0n;
    };
    const nodeApi = async (n) => (await fetch(`http://127.0.0.1:${n.apiPort}/api/node`)).json();

    // ---- (a) private internet: 3 hops, every hop paid and credited
    await t.test('(a) HTTP through the SOCKS port crosses 3 hops, each hop is paid', async () => {
      const proxy = startProc(CLIENT_BIN, ['proxy', '--coordinator', coordUrl, '--data', cdir, '--socks-port', '0'], 'socks.ready', { timeoutMs: 120_000 });
      procs.push(proxy.proc);
      const ready = await proxy.ready;
      assert.equal(ready.hops, 3);
      const before = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, await earnings(n.id)])));
      const small = await socksGet(ready.socksPort, destPort, '/');
      assert.equal(small.body.toString(), 'hello through three hops');
      const got = await socksGet(ready.socksPort, destPort, '/big');
      assert.equal(createHash('sha256').update(got.body).digest('hex'), createHash('sha256').update(big).digest('hex'), '3 MB arrived intact');

      // every hop of the circuit redeemed vouchers that the coordinator accepted
      const paid = await waitFor(async () => {
        const st = await Promise.all(nodes.map(async (n) => ({ n, v: (await nodeApi(n)).vouchers })));
        const hops = st.filter((x) => BigInt(x.v.creditedByKind.relay) > 0n);
        return hops.length >= 3 ? hops : null;
      }, { what: 'three hops paid', timeoutMs: 60_000, every: 500 });
      for (const { n, v } of paid) {
        assert.ok(v.redeemed > 0, `${n.name} redeemed vouchers`);
        assert.equal(v.refused, 0, `${n.name} had no voucher refused`);
        const after = await earnings(n.id);
        assert.ok(after - before[n.id] >= BigInt(v.creditedByKind.relay), `${n.name} earnings went up by what it redeemed`);
      }
      // the exit is one of the paid hops, and the two plain relays carried it too
      const paidIds = new Set(paid.map((x) => x.n.id));
      assert.ok(paidIds.has(n1.id) && paidIds.has(n2.id), 'both plain relays were hops');
      assert.ok(paidIds.has(n3.id) || paidIds.has(n4.id), 'an exit was the last hop');
      // 3 MB at 10000 lamports per MB, through each of 3 hops: each hop billed for at least the bytes it carried
      for (const { v } of paid) assert.ok(BigInt(v.creditedByKind.relay) >= 25_000n, 'paid for about 3 MB of cells');
      const stats = await api('/api/stats');
      assert.ok(Number(stats.redemptions) >= 3);
      await stopProc(proxy.proc);
    });

    // ---- (a2) credit runs out on every hop: the proxy tops up by itself and carries on
    await t.test('(a2) a client that used up its credit on its hops tops up and continues', async () => {
      const proxy = startProc(CLIENT_BIN, ['proxy', '--coordinator', coordUrl, '--data', cdir, '--socks-port', '0', '--top-up-limit', '6000000'], 'socks.ready', { timeoutMs: 120_000 });
      procs.push(proxy.proc);
      const ready = await proxy.ready;
      assert.deepEqual(ready.topUp, { limitLamports: '6000000', freshAccount: true });
      assert.equal((await socksGet(ready.socksPort, destPort, '/')).body.toString(), 'hello through three hops');

      // spend everything left on each node's account, as earlier traffic would have
      const b0 = await runCli(['balance', '--coordinator', coordUrl, '--data', cdir]);
      const ks = await createKeystore({ dir: cdir });
      const rows = await ks.list('acct-');
      const used = b0.accounts.filter((a) => a.current);
      assert.equal(used.length, 4);
      for (const a of used) {
        const row = rows.find((r) => r.publicKey === a.account);
        const id = createIdentity(unb58(row.secret));
        if (BigInt(a.balance) === 0n) continue;
        const v = signVoucher(id, { session: 'spent-' + a.account.slice(0, 8), node: a.node, kind: 'relay', cumulative: BigInt(a.balance), seq: 1, expires: Date.now() + 60_000 });
        assert.equal((await svc.modules.pay.redeemVoucher(v, { node: a.node })).ok, true);
      }
      const spent = await runCli(['balance', '--coordinator', coordUrl, '--data', cdir]);
      for (const a of spent.accounts.filter((x) => x.current)) assert.equal(a.balance, '0');

      // traffic now: the hops bill, the drained accounts cannot pay, the hops refuse, the client tops up
      const stuck = socksGet(ready.socksPort, destPort, '/big').catch(() => null); // started on the drained accounts
      const toppedUp = () => proxy.log.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j && j.event === 'credit.topped_up');
      await waitFor(() => new Set(toppedUp().map((j) => j.node)).size === 4, { what: 'every node topped up', timeoutMs: 150_000, every: 500 });
      assert.ok(toppedUp().every((j) => j.fresh === true && j.lamports === '1000000'), 'one token each, on a fresh account');
      const after = await runCli(['balance', '--coordinator', coordUrl, '--data', cdir]);
      const current = after.accounts.filter((x) => x.current);
      assert.equal(current.length, 4);
      for (const a of current) assert.ok(!used.some((u) => u.account === a.account), 'a new account per node');
      assert.equal(after.accounts.length, b0.accounts.length + 4, 'the old accounts are kept');

      // and it carries on: new traffic rides a circuit paid by the new accounts
      const before = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, await earnings(n.id)])));
      const got = await socksGet(ready.socksPort, destPort, '/big');
      assert.equal(createHash('sha256').update(got.body).digest('hex'), createHash('sha256').update(big).digest('hex'), '3 MB arrived intact after the top up');
      await waitFor(async () => {
        const now = await runCli(['balance', '--coordinator', coordUrl, '--data', cdir]);
        const paidFromNew = now.accounts.filter((x) => x.current && BigInt(x.balance) < 1_000_000n);
        return paidFromNew.length >= 3 ? paidFromNew : null;
      }, { what: 'three hops paid from the new accounts', timeoutMs: 60_000, every: 1000 });
      let gained = 0;
      for (const n of nodes) if ((await earnings(n.id)) > before[n.id]) gained += 1;
      assert.ok(gained >= 3, 'three hops earned again');
      // the 24 hour record holds what was spent, under the limit
      const rec = JSON.parse(await fs.readFile(path.join(cdir, 'credit', 'auto-top-up.json'), 'utf8'));
      assert.equal(rec.spends.reduce((a, x) => a + BigInt(x.lamports), 0n), 4_000_000n);
      await stopProc(proxy.proc);
      await stuck;
    });

    // ---- (b) off grid: client -> N1 -> N2 -> N3 -> N4 gateway -> LiteSVM, receipt back, tip claimed
    await t.test('(b) an off grid bundle crosses 3 carriers to the gateway and the tip is claimed', async () => {
      const payer = Keypair.generate();
      svm.airdrop(payer.publicKey.toBase58(), BigInt(5 * LAMPORTS_PER_SOL));
      // the one online step: a durable nonce account
      const nonce = Keypair.generate();
      const rent = svm.minimumBalanceForRentExemption(BigInt(NONCE_ACCOUNT_LENGTH));
      const create = buildCreateNonceAccountTx({ payer, nonceAccount: nonce, authority: payer.publicKey, lamports: rent, recentBlockhash: svm.latestBlockhash() });
      const res = svm.sendTransaction(getTransactionDecoder().decode(create));
      assert.notEqual(typeof res.err, 'function', 'nonce account created');
      svm.expireBlockhash();
      const nonceValue = readNonceValue(svm.getAccount(nonce.publicKey.toBase58()).data);
      const kpFile = path.join(tmp, 'sender.json');
      await fs.writeFile(kpFile, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
      const to = Keypair.generate().publicKey.toBase58();
      const tipAccount = health0.network.tipAccount;
      // the owner funds the tip account with its rent exempt minimum, as the coordinator's WALLETS block asks
      assert.ok(coordLog.some((l) => l.includes('tip account') && l.includes(tipAccount)), 'the wallet block names the tip account');
      svm.airdrop(tipAccount, 890_880n);
      const before = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, await earnings(n.id)])));

      const r = await runCli(['offgrid-send', '--coordinator', coordUrl, '--data', cdir, '--peer', `127.0.0.1:${n1.offgridPort}`,
        '--keypair', kpFile, '--nonce-account', nonce.publicKey.toBase58(), '--nonce-value', nonceValue,
        '--to', to, '--lamports', '1000000', '--tip', '60000', '--timeout-sec', '150']);
      assert.equal(r.receipt.status, 'landed', JSON.stringify(r.receipt));
      assert.equal(r.receipt.gateway, n4.id);
      assert.deepEqual(r.receipt.trail.map((e) => e.node), [n1.id, n2.id, n3.id], 'carried by N1, N2, N3 in order');
      assert.equal(svm.getBalance(to), 1_000_000n, 'the transfer landed on chain');
      assert.ok(rpc.txs.has(r.receipt.signature));

      // the gateway (or a carrier) claimed; the coordinator verified the tip on chain and split it
      await waitFor(async () => (await api('/api/stats')).offgridClaims === '1', { what: 'claim accepted', timeoutMs: 60_000 });
      const stats = await api('/api/stats');
      assert.equal(stats.offgridTipLamports, '60000');
      const gained = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, (await earnings(n.id)) - before[n.id]])));
      assert.equal(gained[n4.id], 30_000n, 'gateway half');
      for (const c of [n1, n2, n3]) assert.equal(gained[c.id], 10_000n, `${c.name} carrier share`);
      // the gateway submitted it; nodes without an RPC never touched the chain
      assert.ok((await nodeApi(n4)).offgrid.landed >= 1);
      assert.equal(Number(rpc.calls.sendTransaction), 1, 'one submission, by the gateway');
      assert.equal(svm.getBalance(tipAccount), 890_880n + 60_000n, 'the tip reached the network tip account');
    });

    // ---- (b2) the tip sweep moves the tip into the Rings vault by itself, exactly once
    await t.test('(b2) the claimed tip moves from the tip account into the Rings vault, once, keeping the rent minimum', async () => {
      const tipAccount = health0.network.tipAccount;
      const rent0 = svm.minimumBalanceForRentExemption(0n);
      const vault = svc.modules.rings.vaultAddress();
      const tipBefore = svm.getBalance(tipAccount);
      const vaultPrivateBefore = await svc.modules.rings.vaultBalance('SOL');
      const expect = tipBefore - rent0 - 10_000n; // everything above the rent minimum and the fee reserve
      assert.ok(expect >= 10_000n, `sweepable ${expect}`);
      // the simulated Rings books the deposit as a transfer to the Rings wallet's public address; before the
      // owner funds that wallet (the WALLETS block asks for it) the chain refuses it: the sweep stays pending
      const early = await svc.tipSweeper.tick();
      assert.equal(early.status, 'pending', JSON.stringify(early));
      // nothing but at most the fee of the refused transaction (this test RPC runs a refused transaction and charges it)
      const afterRefused = svm.getBalance(tipAccount);
      assert.ok(afterRefused === tipBefore || afterRefused === tipBefore - 5_000n, `tip account ${afterRefused}`);
      svm.airdrop(vault, 50_000_000n);
      svm.expireBlockhash(); // a new blockhash, as on a real chain minutes later
      const vaultPublicFunded = svm.getBalance(vault);
      const r = await svc.tipSweeper.tick(); // the same recorded sweep, retried
      assert.equal(r.sweep, 'sweep:1');
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.equal(BigInt(r.lamports), expect);
      assert.equal(svm.getBalance(tipAccount), afterRefused - expect - 5_000n, 'only the recorded sweep amount and its fee left the tip account');
      assert.ok(svm.getBalance(tipAccount) >= rent0, 'the tip account keeps its rent exempt minimum');
      assert.equal(svm.getBalance(vault) - vaultPublicFunded, expect, 'the SOL reached the service\'s own Rings wallet on chain');
      assert.equal(await svc.modules.rings.vaultBalance('SOL') - vaultPrivateBefore, expect, 'booked in the vault\'s private balance');
      // pay recorded the sweep and credited nobody; the money invariant still holds
      await waitFor(async () => (await svc.store.collection('pay_deposits').find({ reason: 'tip_sweep' })).length === 1, { what: 'sweep seen by pay', timeoutMs: 20_000 });
      assert.equal((await svc.modules.pay.totals()).balanced, true);
      // nothing more to move: a second pass sends nothing
      const sends = Number(rpc.calls.sendTransaction);
      assert.equal((await svc.tipSweeper.tick()).reason, 'below_threshold');
      assert.equal(Number(rpc.calls.sendTransaction), sends);
      const h = await svc.tipSweeper.history();
      assert.deepEqual(h.map((d) => [d.status, d.from, d.to]), [['sent', tipAccount, vault]]);
    });

    // ---- (c) agent computer: rent, run, billed per second, earnings up
    await t.test('(c) rent a sealed machine, run a command, billed by the second', { skip: DOCKER ? false : 'DOCKER_HOST is not set: the Docker machine test needs a Docker daemon' }, async () => {
      const before = await earnings(n1.id);
      const r = await runCli(['rent', '--coordinator', coordUrl, '--data', cdir, '--node', n1.id, '--image', 'alpine',
        '--cmd', 'echo hello from the machine; id -u; cat /etc/os-release | head -1', '--cmd', 'sleep 2', '--hold-seconds', '1'], { timeoutMs: 240_000 });
      assert.equal(r.sealed, true);
      assert.equal(r.results[0].exitCode, 0);
      assert.match(r.results[0].stdout, /hello from the machine/);
      assert.match(r.results[0].stdout, /^1000$/m, 'runs as uid 1000');
      assert.match(r.results[0].stdout, /Alpine/);
      const ms = Number(r.bill.usage.milliseconds);
      assert.ok(ms >= 3000, `billed for the time it ran (${ms} ms)`);
      // 1000 lamports per second for a small machine, rounded up to the lamport
      assert.equal(BigInt(r.bill.usage.owedLamports), (BigInt(ms) * 1000n + 999n) / 1000n);
      assert.ok(BigInt(r.paid) >= BigInt(r.bill.usage.owedLamports), 'autopay kept it paid');
      await waitFor(async () => BigInt((await nodeApi(n1)).vouchers.creditedByKind.compute) > 0n, { what: 'compute voucher redeemed' });
      const after = await earnings(n1.id);
      assert.ok(after > before, 'node earnings went up');
      assert.ok(after - before >= BigInt(r.bill.usage.owedLamports));

      // the node kept the machine wallet's key (encrypted, insert only) and the renter gets it back
      // after the machine ended, by signing with the payer identity that rented it
      assert.match(r.wallet.keyKept, /30 days after the machine ends/);
      assert.ok(r.bill.wallet.keyKeptUntil > Date.now() + 29 * 24 * 3600_000, 'kept for 30 days after the end');
      const mw = await fs.readdir(path.join(tmp, 'n1', 'backups', 'machine-wallets'));
      assert.ok(mw.includes(`${r.machine}.json`) && mw.includes(`${r.machine}.ended.json`));
      const rec = await runCli(['recover-wallet', '--coordinator', coordUrl, '--data', cdir, '--node', n1.id, '--machine', r.machine]);
      assert.equal(rec.address, r.wallet.address);
      const recovered = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await fs.readFile(rec.keyFile, 'utf8'))));
      assert.equal(recovered.publicKey.toBase58(), r.wallet.address);
      assert.equal(new Date(rec.keyKeptOnNodeUntil).getTime(), r.bill.wallet.keyKeptUntil);
      const nodeLog = n1.log.join('\n');
      assert.ok(!nodeLog.includes(bs58.encode(recovered.secretKey)) && !nodeLog.includes(bs58.encode(recovered.secretKey.subarray(0, 32))), 'the key is not in the node log');

      // the sealed machine's only way out is the node's own relay client: 127.0.0.1:1080 inside the
      // machine reaches n1's egress SOCKS port, which builds circuits over n2, n3 and n4
      const script = `const n=require("net");const s=n.connect(1080,"127.0.0.1");let st=0,b=Buffer.alloc(0);`
        + `s.on("connect",()=>s.write(Buffer.from([5,1,0])));`
        + `s.on("data",d=>{if(st===2){process.stdout.write(d);return}b=Buffer.concat([b,d]);`
        + `if(st===0&&b.length>=2){b=b.subarray(2);const h=Buffer.from("127.0.0.1");const p=Buffer.alloc(2);p.writeUInt16BE(${destPort});s.write(Buffer.concat([Buffer.from([5,1,0,3,h.length]),h,p]));st=1}`
        + `if(st===1&&b.length>=10){if(b[1]!==0){console.log("REFUSED",b[1]);process.exit(3)}st=2;const r=b.subarray(10);if(r.length)process.stdout.write(r);s.write("GET / HTTP/1.0\\r\\nHost: x\\r\\n\\r\\n")}});`
        + `s.on("error",e=>{console.log("ERR",e.message);process.exit(2)})`;
      const eg = await runCli(['rent', '--coordinator', coordUrl, '--data', cdir, '--node', n1.id, '--image', 'node',
        '--cmd', `node -e '${script}'`, '--cmd', 'wget -Y off -q -T 3 -O- http://1.1.1.1/ >/dev/null 2>&1; echo direct=$?'], { timeoutMs: 240_000 });
      assert.equal(eg.sealed, true);
      assert.match(eg.results[0].stdout, /hello through three hops/, 'machine traffic crossed the network: ' + eg.results[0].stdout + eg.results[0].stderr);
      assert.match(eg.results[1].stdout, /direct=[1-9]/, 'no direct route out of the machine');

      // the stdio MCP entry lists its tools and answers balance
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const mcp = new Client({ name: 'e2e', version: '0.0.0' });
      await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'mcp.js'), '--coordinator', coordUrl, '--data', cdir, '--node', n1.id], stderr: 'ignore' }));
      try {
        const tools = (await mcp.listTools()).tools.map((x) => x.name);
        for (const name of ['rent_computer', 'exec', 'stop_computer', 'balance']) assert.ok(tools.includes(name), name);
        const bal = await mcp.callTool({ name: 'balance', arguments: {} });
        assert.ok(!bal.isError, JSON.stringify(bal));
      } finally { await mcp.close(); }
    });

    // ---- (d) map, stats, health stay truthful
    await t.test('(d) directory, map, stats and health show the real network', async () => {
      const map = await api('/api/map');
      assert.equal(map.nodes.length, 4);
      for (const m of map.nodes) {
        assert.ok(ids.has(m.id));
        for (const k of ['host', 'port', 'ip', 'onion', 'kx', 'apiPort']) assert.equal(m[k], undefined, `map never shows ${k}`);
        assert.equal(m.region, 'test-local');
        assert.match(m.link, /^https:\/\/solscan\.io\/account\//);
      }
      const stats = await api('/api/stats');
      assert.equal(stats.nodes.online, 4);
      assert.equal(stats.nodes.relay, 4);
      assert.equal(stats.nodes.exit, 2);
      assert.equal(stats.nodes.gateway, 1);
      if (DOCKER) assert.equal(stats.nodes.compute, 1); else assert.equal(stats.nodes.compute, undefined);
      assert.ok(BigInt(stats.redeemedLamports) > 0n);
      assert.ok(Number(stats.sessions) >= 3);
      const h = await api('/api/health');
      assert.equal(h.ok, true);
      assert.equal(h.storage.kind, 'memory');
      assert.deepEqual(h.config, { mongo: false, helius: false, token: false, rpc: true });
      assert.equal(h.modules.token, false);
      // a stopped node leaves the live counts once the coordinator stops hearing from it is covered by the
      // coordinator's own liveness tests; here every node is still heartbeating
      for (const n of nodes) assert.equal((await nodeApi(n)).registered, true);
    });

    // ---- (e) withdraw through the CLI
    await t.test('(e) withdraw: accepted, sent by the sim adapter, followed until sent', async () => {
      const to = Keypair.generate().publicKey.toBase58();
      const b0 = await runCli(['balance', '--coordinator', coordUrl, '--data', cdir]);
      const r = await runCli(['withdraw', '--coordinator', coordUrl, '--data', cdir, '--to', to, '--lamports', '2000000', '--public']);
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.equal(r.amount, '2000000');
      assert.equal(r.to.address, to);
      assert.match(r.explorer, /^https:\/\/solscan\.io\/tx\//);
      assert.equal(svc.modules.rings.sim.publicBalanceOf(to), 2_000_000n, 'the sim sent it to that address');
      const b1 = await runCli(['balance', '--coordinator', coordUrl, '--data', cdir]);
      assert.equal(BigInt(b0.walletBalance.balance) - BigInt(b1.walletBalance.balance), 2_000_000n);
      const again = await runCli(['withdraw', '--coordinator', coordUrl, '--data', cdir, '--id', r.id]);
      assert.deepEqual([again.status, again.signature], ['sent', r.signature]);
      assert.equal((await svc.modules.pay.totals()).balanced, true);
    });
  } finally {
    for (const p of procs) await stopProc(p).catch(() => {});
    if (svc) await svc.stop().catch(() => {});
    if (rpc) await rpc.close().catch(() => {});
    if (dest) await new Promise((r) => { dest.close(() => r()); dest.closeAllConnections(); });
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
