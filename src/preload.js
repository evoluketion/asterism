'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = channel => cb => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('asterism', {
  platform: process.platform,
  init: () => ipcRenderer.invoke('app:init'),
  createPane: opts => ipcRenderer.invoke('pane:create', opts),
  write: (id, data) => ipcRenderer.send('pane:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pane:resize', id, cols, rows),
  kill: id => ipcRenderer.send('pane:kill', id),
  rename: (id, name) => ipcRenderer.send('pane:rename', id, name),
  relaunchClaude: id => ipcRenderer.invoke('pane:claude', id),
  setOrder: ids => ipcRenderer.send('layout:order', ids),
  setWaiting: (count, title) => ipcRenderer.send('app:waiting', count, title),
  notify: (paneId, title, body) => ipcRenderer.send('app:notify', paneId, title, body),
  pickDir: start => ipcRenderer.invoke('dialog:dir', start),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  saveProject: p => ipcRenderer.invoke('project:save', p),
  deleteProject: id => ipcRenderer.invoke('project:delete', id),
  saveSession: (ws, projectId) => ipcRenderer.send('session:save', ws, projectId),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: text => ipcRenderer.send('clipboard:write', text),
  openExternal: url => ipcRenderer.send('open:external', url),
  openDir: id => ipcRenderer.send('open:dir', id),
  screenReply: (reqId, text) => ipcRenderer.send('screen:reply', reqId, text),
  onData: on('pane:data'),
  onStatus: on('pane:status'),
  onExit: on('pane:exit'),
  onScreenRequest: on('screen:request'),
  onFocusPane: on('pane:focus'),
});
