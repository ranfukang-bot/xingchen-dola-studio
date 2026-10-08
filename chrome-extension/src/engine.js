/**
 * 引擎：跑在页面主世界（MAIN world）。
 *
 * 为什么必须在主世界：
 *   - 原版的 30 秒 hook 要改写页面自己的 fetch 请求体；
 *   - 原版的参考图脚本要钩进 Dola 的 webpack 上传管线；
 *   - 给 <input type=file> 塞 File 对象，File 和 input 必须同一个世界。
 * 这些在隔离世界都做不到。
 *
 * 它不碰 chrome.* （主世界没有），只通过 window.postMessage 和面板通信。
 */
(function () {
  'use strict';
  if (window.__XCB_ENGINE__) return;
  window.__XCB_ENGINE__ = true;

  const NS = 'XCB';
  const send = (type, data) => {
    try { window.postMessage({ __xcb: NS, dir: 'evt', type, data }, location.origin); }
    catch (_) { /* 忽略 */ }
  };

  /* ===================== 1. 时长开关 ===================== */
  // 和原版「30 秒」按钮写的是同一组键；原版 hook 会在发请求时据此
  // 把 ability_type:17 节点里的 ability_param.duration 改写掉。
  function setDuration(seconds) {
    const v = Number(seconds) === 15 ? 15 : 30;
    try {
      localStorage.setItem('intl_doubao_enable_' + v + 's_v1', '1');
      localStorage.setItem('intl_doubao_enable_' + (v === 15 ? 30 : 15) + 's_v1', '0');
      window.dispatchEvent(new CustomEvent('wanwan-duration-change', { detail: v }));
      return true;
    } catch (_) { return false; }
  }
  setDuration(30); // 默认先打开，面板随后可改

  /* ===================== 2. 结果判定 ===================== */
  // 文案与原版 ba_curl_submit.py 的 classify() 对齐
  function classify(text) {
    const t = String(text || '');
    if (t.includes('无法生成该视频') && t.includes('视频生成额度') && t.includes('剩余')) {
      return { code: 'QUOTA_CREDITS', msg: '本次配置额度不足' };
    }
    for (const kw of ['今天的生成次数已经达到上限', '明天再来免费生成', '视频生成额度不足']) {
      if (t.includes(kw)) return { code: 'QUOTA_EXHAUSTED', msg: '今天的生成次数已达上限' };
    }
    if ((t.includes('mode_downgrade_reason') && t.includes('user_quota')) || t.includes('今日专家模式使用已达上限')) {
      return { code: 'EXPERT_QUOTA', msg: '今日专家模式已达上限' };
    }
    if (t.includes('游客') || t.includes('请登录') || /log ?in/i.test(t)) {
      return { code: 'LOGIN_REQUIRED', msg: '登录态失效' };
    }
    if (t.includes('频繁') || t.includes('稍后再试') || /try again later/i.test(t)) {
      return { code: 'RATE_LIMITED', msg: '被限流' };
    }
    return null;
  }

  function isCompletionUrl(url) {
    try {
      const u = new URL(url, location.href);
      return /\/chat\/completion\/?$/i.test(u.pathname);
    } catch (_) { return false; }
  }

  function handleCompletionBody(text) {
    if (!text) return;
    if (text.includes('SSE_ACK')) {
      const m = text.match(/conversation_id"\s*:\s*"(\d{10,25})/);
      send('submit', { accepted: true, conversationId: m ? m[1] : '', raw: text.slice(0, 400) });
      return;
    }
    const hit = classify(text);
    if (hit) send('submit', { accepted: false, code: hit.code, msg: hit.msg, raw: text.slice(0, 400) });
  }

  /* ===================== 3. 无水印地址嗅探 ===================== */
  // 依据：原版扩展 content-panel.js 里
  //   json.data.original_media_info.main_url  = 无水印原片
  //   rendition === 'video_gen_watermark_dyn' 是带水印的，'unwatermarked' 才是要的
  const seenMedia = new Set();

  function looksVideo(u) {
    return typeof u === 'string' &&
      (/\/video\/fplay\//i.test(u) || /(\.mp4|\.webm|\.mov|\.m4v)(\?|#|$)/i.test(u) || /mime_type=video/i.test(u));
  }

  function reportMedia(url, tag) {
    if (!looksVideo(url) || seenMedia.has(url)) return;
    seenMedia.add(url);
    send('media', { url, tag: tag || '', page: location.href });
  }

  /**
   * 扫出无水印视频地址。
   * @param mark 继承下来的水印标记：'unknown' | 'wm'(带水印) | 'clean'(无水印)
   *
   * 注意：标记为 'wm' 的节点，它底下的视频地址要整个跳过，不能只当标签用——
   * 因为带水印那条的键名往往就叫 url，光看键名根本认不出来。
   */
  function scanForMedia(node, depth, mark) {
    if (!node || depth > 10) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      for (const x of node) scanForMedia(x, depth + 1, mark);
      return;
    }
    if (typeof node !== 'object') return;

    // 最直接的一条：原片地址，必定无水印
    const direct = node.original_media_info && node.original_media_info.main_url;
    if (typeof direct === 'string') reportMedia(direct, 'original_media_info');

    const rend = node.rendition || node.rendition_type || node.media_rendition;
    let m = mark || 'unknown';
    if (typeof rend === 'string') {
      if (/unwatermark/i.test(rend)) m = 'clean';
      else if (/watermark/i.test(rend)) m = 'wm';
    }

    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if (!looksVideo(v)) continue;
        if (/watermark/i.test(k) && !/unwatermark/i.test(k)) continue; // 键名就写着带水印
        if (m === 'wm') continue;                                      // 所在节点声明了带水印
        reportMedia(v, m === 'clean' ? 'unwatermarked' : k);
      } else {
        scanForMedia(v, depth + 1, m);
      }
    }
  }

  function inspectJson(text) {
    if (!text || text.length > 4 * 1024 * 1024) return;
    try {
      scanForMedia(JSON.parse(text), 0, 'unknown');
    } catch (_) {
      // 不是 JSON（例如 SSE 流），退一步按正则抓
      const hits = text.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
      for (const h of hits) if (looksVideo(h)) reportMedia(h, 'raw');
    }
  }

  /* ===================== 4. 网络钩子 ===================== */
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      return nativeFetch.apply(this, args).then((res) => {
        try {
          const url = res.url || (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('json') || ct.includes('text') || ct.includes('event-stream')) {
            res.clone().text().then((t) => {
              if (isCompletionUrl(url)) handleCompletionBody(t);
              inspectJson(t);
            }).catch(() => {});
          }
        } catch (_) { /* 忽略 */ }
        return res;
      });
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__xcbUrl = u;
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
        if (!(ct.includes('json') || ct.includes('text'))) return;
        const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
        if (!t) return;
        if (isCompletionUrl(this.responseURL || this.__xcbUrl || '')) handleCompletionBody(t);
        inspectJson(t);
      } catch (_) { /* 忽略 */ }
    });
    return xhrSend.apply(this, arguments);
  };

  /* ===================== 5. 传参考图 ===================== */
  // File 对象和 <input type=file> 必须在同一个世界，所以这步只能在这里做。
  function findFileInput() {
    const sels = [
      'input[type=file][accept*="webp"]',
      'input[type=file][accept*="image"]',
      'input[type=file][multiple]',
      'input[type=file]'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function uploadFiles(files) {
    const input = findFileInput();
    if (!input) return { ok: false, msg: '页面上找不到文件输入框' };
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, count: files.length };
    } catch (err) {
      return { ok: false, msg: String(err && err.message || err) };
    }
  }

  /* ===================== 6. 下载（带正确 referer） ===================== */
  // 视频 CDN 会校验来源。在页面里 fetch 天然带着 dola 的 referer 和 cookie，
  // 比用 chrome.downloads 直接拉稳。
  async function downloadVideo(url, filename) {
    const res = await fetch(url, { credentials: 'include', referrer: location.href });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename || ('dola-' + Date.now() + '.mp4');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    return { ok: true, size: blob.size };
  }

  /* ===================== 7. 命令入口 ===================== */
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__xcb !== NS || d.dir !== 'cmd') return;

    const reply = (data) => send('reply:' + d.id, data);

    try {
      switch (d.type) {
        case 'ping':
          reply({ ok: true, ready: true });
          break;
        case 'setDuration':
          reply({ ok: setDuration(d.data && d.data.seconds) });
          break;
        case 'upload':
          reply(uploadFiles((d.data && d.data.files) || []));
          break;
        case 'download':
          reply(await downloadVideo(d.data.url, d.data.filename));
          break;
        case 'collectMedia':
          reply({ ok: true, items: Array.from(seenMedia) });
          break;
        case 'resetMedia':
          seenMedia.clear();
          reply({ ok: true });
          break;
        default:
          reply({ ok: false, msg: '未知命令 ' + d.type });
      }
    } catch (err) {
      reply({ ok: false, msg: String(err && err.message || err) });
    }
  });

  // 调试出口：在 dola 页面的控制台里可以直接调这几个函数验证判断逻辑，
  // 例如 __XCB_DEBUG__.scanForMedia(某段接口返回, 0, false)
  window.__XCB_DEBUG__ = { classify, scanForMedia, looksVideo, inspectJson, seenMedia };

  send('ready', { at: Date.now() });
})();
