(function () {
  'use strict';
  if (window.__astraMediaCaptureInstalled) return;
  window.__astraMediaCaptureInstalled = true;

  var MAX_TEXT_BYTES = 2 * 1024 * 1024;
  var PANEL_HOST_ID = 'astra-media-capture-host';
  var candidates = [];
  var seen = Object.create(null);
  var currentSource = location.href;
  var scanTimer = 0;

  function normalizeUrl(value) {
    if (typeof value !== 'string') return '';
    value = value.trim();
    if (!value || value.indexOf('blob:') === 0 || value.indexOf('data:') === 0) return '';
    try { return new URL(value, location.href).href; } catch (_) { return ''; }
  }

  function isFplay(url) {
    return /\/video\/fplay\//i.test(url || '');
  }

  function isVideo(url) {
    return isFplay(url) || /(?:\.mp4|\.webm|\.mov|\.m4v)(?:[?#]|$)/i.test(url || '') || /(?:mime_type=video|video_mp4|\/video\/)/i.test(url || '');
  }

  function pageTitle() {
    var heading = document.querySelector('h1,[data-testid*=title],[class*=title]');
    var text = heading && heading.textContent ? heading.textContent.trim() : '';
    return text || (document.title || '').trim() || '当前页面视频';
  }

  function post(type, item) {
    if (!window.chrome || !window.chrome.webview || !window.chrome.webview.postMessage || !item) return;
    window.chrome.webview.postMessage({
      type: type,
      fplayUrl: item.fplayUrl || '',
      directVideoUrl: item.directVideoUrl || '',
      previewUrl: item.previewUrl || '',
      videoInfo: item.videoInfo || null,
      referer: location.href,
      conversationTitle: item.title || pageTitle(),
      key: item.key || item.fplayUrl || item.directVideoUrl || item.previewUrl || ''
    });
  }

  function ensureSource() {
    if (currentSource === location.href) return;
    currentSource = location.href;
    candidates = [];
    seen = Object.create(null);
    render();
  }

  function remember(url, videoInfo, previewUrl) {
    ensureSource();
    url = normalizeUrl(url);
    previewUrl = normalizeUrl(previewUrl);
    if (!url || !isVideo(url)) return null;
    var key = url;
    var item = seen[key];
    var changed = false;
    if (!item) {
      item = {
        key: key,
        title: pageTitle(),
        fplayUrl: isFplay(url) ? url : '',
        directVideoUrl: isFplay(url) ? '' : url,
        previewUrl: previewUrl || '',
        videoInfo: videoInfo || null,
        capturedAt: Date.now()
      };
      seen[key] = item;
      candidates.push(item);
      changed = true;
    } else {
      if (videoInfo && !item.videoInfo) { item.videoInfo = videoInfo; changed = true; }
      if (previewUrl && !item.previewUrl) { item.previewUrl = previewUrl; changed = true; }
    }
    if (changed) {
      post('DOLA_NATIVE_PREVIEW', item);
      render();
    }
    return item;
  }

  function walk(value, root, depth) {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      if (isVideo(value)) remember(value, root, '');
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) walk(value[i], root, depth + 1);
      return;
    }
    var preview = normalizeUrl(value.poster || value.cover || value.cover_url || value.preview || value.preview_url || value.thumbnail || value.thumbnail_url || '');
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      var child = value[keys[j]];
      if (typeof child === 'string' && isVideo(child)) remember(child, root, preview);
      else walk(child, root, depth + 1);
    }
  }

  function inspectText(text) {
    if (!text || typeof text !== 'string') return;
    try {
      var parsed = JSON.parse(text);
      walk(parsed, parsed, 0);
      return;
    } catch (_) { }
    var matches = text.match(/https?:\/\/[^\s'<>]+/g) || [];
    for (var i = 0; i < matches.length; i++) remember(matches[i].replace(/[),;]+$/, ''), null, '');
  }

  function scanDom() {
    ensureSource();
    var nodes = document.querySelectorAll('video,video source');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var video = node.tagName === 'VIDEO' ? node : node.parentElement;
      var url = node.currentSrc || node.src || node.getAttribute('src') || '';
      var poster = video && video.getAttribute ? (video.getAttribute('poster') || '') : '';
      remember(url, null, poster);
    }
  }

  function readResponseTextLimited(response) {
    try {
      var clone = response.clone();
      var contentLength = Number(clone.headers.get('content-length') || 0);
      if (contentLength > MAX_TEXT_BYTES) return Promise.resolve(null);
      if (!clone.body || typeof clone.body.getReader !== 'function' || typeof TextDecoder !== 'function') {
        if (!contentLength) return Promise.resolve(null);
        return clone.text().then(function (text) { return text.length <= MAX_TEXT_BYTES ? text : null; }).catch(function () { return null; });
      }
      var reader = clone.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var totalBytes = 0;
      var chunks = [];
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            chunks.push(decoder.decode());
            return chunks.join('');
          }
          var bytes = result.value || new Uint8Array(0);
          totalBytes += bytes.byteLength;
          if (totalBytes > MAX_TEXT_BYTES) {
            try { reader.cancel(); } catch (_) { }
            return null;
          }
          chunks.push(decoder.decode(bytes, { stream: true }));
          return pump();
        });
      }
      return pump().catch(function () { return null; });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function installNetworkHooks() {
    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function () {
        return originalFetch.apply(this, arguments).then(function (response) {
          try {
            remember(response.url, null, '');
            var contentType = (response.headers.get('content-type') || '').toLowerCase();
            if (contentType.indexOf('json') >= 0 || contentType.indexOf('text/') >= 0 || contentType.indexOf('javascript') >= 0) {
              readResponseTextLimited(response).then(function (text) { if (text) inspectText(text); });
            }
          } catch (_) { }
          return response;
        });
      };
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__astraRequestUrl = normalizeUrl(url);
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          remember(this.responseURL || this.__astraRequestUrl, null, '');
          var contentType = (this.getResponseHeader('content-type') || '').toLowerCase();
          if (this.responseType === 'json') walk(this.response, this.response, 0);
          else if ((!this.responseType || this.responseType === 'text') && (contentType.indexOf('json') >= 0 || contentType.indexOf('text/') >= 0 || contentType.indexOf('javascript') >= 0)) {
            var text = this.responseText || '';
            if (text.length <= MAX_TEXT_BYTES) inspectText(text);
          }
        } catch (_) { }
      });
      return originalSend.apply(this, arguments);
    };
  }

  var host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  document.documentElement.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' +
    ':host{all:initial;position:fixed;right:18px;top:16px;bottom:auto;z-index:2147483647;font-family:"Microsoft YaHei UI","Segoe UI",sans-serif;color:#eef4ff}' +
    '.launcher{position:relative;width:48px;height:48px;border:1px solid rgba(125,211,252,.42);border-radius:15px;background:linear-gradient(145deg,#13223e,#0a1021);box-shadow:0 14px 42px rgba(0,0,0,.45);color:#9ee7ff;cursor:pointer;font-size:22px;display:grid;place-items:center}' +
    '.launcher:hover{border-color:#67e8f9;transform:translateY(-1px)}' +
    '.astra-media-capture-badge{display:none;position:absolute;right:-7px;top:-7px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#6ee7f9;color:#06111f;border:2px solid #080d1b;font-size:11px;font-weight:800;line-height:20px;text-align:center}' +
    '.astra-media-capture-badge.show{display:block}' +
    '.panel{display:none;position:absolute;right:0;top:58px;bottom:auto;width:342px;max-height:420px;overflow:hidden;border:1px solid rgba(125,211,252,.28);border-radius:16px;background:rgba(7,12,27,.97);box-shadow:0 24px 80px rgba(0,0,0,.58);backdrop-filter:blur(18px)}' +
    '.panel.open{display:flex;flex-direction:column}' +
    '.head{display:flex;align-items:center;justify-content:space-between;padding:13px 14px 11px;border-bottom:1px solid rgba(148,163,184,.15)}' +
    '.head strong{font-size:14px}.head span{font-size:12px;color:#8da2c2}' +
    '.list{padding:8px;overflow:auto;display:flex;flex-direction:column;gap:7px}' +
    '.empty{padding:28px 16px;text-align:center;color:#8192ad;font-size:13px}' +
    '.row{display:grid;grid-template-columns:54px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px;border-radius:11px;background:rgba(17,29,52,.82);border:1px solid rgba(148,163,184,.1)}' +
    '.thumb{width:54px;height:36px;border-radius:7px;background:#080d18 center/cover no-repeat;display:grid;place-items:center;color:#60708a;font-size:11px;overflow:hidden}' +
    '.meta{min-width:0}.name{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{font-size:11px;color:#7f91ad;margin-top:3px}' +
    '.download{height:30px;padding:0 11px;border:1px solid rgba(103,232,249,.35);border-radius:9px;background:#102840;color:#a5f3fc;font-size:12px;cursor:pointer}.download:hover{background:#123554;border-color:#67e8f9}' +
    '</style>' +
    '<button class="launcher" type="button" title="已捕获视频"><span>⇩</span><span class="astra-media-capture-badge" id="badge">0</span></button>' +
    '<section class="panel" id="panel"><div class="head"><strong>已捕获视频</strong><span id="summary">0 个</span></div><div class="list" id="list"></div></section>';

  var launcher = shadow.querySelector('.launcher');
  var badge = shadow.getElementById('badge');
  var panel = shadow.getElementById('panel');
  var summary = shadow.getElementById('summary');
  var list = shadow.getElementById('list');

  function render() {
    if (!badge || !list) return;
    var total = candidates.length;
    badge.textContent = String(total);
    badge.classList.toggle('show', total > 0);
    if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
      window.chrome.webview.postMessage({
        type: 'DOLA_EXTENSION_MEDIA_RESOLVED',
        sourceKey: currentSource,
        items: candidates.map(function (item) {
          return { type: 'video', url: item.directVideoUrl || item.fplayUrl || item.previewUrl || '' };
        })
      });
    }
    summary.textContent = total + ' 个';
    list.textContent = '';
    if (!total) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '当前页面还没有捕获到视频';
      list.appendChild(empty);
      return;
    }
    candidates.slice().reverse().forEach(function (item, reverseIndex) {
      var index = total - reverseIndex;
      var row = document.createElement('div');
      row.className = 'row';
      row.setAttribute('data-astra-media-key', item.key);
      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (item.previewUrl) thumb.style.backgroundImage = 'url("' + item.previewUrl.replace(/"/g, '%22') + '")';
      else thumb.textContent = 'VIDEO';
      var meta = document.createElement('div');
      meta.className = 'meta';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = '视频 ' + index;
      name.title = item.title || item.key;
      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = isFplay(item.fplayUrl) ? '已识别 · 可解析下载' : '已识别 · 可直接下载';
      meta.append(name, sub);
      var button = document.createElement('button');
      button.className = 'download';
      button.type = 'button';
      button.textContent = '下载';
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        post('DOLA_NATIVE_DOWNLOAD_NOWATERMARK', item);
      });
      row.append(thumb, meta, button);
      list.appendChild(row);
    });
  }

  function openPicker() {
    scanDom();
    render();
    panel.classList.add('open');
    return candidates.length;
  }

  launcher.addEventListener('click', function () {
    scanDom();
    render();
    panel.classList.toggle('open');
  });
  document.addEventListener('pointerdown', function (event) {
    if (panel.classList.contains('open') && event.composedPath && event.composedPath().indexOf(host) < 0) panel.classList.remove('open');
  }, true);

  window.__astraOpenMediaPicker = openPicker;
  window.__dolaNativeDownloadNowatermark = openPicker;
  window.addEventListener('message', function (event) {
    if (event.source === window && event.data && event.data.type === 'ASTRA_MEDIA_PICKER_OPEN') openPicker();
  });

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(function () { scanTimer = 0; scanDom(); }, 100);
  }

  function startObserver() {
    scanDom();
    if (!document.documentElement) return;
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster'] });
  }

  installNetworkHooks();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  else startObserver();
})();
