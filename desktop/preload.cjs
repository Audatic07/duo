// The only desktop capabilities the page gets: a native folder picker, "show this folder",
// notifications when the window is in the background, and being told to open a view.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duoDesktop', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('duo:pick-folder'),
  openPath: (p) => ipcRenderer.invoke('duo:open-path', p),
  notify: (o) => ipcRenderer.invoke('duo:notify', o),
  onNavigate: (fn) => ipcRenderer.on('duo:navigate', (_e, route) => fn(route)),
});
