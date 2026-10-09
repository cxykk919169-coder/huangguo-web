@echo off
title Huangguo - Check
cd /d "%~dp0"
echo.
echo ============================================================
echo   黄果客户端 · 体检与自愈
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1"
echo.
pause
