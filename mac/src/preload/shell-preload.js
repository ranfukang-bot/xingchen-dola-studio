'use strict';
/** 外壳界面可用的受限 API。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dola', {
  // 账号
  listAccounts: () => ipcRenderer.invoke('acct:list'),
  groups: () => ipcRenderer.invoke('acct:groups'),
  createAccount: (opts) => ipcRenderer.invoke('acct:create', opts),
  updateAccount: (code, patch) => ipcRenderer.invoke('acct:update', { code, patch }),
  removeAccount: (code) => ipcRenderer.invoke('acct:remove', code),
  clearAllAccounts: () => ipcRenderer.invoke('acct:clearAll'),
  addGroup: (name) => ipcRenderer.invoke('acct:addGroup', name),
  renameGroup: (id, name) => ipcRenderer.invoke('acct:renameGroup', { id, name }),
  removeGroup: (id) => ipcRenderer.invoke('acct:removeGroup', id),
  partitionOf: (code) => ipcRenderer.invoke('acct:partition', code),

  // Cookie
  importCookie: (code, text, kind) => ipcRenderer.invoke('cookie:import', { code, text, kind }),
  bulkImportCookie: (text, kind, groupId) => ipcRenderer.invoke('cookie:bulkImport', { text, kind, groupId }),
  exportCookie: (code, kind) => ipcRenderer.invoke('cookie:export', { code, kind }),
  clearCookie: (code) => ipcRenderer.invoke('cookie:clear', code),

  // 标签绑定
  bindTab: (webContentsId, code) => ipcRenderer.invoke('tab:bind', { webContentsId, code }),

  // 时长
  setDuration: (webContentsId, seconds) => ipcRenderer.invoke('duration:set', { webContentsId, seconds }),

  // 下载 / 作品库
  download: (opts) => ipcRenderer.invoke('dl:download', opts),
  library: () => ipcRenderer.invoke('dl:library'),
  revealLibrary: () => ipcRenderer.invoke('dl:reveal'),
  libraryRoot: () => ipcRenderer.invoke('dl:root'),
  openPath: (p) => ipcRenderer.invoke('dl:open', p),
  showItem: (p) => ipcRenderer.invoke('dl:showItem', p),

  // 杂项
  paths: () => ipcRenderer.invoke('app:paths'),
  version: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  onAccountsChanged: (fn) => {
    const h = () => fn();
    ipcRenderer.on('shell:accounts-changed', h);
    return () => ipcRenderer.removeListener('shell:accounts-changed', h);
  }
});
