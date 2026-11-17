@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 鑫淼考勤 · 打包最新版

echo ==========================================
echo   打包最新版（安装版 + 绿色版）
echo   产物在 dist\ 目录
echo ==========================================
echo.
echo 说明：镜像已配在 .npmrc / electron-builder.yml 里，
echo       本机直连 GitHub 不通，靠镜像取 Electron 二进制。
echo.

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

echo [1/3] 构建...
call npm run build
if errorlevel 1 goto fail

echo.
echo [2/3] 打安装版（NSIS）...
call npm run dist
if errorlevel 1 goto fail

echo.
echo [3/3] 打绿色版（免安装）...
call npm run dist:portable
if errorlevel 1 goto fail

echo.
echo ==========================================
echo   完成，产物：
echo ==========================================
dir /b dist\*.exe
echo.
echo 绿色版双击即用；安装版会走安装向导。
echo 注意：未签名，首次运行 Windows 会拦一下，
echo       点「更多信息」→「仍要运行」。
echo.
pause
exit /b 0

:fail
echo.
echo [打包失败] 请把上面的报错内容发给开发。
pause
exit /b 1
