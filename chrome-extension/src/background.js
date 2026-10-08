/**
 * 后台：负责油猴脚本做不到的那两件事——换账号、存状态。
 *
 * 换账号的原理和创作台一模一样：同一个真实浏览器，只是把 dola.com 的
 * Cookie 换成下一个账号的。浏览器本身没变，所以不会被当成机器人、不弹滑块。
 */

const DOLA_DOMAIN = 'dola.com';

/* ---------------- Cookie 解析：三种格式都认 ---------------- */
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
    domain: c.domain ? String(c.domain) : '.' + DOLA_DOMAIN,
    path: c.path ? String(c.path) : '/',
    secure: c.secure !== false,
    httpOnly: !!c.httpOnly,
    expirationDate: Number(c.expirationDate || c.expires || 0) || undefined,
    sameSite: normSameSite(c.sameSite)
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
      expirationDate: Number(f[4]) || undefined,
      name: f[5], value: f[6], sameSite: 'unspecified'
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
      domain: '.' + DOLA_DOMAIN, path: '/',
      secure: true, httpOnly: false, sameSite: 'unspecified'
    });
  }
  return out.length ? out : null;
}

function normSameSite(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'strict') return 'strict';
  if (s === 'lax') return 'lax';
  if (s === 'none' || s === 'no_restriction') return 'no_restriction';
  return 'unspecified';
}

/* ---------------- 清空 / 写入 ---------------- */
async function clearDolaCookies() {
  const all = await chrome.cookies.getAll({ domain: DOLA_DOMAIN });
  let n = 0;
  for (const c of all) {
    const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path;
    try {
      await chrome.cookies.remove({ url, name: c.name });
      n++;
    } catch (_) { /* 忽略单条失败 */ }
  }
  return n;
}

async function applyCookies(text) {
  const list = parseCookies(text);
  if (!list.length) return { ok: false, msg: 'Cookie 解析为空，检查粘贴内容' };

  await clearDolaCookies();

  let ok = 0;
  const errors = [];
  for (const c of list) {
    const host = (c.domain || '.' + DOLA_DOMAIN).replace(/^\./, '');
    const secure = c.secure !== false;
    const url = (secure ? 'https://' : 'http://') + host + (c.path || '/');
    const detail = {
      url,
      name: c.name,
      value: c.value,
      domain: c.domain || '.' + DOLA_DOMAIN,
      path: c.path || '/',
      secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified'
    };
    if (c.expirationDate && c.expirationDate > 0) detail.expirationDate = c.expirationDate;

    try {
      await chrome.cookies.set(detail);
      ok++;
    } catch (err) {
      // sameSite=none 必须 secure，部分导出工具标记不一致，退一步重试
      try {
        await chrome.cookies.set({ ...detail, sameSite: 'unspecified', secure: true });
        ok++;
      } catch (err2) {
        if (errors.length < 6) errors.push(c.name + ': ' + err2.message);
      }
    }
  }
  return { ok: true, written: ok, total: list.length, errors };
}

/* ---------------- 消息入口 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'applyCookies':
          sendResponse(await applyCookies(msg.text));
          break;
        case 'clearCookies':
          sendResponse({ ok: true, removed: await clearDolaCookies() });
          break;
        case 'currentCookieCount': {
          const all = await chrome.cookies.getAll({ domain: DOLA_DOMAIN });
          sendResponse({ ok: true, count: all.length });
          break;
        }
        case 'getState':
          sendResponse({ ok: true, state: (await chrome.storage.local.get('state')).state || null });
          break;
        case 'setState':
          await chrome.storage.local.set({ state: msg.state });
          sendResponse({ ok: true });
          break;
        case 'reloadTab':
          if (sender.tab && sender.tab.id) await chrome.tabs.reload(sender.tab.id);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, msg: '未知消息' });
      }
    } catch (err) {
      sendResponse({ ok: false, msg: String(err && err.message || err) });
    }
  })();
  return true; // 异步回复
});
