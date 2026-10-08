# 星辰 Dola 创作台

## 2.6 离线永久版

[前往下载页](https://github.com/ranfukang-bot/xingchen-dola-studio/releases/tag/v2.6)

Windows EXE 文件保存在本仓库的 Releases 中。进入下载页，在 Assets 中下载 EXE。

- 下载文件名：xingchen-dola-studio-2.6-offline.exe
- 原始文件名：星辰Dola创作台2.6-离线永久版.exe
- 文件大小：75,739,261 字节（约 72.2 MiB）
- SHA-256：`8ab1237f9e790d7ee80c683a84983ea026d5c4e05a4fbf33362badf84fc811cb`

本仓库用于存放该版本的可执行文件，未包含源代码。

## macOS 版（Apple Silicon）

见 [`mac/`](mac/) 目录，基于 Electron 的 arm64 原生移植，覆盖多账号浏览器隔离、
Cookie 导入、15/30 秒视频生成、无水印下载。

```bash
cd mac && npm install && npm start
```

构建说明、实现对照表与已知事项见 [`mac/README.md`](mac/README.md)。

## 批量生成自动化（Windows）

见 [`windows-batch/`](windows-batch/)，独立运行的批量工具，**不修改创作台本体**
（2.6 的 exe 带防篡改保护，加不进去）。

把「传图 → 选视频生成 → 开 30 秒 → Seedance 2.5 → 9:16 → 粘提示词 → 发送」
整串自动化，按文件夹队列依次生成，账号额度用完自动换下一个。

```
双击 windows-batch\校准.bat      先校准一次
双击 windows-batch\开始批量.bat  开跑
```

用法见 [`windows-batch/README.md`](windows-batch/README.md)。

## 批量生成（Chrome 扩展，推荐）

见 [`chrome-extension/`](chrome-extension/)。装进 Chrome 就能用，**Mac / Windows 通用,
不用编译**。在 dola.com 页面里批量生成：自动 2.5 / 30 秒 / 9:16、自动传图、
自动加提示词前缀、自动换账号、自动下载无水印成片。

之所以是扩展而不是独立软件：自动化浏览器一启动就被识别成机器人、**每次都弹滑块**；
而扩展跑在你真实的 Chrome 里，和创作台一样——有效 Cookie 直接已登录。

装法和用法见 [`chrome-extension/README.md`](chrome-extension/README.md)。
