const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  hit: (v) => ipcRenderer.send('pet:hit', !!v),
  dragStart: (p) => ipcRenderer.send('pet:drag-start', p),
  dragMove: (p) => ipcRenderer.send('pet:drag-move', p),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  quit: () => ipcRenderer.send('pet:quit'),
  hide: () => ipcRenderer.send('pet:hide'),
  interactive: (rects) => ipcRenderer.send('pet:interactive', rects),
  menu: () => ipcRenderer.send('pet:menu'),
  usage: () => ipcRenderer.invoke('pet:usage'),
  balance: () => ipcRenderer.invoke('pet:balance'),
  config: () => ipcRenderer.invoke('pet:config'),
  skin: () => ipcRenderer.invoke('pet:skin'),
  skins: () => ipcRenderer.invoke('pet:skins'),
  fit: () => ipcRenderer.invoke('pet:fit'),
  onSkin: (cb) => ipcRenderer.on('pet:skin-changed', (_e, rel) => cb(rel)),
  onFit: (cb) => ipcRenderer.on('pet:fit-changed', (_e, m) => cb(m)),
})
