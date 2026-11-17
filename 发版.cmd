@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 鑫淼考勤 · 发版

set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules" (
  echo.
  echo [错误] 还没装依赖。
  echo        请先在本目录执行：npm install
  echo.
  pause
  exit /b 1
)

node scripts\release-flow.mjs
if errorlevel 1 (
  echo.
  echo ==========================================
  echo  [发版没成功] 把上面的报错内容发给开发。
  echo  已经做过的步骤不会丢，修好后重新双击本文件即可。
  echo ==========================================
  echo.
  pause
  exit /b 1
)

echo.
pause
