'use strict';
/**
 * 注入到 dola.com / 豆包 / 千问 / 小云雀 页面的预加载脚本。
 *
 * 负责四件事：
 *   1. 应用该账号的指纹（UA / WebGL / 屏幕 / canvas 噪声）—— 必须早于页面脚本；
 *   2. 装上 window.chrome.webview 垫片，让原版 dola-native-bridge.js 原样可用；
 *   3. 注入 15/30 秒时长 hook（原版 dola-15s-dom-request-hook.js，零改动）；
 *   4. 注入扩展的内容脚本，并与 service worker 宿主互通消息。
 *
 * 这里刻意用 contextIsolation:false 让脚本直接落在页面世界 ——
 * 因为 hook 需要改写页面的 fetch/XHR 和 localStorage，隔离世界做不到。
 * 作用域限定在 Dola 相关站点（见 main/index.js 的导航拦截）。
 */
const fs = require('fs');
const path = require('path');
const { ipcRenderer, webFrame } = require('electron');

const VENDOR = path.join(__dirname, '..', '..', 'vendor');

function readScript(rel) {
  try {
    return fs.readFileSync(path.join(VENDOR, rel), 'utf8');
  } catch (err) {
    console.error('[dola] 读取脚本失败', rel, err.message);
    return '';
  }
}

/**
 * 在页面主世界执行脚本。
 *
 * 用 webFrame.executeJavaScript 而不是插 <script> 标签：后者会被站点的
 * CSP（script-src 无 unsafe-inline）直接拦掉，而 webFrame 是渲染进程的
 * 特权接口，不受页面 CSP 约束 —— 对应原版 WebView2 的
 * AddScriptToExecuteOnDocumentCreatedAsync。
 */
const injected = new Set();
function runInPage(code, label, once) {
  if (!code) return;
  if (once) {
    if (injected.has(label)) return;
    injected.add(label);
  }
  try {
    webFrame.executeJavaScript(code, false);
  } catch (err) {
    // 退路：极少数情况下 webFrame 不可用时再试标签注入
    try {
      const el = document.createElement('script');
      el.textContent = code;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
    } catch (err2) {
      console.error('[dola] 注入失败', label, err.message, err2.message);
    }
  }
}

/* ============ 1. 指纹 ============ */
function applyFingerprint(fp) {
  if (!fp) return;
  const code = '(' + function (fp) {
    const def = (obj, key, value) => {
      try { Object.defineProperty(obj, key, { get: () => value, configurable: true }); } catch (_) {}
    };

    def(navigator, 'platform', fp.platform);
    def(navigator, 'hardwareConcurrency', fp.hardwareConcurrency);
    def(navigator, 'deviceMemory', fp.deviceMemory);
    def(navigator, 'languages', Object.freeze(fp.languages.slice()));
    def(navigator, 'maxTouchPoints', 0);

    if (navigator.userAgentData) {
      def(navigator, 'userAgentData', {
        brands: fp.uaBrands,
        mobile: false,
        platform: fp.uaPlatform,
        getHighEntropyValues: () => Promise.resolve({
          architecture: 'arm', bitness: '64', model: '',
          platform: fp.uaPlatform, platformVersion: '15.0.0',
          uaFullVersion: fp.uaBrands[0].version + '.0.0.0',
          brands: fp.uaBrands, fullVersionList: fp.uaBrands, mobile: false
        }),
        toJSON: () => ({ brands: fp.uaBrands, mobile: false, platform: fp.uaPlatform })
      });
    }

    for (const [k, v] of Object.entries(fp.screen)) def(screen, k, v);
    def(screen, 'availWidth', fp.screen.width);
    def(screen, 'colorDepth', 24);
    def(screen, 'pixelDepth', 24);

    // WebGL：UNMASKED_VENDOR_WEBGL(37445) / UNMASKED_RENDERER_WEBGL(37446)
    for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Ctx) continue;
      const orig = Ctx.prototype.getParameter;
      Ctx.prototype.getParameter = function (p) {
        if (p === 37445) return fp.webglVendor;
        if (p === 37446) return fp.webglRenderer;
        if (p === 7936) return 'WebKit';                 // VENDOR
        if (p === 7937) return 'WebKit WebGL';           // RENDERER
        return orig.call(this, p);
      };
    }

    // canvas 噪声：同账号恒定，跨账号不同
    const noise = (seed) => {
      let s = seed >>> 0;
      return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s >>> 24) % 3 - 1; };
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width && this.height) {
          const img = ctx.getImageData(0, 0, this.width, this.height);
          const rnd = noise(fp.canvasSeed);
          for (let i = 0; i < img.data.length; i += 4 * 977) {
            img.data[i] = Math.max(0, Math.min(255, img.data[i] + rnd()));
          }
          ctx.putImageData(img, 0, 0);
        }
      } catch (_) {}
      return origToDataURL.apply(this, a);
    };
  }.toString() + ')(' + JSON.stringify(fp) + ');';
  runInPage(code, 'fingerprint');
}

