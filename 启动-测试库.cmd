@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 鑫淼考勤 · 测试库

if not exist "node_modules" (
  echo [错误] 还没装依赖。请先在本目录执行：npm install
  echo.
  pause
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE="
set "ATT_DATA_ROOT=%~dp0.tmp\测试库"

if not exist "%ATT_DATA_ROOT%" mkdir "%ATT_DATA_ROOT%"

echo ==========================================
echo   鑫淼考勤 · 测试库（随便点，不会碰真实数据）
echo   数据目录：%ATT_DATA_ROOT%
echo ==========================================
echo.
echo 正在启动...
echo.

call npm run dev

if errorlevel 1 (
  echo.
  echo [启动失败] 请把上面的报错内容发给开发。
  pause
)
