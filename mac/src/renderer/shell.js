'use strict';
/* 外壳界面逻辑：账号列表、内嵌浏览器标签、工具条、作品库。 */

const HOME = 'https://www.dola.com/chat/create-image';
const PRELOAD = new URL('../preload/page-preload.js', location.href).href;

let accounts = [];
let groups = [];
let activeCode = '';
let libOpen = false;
/** code -> <webview> */
const views = new Map();

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/* ---------------- 提示 ---------------- */
let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2600);
}

/* ---------------- 弹层 ---------------- */
function closeModal() { $('mask').classList.remove('show'); $('modal').innerHTML = ''; }
$('mask').addEventListener('click', (e) => { if (e.target.id === 'mask') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openModal(build) {
  const m = $('modal');
  m.innerHTML = '';
  build(m);
  $('mask').classList.add('show');
}

/* ---------------- 账号渲染 ---------------- */
async function refresh() {
  accounts = await window.dola.listAccounts();
  groups = await window.dola.groups();
  render();
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('acctList');
  list.innerHTML = '';

  const match = (a) => !q ||
    a.name.toLowerCase().includes(q) ||
    (a.email || '').toLowerCase().includes(q) ||
    (a.accountName || '').toLowerCase().includes(q);

  let shown = 0;
  for (const g of groups) {
    const mine = accounts.filter((a) => a.groupId === g.id && match(a));
    if (!mine.length && q) continue;
    shown += mine.length;

    const box = el('div', 'group');
    const head = el('div', 'groupHead');
    head.append(el('span', 'gname', g.name), el('span', 'gcount', String(mine.length)));

    const bRename = el('button', 'sm', '改名');
    bRename.onclick = async () => {
      const name = prompt('分组名称', g.name);
      if (name) { await window.dola.renameGroup(g.id, name); refresh(); }
    };
    head.append(bRename);

    if (g.id !== 'default') {
      const bDel = el('button', 'sm danger', '删除');
      bDel.onclick = async () => {
        if (!confirm('删除分组「' + g.name + '」？组内账号会移回默认分组。')) return;
        await window.dola.removeGroup(g.id);
        refresh();
      };
      head.append(bDel);
    }
    box.append(head);

    for (const a of mine) box.append(card(a));
    list.append(box);
  }

  $('shownN').textContent = String(shown);
  $('totalN').textContent = String(accounts.length);
  $('residentN').textContent = String(accounts.filter((a) => a.loggedIn).length);
}

function card(a) {
  const n = el('div', 'acct' + (a.code === activeCode ? ' active' : ''));

  const top = el('div', 'top');
  top.append(el('div', 'avatar', (a.name || 'D').slice(0, 1).toUpperCase()));

  const meta = el('div', 'meta');
  meta.append(el('div', 'nm', a.name));
  const st = el('div', 'st' + (a.loggedIn ? ' on' : ''), (a.loggedIn ? '● 已登录' : '○ 未登录') +
    (a.accountName ? ' · ' + a.accountName : ''));
  meta.append(st);
  top.append(meta);
  n.append(top);

  const ops = el('div', 'ops');

  const bOpen = el('button', 'sm', a.code === activeCode ? '当前' : '打开');
  bOpen.onclick = () => openAccount(a.code);

  const bInfo = el('button', 'sm', '信息');
  bInfo.onclick = () => showInfo(a);

  const bEdit = el('button', 'sm', '编辑');
  bEdit.onclick = () => editAccount(a);

  const bDel = el('button', 'sm danger', '删除');
  bDel.onclick = async () => {
    if (!confirm('删除账号「' + a.name + '」？该账号的独立浏览器数据会一并清除。')) return;
    const v = views.get(a.code);
    if (v) { v.remove(); views.delete(a.code); }
    if (activeCode === a.code) { activeCode = ''; $('empty').style.display = 'flex'; }
    await window.dola.removeAccount(a.code);
    refresh();
    toast('已删除并清理隔离数据', 'ok');
  };

  ops.append(bOpen, bInfo, bEdit, bDel);
  n.append(ops);
  return n;
}

function showInfo(a) {
  openModal((m) => {
    m.append(el('h3', null, a.name));
    const info = [
      ['账号码', a.code],
      ['类型', a.kind === 'facebook' ? 'Facebook Cookie' : a.kind === 'password' ? '账号密码' : 'Dola Cookie'],
      ['登录态', a.loggedIn ? '已登录' : '未登录'],
      ['站内昵称', a.accountName || '—'],
      ['邮箱', a.email || '—'],
      ['隔离分区', a.partition],
      ['代理', a.proxy || '直连'],
      ['UA', a.fingerprint && a.fingerprint.userAgent],
      ['显卡', a.fingerprint && (a.fingerprint.webglVendor + ' / ' + a.fingerprint.webglRenderer)],
      ['分辨率', a.fingerprint && (a.fingerprint.screen.width + '×' + a.fingerprint.screen.height)]
    ];
    const hint = el('div', 'hint');
    hint.innerHTML = info
      .map(([k, v]) => '<div><b style="color:var(--text2)">' + k + '：</b>' +
        String(v == null ? '—' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</div>')
      .join('');
    m.append(hint);
    const foot = el('div', 'foot');
    const b = el('button', 'primary', '关闭');
    b.onclick = closeModal;
    foot.append(b);
    m.append(foot);
  });
}

function editAccount(a) {
  openModal((m) => {
    m.append(el('h3', null, '编辑账号'));
    m.append(el('div', 'hint', '代理支持 http://host:port 或 socks5://host:port，留空为直连。'));

    const mk = (label, value, ph) => {
      const row = el('div', 'fieldrow');
      row.append(el('label', null, label));
      const i = document.createElement('input');
      i.type = 'text'; i.value = value || ''; i.placeholder = ph || '';
      row.append(i); m.append(row);
      return i;
    };
    const iName = mk('名称', a.name);
    const iProxy = mk('代理', a.proxy, 'socks5://127.0.0.1:1080');

    const gRow = el('div', 'fieldrow');
    gRow.append(el('label', null, '分组'));
    const sel = document.createElement('select');
    groups.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.name;
      if (g.id === a.groupId) o.selected = true;
      sel.append(o);
    });
    gRow.append(sel); m.append(gRow);

    const foot = el('div', 'foot');
    const bC = el('button', null, '取消'); bC.onclick = closeModal;
    const bS = el('button', 'primary', '保存');
    bS.onclick = async () => {
      await window.dola.updateAccount(a.code, {
        name: iName.value.trim() || a.name,
        proxy: iProxy.value.trim(),
        groupId: sel.value
      });
      closeModal(); refresh(); toast('已保存', 'ok');
    };
    foot.append(bC, bS); m.append(foot);
  });
}

/* ---------------- 浏览器标签 ---------------- */
function openAccount(code) {
  const a = accounts.find((x) => x.code === code);
  if (!a) return;

  $('empty').style.display = 'none';
  for (const [, v] of views) v.classList.add('hidden');

  let view = views.get(code);
  if (!view) {
    view = document.createElement('webview');
    view.setAttribute('partition', a.partition);          // 关键：账号级隔离
    view.setAttribute('preload', PRELOAD);
    view.setAttribute('allowpopups', 'true');
    // 必须关掉上下文隔离：注入的 hook 要改写页面自身的 fetch/XHR 和 localStorage，
    // 且 preload 需要和页面共享同一个 window 才能转发 chrome.webview 消息。
    view.setAttribute('webpreferences', 'contextIsolation=no,sandbox=no,nodeIntegration=no');
    if (a.fingerprint && a.fingerprint.userAgent) {
      view.setAttribute('useragent', a.fingerprint.userAgent);
    }
    view.setAttribute('src', HOME);
    view.addEventListener('dom-ready', async () => {
      try {
        await window.dola.bindTab(view.getWebContentsId(), code);
      } catch (_) {}
    });
    view.addEventListener('did-navigate', (e) => { if (code === activeCode) $('url').value = e.url; });
    view.addEventListener('did-navigate-in-page', (e) => { if (code === activeCode) $('url').value = e.url; });
    view.addEventListener('console-message', (e) => {
      if (e.message && e.message.includes('[chrome-shim] 未实现')) console.warn('[页面]', e.message);
    });
    $('stage').append(view);
    views.set(code, view);
  }

  view.classList.remove('hidden');
  activeCode = code;
  // webview 在 attach + dom-ready 之前调用这些方法会抛异常
  $('url').value = wvSafe(view, (v) => v.getURL(), '') || HOME;
  window.dola.updateAccount(code, { lastUsedAt: Date.now() });
  render();
}

function active() { return views.get(activeCode) || null; }

/** webview 方法安全调用：未就绪时返回兜底值而不是抛出。 */
function wvSafe(view, fn, dflt) {
  if (!view) return dflt;
  try { return fn(view); } catch (_) { return dflt; }
}

/* ---------------- 工具条 ---------------- */
$('btnBack').onclick = () => { const v = active(); if (wvSafe(v, (x) => x.canGoBack(), false)) v.goBack(); };
$('btnFwd').onclick = () => { const v = active(); if (wvSafe(v, (x) => x.canGoForward(), false)) v.goForward(); };
$('btnReload').onclick = () => wvSafe(active(), (v) => v.reload());
$('btnHome').onclick = () => wvSafe(active(), (v) => v.loadURL(HOME));
$('url').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = active();
  if (!v) return;
  let u = $('url').value.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  v.loadURL(u);
});

