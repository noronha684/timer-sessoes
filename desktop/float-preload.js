// Ponte da janelinha flutuante: manda ações pro main e recebe o estado do timer.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('timerFloat', {
  action: (a) => ipcRenderer.send('float-action', String(a)),
  onState: (cb) => ipcRenderer.on('float-state', (_e, s) => cb(s)),
});
