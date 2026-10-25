const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('host', {
  frameConsumed:sequence=>ipcRenderer.send('link:frame-consumed',sequence),
  captureFallback:reason=>ipcRenderer.invoke('link:capture-fallback',reason),
  glasses: command => ipcRenderer.invoke('link:glasses',command),
  state: () => ipcRenderer.invoke('link:state'),
  permissions: () => ipcRenderer.invoke('link:permissions'),
  settings: kind => ipcRenderer.invoke('link:settings',kind),
  sources: () => ipcRenderer.invoke('link:sources'),
  select: id => ipcRenderer.invoke('link:select', id),
  rotate: () => ipcRenderer.invoke('link:rotate'),
  signal: (id, message) => ipcRenderer.invoke('link:signal', id, message),
  inputSession: (id, token) => ipcRenderer.invoke('link:input-session',id,token),
  input: (id, event) => ipcRenderer.invoke('link:input', id, event),
  report: report => ipcRenderer.send('link:report', report),
  onEvent: fn => { const listener = (_event, value) => fn(value); ipcRenderer.on('link:event', listener); return () => ipcRenderer.removeListener('link:event', listener); }
});
