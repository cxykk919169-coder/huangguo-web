@echo off
title Huangguo - Deploy
cd /d "%~dp0"
echo.
echo ============================================================
echo   黄果客户端 · 自动部署
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
set EC=%ERRORLEVEL%
echo.
if "%EC%"=="0" (
  echo ============================================================
  echo   部署成功
  echo ============================================================
) else (
  echo ============================================================
  echo   部署未完全成功 [代码 %EC%]
  echo   排查建议:
  echo     1. 检查 deploy.config.psd1 里的 Token
  echo     2. Token 权限需要: Workers Scripts - Edit
  echo     3. 确认代理软件已开启 (Clash 等)
  echo     4. 或运行 体检.cmd 看诊断
  echo ============================================================
)
echo.
pause
