const { contextBridge, ipcRenderer } = require('electron');
const on = (ch, cb) => ipcRenderer.on(ch, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('sop', {
  permissions: () => ipcRenderer.invoke('perm'),
  askPermission: kind => ipcRenderer.invoke('perm:ask', kind),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  version: () => ipcRenderer.invoke('version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateReady: cb => on('update:ready', cb),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  setTheme: t => ipcRenderer.send('theme:set', t),
  updateStatus: () => ipcRenderer.invoke('update:get'),
  onUpdateStatus: cb => on('update:status', cb),
  displays: () => ipcRenderer.invoke('displays'),
  startClicks: opts => ipcRenderer.invoke('rec:start', opts),
  stopClicks: () => ipcRenderer.invoke('rec:stop'),
  count: n => ipcRenderer.send('rec:count', n),
  onClick: cb => on('rec:click', cb),
  onLabel: cb => on('rec:label', cb),
  onStop: cb => on('rec:stop', cb),
  onPause: cb => on('rec:pause', cb),
  // floating panel
  pause: () => ipcRenderer.send('panel:pause'),
  done: () => ipcRenderer.send('panel:done'),
  onPanelState: cb => on('panel:state', cb),
  onClosing: cb => on('app:closing', cb),
  closeNow: () => ipcRenderer.invoke('app:closeNow'),
  // PDFs that carry their own editable copy
  pdf: {
    embed: data => ipcRenderer.invoke('pdf:embed', data),
    extract: bytes => ipcRenderer.invoke('pdf:extract', bytes)
  },
  // Google Drive
  drive: {
    accounts: () => ipcRenderer.invoke('drive:accounts'),
    signIn: () => ipcRenderer.invoke('drive:signIn'),
    switchTo: email => ipcRenderer.invoke('drive:switchTo', email),
    signOut: email => ipcRenderer.invoke('drive:signOut', email),
    list: () => ipcRenderer.invoke('drive:list'),
    save: data => ipcRenderer.invoke('drive:save', data),
    open: id => ipcRenderer.invoke('drive:open', id),
    pdf: pdfId => ipcRenderer.invoke('drive:pdf', pdfId),
    rename: data => ipcRenderer.invoke('drive:rename', data),
    pickTest: () => ipcRenderer.invoke('drive:pickTest')
  }
});
