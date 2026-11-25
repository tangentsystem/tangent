// Which downloads exist right now.
//
// The app and the browser extension are published as files on the public repo's releases.
// The site offers a download only while that file is really there, and never before: each
// file is checked with a HEAD request to its "latest" address, which GitHub answers with a
// redirect to the versioned file when it exists and with 404 when it does not.
//
// A file once seen stays offered until GitHub says plainly that it is gone (404). Anything
// else (a timeout, a rate limit, an error) changes nothing.

export const RELEASE_REPO = 'tangentsystem/tangent';
export const ASSETS = Object.freeze({
  windows: 'Tangent-Setup.exe',
  linux: 'Tangent.AppImage',
  extension: 'tangent-chrome-extension.zip',
});

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createReleases({
  repo = RELEASE_REPO,
  assets = ASSETS,
  fetchFn = globalThis.fetch,
  refreshMs = 10 * 60_000,
  retryMs = 60_000,
  timeoutMs = 8000,
  log = () => {},
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('releases: bad repo');
  const base = `https://github.com/${repo}/releases`;
  const found = Object.fromEntries(Object.keys(assets).map((k) => [k, null])); // key -> { url, version } | null
  let timer = null;
  let stopped = false;
  let running = null;
  let checkedOnce = false;

  // { url, version } when the file is there, null when GitHub says it is not, undefined when unknown
  async function probe(name) {
    const url = `${base}/latest/download/${name}`;
    let r;
    try {
      r = await fetchFn(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'tangent-site' } });
    } catch { return undefined; }
    if (r.status === 404) return null;
    if (r.status >= 300 && r.status < 400) {
      const loc = String(r.headers.get('location') || '');
      const m = new RegExp(`^${reEsc(base)}/download/([^/?#]+)/${reEsc(name)}$`).exec(loc);
      if (!m) return undefined;
      let tag;
      try { tag = decodeURIComponent(m[1]); } catch { return undefined; }
      const version = /^v?[0-9]+(\.[0-9]+){1,3}([-.][0-9A-Za-z.]+)?$/.test(tag) ? tag.replace(/^v/, '') : null;
      return { url, version };
    }
    return undefined;
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      let unknown = 0;
      await Promise.all(Object.entries(assets).map(async ([key, name]) => {
        const got = await probe(name);
        if (got === undefined) { unknown += 1; return; }
        const before = found[key];
        found[key] = got;
        if (!!before !== !!got || (before && got && before.version !== got.version)) log('releases.changed', { file: name, available: !!got, version: got ? got.version : null });
      }));
      checkedOnce = true;
      return unknown === 0;
    })().finally(() => { running = null; });
    return running;
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimeout(async () => {
      let ok = false;
      try { ok = await refresh(); } catch { ok = false; }
      schedule(ok ? refreshMs : retryMs);
    }, ms);
    timer.unref?.();
  }

  return {
    assets,
    repo,
    // What can be offered right now. `app` is true when at least one desktop build exists.
    current() {
      const out = {};
      for (const key of Object.keys(assets)) out[key] = found[key] ? found[key].url : null;
      const first = found.windows || found.linux || null;
      out.version = first ? first.version : null;
      out.app = !!(found.windows || found.linux);
      return out;
    },
    checked: () => checkedOnce,
    refresh,
    start() { stopped = false; if (!timer) schedule(0); return this; },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
