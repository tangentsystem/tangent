import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProcessDriver } from './drivers/process.js';
import { createMcpHttpRouter } from './mcp.js';
import { startNode, startPage, fakePayer } from './test-helpers.js';

const rootDir = path.join(os.tmpdir(), 'tangent-compute-mtest-' + process.pid);
const parse = (r) => JSON.parse(r.content[0].text);
const TOOLS = ['rent_computer', 'exec', 'write_file', 'read_file', 'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_screenshot', 'wallet_address', 'wallet_sign_message', 'inbox_read', 'stop_computer', 'balance'];

test('MCP over streamable HTTP: an agent rents and drives a machine', { timeout: 120_000 }, async (t) => {
  const node = await startNode({ driver: createProcessDriver({ dev: true, rootDir }), tickMs: 100, creditLimitSeconds: 1 });
  const page = await startPage('<html><head><title>Agent Page</title></head><body><input id="q"><button id="b" onclick="document.body.append(\'got \'+document.getElementById(\'q\').value)">b</button></body></html>');
  const app = express();
  const mcpRouter = createMcpHttpRouter({ nodeUrl: node.url, payer: fakePayer(), autopayIntervalMs: 200 });
  app.use('/mcp', mcpRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.address().port}/mcp`)));
  t.after(async () => { await client.close(); await mcpRouter.closeAll(); srv.closeAllConnections(); srv.close(); await node.close(); await page.close(); });

  const names = (await client.listTools()).tools.map((x) => x.name);
  for (const n of TOOLS) assert.ok(names.includes(n), n);

  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const rent = parse(await call('rent_computer', {}));
  assert.match(rent.machine_id, /^m_/);
  assert.equal(rent.price_lamports_per_second, '1000');

  const ex = parse(await call('exec', { command: 'echo agent-$((40+2)); exit 5' }));
  assert.equal(ex.stdout, 'agent-42\n'); assert.equal(ex.exit_code, 5);
  await call('write_file', { path: 'notes.txt', content: 'remember this' });
  assert.equal((await call('read_file', { path: 'notes.txt' })).content[0].text, 'remember this');
  await call('write_file', { path: 'b.bin', content: Buffer.from([0, 255, 1, 254]).toString('base64'), encoding: 'base64' });
  assert.equal((await call('read_file', { path: 'b.bin', encoding: 'base64' })).content[0].text, Buffer.from([0, 255, 1, 254]).toString('base64'));

  const opened = parse(await call('browser_open', { url: page.url }));
  assert.equal(opened.title, 'Agent Page');
  assert.equal(opened.sealed, false);
  assert.match(opened.warning, /NOT sealed/);
  await call('browser_type', { selector: '#q', text: 'tokens' });
  await call('browser_click', { selector: '#b' });
  assert.match((await call('browser_read')).content[0].text, /got tokens/);
  assert.match((await call('browser_read')).content[0].text, /^warning: .*NOT sealed/);
  const shot = await call('browser_screenshot');
  assert.equal(shot.content[0].type, 'image');
  assert.match(shot.content[1].text, /NOT sealed/, 'process driver: screenshot is labelled not sealed');
  assert.equal(Buffer.from(shot.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');

  const w = parse(await call('wallet_address'));
  const sig = parse(await call('wallet_sign_message', { message: 'hi' }));
  assert.ok(ed25519.verify(bs58.decode(sig.signature), new TextEncoder().encode('hi'), bs58.decode(w.address)));

  await fetch(new URL(`inbox/${rent.machine_id}`, node.url), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'job for you' });
  assert.equal(parse(await call('inbox_read')).messages[0].body, 'job for you');

  // credit limit is 1 s, autopay keeps it running well past that
  await new Promise((r) => setTimeout(r, 2500));
  const bal = parse(await call('balance'));
  assert.equal(bal.balance_lamports, '10000000000');
  assert.equal(bal.machines[0].state, 'running');
  assert.ok(BigInt(bal.machines[0].usage.paidLamports) >= BigInt(bal.machines[0].usage.owedLamports));
  assert.ok(node.accepted.length >= 1);
  assert.equal(parse(await call('exec', { command: 'echo still' })).stdout, 'still\n');

  const fin = parse(await call('stop_computer'));
  assert.equal(fin.state, 'stopped');
  const err = await call('exec', { command: 'id' });
  assert.equal(err.isError, true);
});

test('MCP over stdio: rent, exec, stop', { timeout: 60_000 }, async (t) => {
  const node = await startNode({ driver: createProcessDriver({ dev: true, rootDir }) });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const script = fileURLToPath(new URL('./test-fixtures/mcp-stdio.js', import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, node.url], stderr: 'inherit' }));
  t.after(async () => { await client.close(); await node.close(); });
  const rent = parse(await client.callTool({ name: 'rent_computer', arguments: {} }));
  const r = parse(await client.callTool({ name: 'exec', arguments: { command: 'printf stdio-ok' } }));
  assert.equal(r.stdout, 'stdio-ok');
  assert.equal(node.compute.machines()[0].machineId, rent.machine_id);
  assert.equal(parse(await client.callTool({ name: 'stop_computer', arguments: {} })).state, 'stopped');
});
