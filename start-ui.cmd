@echo off
setlocal
cd /d "%~dp0"

echo Starting Qoder Proxy with Web Console...
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
goto :start
:port_busy
echo [INFO] Port 3000 is already in use. Opening browser...
start "" "http://127.0.0.1:3000/ui"
pause
exit /b 0

:start
echo Web Console: http://127.0.0.1:3000/ui
echo.

:: Start server in background
start "Qoder Proxy" cmd /c "npm.cmd start"

:: Wait for server to be ready
echo Waiting for server...
:wait_loop
timeout /t 1 /nobreak >nul
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>nul
if errorlevel 1 goto :wait_loop

:: Open browser
echo Server ready. Opening browser...
start "" "http://127.0.0.1:3000/ui"

echo.
echo Server is running in a separate window.
echo Close that window to stop the server.
echo.
pause
