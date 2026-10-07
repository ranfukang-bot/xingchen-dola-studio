'use strict';
/**
 * service worker 侧的 chrome.* 兼容层。
 *
 * 扩展代码是混淆过的，调用点看不出来，所以这里按 manifest 声明的权限
 * （debugger / tabs / downloads）把相关命名空间做全，宁可多实现。
 * 任何未覆盖的属性访问都会打日志，便于在 Mac 上一眼定位缺口。
 */
const { ipcRenderer } = require('electron');

const DEBUG = !!process.env.DOLA_DEBUG;
function log(...a) { if (DEBUG) console.log('[chrome-shim]', ...a); }
function warn(...a) { console.warn('[chrome-shim] 未实现:', ...a); }

/* ---------- 事件对象 ---------- */
function Event(name) {
  const fns = new Set();
  return {
    addListener: (f) => { if (typeof f === 'function') fns.add(f); },
    removeListener: (f) => fns.delete(f),
    hasListener: (f) => fns.has(f),
    hasListeners: () => fns.size > 0,
    _emit(...args) {
      for (const f of Array.from(fns)) {
        try { f(...args); } catch (err) { console.error('[chrome-shim] ' + name + ' 回调异常', err); }
      }
    }
  };
}

/** 同时支持 callback 与 Promise 两种调用风格（MV3 两种都有人用）。 */
function dual(promise, cb) {
  if (typeof cb === 'function') {
    promise.then(
      (v) => { chrome.runtime.lastError = undefined; cb(v); },
      (e) => { chrome.runtime.lastError = { message: e.message }; try { cb(undefined); } finally { chrome.runtime.lastError = undefined; } }
    );
    return undefined;
  }
  return promise;
}

/* ---------- chrome.debugger ---------- */
const dbg = {
  onEvent: Event('debugger.onEvent'),
  onDetach: Event('debugger.onDetach'),
  attach(target, version, cb) {
    return dual(ipcRenderer.invoke('cdp:attach', { target, version }), cb);
  },
  detach(target, cb) {
    return dual(ipcRenderer.invoke('cdp:detach', { target }), cb);
  },
  sendCommand(target, method, params, cb) {
    if (typeof params === 'function') { cb = params; params = {}; }
    return dual(ipcRenderer.invoke('cdp:send', { target, method, params }), cb);
  },
  getTargets(cb) {
    return dual(ipcRenderer.invoke('cdp:targets'), cb);
  }
};

ipcRenderer.on('cdp:event', (_e, { source, method, params }) => {
  if (method === '__detached__') dbg.onDetach._emit(source, (params && params.reason) || 'target_closed');
  else dbg.onEvent._emit(source, method, params);
});

/* ---------- chrome.downloads ---------- */
const dl = {
  onChanged: Event('downloads.onChanged'),
  onCreated: Event('downloads.onCreated'),
  onDeterminingFilename: Event('downloads.onDeterminingFilename'),
  download(opts, cb) {
    return dual(ipcRenderer.invoke('downloads:download', opts), cb);
  },
  search(q, cb) {
    return dual(ipcRenderer.invoke('downloads:search', q || {}), cb);
  },
  cancel(id, cb) { return dual(Promise.resolve(), cb); },
  erase(q, cb) { return dual(Promise.resolve([]), cb); },
  show() {},
  showDefaultFolder() {}
};

ipcRenderer.on('downloads:changed', (_e, rec) => {
  // 转成 chrome.downloads.onChanged 的 delta 形状
  dl.onChanged._emit({
    id: rec.id,
    state: { current: rec.state },
    bytesReceived: { current: rec.received },
    totalBytes: { current: rec.total },
    filename: rec.filename ? { current: rec.filename } : undefined,
    error: rec.error ? { current: rec.error } : undefined
  });
});

/* ---------- chrome.tabs ---------- */
const tabs = {
  onUpdated: Event('tabs.onUpdated'),
  onRemoved: Event('tabs.onRemoved'),
  onActivated: Event('tabs.onActivated'),
  onCreated: Event('tabs.onCreated'),
  query(q, cb) { return dual(ipcRenderer.invoke('tabs:query', q || {}), cb); },
  get(id, cb) { return dual(ipcRenderer.invoke('tabs:get', id), cb); },
  sendMessage(tabId, message, opts, cb) {
    if (typeof opts === 'function') { cb = opts; }
    return dual(ipcRenderer.invoke('tabs:sendMessage', { tabId, message }), cb);
  },
  create(props, cb) { return dual(Promise.resolve({ id: -1, url: props && props.url }), cb); },
  update(id, props, cb) { return dual(Promise.resolve(null), cb); },
  remove(id, cb) { return dual(Promise.resolve(), cb); }
};

/* ---------- chrome.runtime ---------- */
let manifestCache = { name: 'dola_nowatermark', version: '2.0.0' };
ipcRenderer.invoke('ext:manifest').then((m) => { manifestCache = m || manifestCache; }).catch(() => {});

