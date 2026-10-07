'use strict';
/**
 * chrome.debugger -> Electron webContents.debugger 桥接。
 *
 * 这是无水印功能能不能活下来的关键。
 *
 * 扩展 service-worker.js 靠 chrome.debugger 附加到页面、开 Network 域、
 * 在 responseReceived 时用 Network.getResponseBody 把无水印原始地址捞出来。
 * 这是 Chrome DevTools Protocol。
 *
 * macOS 上 WKWebView 完全没有 CDP，所以原生套壳方案在这里必死；
 * 而 Electron 的 webContents.debugger 就是同一套 CDP，方法名、参数、事件
 * 全部一致 —— 可以做到 1:1 转发，混淆过的扩展代码无需改动。
 */
const { webContents } = require('electron');

/** tabId(=webContents.id) -> {wc, version, onMessage} */
const attached = new Map();

/** 事件回调：由 extension-host 注入，用于推送给 service worker。 */
let emitEvent = () => {};

function setEmitter(fn) {
  emitEvent = typeof fn === 'function' ? fn : () => {};
}

function resolve(target) {
  const id = target && (target.tabId != null ? target.tabId : target.targetId);
  if (id == null) throw new Error('debugger: 缺少 tabId');
  const wc = webContents.fromId(Number(id));
  if (!wc || wc.isDestroyed()) throw new Error('debugger: 目标标签不存在 (' + id + ')');
  return { id: Number(id), wc };
}

function attach(target, version) {
  const { id, wc } = resolve(target);
  if (attached.has(id)) return { already: true };

  if (!wc.debugger.isAttached()) {
    wc.debugger.attach(version || '1.3');
  }

  const onMessage = (_event, method, params) => {
    // 还原成 chrome.debugger.onEvent 的签名： (source, method, params)
    emitEvent({ tabId: id }, method, params);
  };
  wc.debugger.on('message', onMessage);

  const onDetach = (_event, reason) => {
    cleanup(id);
    emitEvent({ tabId: id }, '__detached__', { reason });
  };
  wc.debugger.once('detach', onDetach);

  attached.set(id, { wc, onMessage, onDetach, version: version || '1.3' });
  return { ok: true };
}

function cleanup(id) {
  const rec = attached.get(id);
  if (!rec) return;
  try { rec.wc.debugger.removeListener('message', rec.onMessage); } catch (_) {}
  attached.delete(id);
}

function detach(target) {
  const { id, wc } = resolve(target);
  cleanup(id);
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  } catch (_) { /* 已断开 */ }
  return { ok: true };
}

async function sendCommand(target, method, params) {
  const { id, wc } = resolve(target);
  if (!wc.debugger.isAttached()) {
    // 扩展有时在 attach 回调前就发命令，这里兜一次
    wc.debugger.attach((attached.get(id) || {}).version || '1.3');
  }
  return await wc.debugger.sendCommand(method, params || {});
}

function getTargets() {
  return webContents.getAllWebContents()
    .filter((wc) => !wc.isDestroyed() && wc.getType() !== 'remote')
    .map((wc) => ({
      id: String(wc.id),
      tabId: wc.id,
      type: wc.getType() === 'webview' ? 'page' : wc.getType(),
      title: safeTitle(wc),
      url: safeUrl(wc),
      attached: wc.debugger.isAttached()
    }));
}

function safeTitle(wc) { try { return wc.getTitle(); } catch (_) { return ''; } }
function safeUrl(wc) { try { return wc.getURL(); } catch (_) { return ''; } }

function detachAll() {
  for (const id of Array.from(attached.keys())) {
    try { detach({ tabId: id }); } catch (_) {}
  }
}

module.exports = { attach, detach, sendCommand, getTargets, setEmitter, detachAll };
