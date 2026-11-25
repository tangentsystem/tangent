// Test only: a Solana JSON-RPC endpoint on 127.0.0.1 backed by LiteSVM, so separate
// processes (the gateway node, the coordinator) can use a real @solana/web3.js
// Connection against one shared local chain. Implements the methods the gateway and
// the coordinator's claim check call: sendTransaction, getSignatureStatuses,
// getAccountInfo, getTransaction (json and base64), getBalance, getLatestBlockhash,
// getSlot, getBlockHeight, getMinimumBalanceForRentExemption, getVersion, getHealth.
// Error strings copy what a real RPC node returns. litesvm is a dev dependency.
import http from 'node:http';
import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js';
import { createLiteSvmConnection } from '../../../src/offgrid/test-support/litesvm-connection.js';

export async function startSvmRpc(svm) {
  const conn = createLiteSvmConnection(svm);
  const txs = new Map(); // signature -> { raw, slot, pre, post, keys, fee }
  const calls = {};

  const balance = (k) => Number(svm.getBalance(k) ?? 0n);

  async function sendTransaction([encoded, cfg = {}]) {
    const raw = Buffer.from(encoded, (cfg && cfg.encoding) === 'base58' ? undefined : 'base64');
    const bytes = (cfg && cfg.encoding) === 'base58' ? Buffer.from(bs58.decode(encoded)) : raw;
    const vt = VersionedTransaction.deserialize(bytes);
    const keys = vt.message.staticAccountKeys.map((k) => k.toBase58());
    const pre = keys.map(balance);
    const sig = await conn.sendRawTransaction(bytes); // throws with the RPC's message on failure
    const post = keys.map(balance);
    const slot = conn.statuses.get(sig).slot;
    txs.set(sig, { raw: bytes, slot, pre, post, keys, vt, fee: Math.max(0, pre[0] - post[0] - outflow(vt, keys, pre, post)) });
    return sig;
  }
  // lamports the fee payer moved to others (so the fee can be told apart); good enough for tests
  function outflow(_vt, _keys, pre, post) {
    let gained = 0;
    for (let i = 1; i < pre.length; i++) if (post[i] > pre[i]) gained += post[i] - pre[i];
    return gained;
  }

  function txJson(sig, enc) {
    const t = txs.get(sig);
    if (!t) return null;
    const meta = {
      err: null, status: { Ok: null }, fee: 5000 * t.vt.message.header.numRequiredSignatures,
      preBalances: t.pre, postBalances: t.post, innerInstructions: [], logMessages: [],
      preTokenBalances: [], postTokenBalances: [], rewards: [], loadedAddresses: { writable: [], readonly: [] }, computeUnitsConsumed: 0,
    };
    const base = { slot: t.slot, blockTime: Math.floor(Date.now() / 1000), version: t.vt.version === 'legacy' ? 'legacy' : 0, meta };
    if (enc === 'base64') return { ...base, transaction: [Buffer.from(t.raw).toString('base64'), 'base64'] };
    const m = t.vt.message;
    const message = {
      accountKeys: t.keys,
      header: m.header,
      recentBlockhash: m.recentBlockhash,
      instructions: m.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: bs58.encode(Buffer.from(ix.data)), stackHeight: null })),
      ...(t.vt.version === 'legacy' ? {} : { addressTableLookups: [] }),
    };
    return { ...base, transaction: { signatures: t.vt.signatures.map((s) => bs58.encode(s)), message } };
  }

  const methods = {
    sendTransaction,
    async getSignatureStatuses([sigs]) { return conn.getSignatureStatuses(sigs); },
    async getAccountInfo([pubkey, cfg = {}]) {
      const a = svm.getAccount(pubkey);
      const ctx = { slot: Number(svm.getClock().slot) };
      if (!a || !a.exists) return { context: ctx, value: null };
      const data = Buffer.from(a.data);
      return {
        context: ctx,
        value: {
          data: cfg.encoding === 'base58' ? bs58.encode(data) : [data.toString('base64'), 'base64'],
          executable: a.executable, lamports: Number(a.lamports), owner: String(a.programAddress), rentEpoch: 0, space: data.length,
        },
      };
    },
    async getTransaction([sig, cfg = {}]) { return txJson(sig, cfg.encoding); },
    async getBalance([pubkey]) { return { context: { slot: Number(svm.getClock().slot) }, value: balance(pubkey) }; },
    async getLatestBlockhash() { return { context: { slot: Number(svm.getClock().slot) }, value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number(svm.getClock().slot) + 150 } }; },
    async getSlot() { return Number(svm.getClock().slot); },
    async getBlockHeight() { return Number(svm.getClock().slot); },
    async getMinimumBalanceForRentExemption([len]) { return Number(svm.minimumBalanceForRentExemption(BigInt(len))); },
    async getVersion() { return { 'solana-core': 'litesvm', 'feature-set': 0 }; },
    async getHealth() { return 'ok'; },
  };

  async function handle(req) {
    calls[req.method] = (calls[req.method] || 0) + 1;
    const fn = methods[req.method];
    if (!fn) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
    try {
      return { jsonrpc: '2.0', id: req.id, result: await fn(req.params || []) };
    } catch (err) {
      const msg = String((err && err.message) || err).replace(/^failed to send transaction: /, '');
      return { jsonrpc: '2.0', id: req.id, error: { code: -32002, message: msg, data: { logs: [] } } };
    }
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, svm, txs, calls,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}