/* ============ 2. chrome.webview 垫片 ============ */
function installWebViewShim() {
  const code = '(' + function () {
    const listeners = { message: [] };
    const queue = [];
    window.__dolaNativeDispatch = (data) => {
      const ev = { data };
      listeners.message.forEach((f) => { try { f(ev); } catch (e) { console.error(e); } });
    };
    window.chrome = window.chrome || {};
    window.chrome.webview = {
      postMessage(payload) {
        // 由 preload 轮询这个队列转发到主进程
        queue.push(payload);
        window.dispatchEvent(new CustomEvent('__dola_native_post'));
      },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        if (!listeners[type]) return;
        const i = listeners[type].indexOf(fn);
        if (i >= 0) listeners[type].splice(i, 1);
      },
      __drain() { return queue.splice(0, queue.length); }
    };
  }.toString() + ')();';
  runInPage(code, 'webview-shim');

  window.addEventListener('__dola_native_post', () => {
    try {
      const items = window.chrome && window.chrome.webview && window.chrome.webview.__drain
        ? window.chrome.webview.__drain() : [];
      for (const payload of items) ipcRenderer.send('page:native-message', payload);
    } catch (err) {
      console.error('[dola] 转发 native 消息失败', err.message);
    }
  });

  // 主进程 -> 页面
  ipcRenderer.on('native:to-page', (_e, data) => {
    try { window.__dolaNativeDispatch && window.__dolaNativeDispatch(data); } catch (_) {}
  });
  ipcRenderer.on('native:download-progress', (_e, rec) => {
    try {
      window.__dolaNativeDispatch && window.__dolaNativeDispatch({
        type: 'DOLA_NATIVE_DOWNLOAD_PROGRESS',
        requestId: String(rec.id),
        state: rec.state,
        progress: rec.total ? rec.received / rec.total : 0
      });
    } catch (_) {}
  });
}

/* ============ 3 & 4. 业务脚本与内容脚本 ============ */
function injectForUrl(href) {
  const host = (() => { try { return new URL(href).hostname; } catch (_) { return ''; } })();
  const is = (d) => host === d || host.endsWith('.' + d);

  // 这些脚本会打全局补丁（fetch / XHR / DOM 观察器），同一个 document 里
  // 只能装一次，否则 SPA 换路由时会被重复 patch。真正跳转时 preload 重跑，
  // injected 集合随之重置，不影响新页面。
  // 15/30 秒时长 hook —— 原版脚本，零改动
  if (is('dola.com') || is('doubao.com')) {
    runInPage(readScript('scripts/dola-15s-dom-request-hook.js'), '15s-hook', true);
    runInPage(readScript('scripts/astra-media-capture.js'), 'astra-capture', true);
    runInPage(readScript('scripts/dola-native-bridge.js'), 'native-bridge', true);
  }

  // 扩展内容脚本
  const ext = 'extensions/dola_nowatermark/';
  if (is('dola.com') || is('doubao.com') || is('qianwen.com') || is('xyq.jianying.com')) {
    runInPage(readScript(ext + 'content-panel.js'), 'content-panel', true);
    runInPage(readScript(ext + 'xingchen-plugin-icon.js'), 'plugin-icon', true);
  }
  if (is('qianwen.com')) runInPage(readScript(ext + 'qianwen-content.js'), 'qianwen', true);
  if (is('xyq.jianying.com')) runInPage(readScript(ext + 'xyq-content.js'), 'xyq', true);
}

/** 内容脚本用的 chrome.runtime 垫片（只需消息收发） */
function installContentRuntimeShim() {
  const code = '(' + function () {
    const fns = [];
    window.chrome = window.chrome || {};
    const q = [];
    window.chrome.runtime = Object.assign(window.chrome.runtime || {}, {
      id: 'dola-nowatermark-mac',
      getURL: (p) => 'dola-ext://' + String(p || '').replace(/^\//, ''),
      sendMessage(msg, cb) {
        q.push(msg);
        window.dispatchEvent(new CustomEvent('__dola_ext_post'));
        if (typeof cb === 'function') setTimeout(() => cb(undefined), 0);
      },
      onMessage: {
        addListener: (f) => fns.push(f),
        removeListener: (f) => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); }
      },
      __drain: () => q.splice(0, q.length)
    });
    window.__dolaExtDispatch = (msg) => {
      fns.forEach((f) => { try { f(msg, { id: 'dola-nowatermark-mac' }, () => {}); } catch (e) { console.error(e); } });
    };
  }.toString() + ')();';
  runInPage(code, 'content-runtime-shim');

  window.addEventListener('__dola_ext_post', () => {
    try {
      const items = window.chrome.runtime.__drain();
      for (const m of items) ipcRenderer.send('ext:from-content', m);
    } catch (_) {}
  });
  ipcRenderer.on('ext:to-content', (_e, msg) => {
    try { window.__dolaExtDispatch && window.__dolaExtDispatch(msg); } catch (_) {}
  });
}

/* ============ 启动 ============ */
(function boot() {
  // 同步取配置：指纹必须赶在页面任何脚本之前落位
  let cfg = {};
  try { cfg = ipcRenderer.sendSync('page:config-sync') || {}; } catch (_) {}

  applyFingerprint(cfg.fingerprint);
  installWebViewShim();
  installContentRuntimeShim();

  const run = () => injectForUrl(location.href);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
  // 单页应用路由切换后补注入
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) { last = location.href; injectForUrl(last); }
  }, 1500);
})();
