// The control API for Tangent for Chrome (app/CONTROL-API.md, v1). Plain node:http so the
// rules stay readable: 127.0.0.1 only, Host check, Origin check, pairing, bearer tokens.
import http from 'node:http';

const VIEWS = new Set(['internet', 'wallet', 'computers', 'network']);
const MAX_BODY = 8 * 1024;

export function createControlApi({ port = 47611, host = '127.0.0.1', version, session, pairing, onOpen = () => {}, log = () => {} }) {
  let server = null;
  let boundPort = port;
  const allowedHosts = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);

  function send(res, status, body, origin) {
    const data = Buffer.from(JSON.stringify(body));
    const h = { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (origin) { h['access-control-allow-origin'] = origin; h.vary = 'Origin'; }
    res.writeHead(status, h);
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); else if (size > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        if (size > MAX_BODY) return reject(Object.assign(new Error('too large'), { status: 413 }));
        if (!size) return resolve({});
        try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts().has(hostHeader)) return send(res, 403, { error: 'forbidden_host' });
    const origin = req.headers.origin;
    let allowOrigin = null;
    if (origin !== undefined) {
      if (!/^(chrome-extension|moz-extension):\/\//.test(origin)) return send(res, 403, { error: 'forbidden_origin' });
      allowOrigin = origin;
    }
    const url = new URL(req.url, `http://${hostHeader}`);
    const p = url.pathname;
    const m = req.method;

    if (m === 'OPTIONS') {
      const h = { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600', 'cache-control': 'no-store', 'content-length': 0 };
      if (allowOrigin) { h['access-control-allow-origin'] = allowOrigin; h.vary = 'Origin'; }
      res.writeHead(204, h);
      return res.end();
    }

    if (p === '/v1/hello') {
      if (m !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, allowOrigin);
      return send(res, 200, { app: 'tangent', version, api: 1 }, allowOrigin);
    }
    if (p === '/v1/pair') {
      if (m !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, allowOrigin);
      const body = await readBody(req);
      const id = pairing.request(typeof body.client === 'string' ? body.client : '');
      if (!id) return send(res, 429, { error: 'busy' }, allowOrigin);
      log('info', 'control.pair_requested', { client: String(body.client || '').slice(0, 60) });
      return send(res, 200, { request: id }, allowOrigin);
    }
    const pm = /^\/v1\/pair\/([A-Za-z0-9_-]{1,64})$/.exec(p);
    if (pm) {
      if (m !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, allowOrigin);
      const r = pairing.read(pm[1]);
      if (!r) return send(res, 404, { error: 'unknown_request' }, allowOrigin);
      return send(res, 200, r, allowOrigin);
    }

    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!pairing.check(token)) return send(res, 401, { error: 'unpaired' }, allowOrigin);

    if (p === '/v1/status') {
      if (m !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, allowOrigin);
      return send(res, 200, session.status(), allowOrigin);
    }
    if (p === '/v1/connect') {
      if (m !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, allowOrigin);
      return send(res, 200, session.connect(), allowOrigin);
    }
    if (p === '/v1/disconnect') {
      if (m !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, allowOrigin);
      return send(res, 200, await session.disconnect(), allowOrigin);
    }
    if (p === '/v1/open') {
      if (m !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, allowOrigin);
      const body = await readBody(req);
      const view = body.view === undefined ? 'internet' : body.view;
      if (!VIEWS.has(view)) return send(res, 400, { error: 'bad_view' }, allowOrigin);
      try { onOpen(view); } catch { /* window may be gone */ }
      return send(res, 200, { ok: true }, allowOrigin);
    }
    return send(res, 404, { error: 'not_found' }, allowOrigin);
  }

  return {
    get port() { return boundPort; },
    start() {
      return new Promise((resolve, reject) => {
        // requireHostHeader off: a request with no Host gets our own 403 below
        server = http.createServer({ requireHostHeader: false }, (req, res) => {
          handle(req, res).catch((err) => {
            if (!res.headersSent) send(res, err.status || 500, { error: err.status === 413 ? 'too_large' : err.status === 400 ? 'bad_json' : 'failed' });
            else res.destroy();
          });
        });
        server.headersTimeout = 10_000;
        server.requestTimeout = 15_000;
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          boundPort = server.address().port;
          log('info', 'control.listening', { port: boundPort });
          resolve(boundPort);
        });
      });
    },
    stop() { return new Promise((r) => { if (!server) return r(); server.close(() => r()); server.closeAllConnections?.(); server = null; }); },
  };
}
