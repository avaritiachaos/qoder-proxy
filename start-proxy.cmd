@echo off
setlocal
cd /d "%~dp0"

echo Starting Qoder Proxy...
echo   Project: %CD%
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Install Node.js or run this from a shell where npm is available.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>nul
if not errorlevel 1 goto :port_busy
goto :port_ok
:port_busy
echo [WARN] Port 3000 is already in use.
echo The proxy may already be running. Close the existing window first.
echo.
pause
exit /b 0
:port_ok

if exist ".env" goto :env_ok
echo [WARN] .env file not found.
echo Run: Copy-Item .env.example .env
echo Then edit .env and set QODERCN_PERSONAL_ACCESS_TOKEN.
echo.
:env_ok

if defined QODERCN_PERSONAL_ACCESS_TOKEN goto :token_ok
echo [WARN] QODERCN_PERSONAL_ACCESS_TOKEN is not set in environment.
echo The proxy will start, but model requests will fail without a valid token.
echo Create one at: https://qoder.com.cn/account/integrations
echo.
:token_ok

echo Proxy will listen on:
echo   http://127.0.0.1:3000
echo Keep this service local. Do not bind to 0.0.0.0 or expose it publicly.
echo.
echo Endpoints:
echo   GET  http://127.0.0.1:3000/health
echo   GET  http://127.0.0.1:3000/v1/models
echo   POST http://127.0.0.1:3000/v1/chat/completions
echo   POST http://127.0.0.1:3000/v1/messages
echo.

npm.cmd start
set EXIT_CODE=%ERRORLEVEL%

echo.
echo Proxy exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
