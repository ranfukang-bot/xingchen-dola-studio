'use strict';
/**
 * 浏览器上下文：每个账号一个完全隔离的 context。
 *
 * 关键在于 addInitScript —— 在页面任何脚本之前，先
 *   1. 写入 30 秒解锁开关（intl_doubao_enable_30s_v1）
 *   2. 注入原版的 dola-15s-dom-request-hook.js（改写 ability_param.duration）
 *   3. 注入原版的 dola-reference-materials.js（参考图上传管线）
 *
 * 这几个脚本是原封不动搬过来的，所以上传走的是 Dola 自己的链路，
 * 不需要逆向它的 VOD/ImageX 接口。
 */
const fs = require('fs');
const path = require('path');

// 懒加载：没装 playwright 时也能单独用本模块的解析函数（便于自检）
let _chromium = null;
function chromium() {
  if (!_chromium) _chromium = require('playwright').chromium;
  return _chromium;
}

const VENDOR = path.join(__dirname, '..', 'vendor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------- Cookie 解析（三种格式，与创作台一致） ---------------- */
function parseCookies(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  return parseJsonArray(t) || parseNetscape(t) || parseHeader(t) || [];
}

function parseJsonArray(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) { return null; }
  if (!Array.isArray(data)) return null;
  return data.filter((c) => c && c.name).map((c) => ({
    name: String(c.name),
    value: String(c.value == null ? '' : c.value),
    domain: c.domain ? String(c.domain) : '.dola.com',
    path: c.path ? String(c.path) : '/',
    secure: c.secure !== false,
    httpOnly: !!c.httpOnly,
    expires: Number(c.expirationDate || c.expires || 0) || -1,
    sameSite: sameSite(c.sameSite)
  }));
}

function parseNetscape(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const f = s.split('\t');
    if (f.length < 7) continue;
    out.push({
      domain: f[0], path: f[2] || '/',
      secure: String(f[3]).toUpperCase() === 'TRUE',
      expires: Number(f[4]) || -1,
      name: f[5], value: f[6], sameSite: 'Lax'
    });
  }
  return out.length ? out : null;
}

function parseHeader(text) {
  const out = [];
  const body = text.replace(/^\s*cookie\s*:/i, '').trim();
  for (const part of body.split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out.push({
      name: part.slice(0, i).trim(),
      value: part.slice(i + 1).trim(),
      domain: '.dola.com', path: '/', secure: true, sameSite: 'Lax', expires: -1
    });
  }
  return out.length ? out : null;
}

function sameSite(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return 'Lax';
}

/* ---------------- 启动 ---------------- */
let browser = null;

async function launch(cfg) {
  if (browser) return browser;
  const b = cfg['浏览器'] || {};
  browser = await chromium().launch({
    headless: !!b.headless,
    slowMo: Number(b['慢放毫秒']) || 0,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });
  return browser;
}

async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

function readVendor(name) {
  try { return fs.readFileSync(path.join(VENDOR, name), 'utf8'); }
  catch (_) { return ''; }
}

/**
 * 为某个账号开一个隔离上下文。
 * @param {object} account {id,name,cookie,proxy}
 */
async function contextFor(account, cfg) {
  const b = await launch(cfg);
  const bc = cfg['浏览器'] || {};
  const seconds = Number((cfg['生成参数'] || {})['时长秒']) === 15 ? 15 : 30;

  const ctx = await b.newContext({
    userAgent: UA,
    viewport: { width: Number(bc['窗口宽']) || 1440, height: Number(bc['窗口高']) || 960 },
    locale: bc['语言'] || 'zh-CN',
    timezoneId: bc['时区'] || 'Asia/Shanghai',
    proxy: account.proxy ? { server: account.proxy } : undefined,
    acceptDownloads: true
  });

  // 1) 反自动化特征 + 时长解锁开关，必须早于页面脚本
  await ctx.addInitScript(({ sec }) => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (_) {}
    try {
      // 与原版「30 秒」按钮写的是同一组键
      localStorage.setItem('intl_doubao_enable_' + sec + 's_v1', '1');
      localStorage.setItem('intl_doubao_enable_' + (sec === 15 ? 30 : 15) + 's_v1', '0');
    } catch (_) {}
  }, { sec: seconds });

  // 2) 原版脚本，一行未改
  for (const name of ['dola-15s-dom-request-hook.js', 'dola-reference-materials.js']) {
    const code = readVendor(name);
    if (code) await ctx.addInitScript({ content: code });
  }

  // 3) 写入 Cookie
  const cookies = parseCookies(account.cookie);
  if (!cookies.length) throw new Error('账号 ' + (account.name || account.id) + ' 的 Cookie 解析为空');
  await ctx.addCookies(cookies.map((c) => ({
    name: c.name, value: c.value,
    domain: c.domain || '.dola.com',
    path: c.path || '/',
    secure: c.secure !== false,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || 'Lax',
    ...(c.expires && c.expires > 0 ? { expires: c.expires } : {})
  })));

  return ctx;
}

module.exports = { launch, closeBrowser, contextFor, parseCookies, UA };
