@echo off
chcp 65001 >nul
title 重新上线 - 湟果视频
cd /d "%~dp0"
echo.
echo ============================================================
echo   重新上线 - 湟果视频
echo ============================================================
echo.
echo   会重新部署 Cloudflare Worker 和静态页面。
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
echo.
pause