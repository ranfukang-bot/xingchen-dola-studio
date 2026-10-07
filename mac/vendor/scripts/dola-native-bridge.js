(function () {
  "use strict";

  if (window.__dolaNativeBridgeInstalled) return;
  window.__dolaNativeBridgeInstalled = true;
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute("data-dola-native-download-host", "1");
    }
  } catch (_) {
    // ignored
  }

  const MESSAGE_TYPE = "DOLA_API_PLUGIN_CAPTURE";
  const MAX_ITEMS = 40;
  const fplayUrls = [];
  const videoInfos = [];
  const fplayStatuses = new Map();
  const postedPreviews = new Map();
  const openedHistoryKeys = new Set();
  let resolvedVideos = [];
  let resolvedSourceKey = "";
  let resolvedRevision = 0;
  let lastConversationTitle = "";
  let lastHistoryOpenAt = 0;
  let historyScanPromise = null;
  let panel = null;
  let downloadButton = null;
  let lastPanelSignature = "";
  let currentTaskId = "";
  let lastStatusSignature = "";

  function normalizeUrl(raw) {
    return String(raw || "")
      .replace(/&amp;/g, "&")
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/");
  }

  

  function isRejectedDynamicWatermarkVideo(item) {
    if (!item) return false;
    const sourcePipeline = String(item.sourcePipeline || "").toLowerCase();
    if (sourcePipeline === "dola_fallback_api_h265") return true;
    if (
      sourcePipeline !== "dola_chain_main_url" &&
      sourcePipeline !== "dola_fallback_api_h264"
    ) return false;
    try {
      const rendition = String(new URL(String(item.url || "")).searchParams.get("lr") || "").toLowerCase();
      if (rendition === "video_gen_watermark_dyn") return true;
      return rendition !== "unwatermarked";
    } catch {
      return true;
    }
  }

  function isFplayUrl(url) {
    return /\/video\/fplay\//i.test(url || "");
  }

  function hasKeySeed(url) {
    return /(?:^|[?&])key_seed=/i.test(url || "");
  }

  function fplayResourceKey(url) {
    const text = normalizeUrl(url);
    const match = text.match(/\/video\/fplay\/([^?#]+)/i);
    return match ? match[1] : text.split("?")[0];
  }

  function sameFplayResource(left, right) {
    return fplayResourceKey(left) === fplayResourceKey(right);
  }

  function bestSeededVariant(url) {
    if (!url || hasKeySeed(url)) return url;
    return fplayUrls.find((candidate) => fplayStatuses.get(candidate) !== "bad" && hasKeySeed(candidate) && sameFplayResource(candidate, url)) || url;
  }

  function pushUnique(list, value) {
    if (!value || list.includes(value)) return;
    list.unshift(value);
    if (list.length > MAX_ITEMS) list.length = MAX_ITEMS;
  }

  function remember(raw, meta) {
    const url = normalizeUrl(raw);
    if (!isFplayUrl(url)) return;
    const seeded = meta && meta.keySeed && !hasKeySeed(url)
      ? url + (url.includes("?") ? "&" : "?") + "key_seed=" + encodeURIComponent(meta.keySeed)
      : url;
    pushUnique(fplayUrls, seeded);
  }

  function scanDom() {
    try {
      Array.from(document.querySelectorAll("[src], [href]")).forEach((node) => {
        remember(node.getAttribute("src") || node.getAttribute("href") || "");
      });
      Array.from(document.querySelectorAll("script")).forEach((node) => {
        const text = node.textContent || "";
        const matches = text.match(/https?:[^"'\\\s<>]+\/video\/fplay\/[^"'\\\s<>]+/gi) || [];
        matches.forEach(remember);
      });
    } catch (_) {
      // ignored
    }
  }

  function scanPerformance() {
    try {
      const entries = performance.getEntriesByType("resource") || [];
      entries.forEach((entry) => remember(entry.name, { startTime: entry.startTime }));
    } catch (_) {
      // ignored
    }
  }

  function rankedFplayUrls() {
    scanPerformance();
    const ranked = [];
    const seen = new Set();
    fplayUrls.forEach((raw) => {
      const url = bestSeededVariant(raw);
      const key = fplayResourceKey(url);
      if (!key || seen.has(key) || fplayStatuses.get(url) === "bad") return;
      seen.add(key);
      ranked.push({ url, status: fplayStatuses.get(url), seeded: hasKeySeed(url) });
    });
    ranked.sort((left, right) => {
      if (left.status !== right.status) return left.status === "ok" ? -1 : 1;
      if (left.seeded !== right.seeded) return left.seeded ? -1 : 1;
      return 0;
    });
    return ranked.map((item) => item.url);
  }

  function bestFplayUrl() {
    scanDom();
    scanPerformance();
    return rankedFplayUrls()[0] || "";
  }

  function bestVideoInfo() {
    scanDom();
    return videoInfos[0] || null;
  }

  function bestDirectVideoUrl() {
    const videos = Array.from(document.querySelectorAll("video"));
    const target = pickPrimaryMedia(videos);
    const ordered = target ? [target, ...videos.filter((video) => video !== target)] : videos;
    for (const video of ordered) {
      const url = normalizeUrl(video.currentSrc || video.src || "");
      if (/^https?:\/\/.+(?:mime_type=video_mp4|\/video\/|\.mp4)/i.test(url)) return url;
    }
    return "";
  }

  function postNative(payload) {
    try {
      if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(payload);
    } catch (_) {
      // ignored
    }
  }

  const DOWNLOAD_ICON_SVG = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 16v2.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function setButtonLabel(button, text) {
    if (!button) return;
    button.innerHTML = DOWNLOAD_ICON_SVG + '<span>' + text + '</span>';
  }

  function setTempText(button, text, fallback) {
    if (!button) return;
    setButtonLabel(button, text);
    clearTimeout(button.__dolaNativeTimer);
    button.__dolaNativeTimer = setTimeout(() => {
      setButtonLabel(button, fallback);
    }, 1500);
  }

  function downloadNowatermark(button) {
    // 工具栏“无水印下载”没有任何面板上下文，直接取当前可见的最大媒体节点当目标。
    const media = pickPrimaryMedia(Array.from(document.querySelectorAll("video,img")));
    setTempText(button, "\u5904\u7406\u4e2d...", "\u53bb\u6c34\u5370\u4e0b\u8f7d");
    const selectedVideo = resolvedVideos[0] || null;
    const directVideoUrl = normalizeUrl(selectedVideo ? selectedVideo.url : "") || bestDirectVideoUrl();
    const fplayUrl = bestFplayForMedia(media);
    const videoInfo = videoInfos[0] || null;
    if (directVideoUrl || fplayUrl || videoInfo) {
      postNative({
        type: "DOLA_NATIVE_DOWNLOAD_NOWATERMARK",
        fplayUrl: fplayUrl,
        directVideoUrl: directVideoUrl,
        videoInfo: videoInfo,
        sourcePipeline: selectedVideo ? selectedVideo.sourcePipeline : "",
        referer: location.href
      });
      return;
    }
    // The extension may finish resolving the original URL after this bridge
    // scans the page. Let it report that exact URL back to the native host.
    window.postMessage({
      type: "DOLA_EXTENSION_DOWNLOAD_CURRENT",
      key: previewKey(media),
      referer: location.href
    }, location.origin);
  }

  try {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.addEventListener("message", function (event) {
        const data = event && event.data;
        if (!data || data.type !== "DOLA_NATIVE_DOWNLOAD_PROGRESS") return;
        window.postMessage({
          type: "DOLA_EXTENSION_DOWNLOAD_PROGRESS",
          requestId: data.requestId || "",
          state: data.state || "",
          progress: Number(data.progress) || 0,
          text: data.text || ""
        }, "*");
      });
    }
  } catch (_) {
    // ignored
  }

  window.__dolaNativeDownloadNowatermark = function () {
    downloadNowatermark(downloadButton);
  };

  function ensurePanel() {
    if (panel || !document.body) return;
    panel = document.createElement("div");
    panel.className = "dola-native-actions";
    panel.style.position = "fixed";
    panel.style.zIndex = "2147483647";
    panel.style.display = "none";
    panel.style.pointerEvents = "none";
    document.body.appendChild(panel);
  }

  function styleButton(button) {
    button.style.width = "210px";
    button.style.height = "42px";
    button.style.padding = "0 18px";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.gap = "10px";
    button.style.border = "1px solid rgba(255,255,255,.92)";
    button.style.borderRadius = "999px";
    button.style.background = "linear-gradient(105deg, rgba(120,178,255,.94), rgba(91,206,239,.92))";
    button.style.backdropFilter = "blur(14px) saturate(1.35)";
    button.style.webkitBackdropFilter = "blur(14px) saturate(1.35)";
    button.style.color = "#fff";
    button.style.font = "700 14px Microsoft YaHei, Segoe UI, Arial, sans-serif";
    button.style.letterSpacing = ".3px";
    button.style.textShadow = "0 1px 2px rgba(36,91,150,.28)";
    button.style.boxShadow = "0 8px 22px rgba(57,143,219,.30), inset 0 1px 0 rgba(255,255,255,.72), inset 0 0 0 2px rgba(213,241,255,.25)";
    button.style.cursor = "pointer";
    button.style.transition = "transform .16s ease, box-shadow .16s ease, filter .16s ease";
    button.onmouseenter = () => { button.style.transform = "translateY(-1px)"; button.style.filter = "brightness(1.04)"; };
    button.onmouseleave = () => { button.style.transform = "translateY(0)"; button.style.filter = "none"; };
    button.onmousedown = () => { button.style.transform = "scale(.98)"; };
    button.onmouseup = () => { button.style.transform = "translateY(-1px)"; };
  }

  function pickPrimaryMedia(nodes) {
    let best = null;
    let bestArea = 0;
    nodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) return;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = node;
        bestArea = area;
      }
    });
    return best;
  }

  function mediaUrlOf(node) {
    if (!node) return "";
    if (node.tagName === "VIDEO") return videoUrlOf(node);
    return normalizeUrl(node.currentSrc || node.src || node.getAttribute("data-src") || "");
  }

  function videoUrlOf(video) {
    return normalizeUrl(video && (video.currentSrc || video.src || ""));
  }

  function mediaFormatOf(node, videoInfo) {
    const text = String((node && (node.getAttribute("type") || node.currentSrc || node.src || node.getAttribute("data-format"))) || "").toLowerCase();
    const info = videoInfo && typeof videoInfo === "object" ? videoInfo : {};
    const codec = String(info.codec_name || info.codec || info.video_codec || info.format || "").toLowerCase();
    if (/h265|hevc|hev1|hvc1/.test(codec + text)) return "H.265";
    if (/h264|avc1|avc/.test(codec + text)) return "H.264";
    if (/webm/.test(codec + text)) return "WebM";
    if (/png/.test(codec + text)) return "PNG";
    if (/webp/.test(codec + text)) return "WebP";
    if (/jpe?g/.test(codec + text)) return "JPG";
    if (node && node.tagName === "IMG") return "图片";
    return "MP4";
  }

  function bestFplayForMedia(node) {
    const direct = mediaUrlOf(node);
    if (!direct) return bestFplayUrl();
    const directKey = fplayResourceKey(direct);
    return rankedFplayUrls().find((candidate) => {
      const key = fplayResourceKey(candidate);
      return key && directKey && (key === directKey || direct.indexOf(key) >= 0 || candidate.indexOf(directKey) >= 0);
    }) || bestFplayUrl();
  }

  function previewUrlForMedia(node) {
    if (!node) return "";
    if (node.tagName === "IMG") {
      const src = normalizeUrl(node.currentSrc || node.src || node.getAttribute("data-src") || "");
      if (/^https?:\/\//i.test(src)) return src;
    }
    const poster = normalizeUrl(node.poster || node.getAttribute("poster") || "");
    if (/^https?:\/\//i.test(poster)) return poster;
    const parent = node.closest("[class], div, article, section") || node.parentElement;
    if (parent) {
      const img = parent.querySelector("img[src],img[data-src]");
      const src = normalizeUrl(img && (img.currentSrc || img.src || img.getAttribute("data-src") || ""));
      if (/^https?:\/\//i.test(src)) return src;
    }
    return "";
  }

  function isHistorySidebarRect(rect) {
    // 只认 Dola 网页左侧“历史对话”区域，避免把视频悬浮工具栏里的“重播/播放/暂停”等当成历史标题。
    return rect.left >= 0 && rect.left < Math.min(320, innerWidth * 0.32) && rect.top > 140 && rect.bottom < innerHeight - 20;
  }

  function normalizeHistoryTitleText(text) {
    let value = (text || "").replace(/\s+/g, "").trim();
    value = value.replace(/^[○●◌◦·]+/, "").replace(/[1-9]$/, "");
    return value.slice(0, 80);
  }

  function isBadHistoryTitle(text) {
    if (!text || text.length < 2 || text.length > 80) return true;
    if (/[：:，。！？【】《》]|@图|本次使用|你的|我会|今日剩余|将消耗|预计等待|生成好后|视频生成好了/.test(text)) return true;
    return /(新对话|AI创作|发现智能体|关于Dola|下载电脑版|登录|删除|账号档案|正在使用|已打开|已保存|请输入|描述你想要|图像生成|^视频生成$|^生成视频|视频预览|^快速$|快速新|参考图|模型|比例|风格|更多|重播|播放|暂停|复制链接|无水印下载|下载|Dola$)/.test(text);
  }

  function selectedHistoryTitle() {
    const candidates = Array.from(document.querySelectorAll("a,button,[role='button'],li,div,span"));
    const scored = candidates.map((element) => {
      if (!isVisibleElement(element)) return null;
      const rect = element.getBoundingClientRect();
      if (!isHistorySidebarRect(rect)) return null;
      const text = normalizeHistoryTitleText(element.textContent || "");
      if (isBadHistoryTitle(text)) return null;
      const cls = String(element.className || "");
      let score = 0;
      if (element.getAttribute("aria-current") || element.getAttribute("aria-selected") === "true" || /active|selected|current/i.test(cls)) score += 40;
      if (rect.width >= 120 && rect.height >= 26 && rect.height <= 70) score += 8;
      if (/(视频|生成|猫|狗|猪|飞|谈判|会|场景|对话)/.test(text)) score += 3;
      if (text.length <= 12) score += 2;
      return { element, text, score, top: rect.top };
    }).filter(Boolean);
    if (!scored.length) return "";
    scored.sort((a, b) => b.score - a.score || a.top - b.top);
    return scored[0].score > 0 ? scored[0].text : "";
  }

  function syncConversationContext() {
    const title = selectedHistoryTitle();
    if (title && lastConversationTitle && title !== lastConversationTitle) {
      resolvedVideos = [];
      resolvedSourceKey = "";
    }
    if (title) lastConversationTitle = title;
    return title;
  }

  function currentConversationKey(node) {
    const selected = selectedHistoryTitle();
    return [location.pathname, selected].filter(Boolean).join("|");
  }

  function previewKey(node) {
    const resource = previewUrlForMedia(node) || fplayResourceKey(bestFplayForMedia(node)) || mediaUrlOf(node);
    const conversation = currentConversationKey(node);
    return [conversation, resource].filter(Boolean).join("|");
  }

  function nearbyText(node) {
    let current = node;
    const parts = [];
    for (let i = 0; current && i < 7; i += 1, current = current.parentElement) {
      const text = (current.textContent || "").replace(/\s+/g, "");
      if (text.length > 4) {
        parts.push(text.slice(0, 500));
        if (/(你的视频生成好啦|视频生成好了|视频已生成|你的图片生成好啦|图片生成好了|图片已生成|图像生成完成)/.test(text)) break;
      }
    }
    return parts.join("|");
  }

  function isPreviewOverlayMedia(node) {
    const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if (!rect) return false;
    // 点击历史里的缩略图后，Dola 会打开一个大尺寸预览层。这个预览层和历史消息里的同一个视频重复，不能加入右侧视频管理。
    // 正常聊天消息中的视频缩略图一般较小；预览层通常占据页面较大比例。
    const tooLarge = rect.width >= Math.min(460, innerWidth * 0.38) || rect.height >= Math.min(460, innerHeight * 0.55);
    if (tooLarge) return true;
    const dialog = node.closest('[role="dialog"],[aria-modal="true"],.modal,.preview,.viewer,[class*="modal"],[class*="preview"],[class*="viewer"]');
    if (dialog) {
      const text = (dialog.textContent || "").replace(/\s+/g, "");
      if (/保存|关闭|放大|缩小|复制链接|无水印下载/.test(text)) return true;
    }
    return false;
  }

  function isGeneratedResultMedia(node) {
    if (!node || !/^(VIDEO|IMG)$/i.test(node.tagName)) return false;
    if (isPreviewOverlayMedia(node)) return false;
    if (node.closest("textarea,input,[contenteditable='true']")) return false;
    const text = nearbyText(node);
    const bodyText = (document.body && document.body.textContent || "").replace(/\s+/g, "");
    const src = mediaUrlOf(node) || previewUrlForMedia(node);
    if (node.tagName === "IMG" && !/^https?:\/\//i.test(src)) return false;
    if (/(你的视频生成好啦|视频生成好了|视频已生成|你的图片生成好啦|图片生成好了|图片已生成|图像生成完成)/.test(text)) return true;
    // 有些结果卡片在缩略图区域和提示文案之间隔了多层容器，祖先文本读不到。
    // 只在当前页面明确出现“视频已生成”提示时，放宽为主内容区里尺寸合格的媒体，避免首页示例图误加按钮。
    if (/(你的视频生成好啦|视频生成好了|视频已生成|你的图片生成好啦|图片生成好了|图片已生成|图像生成完成)/.test(bodyText)) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 60 && rect.height >= 60 && rect.left > Math.min(280, innerWidth * 0.22)) return true;
    }
    if (/正在为您生成/.test(text) && !/(你的视频生成好啦)/.test(text)) return false;
    return false;
  }

  function hasGeneratedResultMedia() {
    return Array.from(document.querySelectorAll("video,img")).some(isGeneratedResultMedia);
  }

  function pageStatus() {
    const bodyText = (document.body && document.body.textContent || "").replace(/\s+/g, "");
    // Dola 会把“本次使用 Dreamina…”的排队文案永久保留在历史对话中。
    // 因此必须先判断完成结果，否则已完成的视频会一直被旧文案误判为“制作中”。
    if (hasGeneratedResultMedia() || /(你的视频生成好啦|你的视频生成好了|视频生成好了|视频已生成)/.test(bodyText)) {
      return "done";
    }
    if (/本次使用.*Dreamina.*生成.*将消耗.*视频生成额度.*预计等待.*分钟.*视频生成好后/.test(bodyText) ||
        /正在为您生成/.test(bodyText) ||
        /视频生成好后，我会主动发送给你/.test(bodyText)) {
      return "running";
    }
    if (findHistoryCandidate(false)) return "ready";
    return "idle";
  }

  function reportStatus() {
    const payload = {
      type: "DOLA_NATIVE_STATUS",
      status: pageStatus(),
      taskId: currentTaskId,
      hasReadyBadge: !!findHistoryCandidate(false),
      hasGeneratedResult: hasGeneratedResultMedia(),
      historyCandidate: (findHistoryCandidate(true)?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
    };
    const signature = JSON.stringify(payload);
    if (signature === lastStatusSignature) return;
    lastStatusSignature = signature;
    postNative(payload);
  }

  function postVideoPreviews() {
    scanDom();
    scanPerformance();
    const conversationTitle = syncConversationContext() || (hasGeneratedResultMedia() ? "当前任务" : "");
    const candidates = Array.from(document.querySelectorAll("video,img"))
      .filter(isGeneratedResultMedia)
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
      });
    if (!conversationTitle || isBadHistoryTitle(conversationTitle)) return;
    for (const media of candidates) {
      const rect = media.getBoundingClientRect();
      // Only publish the final URL resolved by the extension. The page video
      // URL can now be the newly watermarked rendition and must not overwrite it.
      const directVideoUrl = media.tagName === "VIDEO" && resolvedVideos[0] ? resolvedVideos[0].url : "";
      const directImageUrl = media.tagName === "IMG" ? mediaUrlOf(media) : "";
      const previewUrl = previewUrlForMedia(media);
      const fplayUrl = media.tagName === "VIDEO" ? bestFplayForMedia(media) : "";
      const videoInfo = media.tagName === "VIDEO" ? (videoInfos[0] || null) : null;
      const naturalWidth = media.videoWidth || media.naturalWidth || 0;
      const naturalHeight = media.videoHeight || media.naturalHeight || 0;
      if ((rect.width < 60 || rect.height < 60) && (naturalWidth < 60 || naturalHeight < 60)) continue;
      if (!previewUrl && !directVideoUrl && !directImageUrl) continue;
      if (media.tagName === "VIDEO" && !fplayUrl && !videoInfo && !directVideoUrl) continue;
      const key = previewKey(media);
      if (!key) continue;
      const stableResource = fplayResourceKey(fplayUrl || directVideoUrl)
        || normalizeUrl(directVideoUrl).split("?")[0]
        || normalizeUrl(previewUrl).split("?")[0]
        || key;
      const rememberKey = location.pathname + "|" + conversationTitle + "|" + stableResource;
      const payload = {
        type: "DOLA_NATIVE_PREVIEW",
        taskId: currentTaskId,
        key,
        fplayUrl,
        videoInfo,
        directVideoUrl,
        directImageUrl,
        mediaType: media.tagName === "IMG" ? "image" : "video",
        mediaFormat: mediaFormatOf(media, videoInfo),
        previewUrl,
        conversationTitle,
        referer: location.href,
        title: document.title || "Dola video"
      };
      const signature = JSON.stringify({
        taskId: payload.taskId,
        stableResource,
        fplayUrl: payload.fplayUrl,
        directVideoUrl: payload.directVideoUrl,
        directImageUrl: payload.directImageUrl,
        mediaType: payload.mediaType,
        mediaFormat: payload.mediaFormat,
        previewUrl: payload.previewUrl,
        videoInfo: payload.videoInfo
      });
      if (postedPreviews.get(rememberKey) === signature) continue;
      postedPreviews.set(rememberKey, signature);
      postNative(payload);
    }
  }

  window.__dolaNativePostVideoPreviews = postVideoPreviews;

  function isVisibleElement(element) {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 20) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
  }

  function hasReadyBadge(element) {
    if (!element) return false;
    const text = (element.textContent || "").replace(/\s+/g, "");
    if (/[1-9]$/.test(text)) return true;
    const nodes = [element, ...Array.from(element.querySelectorAll("*")).slice(0, 80)];
    return nodes.some((node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (rect.width < 4 || rect.height < 4 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) return false;
      const cls = String(node.className || "");
      const label = (node.textContent || "").replace(/\s+/g, "");
      const colorText = [style.backgroundColor, style.color, style.borderColor].join(" ");
      const looksRed = /rgb\(\s*(?:2[0-5][0-9]|1[8-9][0-9])\s*,\s*(?:0|[1-9]|[1-8][0-9])\s*,\s*(?:0|[1-9]|[1-8][0-9])/.test(colorText);
      const smallBadge = rect.width <= 24 && rect.height <= 24 && rect.width >= 6 && rect.height >= 6;
      return (smallBadge && (looksRed || /red|badge|dot|notice|unread/i.test(cls) || /^[1-9]$/.test(label))) ||
        (/red|unread|notice/i.test(cls) && /^[1-9]?$/.test(label));
    });
  }


  function historyKey(element) {
    return ((element && element.textContent) || "").replace(/\s+/g, "").slice(0, 120);
  }
  function historyCandidateScore(element, allowNoReady) {
    if (!isVisibleElement(element)) return -1;
    const rect = element.getBoundingClientRect();
    if (!isHistorySidebarRect(rect)) return -1;
    const text = normalizeHistoryTitleText(element.textContent || "");
    if (isBadHistoryTitle(text)) return -1;
    const ready = hasReadyBadge(element);
    if (!ready && !allowNoReady) return -1;
    let score = 0;
    if (/视频/.test(text)) score += 8;
    if (/生成/.test(text)) score += 5;
    if (ready) score += 12;
    if (!ready && allowNoReady) score += 1;
    if (openedHistoryKeys.has(historyKey(element))) score -= ready ? 2 : 12;
    if (text.length < 24) score += 2;
    if (rect.width > 150 && rect.height > 28) score += 3;
    if (element.getAttribute("aria-current") || /active|selected/i.test(element.className || "")) score -= 4;
    return score;
  }

  function findHistoryCandidate(allowNoReady) {
    const elements = Array.from(document.querySelectorAll("a,button,[role='button'],li,div,span"));
    return elements
      .map((element) => ({ element, score: historyCandidateScore(element, !!allowNoReady) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.element.getBoundingClientRect().top - right.element.getBoundingClientRect().top)[0]?.element || null;
  }

  function findHistoryCandidatesForSweep() {
    const seen = new Set();
    const candidates = [];
    const elements = Array.from(document.querySelectorAll("a,button,[role='button'],li,div,span"));
    for (const element of elements) {
      if (historyCandidateScore(element, true) <= 0) continue;
      const target = clickableHistoryTarget(element);
      if (!target) continue;
      const title = normalizeHistoryTitleText(target.textContent || "");
      if (isBadHistoryTitle(title) || seen.has(title)) continue;
      seen.add(title);
      candidates.push(target);
    }
    return candidates.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top).slice(0, 6);
  }

  function clickableHistoryTarget(element) {
    if (!element) return null;
    let current = element;
    let best = element;
    for (let i = 0; current && i < 6; i += 1, current = current.parentElement) {
      const rect = current.getBoundingClientRect();
      const text = (current.textContent || "").replace(/\s+/g, "");
      if (!isHistorySidebarRect(rect)) continue;
      if (!isBadHistoryTitle(normalizeHistoryTitleText(text)) && rect.width >= 120 && rect.height >= 28 && rect.height <= 90) {
        best = current;
      }
      if (/^(A|BUTTON)$/i.test(current.tagName) || current.getAttribute("role") === "button") return current;
    }
    return best;
  }

  function clickLikeUser(element) {
    const target = clickableHistoryTarget(element);
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const x = Math.max(rect.left + 8, Math.min(rect.right - 8, rect.left + rect.width * 0.5));
    const y = Math.max(rect.top + 8, Math.min(rect.bottom - 8, rect.top + rect.height * 0.5));
    const realTarget = document.elementFromPoint(x, y) || target;
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      realTarget.dispatchEvent(new MouseEvent(type, options));
    });
    if (realTarget !== target) target.click();
    return true;
  }

  function autoOpenHistoryForScan(allowNoReady) {
    postVideoPreviews();
    reportStatus();
    if (historyScanPromise) return true;
    if (Date.now() - lastHistoryOpenAt < 3000) return false;
    const bodyText = (document.body && document.body.textContent || "").replace(/\s+/g, "");
    if (!allowNoReady && /正在为您生成/.test(bodyText) && /预计等待|请稍等/.test(bodyText)) return false;
    const candidates = findHistoryCandidatesForSweep();
    try {
      document.documentElement.setAttribute("data-dola-native-history-candidate", candidates.map((candidate) => normalizeHistoryTitleText(candidate.textContent || "")).join("|").slice(0, 240));
    } catch (_) {
      // ignored
    }
    if (!candidates.length) return false;
    lastHistoryOpenAt = Date.now();
    historyScanPromise = (async () => {
      for (const candidate of candidates) {
        const key = historyKey(candidate);
        if (!key || !clickLikeUser(candidate)) continue;
        openedHistoryKeys.add(key);
        // 切换历史对话后先清空上一条对话的解析结果，等待新插件返回当前对话直链。
        // 最多等待约 2.1 秒；网络快时收到结果就立即继续，不再固定空等。
        const revisionBefore = resolvedRevision;
        resolvedVideos = [];
        resolvedSourceKey = "";
        const waitStartedAt = Date.now();
        while (resolvedRevision === revisionBefore && Date.now() - waitStartedAt < 2100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        postVideoPreviews();
        await new Promise((resolve) => setTimeout(resolve, 400));
        postVideoPreviews();
      }
      reportStatus();
    })().catch(() => {}).finally(() => { historyScanPromise = null; });
    return true;
  }

  window.__dolaNativeAutoOpenHistoryForScan = autoOpenHistoryForScan;
  window.__dolaNativeReportStatus = reportStatus;

  function updatePanel() {
    ensurePanel();
    if (!panel) return;
    // The old inline download action has been removed. Keeping its empty
    // positioning layer in sync with a hover-swapped preview can make the
    // page and native sidebar alternate layouts, so leave it permanently off.
    if (lastPanelSignature !== "disabled") {
      panel.style.display = "none";
      lastPanelSignature = "disabled";
    }
  }

  window.addEventListener("message", function (event) {
    const data = event.data;
    if (!data) return;
    if (data.type === "DOLA_EXTENSION_DOWNLOAD_HOST" && data.url) {
      if (!(window.chrome && window.chrome.webview)) return;
      window.postMessage({
        type: "DOLA_EXTENSION_DOWNLOAD_HOST_ACK",
        requestId: data.requestId || ""
      }, "*");
      const directVideoUrl = normalizeUrl(data.url);
      if (!directVideoUrl || isRejectedDynamicWatermarkVideo(data)) {
        console.warn("Ignored dynamic-watermark H265 download candidate.");
        return;
      }
      postNative({
        type: "DOLA_NATIVE_DOWNLOAD_NOWATERMARK",
        directVideoUrl,
        sourcePipeline: String(data.sourcePipeline || ""),
        requestId: data.requestId || "",
        referer: location.href
      });
      return;
    }
    if (event.source !== window) return;
    if (data.type === "DOLA_TASK_UPDATE") {
      currentTaskId = String(data.taskId || "");
      postNative(data);
      return;
    }
    if (data.type === MESSAGE_TYPE && data.routeChanged) {
      currentTaskId = "";
    }
    if (data.type === "DOLA_EXTENSION_MEDIA_RESOLVED") {
      syncConversationContext();
      const nextSourceKey = String(data.sourceKey || "");
      const nextVideos = Array.isArray(data.items)
        ? data.items
          .filter((item) => item && item.type === "video" && /^https?:\/\//i.test(item.url || "") && !isRejectedDynamicWatermarkVideo(item))
          .map((item) => ({
            url: normalizeUrl(item.url),
            sourcePipeline: String(item.sourcePipeline || "")
          }))
          .filter((item) => item.url)
        : [];
      // MEDIA_STATUS/MEDIA_FOUND 每次切换历史对话都会带新的 sourceKey。
      // 直接替换而不是累加，避免把上一个历史对话的直链错误配给当前缩略图。
      resolvedSourceKey = nextSourceKey;
      resolvedVideos = Array.from(new Map(nextVideos.map((item) => [item.url, item])).values());
      resolvedRevision += 1;
      if (resolvedVideos.length) {
        postResolvedMediaToHost();
        setTimeout(postVideoPreviews, 0);
        setTimeout(reportStatus, 0);
      }
      return;
    }
    if (data.type !== MESSAGE_TYPE) return;
    if (data.url) remember(data.url, data);
    if (data.linkStatus && data.url) fplayStatuses.set(normalizeUrl(data.url), data.linkStatus);
    if (data.videoInfo && typeof data.videoInfo === "object") pushUnique(videoInfos, data.videoInfo);
  }, true);

  function postResolvedMediaToHost() {
    const selectedVideo = resolvedVideos[0] || null;
    const directVideoUrl = selectedVideo ? selectedVideo.url : "";
    if (!directVideoUrl) return;
    const media = Array.from(document.querySelectorAll("video,img"))
      .find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 60 && rect.height >= 60;
      });
    const conversationTitle = syncConversationContext() || document.title || "Dola video";
    const previewUrl = media ? previewUrlForMedia(media) : "";
    const key = media ? (previewKey(media) || directVideoUrl) : directVideoUrl;
    postNative({
      type: "DOLA_NATIVE_PREVIEW",
      key,
      directVideoUrl,
      previewUrl,
      conversationTitle,
      referer: location.href,
      title: document.title || "Dola video"
    });
  }

  setInterval(function () {
    scanPerformance();
    postVideoPreviews();
    reportStatus();
  }, 1400);
  document.addEventListener("DOMContentLoaded", updatePanel, true);
})();





