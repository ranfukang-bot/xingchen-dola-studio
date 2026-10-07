(function () {
  const PANEL_ID = "watermark-free-media-panel";
  const DOUBAO_PLAY_INFO_URL = "https://www.doubao.com/samantha/media/get_play_info?version_code=20800&language=zh-CN&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=&pc_version=2.51.7&region=&sys_region=&samantha_web=1&use-olympus-account=1&web_tab_id=";
  const items = new Map();
  if (document.getElementById(PANEL_ID)) {
    return;
  }
  const host = document.createElement("div");
  host.className = "astra-dola-media-panel";
  host.id = PANEL_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const XINGCHEN_ICON_URL = chrome.runtime.getURL("xingchen-plugin-icon.png");
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        left: 0;
        top: 16px;
        bottom: auto;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
        --xingchen-blue: #48a8ff;
        --xingchen-cyan: #62e6ff;
        --xingchen-ink: #071126;
        --xingchen-panel: #0a1832;
        --radius-lg: 16px;
        --radius-md: 12px;
        --radius-sm: 8px;
        --radius-full: 999px;
        --transition-smooth: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      :host { display: none; }
      :host(.has-media) { display: block; }

      .toggle-wrap {
        position: relative;
        width: 56px;
        height: 56px;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      .toggle-wrap:active { cursor: grabbing; }
      .toggle-btn {
        position: relative;
        width: 56px;
        height: 56px;
        padding: 5px;
        border-radius: var(--radius-full);
        border: 1px solid rgba(98, 230, 255, 0.7);
        background: radial-gradient(circle at 35% 25%, rgba(79, 172, 255, 0.42), transparent 42%), linear-gradient(145deg, #0c2144, #061124 72%);
        color: #fff;
        cursor: pointer;
        box-shadow: 0 10px 30px rgba(38, 139, 255, 0.38), inset 0 0 0 1px rgba(255,255,255,0.08);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform var(--transition-smooth), box-shadow var(--transition-smooth), border-color var(--transition-smooth);
        overflow: hidden;
      }
      .toggle-btn::after {
        content: "";
        position: absolute;
        inset: -40%;
        background: conic-gradient(from 180deg, transparent, rgba(98,230,255,.32), transparent 35%);
        animation: xingchenOrbit 5s linear infinite;
      }
      .toggle-btn:hover {
        transform: translateY(-4px) scale(1.02);
        border-color: rgba(164, 241, 255, 0.95);
        box-shadow: 0 14px 38px rgba(38, 139, 255, 0.5), 0 0 20px rgba(98, 230, 255, 0.16);
      }
      .toggle-btn:active { transform: translateY(0) scale(0.94); }
      .toggle-icon {
        position: relative;
        z-index: 1;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        object-fit: cover;
        box-shadow: 0 0 18px rgba(98,230,255,.28);
      }
      @keyframes xingchenOrbit { to { transform: rotate(360deg); } }

      .badge {
        position: absolute;
        z-index: 3;
        top: -6px;
        right: -6px;
        min-width: 24px;
        height: 24px;
        padding: 0 7px;
        border-radius: var(--radius-full);
        background: linear-gradient(135deg, #ff5577, #ff7b92);
        color: #fff;
        font-size: 12px;
        line-height: 24px;
        text-align: center;
        font-weight: 700;
        display: none;
        box-shadow: 0 5px 14px rgba(255, 85, 119, 0.42);
        border: 2px solid #071126;
      }
      .badge.show { display: block; animation: badgePop 0.35s ease; }
      @keyframes badgePop {
        0% { transform: scale(0.5); opacity: 0; }
        70% { transform: scale(1.2); }
        100% { transform: scale(1); opacity: 1; }
      }

      .panel {
        width: 380px;
        max-height: 460px;
        display: flex;
        flex-direction: column;
        color: #eaf5ff;
        background: linear-gradient(155deg, rgba(10, 24, 50, 0.97), rgba(5, 14, 31, 0.95));
        backdrop-filter: blur(20px) saturate(1.8);
        -webkit-backdrop-filter: blur(20px) saturate(1.8);
        border: 1px solid rgba(91, 190, 255, 0.32);
        border-radius: var(--radius-lg);
        box-shadow: 0 24px 70px rgba(0, 8, 24, 0.52), inset 0 1px 0 rgba(255,255,255,0.08);
        overflow: hidden;
        position: absolute;
        right: 0;
        bottom: 68px;
        opacity: 0;
        transform: translateY(16px) scale(0.96);
        pointer-events: none;
        transition: all var(--transition-smooth);
        transform-origin: bottom right;
      }
      .panel::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image: radial-gradient(circle at 12% 18%, rgba(255,255,255,.35) 0 1px, transparent 1.5px), radial-gradient(circle at 82% 34%, rgba(98,230,255,.28) 0 1px, transparent 1.5px), radial-gradient(circle at 56% 82%, rgba(72,168,255,.24) 0 1px, transparent 1.5px);
        background-size: 90px 90px, 130px 130px, 160px 160px;
        opacity: .55;
      }
      .panel.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      .panel.below {
        top: 68px;
        bottom: auto;
        transform-origin: top right;
      }
      .panel.below.left { transform-origin: top left; }
      .panel.left {
        left: 0;
        right: auto;
      }

      .header {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        background: linear-gradient(90deg, rgba(28, 76, 137, 0.32), rgba(10, 28, 58, 0.24));
        border-bottom: 1px solid rgba(103, 197, 255, 0.18);
      }
      .xingchen-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .xingchen-brand-icon {
        width: 34px;
        height: 34px;
        border-radius: 10px;
        object-fit: cover;
        border: 1px solid rgba(98,230,255,.4);
        box-shadow: 0 0 16px rgba(72,168,255,.24);
      }
      .brand-copy { min-width: 0; }
      .title { color: #f4fbff; font-size: 15px; font-weight: 700; letter-spacing: .2px; line-height: 19px; }
      .subtitle { color: #7fc8f5; font-size: 11px; line-height: 16px; letter-spacing: .4px; }
      .count {
        min-width: 28px;
        height: 28px;
        padding: 0 9px;
        border-radius: var(--radius-full);
        background: rgba(44, 141, 221, 0.2);
        border: 1px solid rgba(98,230,255,.34);
        color: #bcecff;
        font-size: 13px;
        line-height: 28px;
        text-align: center;
        font-weight: 700;
      }

      .list {
        position: relative;
        z-index: 1;
        min-height: 0;
        max-height: none;
        flex: 1 1 auto;
        overflow: auto;
        padding: 12px 14px;
      }
      .list::-webkit-scrollbar { width: 6px; }
      .list::-webkit-scrollbar-thumb { background: rgba(86,181,244,.32); border-radius: 10px; }
      .empty {
        min-height: 76px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #7d9fbd;
        font-size: 13px;
        text-align: center;
      }
      .item {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr);
        grid-template-rows: auto auto;
        align-items: center;
        gap: 7px 10px;
        padding: 11px 12px;
        margin-bottom: 9px;
        border-radius: var(--radius-md);
        background: linear-gradient(120deg, rgba(19, 48, 91, 0.75), rgba(10, 31, 64, 0.72));
        border: 1px solid rgba(92, 184, 244, 0.18);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
      }
      .item:last-child { margin-bottom: 0; }
      .media-preview-wrap {
        position: relative;
        grid-row: 1 / 3;
        width: 96px;
        height: 64px;
        overflow: hidden;
        border-radius: 9px;
        background: radial-gradient(circle at 50% 38%, rgba(72,168,255,.22), transparent 48%), #061126;
        border: 1px solid rgba(98,230,255,.28);
        box-shadow: inset 0 0 18px rgba(20,85,146,.24), 0 5px 16px rgba(0,8,24,.24);
      }
      .media-preview,
      .media-preview-placeholder {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .media-preview {
        z-index: 2;
        object-fit: cover;
        opacity: 0;
        background: #050d1d;
        transition: opacity .2s ease;
      }
      .media-preview-placeholder {
        z-index: 1;
        box-sizing: border-box;
        padding: 15px 31px;
        object-fit: contain;
        opacity: .7;
        filter: saturate(.85) drop-shadow(0 0 8px rgba(98,230,255,.24));
        transition: opacity .2s ease;
      }
      .media-preview-wrap.ready .media-preview { opacity: 1; }
      .media-preview-wrap.ready .media-preview-placeholder { opacity: 0; }
      .label { display: flex; align-items: center; gap: 8px; color: #c6dff1; font-size: 12px; min-width: 0; }
      .tag {
        min-width: 40px;
        height: 23px;
        padding: 0 8px;
        border-radius: 999px;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 23px;
        text-align: center;
        flex-shrink: 0;
      }
      .tag.video { background: linear-gradient(135deg, #277fd2, #31b7e7); }
      .tag.image { background: linear-gradient(135deg, #147f79, #29bba8); }

      button.download {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        width: 100%;
        min-width: 0;
        height: 38px;
        padding: 0 15px;
        border: 1px solid rgba(168, 235, 255, .72);
        border-radius: 999px;
        background: linear-gradient(105deg, #2f85db, #35b9dc);
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: transform .16s ease, box-shadow .16s ease, filter .16s ease;
        box-shadow: 0 8px 22px rgba(24, 126, 213, .32), inset 0 1px 0 rgba(255,255,255,.32);
        white-space: nowrap;
      }
      button.download:hover { transform: translateY(-1px); filter: brightness(1.08); box-shadow: 0 11px 28px rgba(36,145,226,.42); }
      button.download:active { transform: scale(.98); }
      button.download svg { width: 18px; height: 18px; flex: 0 0 auto; }
    </style>

    <div class="toggle-wrap">
      <button class="toggle-btn" id="toggleBtn" data-bridge="astra-open-media-picker" type="button" aria-label="打开星辰Dola无水印面板" title="星辰Dola无水印">
        <img class="toggle-icon" src="${XINGCHEN_ICON_URL}" alt="">
      </button>
      <span class="badge" id="badge">0</span>
    </div>

    <section class="panel" aria-label="星辰无水印资源面板">
      <div class="header">
        <div class="xingchen-brand">
          <img class="xingchen-brand-icon" src="${XINGCHEN_ICON_URL}" alt="">
          <div class="brand-copy">
            <div class="title">星辰Dola无水印</div>
            <div class="subtitle">原画资源直链</div>
          </div>
        </div>
        <div class="count">0</div>
      </div>
      <div class="list">
        <div class="empty">等待捕获资源</div>
      </div>
    </section>
  `;

  // ===== 星辰 UI；以下逻辑负责资源解析与下载 =====
  window.__astraOpenMediaPicker = function () {
    panel.classList.add("open");
    positionPanel();
    return items.size;
  };
  window.addEventListener("message", (event) => {
    if (event.source === window && event.data && event.data.type === "ASTRA_MEDIA_PICKER_OPEN") {
      panel.classList.add("open");
      positionPanel();
    }
  });
  const toggleBtn = shadow.querySelector("#toggleBtn");
  const panel = shadow.querySelector(".panel");
  const list = shadow.querySelector(".list");
  const countEl = shadow.querySelector(".count");
  const badge = shadow.querySelector("#badge");
  let currentSourceKey = "";
  let currentMediaPageKey = getMediaPageKey();
  let statusText = "等待捕获资源";

  const toggleWrap = shadow.querySelector(".toggle-wrap");
  const BALL_POSITION_KEY = "xingchenDolaMediaPanelBall";
  let dragState = null;
  let suppressToggleClick = false;
  let ballPosition = { x: 0, y: 16 };

  function getViewportSize() {
    return {
      width: Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0),
      height: Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0)
    };
  }

  function clampBallPosition(x, y) {
    const viewport = getViewportSize();
    const width = host.offsetWidth || 56;
    const height = host.offsetHeight || 56;
    return {
      x: Math.min(Math.max(x, 8), Math.max(8, viewport.width - width - 8)),
      y: Math.min(Math.max(y, 8), Math.max(8, viewport.height - height - 8))
    };
  }

  function saveBallPosition() {
    try {
      localStorage.setItem(BALL_POSITION_KEY, JSON.stringify(ballPosition));
    } catch (error) {
      // Storage can be unavailable; dragging still works for this page.
    }
  }

  function setBallPosition(x, y, persist) {
    const next = clampBallPosition(x, y);
    ballPosition = next;
    host.style.left = next.x + "px";
    host.style.top = next.y + "px";
    host.style.right = "auto";
    host.style.bottom = "auto";
    if (persist) saveBallPosition();
  }

  function positionPanel() {
    const rect = host.getBoundingClientRect();
    const viewport = getViewportSize();
    const edge = 12;
    const gap = 68;
    const desiredHeight = Math.min(panel.scrollHeight || panel.offsetHeight || 460, 460);
    const belowSpace = viewport.height - rect.top - gap - edge;
    const aboveSpace = rect.top - gap - edge;
    const useBelow = belowSpace >= Math.min(desiredHeight, 220) || belowSpace >= aboveSpace;
    panel.classList.toggle("below", useBelow);

    let alignLeft = panel.classList.contains("left");
    if (rect.right - (panel.offsetWidth || 380) < edge) alignLeft = true;
    if (alignLeft && rect.left + (panel.offsetWidth || 380) > viewport.width - edge) alignLeft = false;
    panel.classList.toggle("left", alignLeft);

    const available = Math.max(180, useBelow ? belowSpace : aboveSpace);
    panel.style.maxHeight = Math.min(460, available) + "px";
  }

  function initializeBallPosition() {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(BALL_POSITION_KEY) || "null");
    } catch (error) {
      stored = null;
    }
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      setBallPosition(stored.x, stored.y, false);
    } else {
      const viewport = getViewportSize();
      const ballSize = host.offsetWidth || 56;
      const defaultBottomOffset = 16 + (ballSize * 2);
      setBallPosition(
        viewport.width - ballSize - 16,
        Math.max(8, viewport.height - (host.offsetHeight || ballSize) - defaultBottomOffset),
        false
      );
    }
    positionPanel();
  }

  toggleWrap.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    event.preventDefault();
  });

  window.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
    dragState.moved = true;
    setBallPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY, false);
    if (panel.classList.contains("open")) positionPanel();
  });

  function endBallDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    if (moved) {
      saveBallPosition();
      suppressToggleClick = true;
      window.setTimeout(() => {
        suppressToggleClick = false;
      }, 0);
    }
    if (panel.classList.contains("open")) positionPanel();
  }

  window.addEventListener("pointerup", endBallDrag);
  window.addEventListener("pointercancel", endBallDrag);
  window.addEventListener("resize", () => {
    if (!dragState) setBallPosition(ballPosition.x, ballPosition.y, false);
    positionPanel();
  });

  requestAnimationFrame(initializeBallPosition);
  toggleBtn.addEventListener("click", () => {
    if (suppressToggleClick) return;
    panel.classList.toggle("open");
    positionPanel();
  });

  function updateBadge(num) {
    badge.textContent = String(num);
    if (num > 0) {
      badge.classList.add("show");
    } else {
      badge.classList.remove("show");
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "MEDIA_STATUS" && typeof message.text === "string") {
      resetForSource(message.sourceKey);
      if (!items.size) {
        announceResolvedItems(message.sourceKey, []);
      }
      statusText = items.size ? "" : message.text;
      render();
      return;
    }
    if (message.type === "MEDIA_FOUND" && Array.isArray(message.items)) {
      resetForSource(message.sourceKey);
      mergeResolvedMediaItems(message.items);
      announceResolvedItems(message.sourceKey, Array.from(items.values()));
      statusText = items.size ? "" : "未提取到无水印原画资源";
      render();
      return;
    }
    if (message.type === "DOUBAO_VIDS_FOUND" && Array.isArray(message.vids)) {
      resetForSource(message.sourceKey);
      fetchDoubaoVideos(message.sourceKey, message.vids);
    }
  });

  setInterval(() => {
    if (!syncMediaScope(getMediaPageKey())) return;
    announceResolvedItems("", []);
    render();
  }, 500);

  // The inline preview button is injected by the desktop host and does not
  // have access to chrome.runtime.  Route it through this content script so
  // it uses the exact same resolved, watermark-free URL as the floating panel.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== "DOLA_EXTENSION_DOWNLOAD_CURRENT") return;
    const video = Array.from(items.values()).find((item) => item && item.type === "video" && isHttpUrl(item.url));
    if (!video) return;
    chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: video.url, sourcePipeline: video.sourcePipeline || "" });
  }, true);

  async function fetchDoubaoVideos(sourceKey, vids) {
    const uniqueVids = Array.from(new Set(vids.filter((vid) => typeof vid === "string" && vid)));
    if (!uniqueVids.length) return;
    statusText = items.size ? "" : "正在获取豆包无水印视频";
    render();
    const foundItems = [];
    for (const vid of uniqueVids) {
      const url = await getDoubaoOriginalVideoUrl(vid);
      if (isHttpUrl(url)) {
        foundItems.push({ type: "video", url });
      }
    }
    if (sourceKey !== currentSourceKey) return;
    addItems(foundItems);
    announceResolvedItems(sourceKey, Array.from(items.values()));
    statusText = items.size ? "" : "未提取到资源";
    render();
  }

  async function getDoubaoOriginalVideoUrl(vid) {
    try {
      const response = await fetch(DOUBAO_PLAY_INFO_URL, {
        method: "POST",
        credentials: "omit",
        headers: {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json"
        },
        body: JSON.stringify({ key: vid })
      });
      const json = await response.json();
      const url = json?.data?.original_media_info?.main_url;
      return isHttpUrl(url) ? url : "";
    } catch (error) {
      console.warn("doubao play info failed:", error);
      return "";
    }
  }

  function getMediaPageKey() {
    return location.origin + location.pathname + location.search;
  }

  function syncMediaScope(nextPageKey) {
    const normalizedPageKey = String(nextPageKey || "");
    if (!normalizedPageKey || normalizedPageKey === currentMediaPageKey) return false;
    currentMediaPageKey = normalizedPageKey;
    currentSourceKey = "";
    items.clear();
    statusText = "";
    return true;
  }

  function resetForSource(sourceKey) {
    syncMediaScope(getMediaPageKey());
    if (typeof sourceKey === "string" && sourceKey) {
      currentSourceKey = sourceKey;
    }
  }

  function createMediaPreview(item) {
    const previewWrap = document.createElement("div");
    previewWrap.className = "media-preview-wrap";
    previewWrap.title = item.type === "image" ? "图片预览" : "视频预览";

    const placeholder = document.createElement("img");
    placeholder.className = "media-preview-placeholder";
    placeholder.src = XINGCHEN_ICON_URL;
    placeholder.alt = "";
    previewWrap.appendChild(placeholder);

    const revealPreview = () => previewWrap.classList.add("ready");
    const previewUrl = isHttpUrl(item.previewUrl) ? item.previewUrl : "";
    if (item.type === "image") {
      const previewImage = document.createElement("img");
      previewImage.className = "media-preview media-preview-image";
      previewImage.alt = "图片预览";
      previewImage.loading = "lazy";
      previewImage.addEventListener("load", revealPreview, { once: true });
      previewImage.src = previewUrl || item.url;
      previewWrap.appendChild(previewImage);
      return previewWrap;
    }

    const previewVideo = document.createElement("video");
    previewVideo.className = "media-preview media-preview-video";
    previewVideo.preload = "metadata";
    previewVideo.muted = true;
    previewVideo.playsInline = true;
    previewVideo.controls = false;
    previewVideo.disablePictureInPicture = true;
    if (previewUrl) {
      previewVideo.poster = previewUrl;
      const posterProbe = new Image();
      posterProbe.addEventListener("load", revealPreview, { once: true });
      posterProbe.src = previewUrl;
    }
    previewVideo.addEventListener("loadeddata", revealPreview, { once: true });
    previewVideo.addEventListener("canplay", revealPreview, { once: true });
    previewVideo.addEventListener("seeked", revealPreview, { once: true });
    previewVideo.addEventListener("loadedmetadata", () => {
      if (previewVideo.readyState >= 2) {
        revealPreview();
        return;
      }
      try {
        const duration = Number.isFinite(previewVideo.duration) ? previewVideo.duration : 0;
        previewVideo.currentTime = duration > 0 ? Math.min(0.1, duration / 20) : 0;
      } catch {}
    }, { once: true });
    previewVideo.src = item.url;
    previewWrap.appendChild(previewVideo);
    return previewWrap;
  }

  function render() {
    const total = items.size;
    host.classList.toggle("has-media", total > 0);
    countEl.textContent = String(total);
    updateBadge(total);
    list.textContent = "";
    if (!total) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = statusText || "等待捕获资源";
      list.appendChild(empty);
      return;
    }
    Array.from(items.values()).forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "item";
      row.dataset.sourcePipeline = String(item.sourcePipeline || "");
      const preview = createMediaPreview(item);
      const label = document.createElement("div");
      label.className = "label";
      label.title = item.url;
      const tag = document.createElement("span");
      tag.className = `tag ${item.type}`;
      tag.textContent = item.type === "image" ? "图片" : "视频";
      const indexText = document.createElement("span");
      indexText.textContent = String(index + 1);
      label.append(tag, indexText);
      const button = document.createElement("button");
      button.className = "download";   // ← 保持原 class
      button.type = "button";
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 16v2.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>去水印下载</span>';
      button.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: item.url, sourcePipeline: item.sourcePipeline || "" });
      });
      row.append(preview, label, button);
      list.appendChild(row);
    });
    if (panel.classList.contains("open")) {
      requestAnimationFrame(positionPanel);
    }
  }



  function isRejectedDynamicWatermarkVideo(item) {
    if (!item || item.type === "image") return false;
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

  function normalizeResolvedItem(item) {
    if (!item || typeof item.url !== "string" || !isHttpUrl(item.url) || isRejectedDynamicWatermarkVideo(item)) {
      return null;
    }
    return {
      type: item.type === "image" ? "image" : "video",
      url: item.url,
      codec: String(item.codec || item.videoCodec || item.video_codec || ""),
      label: String(item.label || item.format || ""),
      previewUrl: String(
        item.previewUrl ||
        item.PreviewUrl ||
        item.poster ||
        item.posterUrl ||
        item.coverUrl ||
        item.thumbnailUrl ||
        ""
      ),
      sourcePipeline: String(item.sourcePipeline || "")
    };
  }

  function getMediaIdentityKey(item) {
    const type = item && item.type === "image" ? "image" : "video";
    const rawUrl = String(item && item.url || "");
    try {
      const parsed = new URL(rawUrl);
      const match = parsed.pathname.match(/\/video\/tos\/mya\/([^/?#]+)\/([^/?#]+)(?:\/|$)/i);
      if (match) {
        return type + ":dola:" + String(match[1]).toLowerCase() + ":" + String(match[2]);
      }
    } catch {}
    return type + ":url:" + rawUrl;
  }

  function addItems(nextItems) {
    for (const item of nextItems) {
      const safeItem = normalizeResolvedItem(item);
      if (!safeItem) continue;
      items.set(getMediaIdentityKey(safeItem), safeItem);
    }
  }

  function mergeResolvedMediaItems(nextItems) {
    addItems(Array.isArray(nextItems) ? nextItems : []);
    return Array.from(items.values());
  }

  function announceResolvedItems(sourceKey, nextItems) {
    const safeItems = Array.isArray(nextItems)
      ? nextItems.map(normalizeResolvedItem).filter(Boolean)
      : [];
    window.postMessage({
      type: "DOLA_EXTENSION_MEDIA_RESOLVED",
      sourceKey: typeof sourceKey === "string" ? sourceKey : "",
      items: safeItems
    }, location.origin);
  }

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(url);
  }
})();
