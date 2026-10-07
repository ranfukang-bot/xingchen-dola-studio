(() => {
  "use strict";

  if (window.__DOLA_API_PLUGIN_HOOKED__) return;
  window.__DOLA_API_PLUGIN_HOOKED__ = true;

  const MESSAGE_TYPE = "DOLA_API_PLUGIN_CAPTURE";
  const MAX_SCAN_NODES = 6000;
  let lastPath = location.pathname;

  function findTaskId(value, depth = 0, seen = new WeakSet()) {
    if (depth > 7 || value == null) return "";
    if (typeof value === "string") {
      const match = value.match(/(?:task[_-]?id|generation[_-]?id|request[_-]?id|job[_-]?id|creation[_-]?id)["'\\s:=]+([A-Za-z0-9._:-]{6,})/i);
      return match ? match[1] : "";
    }
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const key of Object.keys(value).slice(0, 100)) {
      if (/^(task[_-]?id|generation[_-]?id|request[_-]?id|job[_-]?id|creation[_-]?id)$/i.test(key)) {
        const candidate = String(value[key] || "");
        if (candidate.length >= 6) return candidate;
      }
      const nested = findTaskId(value[key], depth + 1, seen);
      if (nested) return nested;
    }
    return "";
  }

  function taskStatus(text) {
    const raw = String(text || "");
    if (/(failed|error|cancelled|失败|错误)/i.test(raw)) return "failed";
    if (/(success|succeed|completed|finished|done|视频生成好了|视频已生成)/i.test(raw)) return "done";
    return "running";
  }

  function postTaskUpdate(text, responseUrl = "") {
    const raw = String(text || "");
    const videoSignal = /(seedance|seedream|video[_-]?(generation|task|creation|url)|generate[_-]?video|fplay|视频生成|生成视频)/i;
    if (!videoSignal.test(raw)) return;
    if (/(conversation|message|chat|completion)/i.test(responseUrl) && !/(seedance|seedream|video|fplay)/i.test(raw)) return;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {}
    const taskId = findTaskId(parsed || raw);
    if (!taskId) return;
    let prompt = "";
    try {
      const source = parsed || {};
      prompt = String(source.prompt || source.description || source.input || source.title || "").slice(0, 160);
    } catch (_) {}
    window.postMessage({
      type: "DOLA_TASK_UPDATE",
      taskId,
      status: taskStatus(raw),
      prompt,
      sourceUrl: responseUrl || location.href,
      conversationTitle: document.title || ""
    }, location.origin);
  }

  function notifyRouteChanged() {
    if (lastPath === location.pathname) return;
    lastPath = location.pathname;
    window.postMessage({ type: MESSAGE_TYPE, routeChanged: true }, location.origin);
  }

  function appendQueryParam(raw, key, value) {
    if (!value) return raw;
    try {
      const url = new URL(raw, location.href);
      if (!url.searchParams.get(key)) url.searchParams.set(key, value);
      return url.href;
    } catch (_error) {
      return raw;
    }
  }

  function bodyToText(body) {
    try {
      if (!body) return "";
      if (typeof body === "string") return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) {
        const parts = [];
        for (const [key, value] of body.entries()) {
          if (typeof value === "string") parts.push(`${key}=${value}`);
        }
        return parts.join("&");
      }
      if (body instanceof ArrayBuffer && body.byteLength <= 65536) {
        return new TextDecoder("utf-8").decode(body);
      }
      if (ArrayBuffer.isView(body) && body.byteLength <= 65536) {
        return new TextDecoder("utf-8").decode(body);
      }
    } catch (_error) {
      // ignored
    }
    return "";
  }

  function extractKeySeed(text) {
    const normalized = String(text || "").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    const matches = [
      normalized.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i),
      normalized.match(/["']key_seed["']\s*:\s*["']([^"']+)/i)
    ];
    const match = matches.find(Boolean);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (_error) {
      return match[1];
    }
  }

  function remember(raw, meta = {}) {
    let url = String(raw || "");
    try {
      url = new URL(url, location.href).href;
    } catch (_error) {
      // ignored
    }
    if (!/\/video\/fplay\//i.test(url)) return;
    if (meta.keySeed) url = appendQueryParam(url, "key_seed", meta.keySeed);
    window.postMessage({ type: MESSAGE_TYPE, url, startTime: meta.startTime, keySeed: meta.keySeed || "" }, location.origin);
  }

  function postFplayStatus(raw, status) {
    if (!status) return;
    let url = String(raw || "");
    try {
      url = new URL(url, location.href).href;
    } catch (_error) {
      // ignored
    }
    if (!/\/video\/fplay\//i.test(url)) return;
    window.postMessage({ type: MESSAGE_TYPE, url, linkStatus: status }, location.origin);
  }

  function safeClone(value, depth = 0, seen = new WeakSet()) {
    if (depth > 8) return undefined;
    if (value == null) return value;
    if (typeof value === "string") return value.length > 12000 ? value.slice(0, 12000) : value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 40).map((item) => safeClone(item, depth + 1, seen));
    }
    const out = {};
    for (const key of Object.keys(value).slice(0, 100)) {
      const cloned = safeClone(value[key], depth + 1, seen);
      if (cloned !== undefined) out[key] = cloned;
    }
    return out;
  }

  function postVideoInfo(value) {
    try {
      const cloned = safeClone(value);
      const text = JSON.stringify(cloned);
      if (text.length > 20 && text.length < 250000) {
        window.postMessage({ type: MESSAGE_TYPE, videoInfo: cloned }, location.origin);
      }
    } catch (_error) {
      // ignored
    }
  }

  function scanString(text) {
    const raw = String(text || "");
    const normalized = raw.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    const keySeed = extractKeySeed(normalized);
    const urls = normalized.match(/https?:\/\/[^"'<>\\\s]+\/video\/fplay\/[^"'<>\\\s]*/gi) || [];
    urls.forEach((url) => remember(url, { keySeed }));
  }

  function classifyFplayResponse(text) {
    const raw = String(text || "");
    if (/error\s+check\s+params|check\s+params/i.test(raw)) return "bad";
    try {
      const obj = JSON.parse(raw);
      const videoInfo = obj && obj.video_info;
      const topCode = typeof obj.code === "number" ? obj.code : null;
      const infoCode = videoInfo && typeof videoInfo.code === "number" ? videoInfo.code : null;
      const topMessage = String((obj && obj.message) || "");
      const infoMessage = String((videoInfo && videoInfo.message) || "");
      if (topCode === 0 || infoCode === 0 || /success/i.test(`${topMessage} ${infoMessage}`)) return "ok";
      if ((topCode != null && topCode !== 0) || (infoCode != null && infoCode !== 0)) return "bad";
    } catch (_error) {
      // ignored
    }
    if (/video_info/i.test(raw) && /key_seed|video_list|main_url|qAAB/i.test(raw)) return "ok";
    return "";
  }

  function scanResponseText(text, responseUrl = "") {
    postTaskUpdate(text, responseUrl);
    postFplayStatus(responseUrl, classifyFplayResponse(text));
    scanString(text);
    if (/key_seed|video_list|main_url|qAAB|video\/fplay/i.test(text)) {
      try {
        scanObject(JSON.parse(text));
      } catch (_error) {
        // ignored
      }
    }
  }

  function scanObject(root) {
    const queue = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    let visited = 0;

    while (queue.length && visited < MAX_SCAN_NODES) {
      const item = queue.shift();
      const value = item && item.value;
      const depth = item ? item.depth : 0;
      visited += 1;

      if (typeof value === "string") {
        scanString(value);
        continue;
      }
      if (!value || typeof value !== "object" || seen.has(value) || depth > 8) continue;
      seen.add(value);

      try {
        const keys = Object.keys(value);
        const keyText = keys.join(",");
        if (
          /key_seed/i.test(keyText)
          && (/main_url|backup_url|video_list|video_1/i.test(keyText) || /qAAB/.test(JSON.stringify(safeClone(value, 0))))
        ) {
          postVideoInfo(value);
        }
        for (const key of keys.slice(0, 120)) {
          queue.push({ value: value[key], depth: depth + 1 });
        }
      } catch (_error) {
        // ignored
      }
    }
  }

  function scanPageState() {
    scanObject(window._ROUTER_DATA);
    scanObject(window._SSR_DATA);
    try {
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          const value = storage.getItem(key);
          scanString(value);
          if (value && /key_seed|video_list|main_url|qAAB|video\/fplay/i.test(value)) {
            try {
              scanObject(JSON.parse(value));
            } catch (_error) {
              // ignored
            }
          }
        }
      }
    } catch (_error) {
      // ignored
    }
  }

  function scanPerformance() {
    try {
      const entries = performance.getEntriesByType("resource") || [];
      for (const entry of entries) remember(entry.name, { startTime: entry.startTime });
    } catch (_error) {
      // ignored
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      const requestUrl = typeof input === "string" ? input : input && input.url;
      const requestText = bodyToText(init && init.body);
      const requestKeySeed = extractKeySeed(requestText);
      remember(requestUrl, { keySeed: requestKeySeed });
      if (requestText) scanResponseText(requestText);
      return originalFetch.apply(this, arguments).then((response) => {
        remember(response && response.url);
        try {
          const contentType = response.headers && response.headers.get("content-type");
          if ((contentType && /json|text/i.test(contentType)) || /\/video\/fplay\//i.test(response.url || "")) {
            response.clone().text().then((text) => {
              scanResponseText(text, response.url || "");
            }).catch(() => {});
          }
        } catch (_error) {
          // ignored
        }
        return response;
      });
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__dolaApiPluginUrl = url;
    remember(url);
    try {
      this.addEventListener("loadend", function onXhrLoadEnd() {
        try {
          remember(this.responseURL || url);
          const responseType = this.responseType || "";
          if (responseType && responseType !== "text") return;
          const contentType = this.getResponseHeader("content-type") || "";
          const text = this.responseText || "";
          if (text && ((contentType && /json|text/i.test(contentType)) || /key_seed|video_list|main_url|qAAB|video\/fplay/i.test(text))) {
            scanResponseText(text, this.responseURL || url);
          }
        } catch (_error) {
          // ignored
        }
      });
    } catch (_error) {
      // ignored
    }
    return originalOpen.apply(this, arguments);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    try {
      const requestText = bodyToText(body);
      const requestKeySeed = extractKeySeed(requestText);
      if (requestText) scanResponseText(requestText);
      if (requestKeySeed) remember(this.__dolaApiPluginUrl, { keySeed: requestKeySeed });
    } catch (_error) {
      // ignored
    }
    return originalSend.apply(this, arguments);
  };

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original === "function") {
      history[method] = function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        notifyRouteChanged();
        return result;
      };
    }
  }
  window.addEventListener("popstate", notifyRouteChanged);

  scanPerformance();
  setInterval(scanPerformance, 1200);
})();
