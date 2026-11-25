// The renderer's only door to the app: named actions and app events. No Node, no Electron.
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set([
  'snapshot', 'status', 'connect', 'disconnect', 'openPrivateWindow', 'walletInfo', 'walletBalance', 'deposit',
  'withdraw', 'withdrawals', 'networkNodes', 'token', 'computerNodes', 'rent', 'exec', 'stopComputer', 'machines',
  'mcpStart', 'mcpStop', 'pairAllow', 'pairDeny', 'appsRemove', 'copy', 'openLink',
]);
const EVENTS = new Set(['status', 'wallet', 'withdrawal', 'pairing', 'apps', 'open', 'computers', 'output', 'mcp']);

contextBridge.exposeInMainWorld('tangent', {
  platform: process.platform,
  async call(name, args) {
    if (!ACTIONS.has(name)) throw new Error('unknown action');
    const r = await ipcRenderer.invoke('core', name, args === undefined ? null : JSON.parse(JSON.stringify(args)));
    if (!r || !r.ok) { const e = new Error((r && r.error) || 'failed'); e.code = r && r.code; throw e; }
    return r.value;
  },
  on(fn) {
    const h = (_e, name, payload) => { if (EVENTS.has(name)) fn(name, payload); };
    ipcRenderer.on('event', h);
    return () => ipcRenderer.removeListener('event', h);
  },
});
