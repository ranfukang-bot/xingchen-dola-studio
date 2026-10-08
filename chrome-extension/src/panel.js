/**
 * 面板 + 编排器：跑在隔离世界（有 chrome.* 权限）。
 *
 * 最关键的设计：换账号必须刷新页面，一刷新脚本就重跑，内存全丢。
 * 所以——
 *   · 进度状态存 chrome.storage.local
 *   · 图片（File 对象）存 IndexedDB（能存 Blob，且扛得住刷新）
 * 每次页面加载都从这两处把状态捞回来接着跑，而不是从头开始。
 */
(function () {
  'use strict';
  if (window.__XCB_PANEL__) return;
  window.__XCB_PANEL__ = true;

  const NS = 'XCB';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * Math.max(0, b - a));

  /* ==================== 与引擎（主世界）通信 ==================== */
  let msgSeq = 0;
  const pending = new Map();
  const engineEvents = { submit: [], media: [], ready: [] };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__xcb !== NS || d.dir !== 'evt') return;

    if (d.type.startsWith('reply:')) {
      const id = d.type.slice(6);
      const r = pending.get(id);
      if (r) { pending.delete(id); r(d.data); }
      return;
    }
    const bucket = engineEvents[d.type];
    if (bucket) bucket.splice(0, 0, { at: Date.now(), data: d.data });
  });

  function callEngine(type, data, timeout = 30000) {
    const id = String(++msgSeq);
    return new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(id); resolve({ ok: false, msg: '引擎超时' }); }, timeout);
      pending.set(id, (v) => { clearTimeout(t); resolve(v); });
      window.postMessage({ __xcb: NS, dir: 'cmd', id, type, data }, location.origin);
    });
  }

  /** 取最近一次某类事件（并清空），用于等结果 */
  function takeEvent(kind, sinceTs) {
    const list = engineEvents[kind] || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].at >= sinceTs) { const e = list[i]; list.length = 0; return e.data; }
    }
    return null;
  }

  /* ==================== IndexedDB：存任务素材 ==================== */
  const DB = 'xcb-db', STORE = 'tasks';
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbPut(rec) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
  }
  async function dbGet(id) {
    const db = await openDB();
    return new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly');
      const q = tx.objectStore(STORE).get(id);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  }
  async function dbClear() {
    const db = await openDB();
    return new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    });
  }

  /* ==================== 状态 ==================== */
  const DEFAULT_STATE = {
    running: false,
    phase: 'idle',               // idle | submit | collect
    currentAccountId: '',        // 当前浏览器里装的是哪个账号的 Cookie
    config: {
      prefix: '不要说任何废话，不要让我进行任何二次确定，不要问我任何问题，直接按照你的理解直接生成视频：',
      model: '2.5',
      duration: 30,
      ratio: '9:16',
      perAccount: 1,
      gapMin: 45000,
      gapMax: 90000
    },
    accounts: [],
    tasks: [],
    log: []
  };

  let S = null;

  async function loadState() {
    const r = await chrome.runtime.sendMessage({ type: 'getState' });
    S = (r && r.state) ? { ...DEFAULT_STATE, ...r.state, config: { ...DEFAULT_STATE.config, ...(r.state.config || {}) } } : { ...DEFAULT_STATE };
    return S;
  }
  async function saveState() {
    if (S.log.length > 400) S.log = S.log.slice(-400);
    await chrome.runtime.sendMessage({ type: 'setState', state: S });
  }

  function log(msg, kind) {
    const line = { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), msg, kind: kind || 'info' };
    S.log.push(line);
    renderLog();
    // eslint-disable-next-line no-console
    console.log('[星辰批量]', msg);
  }

  /* ==================== 页面操作 ==================== */
  const CTRL = 'data-input-engine-actionbar-control-key';

  async function waitFor(fn, timeout = 20000, step = 400) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (_) { /* 继续 */ }
      await sleep(step);
    }
    return null;
  }

  function visible(el) {
    return el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function textOf(el) {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  /** 在动作条上找控件：model / duration / ratio */
  function findControl(kind) {
    const exact = [`[${CTRL}="video-${kind}"]`, `[${CTRL}="${kind}"]`, `[${CTRL}*="${kind}"]`];
    for (const s of exact) {
      const el = document.querySelector(s);
      if (visible(el)) return el;
    }
    const pat = {
      model: /模型|seedance|\d\.\d/i,
      duration: /^\s*\d+\s*(s|秒)\s*$|时长/i,
      ratio: /\d+\s*[:：]\s*\d+|比例/
    }[kind];
    for (const el of document.querySelectorAll(`[${CTRL}]`)) {
      if (visible(el) && pat && pat.test(textOf(el))) return el;
    }
    return null;
  }

  function clickableByText(re) {
    const tags = 'button,[role=button],[role=menuitem],[role=option],li,div,span';
    const hits = [];
    for (const el of document.querySelectorAll(tags)) {
      if (!visible(el) || el.children.length > 2) continue;
      if (re.test(textOf(el))) hits.push(el);
    }
    return hits.length ? hits[hits.length - 1] : null;
  }

  function variants(target) {
    const t = String(target);
    const out = [t];
    if (/^\d+:\d+$/.test(t)) out.push(t.replace(':', '：'));
    if (/^\d+$/.test(t)) out.push(t + 's', t + '秒');
    if (t === '2.5') out.push('Seedance 2.5');
    return [...new Set(out)];
  }

  async function pickOption(ctrl, target, accept, label) {
    if (!ctrl) { log(`没找到${label}控件`, 'warn'); return false; }
    if (accept.test(textOf(ctrl))) { log(`${label}已是 ${target}`, 'dim'); return true; }

    ctrl.click();
    await sleep(500);
    for (const v of variants(target)) {
      const item = clickableByText(new RegExp('^\\s*' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'));
      if (item) {
        item.click();
        await sleep(600);
        if (accept.test(textOf(ctrl))) { log(`${label} → ${target}`, 'ok'); return true; }
      }
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const now = textOf(ctrl);
    if (accept.test(now)) return true;
    log(`${label}没能设成 ${target}（当前「${now}」）`, 'warn');
    return false;
  }

  async function ensureVideoMode() {
    const body = document.body ? document.body.innerText : '';
    if (/视频生成\s*[×x✕]/.test(body)) return true;
    const btn = clickableByText(/^\s*视频生成\s*$/);
    if (btn) { btn.click(); await sleep(1200); return true; }
    return false;
  }

  function findComposer() {
    const sels = [
      'textarea[placeholder*="描述"]',
      'textarea[placeholder*="发送消息"]',
      '[contenteditable="true"][data-slate-editor]',
      '[contenteditable="true"]',
      'textarea'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (visible(el)) return el;
    }
    return null;
  }

  async function fillPrompt(text) {
    const el = findComposer();
    if (!el) throw new Error('找不到提示词输入框');
    el.focus();
    el.click();
    await sleep(150);

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      setter.set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // 富文本编辑器：用 execCommand 插入，React 才认
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
    await sleep(400);
    return true;
  }

  async function submitPrompt() {
    const sels = ['button[aria-label*="发送"]', 'button[aria-label*="Send"]', '[data-testid*="send"]', 'button[type=submit]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (visible(el) && !el.disabled) { el.click(); return true; }
    }
    const el = findComposer();
    if (el) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return true;
    }
    throw new Error('找不到发送方式');
  }

  async function waitUploadDone(timeout = 120000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const t = document.body ? document.body.innerText : '';
      if (!/上传中|正在上传|uploading/i.test(t)) { await sleep(1000); return true; }
      await sleep(1500);
    }
    return false;
  }

  /* ==================== 账号 ==================== */
  async function switchAccount(acct) {
    log(`切到账号「${acct.name}」，写入 Cookie…`);
    const r = await chrome.runtime.sendMessage({ type: 'applyCookies', text: acct.cookie });
    if (!r || !r.ok) { throw new Error('写 Cookie 失败：' + ((r && r.msg) || '未知')); }
    log(`Cookie 写入 ${r.written}/${r.total} 条，刷新页面…`, 'ok');
    S.currentAccountId = acct.id;
    await saveState();
    location.href = 'https://www.dola.com/chat';
    await sleep(60000); // 等刷新接管，不会真的跑到这
  }

  function loggedIn() {
    const t = document.body ? document.body.innerText : '';
    if (/描述你想要|新对话|发送消息/.test(t)) return true;
    if (/请登录|游客|Log ?in/i.test(t)) return false;
    return true;
  }

  /* ==================== 一条任务 ==================== */
  async function runTask(task) {
    log(`—— 任务 ${task.name} ——`);

    const rec = await dbGet(task.id);
    if (!rec) throw new Error('素材丢了（IndexedDB 里没有），请重新选队列文件夹');

    await ensureVideoMode();
    await sleep(300);

    await pickOption(findControl('model'), S.config.model,
      new RegExp(String(S.config.model).replace('.', '\\.')), '模型');

    await callEngine('setDuration', { seconds: S.config.duration });
    await pickOption(findControl('duration'), S.config.duration + 's',
      new RegExp('\\b' + S.config.duration + '\\s*(s|秒)'), '时长');

    await pickOption(findControl('ratio'), S.config.ratio,
      new RegExp(String(S.config.ratio).replace(':', '\\s*[:：]\\s*')), '比例');

    if (rec.images && rec.images.length) {
      const up = await callEngine('upload', { files: rec.images });
      if (!up || !up.ok) log('传图失败：' + ((up && up.msg) || '未知') + '（继续，但这条可能没带参考图）', 'warn');
      else { log(`已投入 ${up.count} 张参考图，等上传完成…`); await waitUploadDone(); }
    }

    const full = S.config.prefix + rec.prompt;
    await fillPrompt(full);
    log(`提示词已填（${full.length} 字）`);

    const t0 = Date.now();
    await submitPrompt();
    log('已发送，等待受理…');

    // 等引擎报结果（它钩着 /chat/completion 的返回）
    const end = Date.now() + 180000;
    while (Date.now() < end) {
      const ev = takeEvent('submit', t0);
      if (ev) {
        if (ev.accepted) return { ok: true, conversationId: ev.conversationId };
        return { ok: false, code: ev.code, msg: ev.msg };
      }
      const txt = document.body ? document.body.innerText : '';
      if (/将消耗\s*\d+\s*个视频生成额度|预计等待|视频生成好后/.test(txt)) {
        return { ok: true, conversationId: (location.pathname.match(/\/chat\/(\d{10,25})/) || [])[1] || '' };
      }
      await sleep(2000);
    }
    return { ok: false, code: 'UNCERTAIN', msg: '等待超时，没确认是否受理' };
  }

  /* ==================== 编排：提交阶段 ==================== */
  async function pumpSubmit() {
    const task = S.tasks.find((t) => t.status === 'pending');
    if (!task) {
      log('全部提交完毕，转入收片阶段', 'ok');
      S.phase = 'collect';
      await saveState();
      return pump();
    }

    // 这条该用哪个账号
    let acct = S.accounts.find((a) => !a.dead && a.used < S.config.perAccount);
    if (!acct) {
      log('没有可用账号了（都用满或失效），停止', 'warn');
      S.running = false; S.phase = 'idle';
      await saveState(); renderAll();
      return;
    }

    if (S.currentAccountId !== acct.id) {
      await switchAccount(acct);
      return; // 刷新后会重新进来
    }

    if (!loggedIn()) {
      log(`账号「${acct.name}」登录态无效，标记跳过`, 'warn');
      acct.dead = true;
      await saveState();
      return pump();
    }

    // 每条任务必须在全新对话里开始，否则会接着上一条的上下文。
    // 注意：/chat/123 也以 /chat 开头，所以必须精确判断。
    if (location.pathname !== '/chat' && location.pathname !== '/chat/') {
      log('回到新对话页…', 'dim');
      location.href = 'https://www.dola.com/chat';
      await sleep(60000);
      return; // 刷新后任务仍是 pending，会重新进来
    }

    task.status = 'running';
    task.accountId = acct.id;
    await saveState();

    let res;
    try {
      res = await runTask(task);
    } catch (err) {
      res = { ok: false, code: 'ERROR', msg: String(err && err.message || err) };
    }

    if (res.ok) {
      task.status = 'submitted';
      task.conversationId = res.conversationId || '';
      task.submittedAt = Date.now();   // 收片阶段靠它判断「等太久了」
      acct.used++;
      log(`${task.name} 已受理${res.conversationId ? '（会话 ' + res.conversationId + '）' : ''}`, 'ok');
    } else if (['QUOTA_EXHAUSTED', 'QUOTA_CREDITS', 'EXPERT_QUOTA'].includes(res.code)) {
      log(`账号「${acct.name}」额度耗尽：${res.msg} → 换号`, 'warn');
      acct.used = S.config.perAccount;
      task.status = 'pending';
    } else if (res.code === 'LOGIN_REQUIRED') {
      log(`账号「${acct.name}」掉登录 → 换号`, 'warn');
      acct.dead = true;
      task.status = 'pending';
    } else {
      task.status = 'failed';
      task.error = res.msg || res.code;
      log(`${task.name} 失败：${task.error}`, 'err');
    }

    await saveState();
    renderAll();

    if (!S.running) return;
    const gap = rand(S.config.gapMin, S.config.gapMax);
    log(`等 ${Math.round(gap / 1000)} 秒…`, 'dim');
    await sleep(gap);
    return pump();
  }

  /* ==================== 编排：收片阶段 ==================== */
  async function pumpCollect() {
    const task = S.tasks.find((t) => t.status === 'submitted' && t.conversationId);
    if (!task) {
      // 还在生成中的（waiting）不能算收完，得等下一轮再扫
      if (S.tasks.some((t) => t.status === 'waiting')) return finishOrWait();

      const noId = S.tasks.filter((t) => t.status === 'submitted');
      if (noId.length) {
        noId.forEach((t) => { t.status = 'missed'; t.error = '没拿到会话号，收不了'; });
        log(`${noId.length} 条没有会话号，列为漏网`, 'warn');
      } else {
        log('全部收完', 'ok');
      }
      S.running = false; S.phase = 'idle';
      await saveState(); renderAll();
      return;
    }

    const acct = S.accounts.find((a) => a.id === task.accountId);
    if (!acct) { task.status = 'missed'; task.error = '找不到当初的账号'; await saveState(); return pump(); }

    if (S.currentAccountId !== acct.id) {
      await switchAccount(acct);
      return;
    }

    const target = '/chat/' + task.conversationId;
    if (location.pathname !== target) {
      log(`回到 ${task.name} 的会话取片…`);
      location.href = 'https://www.dola.com' + target;
      await sleep(60000);
      return;
    }

    await callEngine('resetMedia', {});
    await sleep(500);
    // 滚一下触发懒加载
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(3000);

    const r = await callEngine('collectMedia', {});
    const items = (r && r.items) || [];
    if (!items.length) {
      const age = Date.now() - (task.submittedAt || 0);
      if (age > 3 * 3600 * 1000) {
        task.status = 'missed';
        task.error = '等了 3 小时还没出片';
        log(`${task.name} 超时未出片，列为漏网`, 'warn');
      } else {
        log(`${task.name} 还没生成好，稍后再来`, 'dim');
        task.retryAt = Date.now() + 20 * 60 * 1000;
        task.status = 'waiting';
      }
      await saveState();
      return finishOrWait();
    }

    const url = items[0];
    log(`拿到地址，开始下载 ${task.name}…`);
    const dl = await callEngine('download', { url, filename: task.name + '.mp4' }, 180000);
    if (dl && dl.ok) {
      task.status = 'done';
      log(`${task.name} 已下载（${(dl.size / 1048576).toFixed(1)} MB）`, 'ok');
    } else {
      task.status = 'missed';
      task.error = '下载失败：' + ((dl && dl.msg) || '未知');
      log(`${task.name} 下载失败：${task.error}`, 'err');
    }
    await saveState();
    renderAll();
    await sleep(3000);
    return pump();
  }

  async function finishOrWait() {
    const waiting = S.tasks.filter((t) => t.status === 'waiting');
    if (!waiting.length) return pump();
    // 把 waiting 恢复成 submitted，等下一轮
    const soon = Math.min(...waiting.map((t) => t.retryAt || 0));
    const wait = Math.max(60000, soon - Date.now());
    log(`${waiting.length} 条还在生成，${Math.round(wait / 60000)} 分钟后再扫一轮`, 'dim');
    await sleep(wait);
    waiting.forEach((t) => { t.status = 'submitted'; });
    await saveState();
    return pump();
  }

  async function pump() {
    if (!S.running) return;
    if (S.phase === 'submit') return pumpSubmit();
    if (S.phase === 'collect') return pumpCollect();
  }

  /* ==================== 队列文件夹解析 ==================== */
  const IMG = /\.(jpe?g|png|webp|apng)$/i;

  async function loadFolder(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const groups = new Map();
    for (const f of files) {
      const parts = (f.webkitRelativePath || f.name).split('/');
      if (parts.length < 2) continue;
      const folder = parts[1];                 // parts[0] 是你选的那个总文件夹
      if (!folder || folder.startsWith('_') || folder.startsWith('.')) continue;
      if (!groups.has(folder)) groups.set(folder, { images: [], prompt: null });
      const g = groups.get(folder);
      const base = parts[parts.length - 1];
      if (/^(prompt\.(txt|md)|提示词\.txt)$/i.test(base)) g.prompt = f;
      else if (IMG.test(base) && !base.startsWith('.')) g.images.push(f);
    }

    await dbClear();
    const tasks = [];
    const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));

    for (const name of names) {
      const g = groups.get(name);
      if (!g.prompt) { log(`跳过 ${name}：没有 prompt.txt`, 'warn'); continue; }
      const prompt = (await g.prompt.text()).replace(/^﻿/, '').trim();
      if (!prompt) { log(`跳过 ${name}：提示词是空的`, 'warn'); continue; }
      g.images.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

      const id = 'T' + Math.random().toString(36).slice(2, 10);
      await dbPut({ id, prompt, images: g.images.slice(0, 30) });
      tasks.push({
        id, name, status: 'pending', imageCount: g.images.length,
        accountId: '', conversationId: '', error: '', submittedAt: 0
      });
    }

    S.tasks = tasks;
    await saveState();
    log(`已载入 ${tasks.length} 条任务`, 'ok');
    renderAll();
  }

  /** 账号 id 必须由 Cookie 内容派生、保持稳定——
   *  用随机数的话，每次重新解析 id 就变了，currentAccountId 永远对不上，
   *  会导致无限换号刷新。 */
  function hashOf(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function parseAccounts(text) {
    const blocks = String(text || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const old = new Map((S.accounts || []).map((a) => [a.id, a]));
    return blocks.map((cookie, i) => {
      const id = 'A' + hashOf(cookie);
      const prev = old.get(id);
      return {
        id,
        name: 'Dola ' + (i + 1),
        cookie,
        used: prev ? prev.used : 0,      // 重新粘贴不清零已用次数
        dead: prev ? prev.dead : false
      };
    });
  }

  /* ==================== UI ==================== */
  let root, logBox, statBox;

  function buildUI() {
    root = document.createElement('div');
    root.id = 'xcb-root';
    root.innerHTML = `
      <div id="xcb-tab" title="星辰Dola 批量生成">批量</div>
      <div id="xcb-panel">
        <div class="xcb-head">
          <strong>星辰Dola 批量生成</strong>
          <span id="xcb-close">×</span>
        </div>
        <div class="xcb-body">
          <div class="xcb-sec">
            <label>1 · 队列文件夹</label>
            <input type="file" id="xcb-folder" webkitdirectory directory multiple>
            <div class="xcb-hint">选中装着 001-xxx/、002-xxx/ 的那个总文件夹。每个子文件夹里要有 prompt.txt + 图片。</div>
          </div>

          <div class="xcb-sec">
            <label>2 · 账号 Cookie（一个账号一段，中间空一行）</label>
            <textarea id="xcb-accounts" rows="4" placeholder="第一个账号的 Cookie&#10;&#10;第二个账号的 Cookie"></textarea>
            <div class="xcb-hint">请求头原文 / JSON 数组 / Netscape 三种格式都认。</div>
          </div>

          <div class="xcb-sec">
            <label>3 · 提示词前缀（自动加在每条最前面）</label>
            <textarea id="xcb-prefix" rows="3"></textarea>
          </div>

          <div class="xcb-sec xcb-grid">
            <div><label>模型</label><input type="text" id="xcb-model"></div>
            <div><label>时长(秒)</label><input type="text" id="xcb-duration"></div>
            <div><label>比例</label><input type="text" id="xcb-ratio"></div>
            <div><label>每号几条</label><input type="text" id="xcb-per"></div>
          </div>

          <div class="xcb-stat" id="xcb-stat"></div>

          <div class="xcb-row">
            <button id="xcb-start" class="xcb-primary">开始</button>
            <button id="xcb-collect">只收片</button>
            <button id="xcb-stop">停止</button>
            <button id="xcb-reset" class="xcb-danger">清空</button>
          </div>

          <div class="xcb-log" id="xcb-log"></div>
        </div>
      </div>`;
    document.documentElement.appendChild(root);

    logBox = root.querySelector('#xcb-log');
    statBox = root.querySelector('#xcb-stat');

    const panel = root.querySelector('#xcb-panel');
    root.querySelector('#xcb-tab').onclick = () => panel.classList.toggle('open');
    root.querySelector('#xcb-close').onclick = () => panel.classList.remove('open');

    root.querySelector('#xcb-folder').onchange = (e) => loadFolder(e.target.files);

    root.querySelector('#xcb-accounts').onchange = async (e) => {
      S.accounts = parseAccounts(e.target.value);
      await saveState();
      log(`已载入 ${S.accounts.length} 个账号`, 'ok');
      renderAll();
    };

    const bindCfg = (sel, key, cast) => {
      const el = root.querySelector(sel);
      el.onchange = async () => { S.config[key] = cast ? cast(el.value) : el.value; await saveState(); };
    };
    bindCfg('#xcb-prefix', 'prefix');
    bindCfg('#xcb-model', 'model');
    bindCfg('#xcb-duration', 'duration', Number);
    bindCfg('#xcb-ratio', 'ratio');
    bindCfg('#xcb-per', 'perAccount', Number);

    root.querySelector('#xcb-start').onclick = async () => {
      if (!S.tasks.length) return log('先选队列文件夹', 'warn');
      if (!S.accounts.length) return log('先填账号 Cookie', 'warn');
      S.running = true; S.phase = 'submit';
      await saveState(); renderAll();
      log('开始跑', 'ok');
      pump();
    };
    root.querySelector('#xcb-collect').onclick = async () => {
      S.running = true; S.phase = 'collect';
      await saveState(); renderAll();
      log('只收片模式', 'ok');
      pump();
    };
    root.querySelector('#xcb-stop').onclick = async () => {
      S.running = false; S.phase = 'idle';
      await saveState(); renderAll();
      log('已停止', 'warn');
    };
    root.querySelector('#xcb-reset').onclick = async () => {
      if (!confirm('清空全部任务、账号和进度？')) return;
      await dbClear();
      S = { ...DEFAULT_STATE };
      await saveState();
      renderAll(); renderLog();
      log('已清空', 'ok');
    };
  }

  function renderConfig() {
    root.querySelector('#xcb-prefix').value = S.config.prefix;
    root.querySelector('#xcb-model').value = S.config.model;
    root.querySelector('#xcb-duration').value = S.config.duration;
    root.querySelector('#xcb-ratio').value = S.config.ratio;
    root.querySelector('#xcb-per').value = S.config.perAccount;
    const ta = root.querySelector('#xcb-accounts');
    if (!ta.value && S.accounts.length) ta.value = S.accounts.map((a) => a.cookie).join('\n\n');
  }

  function renderAll() {
    if (!root) return;
    const n = (st) => S.tasks.filter((t) => t.status === st).length;
    statBox.innerHTML =
      `任务 ${S.tasks.length}　待做 ${n('pending')}　已交 ${n('submitted') + n('waiting')}　已下 ${n('done')}　` +
      `失败 ${n('failed') + n('missed')}　|　账号 ${S.accounts.length}　` +
      `状态 <b>${S.running ? (S.phase === 'submit' ? '提交中' : '收片中') : '空闲'}</b>`;
  }

  function renderLog() {
    if (!logBox) return;
    logBox.innerHTML = S.log.slice(-120).map((l) =>
      `<div class="xcb-l xcb-${l.kind}"><span>${l.at}</span>${escapeHtml(l.msg)}</div>`).join('');
    logBox.scrollTop = logBox.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  /* ==================== 启动 ==================== */
  (async function boot() {
    await loadState();

    // 意外刷新（或换账号刷新）时卡在 running 的任务，捡回来重做，
    // 否则它既不是 pending 也不是 submitted，会被永远跳过。
    const stuck = S.tasks.filter((t) => t.status === 'running');
    if (stuck.length) {
      stuck.forEach((t) => { t.status = 'pending'; });
      await saveState();
    }

    buildUI();
    renderConfig();
    renderAll();
    renderLog();

    // 页面刷新后自动接着跑（换账号会刷新，这步是续跑的关键）
    if (S.running) {
      root.querySelector('#xcb-panel').classList.add('open');
      log('检测到未完成的任务，继续…', 'ok');
      await sleep(3000);
      pump();
    }
  })();
})();
