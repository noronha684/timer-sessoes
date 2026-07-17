// Ponte mínima exposta ao site: só o toggle do modo flutuante da casca.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('timerDesktop', {
  toggleFloat: () => ipcRenderer.send('float-action', 'toggle'),
});
