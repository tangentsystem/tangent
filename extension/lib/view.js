// Pure decisions: what the popup shows, what happens to the browser's connection setting,
// and which toolbar icon is up. No chrome.* calls in here so the tests can drive it directly.

export const OTHER = new Set(['controlled_by_other_extensions', 'not_controllable']);

// snapshot:
//   app: 'up' | 'down'          is the app answering on 127.0.0.1:47611
//   paired: boolean             do we hold a token the app accepts
//   pairing: null | { id }      a pairing request waiting for the person
//   pairNote: null | 'denied' | 'expired' | 'failed'
//   status: null | status object from /v1/status
//   engaged: boolean            the person turned Tangent on in this browser and has not turned it off
//   turning: boolean            a turn on is in progress
//   control: levelOfControl of chrome.proxy.settings
//   note: null | string         short line from the last failed turn on
export function deriveView(s) {
  const st = s.status || null;
  const connected = !!(st && st.connected && st.socks && st.socks.port);
  const connecting = !!(st && st.connecting);

  if (s.control === 'controlled_by_other_extensions') return { name: 'controlled', by: 'extension', engaged: !!s.engaged };
  if (s.control === 'not_controllable') return { name: 'controlled', by: 'policy', engaged: !!s.engaged };

  if (s.pairing) return { name: 'pairing', engaged: !!s.engaged };

  if (s.engaged) {
    if (s.app !== 'up') return { name: 'paused', reason: 'app', engaged: true };
    if (!s.paired) return { name: 'paused', reason: 'unpaired', engaged: true, pairNote: s.pairNote || null };
    if (st && st.needsBalance) return { name: 'balance', engaged: true, connected };
    if (s.turning || (connecting && !connected)) return { name: 'turning', engaged: true };
    if (connected) return onView(st, s.now);
    return { name: 'paused', reason: 'dropped', engaged: true, note: (st && st.error) || s.note || null };
  }

  if (s.app !== 'up') return { name: 'noapp', engaged: false };
  if (!s.paired) return { name: 'unpaired', engaged: false, pairNote: s.pairNote || null };
  if (s.turning) return { name: 'turning', engaged: false };
  if (st && st.needsBalance) return { name: 'balance', engaged: false, connected };
  return { name: 'off', engaged: false, note: s.note || null };
}

function onView(st, now) {
  const hops = Array.isArray(st.hops) ? st.hops.map((h) => String(h && h.id ? h.id : '')).filter(Boolean) : [];
  const up = Number(st.usage && st.usage.bytesUp) || 0;
  const down = Number(st.usage && st.usage.bytesDown) || 0;
  const since = Number(st.since) || 0;
  return {
    name: 'on',
    engaged: true,
    hops,
    bytes: up + down,
    since: since > 0 ? since : null,
    elapsed: since > 0 && now ? Math.max(0, now - since) : 0,
    port: st.socks.port,
    host: st.socks.host || '127.0.0.1',
  };
}

// What to do with chrome.proxy.settings on a check.
//   { action: 'apply', port }  point (or keep pointing) the browser at this port
//   { action: 'hold' }         kill switch: keep the browser pointed at Tangent so pages fail
//   { action: 'clear' }        a leftover setting of ours while not engaged: remove it
//   { action: 'none' }
export function decideProxy(s) {
  if (OTHER.has(s.control)) return { action: 'none' };
  if (s.turning) return { action: 'none' };
  if (s.engaged) {
    const st = s.status;
    if (s.app === 'up' && s.paired && st && st.connected && st.socks && st.socks.port) {
      return { action: 'apply', port: Number(st.socks.port) };
    }
    return { action: 'hold' };
  }
  if (s.control === 'controlled_by_this_extension') return { action: 'clear' };
  return { action: 'none' };
}

// The toolbar icon is "on" only while this browser really goes through Tangent.
export function iconOn(s) {
  if (OTHER.has(s.control)) return false;
  const st = s.status;
  return !!(s.engaged && s.app === 'up' && s.paired && st && st.connected && st.socks && st.socks.port && !st.needsBalance);
}
