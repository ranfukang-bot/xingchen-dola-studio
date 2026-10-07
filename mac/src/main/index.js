'use strict';
/**
 * 星辰Dola创作台 macOS 版 —— 主进程入口。
 *
 * 对应原版 WanwanDolaWebView2.MainForm：
 *   顶部工具条 + 中间内嵌浏览器 + 右侧账号面板 + 底部作品库。
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu, webContents } = require('electron');

const accounts = require('./accounts');
const cookies = require('./cookies');
const downloads = require('./downloads');
const extHost = require('./extension-host');
const vault = require('./vault');

const DOLA_HOME = 'https://www.dola.com/chat/create-image';

/** webContents.id -> 账号 code（供 page:config 取指纹） */
const tabAccount = new Map();

let win = null;

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,BlockInsecurePrivateNetworkRequests');
// 多账号并发时减少后台节流导致的生成任务卡住
app.commandLine.appendSwitch('disable-background-timer-throttling');

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    title: '星辰Dola创作台',
    backgroundColor: '#060912',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.DOLA_DEBUG) win.webContents.openDevTools({ mode: 'detach' });

  // 内嵌 <webview> 创建时统一配置
  win.webContents.on('did-attach-webview', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      // 站内链接留在当前 webview，站外交给系统浏览器
      if (/(^https?:\/\/)([^/]*\.)?(dola|doubao|qianwen|jianying|byteintlapi)\./i.test(url)) {
        wc.loadURL(url);
      } else {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    wc.on('destroyed', () => {
      tabAccount.delete(wc.id);
      extHost.unregisterContentTab(wc.id);
    });
  });

  win.on('closed', () => { win = null; });
}

