@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 鑫淼考勤 · 开发版

if not exist "node_modules" (
  echo [错误] 还没装依赖。请先在本目录执行：npm install
  echo.
  pause
  exit /b 1
)

rem 这个环境变量会让 Electron 走 Node 模式，必须清掉
set "ELECTRON_RUN_AS_NODE="

echo ==========================================
echo   鑫淼考勤 · 开发版
echo   数据目录：默认（%USERPROFILE%\Documents\Attendance）
echo   功能：最新代码，含日历视图、目录迁移等
echo ==========================================
echo.
echo 正在启动，首次编译约 5-10 秒...
echo 关掉本窗口 = 关闭软件。
echo.

call npm run dev

if errorlevel 1 (
  echo.
  echo [启动失败] 请把上面的报错内容发给开发。
  pause
)