const runtime = {
  id: 'dola-nowatermark-mac',
  lastError: undefined,
  onMessage: Event('runtime.onMessage'),
  onMessageExternal: Event('runtime.onMessageExternal'),
  onInstalled: Event('runtime.onInstalled'),
  onStartup: Event('runtime.onStartup'),
  onConnect: Event('runtime.onConnect'),
  onSuspend: Event('runtime.onSuspend'),
  getManifest: () => manifestCache,
  getURL: (p) => 'dola-ext://' + String(p || '').replace(/^\//, ''),
  sendMessage(...args) {
    // 兼容 (message) / (message, cb) / (extId, message, cb)
    let message = args[0];
    let cb = args.find((a) => typeof a === 'function');
    if (typeof args[0] === 'string' && args.length > 1 && typeof args[1] === 'object') message = args[1];
    ipcRenderer.send('ext:broadcast', message);
    return dual(Promise.resolve(undefined), cb);
  },
  connect() {
    return { postMessage() {}, disconnect() {}, onMessage: Event('port.onMessage'), onDisconnect: Event('port.onDisconnect') };
  }
};

ipcRenderer.on('runtime:message', (_e, { message, sender }) => {
  runtime.onMessage._emit(message, sender, function sendResponse(resp) {
    if (resp !== undefined) ipcRenderer.send('ext:broadcast', { __response: true, to: sender, payload: resp });
  });
});

/* ---------- chrome.storage ---------- */
function area(prefix) {
  const key = (k) => prefix + ':' + k;
  const readAll = () => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix + ':')) {
        try { out[k.slice(prefix.length + 1)] = JSON.parse(localStorage.getItem(k)); } catch (_) {}
      }
    }
    return out;
  };
  return {
    get(keys, cb) {
      const all = readAll();
      let res;
      if (keys == null) res = all;
      else if (typeof keys === 'string') res = { [keys]: all[keys] };
      else if (Array.isArray(keys)) { res = {}; keys.forEach((k) => { res[k] = all[k]; }); }
      else { res = {}; Object.keys(keys).forEach((k) => { res[k] = all[k] !== undefined ? all[k] : keys[k]; }); }
      return dual(Promise.resolve(res), cb);
    },
    set(obj, cb) {
      const changes = {};
      Object.entries(obj || {}).forEach(([k, v]) => {
        let oldValue;
        try { oldValue = JSON.parse(localStorage.getItem(key(k))); } catch (_) {}
        localStorage.setItem(key(k), JSON.stringify(v));
        changes[k] = { oldValue, newValue: v };
      });
      storage.onChanged._emit(changes, prefix);
      return dual(Promise.resolve(), cb);
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => localStorage.removeItem(key(k)));
      return dual(Promise.resolve(), cb);
    },
    clear(cb) {
      Object.keys(localStorage).filter((k) => k.startsWith(prefix + ':')).forEach((k) => localStorage.removeItem(k));
      return dual(Promise.resolve(), cb);
    },
    getBytesInUse(_k, cb) { return dual(Promise.resolve(0), cb); }
  };
}

const storage = {
  local: area('local'),
  session: area('session'),
  sync: area('sync'),
  managed: area('managed'),
  onChanged: Event('storage.onChanged')
};

/* ---------- chrome.action / 其他 ---------- */
const action = {
  onClicked: Event('action.onClicked'),
  setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {}, setIcon() {},
  setPopup() {}, enable() {}, disable() {}
};

const scripting = {
  executeScript(opts, cb) { warn('scripting.executeScript'); return dual(Promise.resolve([]), cb); },
  insertCSS(opts, cb) { return dual(Promise.resolve(), cb); }
};

/* ---------- 组装 ---------- */
const base = {
  debugger: dbg,
  downloads: dl,
  tabs,
  runtime,
  storage,
  action,
  scripting,
  i18n: { getMessage: (k) => k, getUILanguage: () => 'zh-CN' },
  permissions: {
    contains: (p, cb) => dual(Promise.resolve(true), cb),
    request: (p, cb) => dual(Promise.resolve(true), cb)
  },
  windows: {
    getCurrent: (o, cb) => dual(Promise.resolve({ id: 1 }), cb),
    onRemoved: Event('windows.onRemoved')
  },
  extension: { getURL: runtime.getURL, isAllowedIncognitoAccess: (cb) => dual(Promise.resolve(false), cb) }
};

// 未实现的命名空间走代理记日志，避免直接 TypeError 让整个 SW 挂掉
const chrome = new Proxy(base, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && !k.startsWith('_') && k !== 'then' && k !== 'toJSON') {
      warn('chrome.' + String(k));
      return new Proxy({}, {
        get: (_t2, k2) => {
          if (k2 === 'addListener' || k2 === 'removeListener') return () => {};
          return (...args) => {
            warn('chrome.' + String(k) + '.' + String(k2), args.length);
            const cb = args.find((a) => typeof a === 'function');
            if (cb) cb(undefined);
            return Promise.resolve(undefined);
          };
        }
      });
    }
    return undefined;
  }
});

window.chrome = chrome;
self.chrome = chrome;
// 部分 MV3 代码会探测 browser.*
window.browser = chrome;

log('chrome.* 兼容层已安装');

// service worker 启动钩子
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    runtime.onInstalled._emit({ reason: 'install' });
    runtime.onStartup._emit();
  }, 0);
});
