# 星辰Dola创作台 · macOS 版（Apple Silicon）

Windows 版 `星辰Dola创作台2.6-离线永久版.exe` 的 macOS 移植。

## 为什么是 Electron，不是原生套壳

Windows 版是 **.NET WinForms + WebView2**。界面主体是一个内嵌浏览器，加上右侧
账号面板、工具条和作品库。

移植时有一个硬约束决定了架构：

**无水印功能依赖 `chrome.debugger`（Chrome DevTools Protocol）。**
扩展通过 CDP 挂到页面上，监听 `Network.responseReceived`，再用
`Network.getResponseBody` 把无水印原始地址捞出来。

- 用 macOS 原生 **WKWebView** 套壳 → 程序能跑，但 WKWebView 既不支持 Chrome
  扩展也没有 CDP，**无水印功能直接失效**；
- 用 **Electron** → 自带 Chromium，`webContents.debugger` 就是同一套 CDP，
  方法名、参数、事件逐一对应，可以 1:1 转发。

所以选了 Electron，arm64 原生运行，不走 Rosetta。

## 实现对照

| Windows 原版 | macOS 版 |
|---|---|
| `CoreWebView2Profile`（每账号独立 UserDataFolder） | `session.fromPartition('persist:dola-<code>')` |
| `ApplyFingerprintProfileAsync` / `ApplyCoherentWebGlProfile` | `src/preload/page-preload.js` 指纹注入 |
| `DolaCookieVault` + DPAPI 加密 | `safeStorage` → **macOS 钥匙串** |
| `CookieManager.AddOrUpdateCookie` | `session.cookies.set()` |
| `chrome.debugger`（无水印 CDP 抓流） | `webContents.debugger`（`src/main/cdp.js`） |
| `chrome.downloads` | `net.request` 流式下载（`src/main/downloads.js`） |
| `AddScriptToExecuteOnDocumentCreatedAsync` | `webFrame.executeJavaScript`（绕过页面 CSP） |

### 原样复用的部分

以下来自原版的脚本**一行未改**，直接搬过来：

```
vendor/scripts/dola-15s-dom-request-hook.js   15/30 秒时长开关 + 请求改写
vendor/scripts/astra-media-capture.js         媒体捕获
vendor/scripts/dola-native-bridge.js          原生桥接
vendor/extensions/dola_nowatermark/           无水印扩展（含混淆的 service-worker.js）
```

能原样复用，是因为这些都是纯 JS，不依赖 Windows API。宿主只需提供等价的
`chrome.*` 运行环境 —— 这正是 `src/preload/sw-polyfill.js` 和
`src/main/extension-host.js` 做的事。

## 构建

需要 Node 18+ 和一台 Apple Silicon Mac。

```bash
cd mac
npm install
npm start          # 直接运行，先验证功能
npm run dist       # 打包成 dmg，产物在 mac/dist/
```

调试模式（显示扩展宿主窗口 + 控制台 + 兼容层缺口日志）：

```bash
npm run dev
```

## 首次打开

包**没有做 Apple 公证**（需要 99 美元/年的开发者账号）。首次打开会被 Gatekeeper
拦下，两种放行方式任选其一：

1. 右键点图标 → 「打开」→ 在弹窗里再点「打开」；
2. 终端执行：`xattr -cr "/Applications/星辰Dola创作台.app"`

## 多账号隔离说明

每个账号对应一个独立的 Electron session 分区，**Cookie、localStorage、
IndexedDB、缓存、Service Worker 注册表全部互不可见**。隔离强度与原版的
独立 UserDataFolder 相当。

此外每个账号会由账号码派生一套**恒定指纹**（UA / WebGL 渲染器 / 屏幕 /
CPU 核数 / canvas 噪声），重启不漂移。指纹保持「相干」—— 声称 macOS 就配
Apple GPU，不会出现 macOS UA 配 NVIDIA 显卡这种比不改还可疑的组合。

每个账号可单独设代理（`编辑` → `代理`），支持 `http://` 和 `socks5://`。

## 从 Windows 版迁移账号

在 Windows 端导出各账号 Cookie（JSON 数组或请求头格式均可），然后在
`导入 Dola Cookie` 里**用空行分隔**一次性粘贴，会按顺序逐个建号。

支持三种粘贴格式：

```
1) 请求头原文    a=1; b=2
2) JSON 数组     [{"name":"a","value":"1","domain":".dola.com"}]
3) Netscape      cookies.txt 制表符格式
```

## 数据位置

```
~/Library/Application Support/星辰Dola创作台/AccountData/   账号与 Cookie（钥匙串加密）
~/Downloads/星辰Dola作品库/                                  作品库
```

## 当前状态与已知事项

**构建环境说明：** 本次移植在 Linux 容器中完成，**无法编译和运行 macOS 二进制**。
代码已通过语法检查，但功能需要你在 Mac 上实测。下面如实区分：

已验证：
- 全部 JS 文件语法检查通过
- `.icns` 图标生成且格式合法
- 原版脚本与扩展资源完整提取（SHA-256 与 Release 页面一致）

需要你在 Mac 上实测：
- `chrome.*` 兼容层对混淆扩展的覆盖是否完整。扩展的 `service-worker.js` 是
  混淆过的（base64+RC4 字符串加密），**无法静态确认它到底调了哪些 API**，
  所以兼容层是按 manifest 声明的权限（`debugger`/`tabs`/`downloads`）做全的。
  若有遗漏，用 `npm run dev` 启动，控制台会打印 `[chrome-shim] 未实现: chrome.xxx`，
  把日志发我即可补上。
- 15/30 秒按钮、无水印下载在真实页面上的实际表现。
- 账号登录态从 Windows 迁移后是否被 Dola 风控二次验证（换设备属正常触发）。

**授权：** 授权校验逻辑（`dnd64.top/dola-license/v2/license/activate`）**未做任何
绕过或移除**，按原样保留。若需在 Mac 版接入，需要补一个对应的激活流程 ——
这部分依赖 `BouncyCastle.Crypto.dll` 里的签名校验与机器指纹算法，原 exe 未附源码，
需要你提供服务端协议细节才能对接。

**关于 vendor 目录：** 其中的 JS 来自对 exe 的解包，包含混淆代码。它们在应用内
以页面脚本身份执行。这是复现原功能的必要条件，但你应当知情：这些代码的行为
未经逐行审计。