document.querySelectorAll('.durbtn').forEach((b) => {
  b.onclick = async () => {
    const v = active();
    if (!v) return toast('先选择一个账号', 'bad');
    const sec = Number(b.dataset.sec);
    await window.dola.setDuration(v.getWebContentsId(), sec);
    document.querySelectorAll('.durbtn').forEach((x) => x.classList.toggle('on', x === b));
    toast('已切换到 ' + sec + ' 秒时长', 'ok');
  };
});

$('btnNoMark').onclick = () => {
  const v = active();
  if (!v) return toast('先选择一个账号', 'bad');
  // 唤起扩展注入的无水印面板
  v.executeJavaScript(
    '(function(){' +
    'var p=document.querySelector("[data-xingchen-panel],#xingchen-nowatermark-panel");' +
    'if(p){p.style.display=p.style.display==="none"?"":"none";return "toggled";}' +
    'window.postMessage({type:"DOLA_EXTENSION_OPEN_PANEL"},"*");return "requested";})()'
  ).then((r) => toast(r === 'toggled' ? '已切换无水印面板' : '已请求打开无水印面板'))
   .catch(() => toast('页面未就绪', 'bad'));
};

$('btnAssets').onclick = () => {
  const v = active();
  if (!v) return toast('先选择一个账号', 'bad');
  v.executeJavaScript('window.postMessage({type:"DOLA_EXTENSION_OPEN_ASSETS"},"*");true')
    .then(() => toast('已请求打开素材面板')).catch(() => toast('页面未就绪', 'bad'));
};

