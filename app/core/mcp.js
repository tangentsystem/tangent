// "Connect your AI agent": the repo's MCP server (src/compute/mcp.js) over streamable HTTP on
// 127.0.0.1, as `client.js mcp --http` runs it, paid from this app's wallet.
import http from 'node:http';
import express from 'express';
import { createMcpHttpRouter } from '../../src/compute/mcp.js';
import { payerFor, createAutoTopUp, AUTO_TOP_UP_DEFAULT_LIMIT } from '../../src/node/credit.js';
import { computeBaseUrl } from './computers.js';

export function mcpConfigSnippet(url) {
  return JSON.stringify({ mcpServers: { tangent: { type: 'http', url } } }, null, 2);
}

export function createMcp({ coord, wallet, dataDir, port = 47613, log = () => {}, emit = () => {}, topUpLimitLamports = AUTO_TOP_UP_DEFAULT_LIMIT }) {
  let server = null;
  let router = null;
  let state = null; // { url, node, port }
  let watch = null;
  let auto = null;

  async function start({ node = null } = {}) {
    if (state) return { ...state };
    const dir = await coord.directory({ role: 'compute' });
    const d = node ? dir.find((x) => x.id === node) : dir[0];
    if (!d || !computeBaseUrl(d)) throw Object.assign(new Error('No node is renting computers right now.'), { code: 'NO_NODE' });
    const credit = await wallet.credit();
    const bal = await wallet.balance().catch(() => null);
    if (!credit.has(d.id) && bal && bal.canPay) await credit.fund([d.id], { tokensEach: 1 }).catch((err) => log('warn', 'mcp.fund_failed', { reason: err.message }));
    const view = { has: (n) => credit.has(n), balanceOf: (n) => credit.balanceOf(n), topUp: (...a) => credit.topUp(...a), tokenLamports: () => credit.tokenLamports(), onShort() {} };
    auto = await createAutoTopUp({ credit: view, dir: dataDir, limitLamports: topUpLimitLamports, tokens: 1, fresh: false, log });
    watch = setInterval(() => { auto.check([d.id], { fresh: false }).catch(() => {}); }, 15_000);
    watch.unref?.();
    const base = payerFor(credit, d.id);
    const payer = {
      identityFor(id) {
        const x = base.identityFor(id);
        if (!x) throw new Error('add balance in the Tangent app to rent a computer');
        return x;
      },
      balance: () => base.balance(),
    };
    router = createMcpHttpRouter({ nodeUrl: computeBaseUrl(d), payer });
    const app = express();
    app.disable('x-powered-by');
    // local only: a web page must not reach it (DNS rebinding, cross origin posts)
    app.use((req, res, next) => {
      const host = String(req.headers.host || '').toLowerCase();
      const p = server && server.address() ? server.address().port : port;
      if (host !== `127.0.0.1:${p}` && host !== `localhost:${p}`) return res.status(403).json({ error: 'forbidden_host' });
      if (req.headers.origin !== undefined) return res.status(403).json({ error: 'forbidden_origin' });
      next();
    });
    app.use('/mcp', router);
    server = http.createServer(app);
    const listen = (p) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
    });
    let bound;
    try { bound = await listen(port); } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      server = http.createServer(app);
      bound = await listen(0);
    }
    const url = `http://127.0.0.1:${bound}/mcp`;
    state = { url, node: d.id, port: bound, snippet: mcpConfigSnippet(url) };
    log('info', 'mcp.ready', { port: bound, node: d.id });
    emit('mcp', { ...state });
    return { ...state };
  }

  async function stop() {
    if (watch) { clearInterval(watch); watch = null; }
    if (auto) { auto.stop(); auto = null; }
    if (router) { await router.closeAll().catch(() => {}); router = null; }
    if (server) { const s = server; server = null; await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); }); }
    state = null;
    emit('mcp', null);
    return null;
  }

  return { start, stop, status: () => (state ? { ...state } : null) };
}
