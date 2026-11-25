// Client for the Tangent app's local control API (see app/CONTROL-API.md).

export const API_BASE = 'http://127.0.0.1:47611';
export const CLIENT_NAME = 'Tangent for Chrome';

export class ApiError extends Error {
  // code: 'unreachable' (app not running), 'unpaired' (401), or the app's short error code.
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function createApi({ fetch: fetchFn = globalThis.fetch, base = API_BASE, timeoutMs = 4000 } = {}) {
  async function call(method, path, { token, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      throw new ApiError('unreachable');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401) throw new ApiError('unpaired', 401);
    if (!res.ok) throw new ApiError((data && typeof data.error === 'string' && data.error) || `http_${res.status}`, res.status);
    return data ?? {};
  }

  return {
    hello: () => call('GET', '/v1/hello'),
    pair: () => call('POST', '/v1/pair', { body: { client: CLIENT_NAME } }),
    pairState: (id) => call('GET', `/v1/pair/${encodeURIComponent(id)}`),
    status: (token) => call('GET', '/v1/status', { token }),
    connect: (token) => call('POST', '/v1/connect', { token, body: {} }),
    disconnect: (token) => call('POST', '/v1/disconnect', { token, body: {} }),
    open: (token, view) => call('POST', '/v1/open', { token, body: { view } }),
  };
}

// The app is ours only if hello says so.
export function isTangentHello(h) {
  return !!h && h.app === 'tangent' && Number(h.api) === 1;
}
