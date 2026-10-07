@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 星辰Dola 批量生成

if not exist node_modules (
  echo 第一次运行，正在安装依赖……
  call npm install || goto :fail
  call npx playwright install chromium || goto :fail
)

if not exist accounts.json (
  echo.
  echo  [!] 还没有 accounts.json
  echo      请把 accounts.json.example 复制成 accounts.json，填入你的账号 Cookie。
  echo.
  pause
  exit /b 1
)

node src/index.js %*
echo.
pause
exit /b 0

:fail
echo.
echo  [x] 安装失败。请确认已装 Node.js 18 以上版本：https://nodejs.org
echo.
pause
exit /b 1
