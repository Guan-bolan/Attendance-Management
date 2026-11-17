@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 鑫淼考勤 · 打开数据目录

set "DATA_DIR=%USERPROFILE%\Documents\Attendance"

if not exist "%DATA_DIR%" (
  echo 数据目录还不存在：%DATA_DIR%
  echo 说明软件还没启动过一次。
  echo.
  pause
  exit /b 1
)

echo 数据目录：%DATA_DIR%
echo.
echo   app.db        你的数据（工人、考勤、预支、结算单）
echo   photos\       考勤照片原图
echo   thumbs\       缩略图缓存（可删，会自动重建）
echo   snapshots\    快照（退出软件时自动生成；常规按设置份数留，默认 3 份；迁移前另留 2 份，合计最多 5 份）
echo   archives\     归档的年度档案包
echo   inbox\        收件箱（微信图片拖进来会被自动吸入）
echo.
echo 备份提示：把整个 Attendance 文件夹复制到别处即可。
echo.
start "" "%DATA_DIR%"
