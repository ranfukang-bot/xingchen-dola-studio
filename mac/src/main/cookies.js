'use strict';
/**
 * Cookie 导入 / 导出。
 *
 * 对应原版 DolaCookieImporter / FacebookCookieImporter / ImportDolaCookieTextAsync。
 * Windows 上写入 WebView2 的 CookieManager.AddOrUpdateCookie，
 * macOS 上写入对应账号隔离 session 的 cookies.set()。
 *
 * 兼容三种粘贴格式（市面导出工具基本都在这三类里）：
 *   1. 请求头原文：  a=1; b=2
 *   2. JSON 数组：   [{"name":"a","value":"1","domain":".dola.com",...}]   (Cookie-Editor / EditThisCookie)
 *   3. Netscape：    .dola.com	TRUE	/	TRUE	0	a	1          (cookies.txt)
 */
const accounts = require('./accounts');

const TARGETS = {
  dola: { domain: '.dola.com', url: 'https://www.dola.com/' },
  facebook: { domain: '.facebook.com', url: 'https://www.facebook.com/' }
};

function parseJsonArray(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data
    .filter((c) => c && c.name)
    .map((c) => ({
      name: String(c.name),
      value: String(c.value == null ? '' : c.value),
      domain: c.domain ? String(c.domain) : undefined,
      path: c.path ? String(c.path) : '/',
      secure: c.secure !== false,
      httpOnly: !!c.httpOnly,
      // Cookie-Editor 用 expirationDate(秒)，Puppeteer 用 expires
      expirationDate: Number(c.expirationDate || c.expires || 0) || undefined,
      sameSite: normalizeSameSite(c.sameSite)
    }));
}

function normalizeSameSite(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'lax') return 'lax';
  if (s === 'strict') return 'strict';
  if (s === 'none' || s === 'no_restriction') return 'no_restriction';
  return 'unspecified';
}

function parseNetscape(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const f = t.split('\t');
    if (f.length < 7) continue;
    out.push({
      domain: f[0],
      path: f[2] || '/',
      secure: String(f[3]).toUpperCase() === 'TRUE',
      expirationDate: Number(f[4]) || undefined,
      name: f[5],
      value: f[6]
    });
  }
  return out.length ? out : null;
}

function parseHeader(text) {
  const out = [];
  // 去掉可能粘进来的 "Cookie:" 前缀
  const body = text.replace(/^\s*cookie\s*:/i, '').trim();
  for (const part of body.split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out.length ? out : null;
}

function parseCookieText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  return parseJsonArray(t) || parseNetscape(t) || parseHeader(t) || [];
}

/**
 * 把 Cookie 写入某账号的隔离分区。
 * @returns {Promise<{ok:number, failed:number, errors:string[]}>}
 */
async function importInto(code, text, kind = 'dola') {
  const target = TARGETS[kind] || TARGETS.dola;
  const list = parseCookieText(text);
  if (!list.length) {
    return { ok: 0, failed: 0, errors: ['没有解析出任何 Cookie，请检查粘贴内容格式'] };
  }

  const ses = accounts.sessionFor(code);
  let ok = 0;
  let failed = 0;
  const errors = [];

  for (const c of list) {
    const domain = c.domain || target.domain;
    const host = domain.replace(/^\./, '');
    const secure = c.secure !== false;
    const url = (secure ? 'https://' : 'http://') + host + (c.path || '/');

    const detail = {
      url,
      name: c.name,
      value: c.value,
      domain,
      path: c.path || '/',
      secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified'
    };
    if (c.expirationDate && c.expirationDate > 0) {
      detail.expirationDate = c.expirationDate;
    }

    try {
      await ses.cookies.set(detail);
      ok++;
    } catch (err) {
      // sameSite=none 必须 secure；部分导出工具标记不一致，这里退一步重试
      try {
        await ses.cookies.set({ ...detail, sameSite: 'unspecified', secure: true });
        ok++;
      } catch (err2) {
        failed++;
        if (errors.length < 8) errors.push(c.name + ': ' + err2.message);
      }
    }
  }

  if (ok > 0) {
    accounts.update(code, { kind, lastUsedAt: Date.now() });
  }
  return { ok, failed, errors };
}

/** 导出某账号当前 Cookie（对应 ExportIdentityCookieAsync）。 */
async function exportFrom(code, kind = 'dola') {
  const target = TARGETS[kind] || TARGETS.dola;
  const ses = accounts.sessionFor(code);
  const list = await ses.cookies.get({ domain: target.domain.replace(/^\./, '') });
  return list.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly,
    expirationDate: c.expirationDate, sameSite: c.sameSite
  }));
}

/** 取 Cookie 请求头形式（对应 GetIdentityCookieHeader）。 */
async function headerFor(code, url = 'https://www.dola.com/') {
  const ses = accounts.sessionFor(code);
  const list = await ses.cookies.get({ url });
  return list.map((c) => c.name + '=' + c.value).join('; ');
}

async function clearFor(code) {
  const ses = accounts.sessionFor(code);
  await ses.clearStorageData({ storages: ['cookies'] });
}

module.exports = { parseCookieText, importInto, exportFrom, headerFor, clearFor, TARGETS };
