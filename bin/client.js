#!/usr/bin/env node
// Tangent Systems client CLI.
//   node bin/client.js <command> --coordinator <url> [options]
// Commands: wallet, deposit, balance, credit, withdraw, proxy, rent, recover-wallet, offgrid-send, mcp. --help lists the options.
// Everything it creates (wallet key, throwaway credit account keys, off grid origin key) is stored
// insert only with a backup under the data folder (default ~/.tangent/client).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createKeystore } from '../src/node/keystore.js';
import { createCoordinatorClient } from '../src/node/coord-client.js';
import { createCredit, createAutoTopUp, payerFor, AUTO_TOP_UP_DEFAULT_LIMIT } from '../src/node/credit.js';
import { checkWithdrawArgs, requestWithdrawal, followWithdrawal } from '../src/node/withdraw.js';

const HELP = `Tangent Systems client

Usage: node bin/client.js <command> --coordinator <url> [options]

Commands
  wallet                     show this client's wallet address (created on first use)
  deposit                    show where to deposit through Privacy Rings for this wallet
  balance                    wallet balance and the credit left on each throwaway account
  credit [--nodes <ids>]     buy credit: one throwaway account per node that has none (default: every live node)
         [--tokens <n>]      tokens per account (default 1)
         [--top-up]          also add --tokens to nodes that already have an account: each gets a fresh
                             throwaway account holding the new tokens (the more private choice)
         [--same-account]    with --top-up: put the tokens on the account the node already has instead
  withdraw --to <address> --lamports <n> [--public]
                             send wallet balance out through Privacy Rings (to a Privacy Rings wallet, or to a
                             public address with --public), then follow it until it is sent (--timeout-sec, default 120)
  withdraw --id <withdrawal id>
                             follow an earlier withdrawal
  proxy [--socks-port <n>]   private internet: a local SOCKS5 proxy over 3 hop circuits (default port 1080)
        [--hops <n>]
  rent --node <id>           rent an agent computer, run commands, stop it, print the bill
       [--image alpine] [--size small] [--cmd "<command>"]... [--hold-seconds <n>]
  recover-wallet --node <id> --machine <id>
                             get back the wallet key of a machine you rented on that node (the node keeps
                             it for 30 days after the machine ends, then deletes it). Saved to
                             <data>/recovered/<machine>-<address>.json as a Solana keypair file
  offgrid-send               hand a signed durable nonce SOL transfer to the off grid mesh and wait for its receipt
       --peer <host:port> --keypair <solana keypair json> --nonce-account <address> --nonce-value <hash>
       --to <address> --lamports <n> [--tip <lamports>] [--tip-account <address>] [--timeout-sec <n>]
  mcp [--node <id>]          MCP server on stdio so an AI agent can rent and drive a computer
      [--http <port>]        serve MCP over streamable HTTP on 127.0.0.1 instead

Automatic top up (proxy, rent, mcp)
  When a node's account runs low these buy more credit by themselves:
  --tokens <n>               tokens per top up (default 1)
  --top-up-limit <lamports>  most they spend on top ups in any 24 hours, over every run with this data folder
                             (default 10000000 = 0.01 SOL; 0 turns automatic top up off)
  --same-account             proxy: top up the account a node already has instead of a fresh one. A rented
                             computer is always topped up on the account that rented it

Common options
  --coordinator <url>        coordinator url (or TANGENT_COORDINATOR)
  --coordinator-id <id>      pin the coordinator identity (default: read from /api/health)
  --data <dir>               data folder (default ~/.tangent/client)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' }, coordinator: { type: 'string' }, 'coordinator-id': { type: 'string' }, data: { type: 'string' },
    nodes: { type: 'string' }, tokens: { type: 'string' }, 'top-up': { type: 'boolean' }, 'same-account': { type: 'boolean' }, 'top-up-limit': { type: 'string' },
    public: { type: 'boolean' }, id: { type: 'string' },
    'socks-port': { type: 'string' }, hops: { type: 'string' },
    node: { type: 'string' }, machine: { type: 'string' }, image: { type: 'string' }, size: { type: 'string' }, cmd: { type: 'string', multiple: true }, 'hold-seconds': { type: 'string' },
    peer: { type: 'string' }, keypair: { type: 'string' }, 'nonce-account': { type: 'string' }, 'nonce-value': { type: 'string' },
    to: { type: 'string' }, lamports: { type: 'string' }, tip: { type: 'string' }, 'tip-account': { type: 'string' }, 'timeout-sec': { type: 'string' },
    http: { type: 'string' },
  },
});

const command = positionals[0];
let exitCode = 0;
if (values.help || !command) { process.stdout.write(HELP); process.exit(values.help ? 0 : 2); }

const isMcp = command === 'mcp';
// stdout belongs to the MCP protocol in mcp mode, so everything else goes to stderr there
const out = (obj) => (isMcp ? process.stderr : process.stdout).write(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
const log = (level, event, fields = {}) => process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }) + '\n');
const die = (msg, code = 1) => { log('error', 'client.failed', { reason: String(msg).slice(0, 300) }); process.exit(code); };
const int = (v, d, name) => { if (v === undefined) return d; if (!/^[0-9]{1,15}$/.test(v)) die(`${name} must be a whole number`, 2); return Number(v); };

const coordinatorUrl = values.coordinator || process.env.TANGENT_COORDINATOR;
if (!coordinatorUrl) die('--coordinator is required', 2);
const dataDir = path.resolve(values.data || path.join(os.homedir(), '.tangent', 'client'));
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const keystore = await createKeystore({ dir: dataDir });
const coord = createCoordinatorClient({ url: coordinatorUrl, coordinatorId: values['coordinator-id'] || null });
const explorer = (a) => `https://solscan.io/account/${a}`;