/* ---------------- 导入 ---------------- */
function importModal(kind, title, hint) {
  openModal((m) => {
    m.append(el('h3', null, title));
    m.append(el('div', 'hint', hint));

    const ta = document.createElement('textarea');
    ta.placeholder = '支持三种格式：\n1) 请求头原文  a=1; b=2\n2) JSON 数组   [{"name":"a","value":"1","domain":".dola.com"}]\n3) Netscape    cookies.txt\n\n一次导入多个账号：不同账号之间空一行隔开。';
    m.append(ta);

    const row = el('div', 'fieldrow');
    row.style.marginTop = '10px';
    row.append(el('label', null, '分组'));
    const sel = document.createElement('select');
    groups.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.name;
      sel.append(o);
    });
    row.append(sel); m.append(row);

    const foot = el('div', 'foot');
    const bC = el('button', null, '取消'); bC.onclick = closeModal;
    const bOk = el('button', 'primary', '导入');
    bOk.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return toast('请先粘贴 Cookie', 'bad');
      bOk.disabled = true; bOk.textContent = '导入中…';
      try {
        const res = await window.dola.bulkImportCookie(text, kind, sel.value);
        closeModal();
        await refresh();
        const okN = res.filter((r) => r.ok > 0).length;
        const cookieN = res.reduce((s, r) => s + r.ok, 0);
        toast('新建 ' + res.length + ' 个账号，' + okN + ' 个写入成功（共 ' + cookieN + ' 条 Cookie）', 'ok');
        if (res.length) openAccount(res[0].code);
      } catch (err) {
        toast('导入失败：' + err.message, 'bad');
      } finally {
        bOk.disabled = false; bOk.textContent = '导入';
      }
    };
    foot.append(bC, bOk); m.append(foot);
    ta.focus();
  });
}

$('btnImpDola').onclick = () => importModal('dola', '导入 Dola Cookie',
  '每个账号写入独立的浏览器分区，彼此完全隔离（Cookie、localStorage、IndexedDB 互不可见）。Cookie 经 macOS 钥匙串加密后落盘。');
$('btnImpFb').onclick = () => importModal('facebook', '导入 FB Cookie',
  '用于以 Facebook 身份登录 Dola。同样写入该账号的独立分区。');
$('btnQuickAdd').onclick = () => $('btnImpDola').click();

