@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 星辰Dola 批量生成 - 校准

if not exist node_modules (
  echo 第一次运行，正在安装依赖……
  call npm install || goto :fail
  call npx playwright install chromium || goto :fail
)

if not exist accounts.json (
  echo.
  echo  [!] 还没有 accounts.json，先填好账号再校准。
  echo.
  pause
  exit /b 1
)

echo 即将用第一个账号打开页面并导出结构，浏览器窗口会显示出来。
echo.
node src/probe.js
echo.
echo 完成。请把 probe-report.json 和 probe-*.png 发回给 Claude。
pause
exit /b 0

:fail
echo.
echo  [x] 安装失败。请确认已装 Node.js 18 以上版本：https://nodejs.org
echo.
pause
exit /b 1