/* ---------------- IPC ---------------- */
function installIpc() {
  extHost.installIpc();

  // 页面预加载索要本账号指纹。
  //
  // 必须用同步 IPC：指纹要在 document_start 就绪，异步 invoke 会让页面脚本
  // 先跑一步，指纹就白改了。
  //
  // 此时 tab:bind 还没发生（它在 dom-ready），所以不能靠 tabAccount，
  // 而是用 session 分区反查 —— Electron 的 session 按 partition 名单例，
  // 可以直接比对对象身份。
  ipcMain.on('page:config-sync', (e) => {
    const code = accountForSession(e.sender.session);
    const acct = code ? accounts.get(code) : null;
    if (code) tabAccount.set(e.sender.id, code);
    e.returnValue = { fingerprint: acct ? acct.fingerprint : null, accountCode: code || '' };
  });

  // 保留异步版本，供非关键路径使用
  ipcMain.handle('page:config', (e) => {
    const code = tabAccount.get(e.sender.id) || accountForSession(e.sender.session);
    const acct = code ? accounts.get(code) : null;
    return { fingerprint: acct ? acct.fingerprint : null, accountCode: code || '' };
  });

  // 渲染层告知某个 webview 属于哪个账号
  ipcMain.handle('tab:bind', (_e, { webContentsId, code }) => {
    tabAccount.set(Number(webContentsId), code);
    extHost.registerContentTab(Number(webContentsId));
    return true;
  });

  // ---- 账号 ----
  ipcMain.handle('acct:list', () => accounts.list());
  ipcMain.handle('acct:groups', () => accounts.groups());
  ipcMain.handle('acct:create', (_e, opts) => accounts.create(opts));
  ipcMain.handle('acct:update', (_e, { code, patch }) => accounts.update(code, patch));
  ipcMain.handle('acct:remove', (_e, code) => accounts.remove(code));
  ipcMain.handle('acct:clearAll', () => accounts.clearAll());
  ipcMain.handle('acct:addGroup', (_e, name) => accounts.addGroup(name));
  ipcMain.handle('acct:renameGroup', (_e, { id, name }) => accounts.renameGroup(id, name));
  ipcMain.handle('acct:removeGroup', (_e, id) => accounts.removeGroup(id));
  ipcMain.handle('acct:partition', (_e, code) => accounts.partitionName(code));

  // ---- Cookie ----
  ipcMain.handle('cookie:import', async (_e, { code, text, kind }) => {
    return await cookies.importInto(code, text, kind);
  });
  ipcMain.handle('cookie:export', async (_e, { code, kind }) => cookies.exportFrom(code, kind));
  ipcMain.handle('cookie:header', async (_e, { code, url }) => cookies.headerFor(code, url));
  ipcMain.handle('cookie:clear', async (_e, code) => cookies.clearFor(code));

  // 批量导入：一行一个账号的 Cookie，自动建号
  ipcMain.handle('cookie:bulkImport', async (_e, { text, kind, groupId }) => {
    const blocks = String(text || '')
      .split(/\n{2,}|\r?\n(?=\s*[\[{])/)
      .map((s) => s.trim())
      .filter(Boolean);
    const results = [];
    for (const block of blocks) {
      const acct = accounts.create({ kind, groupId });
      const r = await cookies.importInto(acct.code, block, kind);
      accounts.update(acct.code, { loggedIn: r.ok > 0 });
      results.push({ code: acct.code, name: acct.name, ...r });
    }
    return results;
  });

  // ---- 下载 / 作品库 ----
  ipcMain.handle('dl:download', (_e, opts) => downloads.download(opts));
  ipcMain.handle('dl:library', () => downloads.listLibrary());
  ipcMain.handle('dl:reveal', () => downloads.revealLibrary());
  ipcMain.handle('dl:root', () => downloads.libraryRoot());
  ipcMain.handle('dl:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('dl:showItem', (_e, p) => shell.showItemInFolder(p));

  // ---- 页面 native 消息（来自 dola-native-bridge.js） ----
  ipcMain.on('page:native-message', async (e, payload) => {
    const code = tabAccount.get(e.sender.id) || '';
    try {
      await handleNativeMessage(e.sender, code, payload);
    } catch (err) {
      console.error('[native] 处理失败', err.message);
    }
  });

  // ---- 时长开关（15 / 30 秒） ----
  ipcMain.handle('duration:set', async (_e, { webContentsId, seconds }) => {
    const wc = webContents.fromId(Number(webContentsId));
    if (!wc || wc.isDestroyed()) return false;
    const v = Number(seconds) === 30 ? 30 : 15;
    // 与原版 hook 的开关键一致
    await wc.executeJavaScript(
      '(function(){try{' +
      'localStorage.setItem("intl_doubao_enable_' + v + 's_v1","1");' +
      'localStorage.setItem("intl_doubao_enable_' + (v === 15 ? 30 : 15) + 's_v1","0");' +
      'window.dispatchEvent(new CustomEvent("wanwan-duration-change",{detail:' + v + '}));' +
      'return true}catch(e){return false}})()'
    ).catch(() => false);
    return true;
  });

  // ---- 其他 ----
  ipcMain.handle('app:paths', () => ({
    userData: app.getPath('userData'),
    accountData: vault.dataRoot(),
    library: downloads.libraryRoot(),
    encrypted: vault.canEncrypt()
  }));
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:version', () => app.getVersion());
}

/** 由 session 对象反查它属于哪个账号。 */
function accountForSession(ses) {
  if (!ses) return '';
  for (const a of accounts.list()) {
    try {
      if (session.fromPartition(a.partition) === ses) return a.code;
    } catch (_) { /* 忽略 */ }
  }
  return '';
}

/**
 * 处理页面经 chrome.webview.postMessage 发来的消息。
 * 消息格式沿用原版 dola-native-bridge.js。
 */
async function handleNativeMessage(sender, code, payload) {
  if (!payload || typeof payload !== 'object') return;
  const type = payload.type || '';

  switch (type) {
    case 'DOLA_EXTENSION_DOWNLOAD_HOST':
    case 'DOLA_NATIVE_DOWNLOAD': {
      const id = await downloads.download({
        url: payload.url,
        filename: payload.filename || payload.name,
        referer: payload.referer || sender.getURL(),
        accountCode: code,
        subdir: payload.subdir
      });
      sender.send('native:to-page', {
        type: 'DOLA_NATIVE_DOWNLOAD_STARTED',
        requestId: payload.requestId || String(id),
        downloadId: id
      });
      break;
    }
    case 'XINGCHEN_SESSION_EVIDENCE': {
      // 登录态探测结果，用于右侧面板的「已登录」标记
      if (code) {
        accounts.update(code, {
          loggedIn: payload.phase === 'logged-in' || !!payload.accountId,
          accountId: payload.accountId || '',
          accountName: payload.accountName || '',
          email: payload.email || ''
        });
        if (win && !win.isDestroyed()) win.webContents.send('shell:accounts-changed');
      }
      break;
    }
    default:
      if (process.env.DOLA_DEBUG) console.log('[native] 未处理消息', type);
  }
}

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  installIpc();
  createWindow();
  extHost.start();

  Menu.setApplicationMenu(buildMenu());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  extHost.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => extHost.stop());

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 星辰Dola创作台' },
        { type: 'separator' },
        { label: '打开作品库', click: () => downloads.revealLibrary() },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] }
  ]);
}

module.exports = { DOLA_HOME };
