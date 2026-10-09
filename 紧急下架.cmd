@echo off
chcp 65001 >nul
title 一键下架 - 湟果视频
cd /d "%~dp0"

echo.
echo ============================================================
echo   紧急下架 - 湟果视频
echo ============================================================
echo.
echo   这会立刻:
echo     1. 停用 workers.dev 站点 (秒生效)
echo     2. 删除 Cloudflare Worker
echo     3. 停用 GitHub Pages
echo     4. 归档 GitHub 仓库
echo     5. 清理本地部署产物
echo.
echo   密钥文件会保留 (以后想重新上线还能用)
echo.
echo ============================================================
echo.

set /p ans=确认下架请输入 【下架】 两个字, 其他任意键取消:

if not "%ans%"=="下架" (
  echo.
  echo 已取消。
  echo.
  pause
  exit /b 1
)

echo.
echo 开始执行...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0下架.ps1" -Go -Force

echo.
echo ============================================================
echo   执行完毕。请手动访问一下网址确认已 404。
echo ============================================================
echo.
pause