$('btnImpPwd').onclick = () => {
  openModal((m) => {
    m.append(el('h3', null, '导入账号密码'));
    m.append(el('div', 'hint',
      '每行一个账号，格式：<b>邮箱----密码</b> 或 <b>邮箱:密码</b>。<br>' +
      '导入后会为每个账号建立独立分区，需在各自会话内手动完成一次登录（含验证码/二步验证），之后登录态会持久保存。'));
    const ta = document.createElement('textarea');
    ta.placeholder = 'a@mail.com----Pass1234\nb@mail.com:Pass5678';
    m.append(ta);
    const foot = el('div', 'foot');
    const bC = el('button', null, '取消'); bC.onclick = closeModal;
    const bOk = el('button', 'primary', '建立账号');
    bOk.onclick = async () => {
      const lines = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return toast('请先填写', 'bad');
      let n = 0;
      for (const line of lines) {
        const mm = line.split(/----|:(?!\/\/)/);
        if (mm.length < 2) continue;
        await window.dola.createAccount({ kind: 'password', name: mm[0].trim() });
        n++;
      }
      closeModal(); await refresh();
      toast('已建立 ' + n + ' 个账号，请逐个打开完成首次登录', 'ok');
    };
    foot.append(bC, bOk); m.append(foot);
  });
};

$('btnManual').onclick = async () => {
  const a = await window.dola.createAccount({ kind: 'dola' });
  await refresh();
  openAccount(a.code);
  toast('已新建独立会话，请在页面内登录', 'ok');
};

/* ---------------- 分组 / 清空 ---------------- */
$('btnNewGroup').onclick = async () => {
  const name = prompt('新分组名称', '新分组');
  if (!name) return;
  await window.dola.addGroup(name);
  refresh();
};
$('btnSelectAll').onclick = () => toast('共 ' + accounts.length + ' 个账号');
$('btnClearAll').onclick = async () => {
  if (!confirm('清空全部账号？所有隔离浏览器数据都会被删除，不可恢复。')) return;
  for (const [, v] of views) v.remove();
  views.clear(); activeCode = '';
  $('empty').style.display = 'flex';
  await window.dola.clearAllAccounts();
  refresh();
  toast('已清空', 'ok');
};
$('search').addEventListener('input', render);

/* ---------------- 作品库 ---------------- */
async function refreshLib() {
  const items = await window.dola.library();
  $('libCount').textContent = items.length + ' 个作品';
  const box = $('libList');
  box.innerHTML = '';
  for (const it of items.slice(0, 300)) {
    const row = el('div', 'libItem');
    row.append(el('span', 'nm', it.name));
    row.append(el('span', 'sz', (it.size / 1048576).toFixed(1) + ' MB'));
    const b1 = el('button', 'sm', '打开'); b1.onclick = () => window.dola.openPath(it.path);
    const b2 = el('button', 'sm', '位置'); b2.onclick = () => window.dola.showItem(it.path);
    row.append(b1, b2);
    box.append(row);
  }
}
$('btnLibRefresh').onclick = () => { refreshLib(); toast('已刷新'); };
$('btnLibFolder').onclick = () => window.dola.revealLibrary();
$('btnLibToggle').onclick = () => {
  libOpen = !libOpen;
  $('libList').classList.toggle('open', libOpen);
  $('btnLibToggle').textContent = libOpen ? '收起' : '展开';
  if (libOpen) refreshLib();
};

/* ---------------- 顶栏 ---------------- */
$('btnNotice').onclick = () => toast('离线永久版，无公告');
$('btnBuyAcct').onclick = () => window.dola.openExternal('https://dnd64.top/');
$('btnBuyCard').onclick = () => window.dola.openExternal('https://dnd64.top/');
$('btnMigrate').onclick = () => {
  openModal((m) => {
    m.append(el('h3', null, '账号迁移'));
    m.append(el('div', 'hint',
      '从 Windows 版迁移：在 Windows 端导出各账号 Cookie（JSON 或请求头格式），' +
      '用「导入 Dola Cookie」按空行分隔一次性粘贴即可，账号会按顺序逐个建立。<br><br>' +
      '本机数据位置可在「关于」中查看。'));
    const foot = el('div', 'foot');
    const b = el('button', 'primary', '知道了'); b.onclick = closeModal;
    foot.append(b); m.append(foot);
  });
};

/* ---------------- 启动 ---------------- */
(async function boot() {
  try {
    $('brandIcon').src = new URL('../../vendor/assets/brand-icon.png', location.href).href;
  } catch (_) {}
  try {
    const v = await window.dola.version();
    $('ver').textContent = 'V' + v.replace(/\.0$/, '');
  } catch (_) {}

  window.dola.onAccountsChanged(() => refresh());
  await refresh();
  await refreshLib();

  if (accounts.length) openAccount(accounts[0].code);
})();
