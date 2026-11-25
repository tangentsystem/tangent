// MCP server so an AI agent can rent and drive a machine by itself.
// It is a client of a node's compute HTTP API (client.js) and keeps every machine
// it rents paid through an injected payer: { identityFor(nodeId) -> Identity, balance() }.
// Transports: stdio (runStdio) and streamable HTTP (createMcpHttpRouter).
import { randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createComputeClient, createAutopay } from './client.js';

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const NOT_SEALED = 'warning: this node uses the development driver; the browser runs on the node host and is NOT sealed';
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `error: ${e.body?.error ? e.message : e.message || String(e)}` }] });

// One MCP session = one agent: its own rented machines and its own current machine.
export function createComputeMcpServer({ nodeUrl, payer, fetch, prepaySeconds = 30, autopayIntervalMs = 2000, log = () => {} }) {
  if (!payer || typeof payer.identityFor !== 'function' || typeof payer.balance !== 'function') throw new Error('mcp: payer { identityFor, balance } required');
  const client = createComputeClient({ baseUrl: nodeUrl, fetch });
  const rented = new Map(); // machineId -> { machine, autopay }
  let current = null;
  let nodeInfo = null;

  const server = new McpServer({ name: 'tangent', title: 'Tangent Systems agent computers', version: '0.1.0' });

  function pick(machineId) {
    const id = machineId || current;
    if (!id) throw new Error('no computer rented yet: call rent_computer first');
    const r = rented.get(id);
    if (!r) throw new Error('unknown machine_id');
    return r.machine;
  }
  const tool = (name, description, shape, fn) => server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try { return await fn(args || {}); } catch (e) { return fail(e); }
  });
  const mid = { machine_id: z.string().optional().describe('machine to use; defaults to the last rented one') };

  tool('rent_computer', 'Rent a Tangent Systems computer (shell, files, headless browser, Solana wallet, inbox). Billed per second; this server keeps it paid.', {
    image: z.string().optional().describe('image name from the node, e.g. alpine, node, python'),
    size: z.enum(['small', 'medium', 'large']).optional(),
  }, async ({ image, size }) => {
    nodeInfo = nodeInfo || await client.info();
    const identity = payer.identityFor(nodeInfo.node);
    const machine = await client.rent({ payer: identity.id, image, size });
    const autopay = createAutopay({ machine, nodeId: nodeInfo.node, payer, prepaySeconds, intervalMs: autopayIntervalMs, log });
    await autopay.payNow();
    autopay.start();
    rented.set(machine.machineId, { machine, autopay });
    current = machine.machineId;
    const r = machine.rent;
    return text({
      machine_id: r.machineId, image: r.image, size: r.size, sealed: r.sealed,
      price_lamports_per_second: r.priceLamportsPerSecond, wallet: r.wallet,
      inbox_url: new URL(r.inboxUrl, client.baseUrl).toString(), expires_at: new Date(r.expiresAt).toISOString(),
    });
  });

  tool('exec', 'Run a shell command on the computer. Returns exit code, stdout and stderr.', {
    command: z.string().min(1), timeout_ms: z.number().int().positive().max(15 * 60_000).optional(), stdin: z.string().optional(), ...mid,
  }, async ({ command, timeout_ms, stdin, machine_id }) => {
    const r = await pick(machine_id).exec(command, { timeoutMs: timeout_ms, stdin });
    return text({ exit_code: r.exitCode, timed_out: r.timedOut, stdout: r.stdout, stderr: r.stderr, truncated: r.stdoutTruncated || r.stderrTruncated });
  });

  tool('write_file', 'Write a file on the computer (relative paths are inside /work).', {
    path: z.string().min(1), content: z.string(), encoding: z.enum(['utf8', 'base64']).optional(), ...mid,
  }, async ({ path, content, encoding, machine_id }) => {
    const r = await pick(machine_id).writeFile(path, Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8'));
    return text(r);
  });

  tool('read_file', 'Read a file from the computer.', {
    path: z.string().min(1), encoding: z.enum(['utf8', 'base64']).optional(), ...mid,
  }, async ({ path, encoding, machine_id }) => {
    const b = await pick(machine_id).readFile(path);
    return text(encoding === 'base64' ? b.toString('base64') : b.toString('utf8'));
  });

  tool('browser_open', 'Open a URL in the computer\'s headless browser. On sealed nodes the browser runs inside the computer and needs an image with a browser (the default "browser" image).', { url: z.string().min(1), ...mid },
    async ({ url, machine_id }) => text(await pick(machine_id).browserOpen(url)));
  tool('browser_read', 'Read the visible text of the current page.', { ...mid },
    async ({ machine_id }) => { const r = await pick(machine_id).browserText(); return text(`${r.sealed === false ? NOT_SEALED + '\n' : ''}${r.title}\n${r.url}\n\n${r.text}`); });
  tool('browser_click', 'Click an element by CSS selector.', { selector: z.string().min(1), ...mid },
    async ({ selector, machine_id }) => text(await pick(machine_id).browserClick(selector)));
  tool('browser_type', 'Type text into an input by CSS selector, optionally pressing Enter.', { selector: z.string().min(1), text: z.string(), submit: z.boolean().optional(), ...mid },
    async ({ selector, text: t, submit, machine_id }) => text(await pick(machine_id).browserType(selector, t, submit)));
  tool('browser_screenshot', 'Take a PNG screenshot of the current page.', { full_page: z.boolean().optional(), ...mid },
    async ({ full_page, machine_id }) => {
      const m = pick(machine_id);
      const png = await m.browserScreenshot({ fullPage: full_page });
      const content = [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
      if (m.rent && m.rent.sealed === false) content.push({ type: 'text', text: NOT_SEALED });
      return { content };
    });

  tool('wallet_address', 'The Solana address of the computer\'s own wallet.', { ...mid },
    async ({ machine_id }) => text(await pick(machine_id).wallet()));
  tool('wallet_sign_message', 'Sign a UTF-8 message with the computer\'s wallet (ed25519, base58 signature).', { message: z.string(), ...mid },
    async ({ message, machine_id }) => text(await pick(machine_id).signMessage(message)));
  tool('wallet_sign_transaction', 'Sign a serialized Solana transaction (base64) with the computer\'s wallet.', { transaction_base64: z.string().min(1), ...mid },
    async ({ transaction_base64, machine_id }) => text(await pick(machine_id).signTransaction(transaction_base64)));

  tool('inbox_read', 'Read messages others sent to this computer\'s public inbox.', { after: z.number().int().min(0).optional(), ...mid },
    async ({ after, machine_id }) => text(await pick(machine_id).inbox({ after })));

  tool('stop_computer', 'Stop and destroy the computer. Its files are gone afterwards. The node keeps the computer wallet\'s key for 30 days after it stops, so it can be recovered with recover_wallet_key, then deletes it.', { ...mid },
    async ({ machine_id }) => {
      const m = pick(machine_id);
      const r = rented.get(m.machineId);
      r.autopay.stop();
      const fin = await m.stop();
      rented.delete(m.machineId);
      if (current === m.machineId) current = [...rented.keys()].pop() || null;
      return text(fin);
    });

  tool('recover_wallet_key', 'Get back the secret key of a computer\'s Solana wallet, also after the computer stopped. The node keeps it for 30 days after the computer ends, then deletes it. Proves you rented it by signing with the same payer identity. Returns the base58 64 byte Solana secret key.', {
    machine_id: z.string().regex(/^m_[0-9a-f]{24}$/).describe('the machine whose wallet key to recover'),
  }, async ({ machine_id }) => {
    nodeInfo = nodeInfo || await client.info();
    const identity = payer.identityFor(nodeInfo.node);
    if (!identity) throw new Error('no payer identity for this node, so no computer was rented there by this payer');
    const r = await client.recoverWallet({ machineId: machine_id, identity });
    return text({ machine_id: r.machineId, address: r.address, explorer: r.explorer, secret_key: r.secretKey, secret_key_format: r.secretKeyFormat, key_kept_until: r.keyKeptUntil ? new Date(r.keyKeptUntil).toISOString() : null, note: r.note });
  });

  tool('balance', 'Credit left to pay for computers, and what each rented computer has used.', {}, async () => {
    const bal = await payer.balance();
    const machines = [];
    for (const [id, r] of rented) {
      try { const s = await r.machine.status(); machines.push({ machine_id: id, state: s.state, usage: s.usage }); } catch (e) { machines.push({ machine_id: id, state: e.status === 410 ? 'stopped' : 'unknown' }); }
    }
    return text({ balance_lamports: String(bal && bal.lamports !== undefined ? bal.lamports : bal), machines });
  });

  return {
    server,
    rented: () => [...rented.keys()],
    async close() {
      for (const r of rented.values()) { r.autopay.stop(); await r.machine.stop().catch(() => {}); }
      rented.clear();
      await server.close().catch(() => {});
    },
  };
}

export async function runStdio(opts) {
  const s = createComputeMcpServer(opts);
  await s.server.connect(new StdioServerTransport());
  return s;
}

// Streamable HTTP: mount the returned router (e.g. at /mcp). One MCP server per session.
export function createMcpHttpRouter(opts) {
  const sessions = new Map();
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/', express.json({ limit: '4mb' }), async (req, res) => {
    const sid = req.get('mcp-session-id');
    let entry = sid ? sessions.get(sid) : null;
    if (!entry) {
      if (sid || !isInitializeRequest(req.body)) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'no valid session' }, id: null });
      const mcp = createComputeMcpServer(opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, entry); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); mcp.close(); };
      entry = { mcp, transport };
      await mcp.server.connect(transport);
    }
    await entry.transport.handleRequest(req, res, req.body);
  });
  const bySession = async (req, res) => {
    const entry = sessions.get(req.get('mcp-session-id') || '');
    if (!entry) return res.status(400).json({ error: 'no valid session' });
    await entry.transport.handleRequest(req, res);
  };
  router.get('/', bySession);
  router.delete('/', bySession);
  router.closeAll = async () => { for (const e of sessions.values()) { await e.mcp.close(); await e.transport.close().catch(() => {}); } sessions.clear(); };
  return router;
}
