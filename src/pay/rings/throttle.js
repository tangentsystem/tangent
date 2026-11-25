// One shared pace for every call to the Solana RPC, so the service stays inside the Helius plan's rate limit.
// Plain requests: at most config.rpcMaxRps per second (default 5).
// sendTransaction: at most config.rpcMaxSendPerSec per second (default 1). A 429 answer is retried here with
// growing waits, so callers never see it.

const states = new Map();

function bucketFor(key, perSec) {
  let s = states.get(key);
  if (!s || s.perSec !== perSec) {
    s = { perSec, next: 0, chain: Promise.resolve() };
    states.set(key, s);
  }
  return s;
}

function take(key, perSec) {
  const s = bucketFor(key, perSec);
  const gap = 1000 / perSec;
  const p = s.chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, s.next - now);
    s.next = Math.max(now, s.next) + gap;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  });
  s.chain = p.catch(() => {});
  return p;
}

function isSend(init) {
  try {
    const body = typeof init?.body === 'string' ? init.body : '';
    return body.includes('"sendTransaction"');
  } catch {
    return false;
  }
}

export function makeThrottledFetch(config = {}, baseFetch = globalThis.fetch) {
  const rps = Number(config.rpcMaxRps) > 0 ? Number(config.rpcMaxRps) : 5;
  const sendRps = Number(config.rpcMaxSendPerSec) > 0 ? Number(config.rpcMaxSendPerSec) : 1;
  return async function throttledFetch(input, init) {
    let delay = 600;
    for (let attempt = 0; ; attempt++) {
      if (isSend(init)) await take('send', sendRps);
      await take('rpc', rps);
      const res = await baseFetch(input, init);
      if (res.status !== 429 || attempt >= 8) return res;
      const ra = Number(res.headers?.get?.('retry-after'));
      await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : delay));
      delay = Math.min(delay * 2, 15000);
    }
  };
}
