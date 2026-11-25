// Rented machine wallet key recovery over the compute HTTP API and MCP, with the node's
// machine wallet vault (src/node/machine-wallets.js) and an injected clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createIdentity } from '../core/index.js';
import { createProcessDriver } from './drivers/process.js';
import { createComputeClient } from './client.js';
import { createMcpHttpRouter } from './mcp.js';
import { startNode, fakePayer } from './test-helpers.js';
import { createMachineWalletVault, MACHINE_WALLET_RETENTION_MS as KEEP } from '../node/machine-wallets.js';

const rootDir = path.join(os.tmpdir(), 'tangent-compute-rtest-' + process.pid);

async function setup(t, extra = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tangent-rnode-'));
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const nodeIdentity = createIdentity();
  const vault = await createMachineWalletVault({ dataDir, identity: nodeIdentity, now });
  const logs = [];
  const node = await startNode({
    driver: createProcessDriver({ dev: true, rootDir }), walletVault: vault,
    walletRecovery: { now, challengeTtlMs: 60_000, ...(extra.walletRecovery || {}) },
    log: (e, d) => logs.push(JSON.stringify({ e, ...(d || {}) })),
  });
  t.after(() => node.close());
  return { node, vault, clock, logs, client: createComputeClient({ baseUrl: node.url }) };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('wallet recovery: the renter gets the key back by signing with the payer; others, stale and replayed challenges are refused', { timeout: 60_000 }, async (t) => {
  const { node, vault, clock, logs, client } = await setup(t, { walletRecovery: { perIp: { limit: 100, windowMs: 60_000 }, perMachine: { limit: 100, windowMs: 60_000 } } });
  const payer = createIdentity();
  const m = await client.rent({ payer: payer.id });
  const address = m.rent.wallet.address;
  assert.match(m.rent.wallet.keyKept, /keeps this wallet's key for 30 days after the machine ends/);

  // right payer, machine still running
  const r1 = await client.recoverWallet({ machineId: m.machineId, identity: payer });
  assert.equal(r1.address, address);
  assert.equal(Keypair.fromSecretKey(bs58.decode(r1.secretKey)).publicKey.toBase58(), address);
  assert.equal(r1.endedAt, null);
  // the key still signs for the live machine (the recovered key is the machine's own)
  const sig = await m.signMessage('hi');
  assert.equal(sig.address, address);

  // wrong payer
  await assert.rejects(client.recoverWallet({ machineId: m.machineId, identity: createIdentity() }), (e) => e.status === 403);

  // replayed challenge: a used challenge is refused even with the right signature
  const { challenge } = await (await post(node.url + 'wallet-recovery/challenge', { machineId: m.machineId })).json();
  const signature = payer.signObject(challenge);
  assert.equal((await post(node.url + 'wallet-recovery', { challenge, signature })).status, 200);
  const replay = await post(node.url + 'wallet-recovery', { challenge, signature });
  assert.equal(replay.status, 401);

  // a challenge with a changed field is refused
  const c2 = (await (await post(node.url + 'wallet-recovery/challenge', { machineId: m.machineId })).json()).challenge;
  const forged = { ...c2, expiresAt: c2.expiresAt + 3600_000 };
  assert.equal((await post(node.url + 'wallet-recovery', { challenge: forged, signature: payer.signObject(forged) })).status, 401);

  // stale challenge
  const c3 = (await (await post(node.url + 'wallet-recovery/challenge', { machineId: m.machineId })).json()).challenge;
  clock.t += 60_001;
  const stale = await post(node.url + 'wallet-recovery', { challenge: c3, signature: payer.signObject(c3) });
  assert.equal(stale.status, 401);
  assert.match((await stale.json()).error, /expired/);

  // the machine ends; the stop answer says how long the key is kept
  const fin = await m.stop();
  assert.equal(fin.wallet.address, address);
  assert.equal(fin.wallet.keyKeptUntil, clock.t + KEEP);

  // after the machine ended, within 30 days: recoverable
  clock.t += KEEP - 1000;
  const r2 = await client.recoverWallet({ machineId: m.machineId, identity: payer });
  assert.equal(r2.secretKey, r1.secretKey);
  assert.equal(r2.keyKeptUntil, fin.wallet.keyKeptUntil);

  // past 30 days: "expired, deleted", before and after the purge has run
  clock.t += 1000;
  const e1 = await post(node.url + 'wallet-recovery/challenge', { machineId: m.machineId });
  assert.equal(e1.status, 410);
  assert.equal((await e1.json()).error, 'expired, deleted');
  assert.deepEqual((await vault.purge()).deleted, [m.machineId]);
  const e2 = await post(node.url + 'wallet-recovery/challenge', { machineId: m.machineId });
  assert.equal(e2.status, 410);
  const body = await e2.json();
  assert.equal(body.error, 'expired, deleted');
  assert.equal(body.address, address);
  await assert.rejects(client.recoverWallet({ machineId: m.machineId, identity: payer }), (e) => e.status === 410);

  // unknown machine
  assert.equal((await post(node.url + 'wallet-recovery/challenge', { machineId: 'm_' + '0'.repeat(24) })).status, 404);

  // key material is never logged
  const all = logs.join('\n');
  assert.ok(!all.includes(r1.secretKey));
  assert.ok(!all.includes(bs58.encode(bs58.decode(r1.secretKey).subarray(0, 32))));
});

test('wallet recovery is rate limited', { timeout: 60_000 }, async (t) => {
  const { node, client } = await setup(t, { walletRecovery: { perIp: { limit: 3, windowMs: 60_000 } } });
  const m = await client.rent({ payer: createIdentity().id });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(node.url + 'wallet-recovery/challenge', { machineId: m.machineId })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  await m.stop();
});

test('MCP recover_wallet_key returns the wallet key of a stopped computer to its renter', { timeout: 60_000 }, async (t) => {
  const { node } = await setup(t);
  const app = express();
  const mcpRouter = createMcpHttpRouter({ nodeUrl: node.url, payer: fakePayer(), autopayIntervalMs: 200 });
  app.use('/mcp', mcpRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const mcp = new Client({ name: 'test-agent', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`)));
  t.after(async () => { await mcp.close(); await mcpRouter.closeAll(); srv.closeAllConnections(); srv.close(); });
  const tools = (await mcp.listTools()).tools;
  const stopTool = tools.find((x) => x.name === 'stop_computer');
  assert.match(stopTool.description, /keeps the computer wallet's key for 30 days/);
  assert.doesNotMatch(stopTool.description, /wallet (is|are) gone/);
  const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
  const rent = await call('rent_computer', {});
  await call('stop_computer', {});
  const rec = await call('recover_wallet_key', { machine_id: rent.machine_id });
  assert.equal(rec.address, rent.wallet.address);
  assert.equal(Keypair.fromSecretKey(bs58.decode(rec.secret_key)).publicKey.toBase58(), rent.wallet.address);
});