async function credit() { return createCredit({ coord, keystore, dir: dataDir, log }); }
// Automatic top up for proxy, rent and mcp (src/node/credit.js createAutoTopUp)
async function autoTopUp(c, { fresh = !values['same-account'] } = {}) {
  const limit = values['top-up-limit'] === undefined ? AUTO_TOP_UP_DEFAULT_LIMIT : BigInt(int(values['top-up-limit'], 0, '--top-up-limit'));
  const tokens = int(values.tokens, 1, '--tokens');
  if (tokens < 1) die('--tokens must be at least 1', 2);
  return createAutoTopUp({ credit: c, dir: dataDir, limitLamports: limit, tokens, fresh, log: (level, event, fields) => log(level, event, fields) });
}

async function computeNode(nodeId) {
  const dir = await coord.directory({ role: 'compute' });
  const d = nodeId ? dir.find((x) => x.id === nodeId) : dir[0];
  if (!d) die(nodeId ? `node ${nodeId} is not a live compute node` : 'no live compute node in the directory');
  if (!d.host || !d.apiPort) die('that node publishes no reachable api');
  const host = d.host.includes(':') ? `[${d.host}]` : d.host;
  return { descriptor: d, baseUrl: `http://${host}:${d.apiPort}/api/compute` };
}

try {
  switch (command) {
    case 'wallet': {
      const c = await credit();
      out({ wallet: c.wallet.id, explorer: explorer(c.wallet.id), data: dataDir });
      break;
    }
    case 'deposit': {
      const c = await credit();
      try { out(await coord.pay.deposit(c.wallet.id)); } catch (err) {
        if (err.code === 'RINGS_NOT_CONFIGURED' || err.status === 503) die('this coordinator takes no deposits yet (Privacy Rings is not configured there)');
        throw err;
      }
      break;
    }
    case 'balance': {
      const c = await credit();
      let wallet = null;
      try { wallet = await c.walletBalance(); } catch (err) { wallet = { error: err.code || err.message }; }
      const accounts = [];
      for (const a of c.allAccounts()) accounts.push({ ...a, balance: (await c.balanceOfAccount({ id: a.account })).toString() });
      out({ wallet: c.wallet.id, explorer: explorer(c.wallet.id), walletBalance: wallet, credit: (await c.balance()).lamports, accounts });
      break;
    }
    case 'credit': {
      const c = await credit();
      const ids = values.nodes && values.nodes !== 'all' ? values.nodes.split(',').map((s) => s.trim()).filter(Boolean) : (await coord.directory()).map((d) => d.id);
      const each = int(values.tokens, 1, '--tokens');
      if (each < 1) die('--tokens must be at least 1', 2);
      if (values['same-account'] && !values['top-up']) die('--same-account goes with --top-up', 2);
      const known = ids.filter((id) => c.has(id));
      const funded = await c.fund(ids, { tokensEach: each });
      const toppedUp = [];
      if (values['top-up']) for (const id of known) toppedUp.push(...(await c.topUp(id, each, { fresh: !values['same-account'] })));
      out({ funded, toppedUp, accounts: c.accounts().length });
      break;
    }
    case 'withdraw': {
      let args;
      try { args = checkWithdrawArgs(values); } catch (err) { if (err.usage) die(err.message, 2); throw err; }
      const timeoutMs = int(values['timeout-sec'], 120, '--timeout-sec') * 1000;
      let id = args.follow;
      let accepted = null;
      if (!id) {
        const c = await credit();
        try {
          accepted = await requestWithdrawal({ coord, wallet: c.wallet, to: args.to, amount: args.amount, public: args.public });
        } catch (err) {
          if (err.code === 'RINGS_NOT_CONFIGURED' || err.status === 503) die('this network takes no withdrawals yet (Privacy Rings is not configured there)');
          if (err.code === 'INSUFFICIENT_BALANCE') die(`wallet balance too low (balance ${err.body && err.body.details ? err.body.details.balance : 'unknown'} lamports)`);
          if (err.code === 'BAD_AMOUNT') die(`amount below the smallest withdrawal (${err.body && err.body.details ? err.body.details.min : 'unknown'} lamports)`);
          throw err;
        }
        id = accepted.id;
        log('info', 'withdraw.accepted', { id, amount: accepted.amount, to: accepted.to, balance: accepted.balance });
      }
      const r = await followWithdrawal({ coord, id, timeoutMs, onUpdate: (w) => log('info', 'withdraw.status', { id, status: w.status }) });
      const w = r.withdrawal || {};
      out({ id, status: w.status || (accepted ? accepted.status : 'unknown'), amount: w.amount || (accepted && accepted.amount), to: w.to || (accepted && accepted.to), public: w.public ?? args.public ?? null, signature: w.signature || null, explorer: w.explorer || null, ...(accepted ? { walletBalance: accepted.balance } : {}), ...(r.done ? {} : { note: `still pending after ${timeoutMs / 1000} seconds; follow it with: withdraw --id ${id}` }) });
      if (w.status === 'refunded') exitCode = 1; // it could not be sent: the amount is back in the wallet balance
      break;
    }
    case 'proxy': {
      const { createClient } = await import('../src/relay/index.js');
      const c = await credit();
      const hops = int(values.hops, 3, '--hops');
      const relays = (dir) => dir.filter((d) => d.roles.includes('relay') || d.roles.includes('exit'));
      let dir = relays(await coord.directory());
      const auto = await autoTopUp(c);
      await c.fund(dir.map((d) => d.id), { tokensEach: int(values.tokens, 1, '--tokens') });
      await auto.check(dir.map((d) => d.id)); // accounts used up on an earlier run get more before the first circuit
      const client = createClient({
        directory: dir, hops, credit: c, socksPort: int(values['socks-port'], 1080, '--socks-port'),
        log: (level, msg, meta) => { if (level !== 'debug') log(level, 'relay.' + String(msg).slice(0, 60), meta || {}); },
      });
      await client.start();
      out({ event: 'socks.ready', socksHost: '127.0.0.1', socksPort: client.socksPort, hops, relays: dir.length, topUp: { limitLamports: auto.limitLamports, freshAccount: auto.fresh } });
      const refresh = setInterval(async () => {
        try {
          dir = relays(await coord.directory());
          client.setDirectory(dir);
          await c.fund(dir.map((d) => d.id), { tokensEach: int(values.tokens, 1, '--tokens') });
          await auto.check(dir.map((d) => d.id));
        } catch (err) { log('warn', 'proxy.refresh_failed', { reason: String(err.message).slice(0, 120) }); }
      }, 60_000);
      const stop = async () => { clearInterval(refresh); auto.stop(); await client.stop().catch(() => {}); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }
    case 'rent': {
      const { createComputeClient, createAutopay } = await import('../src/compute/client.js');
      const { descriptor, baseUrl } = await computeNode(values.node);
      const c = await credit();
      const auto = await autoTopUp(c);
      await c.fund([descriptor.id], { tokensEach: int(values.tokens, 1, '--tokens') });
      await auto.check([descriptor.id]); // a used up account gets more before renting (fresh unless --same-account)
      const payer = payerFor(c, descriptor.id);
      const identity = payer.identityFor(descriptor.id);
      // the machine is tied to the account that rents it, so while it runs it is topped up in place
      const watch = setInterval(() => { auto.check([descriptor.id], { fresh: false }).catch(() => {}); }, 15_000);
      watch.unref();
      const cc = createComputeClient({ baseUrl });
      const machine = await cc.rent({ payer: identity.id, image: values.image, size: values.size });
      const autopay = createAutopay({ machine, nodeId: descriptor.id, payer, log: (e, d) => log('warn', e, d || {}) });
      const results = [];
      try {
        await autopay.payNow();
        autopay.start();
        for (const cmd of values.cmd || []) {
          const r = await machine.exec(cmd);
          results.push({ cmd, ...r });
        }
        const hold = int(values['hold-seconds'], 0, '--hold-seconds');
        if (hold) await new Promise((r) => setTimeout(r, hold * 1000));
        await autopay.payNow();
      } finally {
        autopay.stop();
        clearInterval(watch);
      }
      const bill = await machine.stop();
      out({ node: descriptor.id, machine: machine.machineId, image: machine.rent.image, size: machine.rent.size, sealed: machine.rent.sealed, wallet: machine.rent.wallet, results, bill, paid: autopay.last() ? autopay.last().cumulative : '0', toppedUp: auto.stats().toppedUp });
      break;
    }
    case 'recover-wallet': {
      const { createComputeClient } = await import('../src/compute/client.js');
      if (!values.node || !values.machine) die('--node and --machine are required', 2);
      const { descriptor, baseUrl } = await computeNode(values.node);
      const c = await credit();
      if (!c.has(descriptor.id)) die('this client has no payer account for that node, so it did not rent machines there');
      // the machine was rented by one of this node's accounts (newest first; a top up may have made newer ones)
      const cc = createComputeClient({ baseUrl });
      let r = null; let lastErr = null;
      for (const identity of c.identitiesFor(descriptor.id)) {
        try { r = await cc.recoverWallet({ machineId: values.machine, identity }); break; } catch (err) {
          lastErr = err;
          if (!(err && (err.status === 403 || err.status === 401))) break;
        }
      }
      if (!r) throw lastErr || new Error('no account of this client rented that machine');
      const { Keypair } = await import('@solana/web3.js');
      const bs58 = (await import('bs58')).default;
      const secret = bs58.decode(r.secretKey);
      const kp = Keypair.fromSecretKey(secret);
      if (kp.publicKey.toBase58() !== r.address) die('the node answered a key that does not match the wallet address');
      const dir = path.join(dataDir, 'recovered');
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const keyFile = path.join(dir, `${r.machineId}-${r.address}.json`);
      try { await fs.writeFile(keyFile, JSON.stringify(Array.from(secret)) + '\n', { flag: 'wx', mode: 0o600 }); } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err; // already recovered earlier: that file is kept as it is
      }
      secret.fill(0);
      out({ machine: r.machineId, address: r.address, explorer: r.explorer, keyFile, keyKeptOnNodeUntil: r.keyKeptUntil ? new Date(r.keyKeptUntil).toISOString() : null, note: r.note });
      break;
    }
    case 'offgrid-send': {
      const { Keypair } = await import('@solana/web3.js');
      const { buildDurableTransfer, createOffgrid, createMemoryStore, createTcpTransport } = await import('../src/offgrid/index.js');
      for (const k of ['peer', 'keypair', 'nonce-account', 'nonce-value', 'to', 'lamports']) if (!values[k]) die(`--${k} is required`, 2);
      const m = /^(.+):([0-9]{1,5})$/.exec(values.peer);
      if (!m) die('--peer must be host:port', 2);
      const secret = JSON.parse(await fs.readFile(path.resolve(values.keypair), 'utf8'));
      const from = Keypair.fromSecretKey(Uint8Array.from(secret));
      let tipAccount = values['tip-account'] || null;
      const tip = values.tip ? BigInt(values.tip) : 0n;
      if (tip > 0n && !tipAccount) {
        try { tipAccount = (await coord.health()).network.tipAccount; } catch { die('--tip-account is required when the coordinator cannot be reached'); }
      }
      const tx = buildDurableTransfer({
        from, to: values.to, lamports: BigInt(values.lamports), nonceAccount: values['nonce-account'], nonceValue: values['nonce-value'],
        tip: tip > 0n ? { account: tipAccount, lamports: tip } : null,
      });
      const { identity } = await keystore.identity('offgrid');
      const transport = createTcpTransport({ peers: [{ host: m[1], port: Number(m[2]) }] });
      const node = createOffgrid({ identity, transports: [transport], store: createMemoryStore(), tipAccount, log: () => {} });
      await node.start();
      const receipt = new Promise((resolve) => node.onReceipt(resolve));
      const bundleId = await node.submit(tx, { tipAccount });
      log('info', 'offgrid.submitted', { bundleId });
      const timeout = int(values['timeout-sec'], 120, '--timeout-sec');
      const r = await Promise.race([receipt, new Promise((resolve) => setTimeout(() => resolve(null), timeout * 1000))]);
      await node.stop();
      if (!r) die(`no receipt within ${timeout} seconds; the bundle stays with the mesh peers`);
      out({ bundleId, receipt: r, explorer: r.signature ? `https://solscan.io/tx/${r.signature}` : null });
      break;
    }
    case 'mcp': {
      const { runStdio, createMcpHttpRouter } = await import('../src/compute/mcp.js');
      const { descriptor, baseUrl } = await computeNode(values.node);
      const c = await credit();
      const auto = await autoTopUp(c);
      await c.fund([descriptor.id], { tokensEach: int(values.tokens, 1, '--tokens') });
      await auto.check([descriptor.id]);
      // machines are tied to the account that rented them, so from here on top ups go onto that account
      const watch = setInterval(() => { auto.check([descriptor.id], { fresh: false }).catch(() => {}); }, 15_000);
      watch.unref();
      const payer = payerFor(c, descriptor.id);
      if (values.http) {
        const express = (await import('express')).default;
        const app = express();
        app.use('/mcp', createMcpHttpRouter({ nodeUrl: baseUrl, payer }));
        const port = int(values.http, 0, '--http');
        const server = app.listen(port, '127.0.0.1', () => out({ event: 'mcp.ready', url: `http://127.0.0.1:${server.address().port}/mcp`, node: descriptor.id }));
      } else {
        await runStdio({ nodeUrl: baseUrl, payer });
        log('info', 'mcp.ready', { transport: 'stdio', node: descriptor.id });
      }
      break;
    }
    default:
      die(`unknown command ${command}`, 2);
  }
} catch (err) {
  die(err && err.message ? err.message : err);
}
if (command !== 'proxy' && command !== 'mcp') process.exit(exitCode);
