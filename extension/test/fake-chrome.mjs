// A small fake of the chrome.* APIs the controller uses, with Chrome's layered setting model:
// our setting wins unless another extension or policy has taken the setting.

function setting(initial) {
  const s = {
    base: initial,   // what the browser uses with no extension setting
    ours: undefined, // what we set
    other: null,     // 'controlled_by_other_extensions' | 'not_controllable' | null
    sets: 0,
    clears: 0,
    async get() {
      if (s.other) return { levelOfControl: s.other, value: { mode: 'pac_script' } };
      if (s.ours !== undefined) return { levelOfControl: 'controlled_by_this_extension', value: s.ours };
      return { levelOfControl: 'controllable_by_this_extension', value: s.base };
    },
    async set({ value }) {
      if (s.other) throw new Error('not controllable');
      s.ours = structuredClone(value);
      s.sets++;
    },
    async clear() { s.ours = undefined; s.clears++; },
    effective() { return s.other ? 'other' : s.ours !== undefined ? s.ours : s.base; },
    onChange: { addListener() {} },
  };
  return s;
}

export function fakeChrome() {
  const store = {};
  const icons = [];
  const proxy = setting({ mode: 'system' });
  const webrtc = setting('default');
  return {
    store, icons,
    proxySetting: proxy,
    webrtcSetting: webrtc,
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        async set(patch) { for (const [k, v] of Object.entries(patch)) store[k] = structuredClone(v); },
        async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
      },
    },
    proxy: { settings: proxy, onProxyError: { addListener() {} } },
    privacy: { network: { webRTCIPHandlingPolicy: webrtc } },
    action: {
      async setIcon({ path }) { icons.push(path[16].includes('/on-') ? 'on' : 'off'); },
      async setTitle() {},
    },
  };
}
