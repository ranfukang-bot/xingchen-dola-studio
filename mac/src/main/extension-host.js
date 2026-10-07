'use strict';
/**
 * 扩展宿主：承载 dola_nowatermark 的 service worker。
 *
 * 为什么不用 Electron 自带的 session.loadExtension：
 *   Electron 只实现了 chrome 扩展 API 的一个子集，chrome.debugger 不在其中，
 *   而本扩展的核心恰恰是 chrome.debugger。所以这里自己托管：
 *   在一个隐藏窗口里把 service-worker.js 当普通脚本跑，并注入由主进程
 *   真实能力（webContents.debugger / net 下载 / webContents 列表）支撑的
 *   chrome.* 兼容层。
 *
 * 好处是扩展那 134KB 混淆代码完全不用改。
 */
const path = require('path');
const fs = require('fs');
const { BrowserWindow, ipcMain, webContents } = require('electron');
const cdp = require('./cdp');
const downloads = require('./downloads');

const EXT_DIR = path.join(__dirname, '..', '..', 'vendor', 'extensions', 'dola_nowatermark');

let host = null;
/** 记录内容脚本所在的 webContents，用于 runtime 消息路由 */
const contentTabs = new Set();

function manifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  } catch (_) {
    return { name: 'dola_nowatermark', version: '2.0.0' };
  }
}

function start() {
  if (host && !host.isDestroyed()) return host;

  host = new BrowserWindow({
    show: !!process.env.DOLA_DEBUG,
    width: 900,
    height: 600,
    title: '扩展宿主（无水印引擎）',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'sw-polyfill.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  host.loadFile(path.join(__dirname, '..', 'renderer', 'sw-host.html'));

  if (process.env.DOLA_DEBUG) host.webContents.openDevTools({ mode: 'detach' });

  host.on('closed', () => { host = null; });

  // CDP 事件 -> service worker
  cdp.setEmitter((source, method, params) => {
    send('cdp:event', { source, method, params });
  });

  // 下载进度 -> service worker + 页面
  downloads.setOnChanged((rec) => {
    send('downloads:changed', rec);
    for (const id of contentTabs) {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) {
        wc.send('native:download-progress', rec);
      }
    }
  });

  return host;
}

function send(channel, payload) {
  if (host && !host.isDestroyed()) {
    host.webContents.send(channel, payload);
  }
}

function registerContentTab(id) { contentTabs.add(id); }
function unregisterContentTab(id) { contentTabs.delete(id); }

function stop() {
  cdp.detachAll();
  if (host && !host.isDestroyed()) host.destroy();
  host = null;
}

/** 主进程侧的 IPC 实现，由 sw-polyfill 调用。 */
function installIpc() {
  ipcMain.handle('ext:manifest', () => manifest());
  ipcMain.handle('ext:dir', () => EXT_DIR);

  // ---- chrome.debugger ----
  ipcMain.handle('cdp:attach', (_e, { target, version }) => cdp.attach(target, version));
  ipcMain.handle('cdp:detach', (_e, { target }) => cdp.detach(target));
  ipcMain.handle('cdp:send', (_e, { target, method, params }) => cdp.sendCommand(target, method, params));
  ipcMain.handle('cdp:targets', () => cdp.getTargets());

  // ---- chrome.downloads ----
  ipcMain.handle('downloads:download', (_e, opts) => downloads.download(opts));
  ipcMain.handle('downloads:search', (_e, q) => downloads.search(q));

  // ---- chrome.tabs ----
  ipcMain.handle('tabs:query', (_e, q) => queryTabs(q));
  ipcMain.handle('tabs:get', (_e, id) => oneTab(id));
  ipcMain.handle('tabs:sendMessage', (_e, { tabId, message }) => {
    const wc = webContents.fromId(Number(tabId));
    if (!wc || wc.isDestroyed()) throw new Error('tabs.sendMessage: 标签不存在');
    wc.send('ext:to-content', message);
    return true;
  });

  // 内容脚本 -> service worker
  ipcMain.on('ext:from-content', (e, message) => {
    registerContentTab(e.sender.id);
    send('runtime:message', { message, sender: { tab: tabInfo(e.sender), id: manifest().name } });
  });

  // service worker -> 所有内容脚本（chrome.runtime.sendMessage 广播）
  ipcMain.on('ext:broadcast', (_e, message) => {
    for (const id of contentTabs) {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) wc.send('ext:to-content', message);
    }
  });
}

function tabInfo(wc) {
  return {
    id: wc.id,
    url: safe(() => wc.getURL(), ''),
    title: safe(() => wc.getTitle(), ''),
    active: true,
    windowId: 1,
    status: safe(() => (wc.isLoading() ? 'loading' : 'complete'), 'complete')
  };
}

function safe(fn, dflt) { try { return fn(); } catch (_) { return dflt; } }

function oneTab(id) {
  const wc = webContents.fromId(Number(id));
  return wc && !wc.isDestroyed() ? tabInfo(wc) : null;
}

function queryTabs(q = {}) {
  const all = webContents.getAllWebContents()
    .filter((wc) => !wc.isDestroyed())
    .filter((wc) => wc.getType() === 'webview' || wc.getType() === 'window')
    .map(tabInfo)
    .filter((t) => t.url && /^https?:/i.test(t.url));

  if (!q || !q.url) return all;
  const pats = Array.isArray(q.url) ? q.url : [q.url];
  return all.filter((t) => pats.some((p) => matchPattern(p, t.url)));
}

/** 简化版 chrome match pattern */
function matchPattern(pattern, url) {
  if (pattern === '<all_urls>') return true;
  const m = /^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, hostPat, pathPat] = m;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (scheme !== '*' && u.protocol !== scheme + ':') return false;
  if (hostPat !== '*') {
    if (hostPat.startsWith('*.')) {
      const base = hostPat.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith('.' + base)) return false;
    } else if (u.hostname !== hostPat) return false;
  }
  const re = new RegExp('^' + pathPat.split('*').map(escapeRe).join('.*') + '$');
  return re.test(u.pathname + u.search);
}

function escapeRe(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { start, stop, installIpc, registerContentTab, unregisterContentTab, send, EXT_DIR };
