/**
 * dola-api-command-hook.js
 * Injected into Dola page to monitor generation results and report to C# host.
 */
(() => {
  "use strict";
  if (window.__DOLA_API_COMMAND_HOOK__) return;
  window.__DOLA_API_COMMAND_HOOK__ = true;

  const RESULT_TYPE = "DOLA_API_RESULT";
  const PROGRESS_TYPE = "DOLA_API_PROGRESS";
  const trackedTasks = new Map();
  const MAX_TRACKED = 20;

  function postToNative(payload) {
    try {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(JSON.stringify(payload));
      }
    } catch (_) {}
  }

  window.__dolaApiTrackTask = function(taskId, type) {
    if (trackedTasks.size >= MAX_TRACKED) {
      let oldest = null, oldestTime = Infinity;
      for (const [id, info] of trackedTasks) {
        if (info.startTime < oldestTime) { oldestTime = info.startTime; oldest = id; }
      }
      if (oldest) trackedTasks.delete(oldest);
    }
    trackedTasks.set(taskId, {
      taskId, type, startTime: Date.now(), baseline: snapshotMedia(), reported: false
    });
    postToNative({ type: PROGRESS_TYPE, taskId, status: "monitoring" });
  };

  function snapshotMedia() {
    const urls = new Set();
    document.querySelectorAll("img[src]").forEach(img => {
      if (img.src) urls.add("img:" + normalizeUrl(img.src));
    });
    document.querySelectorAll("video source[src], video[src]").forEach(el => {
      const src = el.src || el.getAttribute("src") || "";
      if (src) urls.add("vid:" + normalizeUrl(src));
    });
    return urls;
  }

  function normalizeUrl(raw) {
    return String(raw || "").replace(/&amp;/g, "&").replace(/\\u0026/g, "&");
  }

  function checkForNewMedia() {
    for (const [taskId, info] of trackedTasks) {
      if (info.reported) continue;
      const current = snapshotMedia();
      const newMedia = [];
      for (const url of current) {
        if (!info.baseline.has(url)) newMedia.push(url);
      }
      if (newMedia.length > 0) {
        const urlEntry = newMedia.find(u => u.startsWith(info.type === "video" ? "vid:" : "img:")) || newMedia[0];
        if (urlEntry) {
          const url = urlEntry.substring(urlEntry.indexOf(":") + 1);
          info.reported = true;
          postToNative({ type: RESULT_TYPE, taskId, mediaType: info.type, url, success: true });
        }
      }
      const timeoutMs = info.type === "video" ? 600000 : 180000;
      if (Date.now() - info.startTime > timeoutMs) {
        info.reported = true;
        postToNative({ type: RESULT_TYPE, taskId, error: "Generation timed out.", success: false });
      }
    }
  }

  setInterval(checkForNewMedia, 2000);
  const observer = new MutationObserver(() => { checkForNewMedia(); });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    const now = Date.now();
    for (const [taskId, info] of trackedTasks) {
      if (info.reported && now - info.startTime > 300000) trackedTasks.delete(taskId);
    }
  }, 60000);
})();