// JS client for the compute HTTP API, plus an autopay helper that keeps a machine
// paid with cumulative vouchers. Used by the MCP server and by integration.
import { signVoucher } from '../core/voucher.js';

export class ComputeError extends Error {
  constructor(status, body) {
    super((body && (body.reason ? `${body.error}: ${body.reason}` : body.error)) || `HTTP ${status}`);
    this.status = status; this.body = body;
  }
}

async function readError(r) {
  let body = null;
  try { body = await r.json(); } catch { body = { error: `HTTP ${r.status}` }; }
  return new ComputeError(r.status, body);
}

export function createComputeClient({ baseUrl, fetch: f = globalThis.fetch }) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const url = (p) => new URL(p.replace(/^\//, ''), base);

  async function call(method, path, { token, json, body, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await f(url(path), { method, headers: h, body });
    if (!r.ok) throw await readError(r);
    if (raw) return Buffer.from(await r.arrayBuffer());
    return r.json();
  }

  function machine(machineId, token, rent = null) {
    const p = (s) => `machines/${machineId}${s}`;
    const q = (path) => `?path=${encodeURIComponent(path)}`;
    return {
      machineId, token, rent,
      status: () => call('GET', p(''), { token }),
      stop: () => call('DELETE', p(''), { token }),
      sendVoucher: (voucher) => call('POST', p('/voucher'), { json: voucher }),
      exec: (cmd, { timeoutMs, stdin, stdinBase64 } = {}) => call('POST', p('/exec'), { token, json: { cmd, timeoutMs, stdin, stdinBase64 } }),
      // streams output as it arrives; onStdout/onStderr get Buffers
      async execStream(cmd, { timeoutMs, stdin, onStdout = () => {}, onStderr = () => {}, signal } = {}) {
        const r = await f(url(p('/exec')), {
          method: 'POST', signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ cmd, timeoutMs, stdin, stream: true }),
        });
        if (!r.ok) throw await readError(r);
        const dec = new TextDecoder(); let buf = ''; let exit = null; let bytes = 0;
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            let event = 'message'; let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            const d = data ? JSON.parse(data) : {};
            if (event === 'stdout' || event === 'stderr') {
              const b = Buffer.from(d.b64, 'base64'); bytes += b.length;
              (event === 'stdout' ? onStdout : onStderr)(b);
            } else if (event === 'exit') exit = d;
          }
        }
        if (!exit) throw new ComputeError(0, { error: 'stream ended without exit status' });
        return { ...exit, bytes };
      },
      writeFile: (path, data) => call('PUT', p('/files' + q(path)), { token, body: Buffer.from(data), headers: { 'content-type': 'application/octet-stream' } }),
      readFile: (path) => call('GET', p('/files' + q(path)), { token, raw: true }),
      browserOpen: (u) => call('POST', p('/browser/open'), { token, json: { url: u } }),
      browserText: () => call('GET', p('/browser/text'), { token }),
      browserClick: (selector) => call('POST', p('/browser/click'), { token, json: { selector } }),
      browserType: (selector, text, submit) => call('POST', p('/browser/type'), { token, json: { selector, text, submit } }),
      browserScreenshot: ({ fullPage } = {}) => call('GET', p('/browser/screenshot' + (fullPage ? '?fullPage=1' : '')), { token, raw: true }),
      wallet: () => call('GET', p('/wallet'), { token }),
      signMessage: (message) => call('POST', p('/wallet/sign-message'), { token, json: Buffer.isBuffer(message) || message instanceof Uint8Array ? { messageBase64: Buffer.from(message).toString('base64') } : { message } }),
      signTransaction: (txBase64) => call('POST', p('/wallet/sign-transaction'), { token, json: { transaction: txBase64 } }),
      inbox: ({ after, limit } = {}) => call('GET', p(`/inbox?${new URLSearchParams({ ...(after !== undefined ? { after } : {}), ...(limit ? { limit } : {}) })}`), { token }),
    };
  }

  return {
    baseUrl: base,
    info: () => call('GET', 'info'),
    async rent({ payer, image, size }) {
      const r = await call('POST', 'machines', { json: { payer, image, size } });
      return machine(r.machineId, r.token, r);
    },
    machine,
    // Get a rented machine's wallet key back from the node (kept 30 days after the machine ends).
    // identity: the payer identity that rented the machine. -> { address, secretKey (base58, 64 bytes), ... }
    async recoverWallet({ machineId, identity }) {
      if (!identity || typeof identity.signObject !== 'function') throw new Error('recoverWallet: the payer identity that rented the machine is required');
      const { challenge } = await call('POST', 'wallet-recovery/challenge', { json: { machineId } });
      return call('POST', 'wallet-recovery', { json: { challenge, signature: identity.signObject(challenge) } });
    },
    postInbox(machineId, message) {
      const isText = typeof message === 'string';
      return call('POST', `inbox/${machineId}`, { body: isText ? message : JSON.stringify(message), headers: { 'content-type': isText ? 'text/plain' : 'application/json' } });
    },
  };
}

// Keeps a machine paid ahead by prepaySeconds of its price using cumulative vouchers
// from payer.identityFor(nodeId). Never signs more than payer.balance() allows.
export function createAutopay({ machine, nodeId, payer, prepaySeconds = 30, intervalMs = 2000, voucherTtlMs = 3600_000, log = () => {} }) {
  const identity = payer.identityFor(nodeId);
  let last = null; let timer = null; let stopped = false; let busy = null;
  async function payNow() {
    if (busy) return busy;
    busy = (async () => {
      const st = await machine.status();
      const price = BigInt(st.priceLamportsPerSecond);
      const owed = BigInt(st.usage.owedLamports);
      const paid = last ? BigInt(last.cumulative) : 0n;
      let target = owed + price * BigInt(prepaySeconds);
      if (paid - owed >= (price * BigInt(prepaySeconds)) / 2n) return { paid: paid.toString(), skipped: true };
      const bal = await payer.balance();
      const available = BigInt(bal && bal.lamports !== undefined ? bal.lamports : bal);
      if (target - paid > available) target = paid + available;
      if (target <= paid) return { paid: paid.toString(), skipped: true, reason: 'insufficient balance' };
      const v = signVoucher(identity, { session: machine.machineId, node: nodeId, kind: 'compute', cumulative: target, seq: last ? last.seq + 1 : 1, expires: Date.now() + voucherTtlMs });
      const r = await machine.sendVoucher(v);
      last = v;
      return { paid: v.cumulative, state: r.state };
    })().finally(() => { busy = null; });
    return busy;
  }
  return {
    identity,
    payNow,
    last: () => last,
    start() {
      stopped = false;
      const loop = async () => {
        if (stopped) return;
        try { await payNow(); } catch (e) { if (e.status === 410 || e.status === 404) { stopped = true; return; } log('autopay.error', { error: e.message }); }
        if (!stopped) { timer = setTimeout(loop, intervalMs); timer.unref?.(); }
      };
      loop();
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
