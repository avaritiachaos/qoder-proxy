@echo off
setlocal
cd /d "%~dp0"

echo Starting Qoder CN OpenCode proxy...
echo Project: %CD%
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm.cmd was not found on PATH.
  echo Install Node.js or open this from a shell where npm is available.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Port 3000 is already listening.
  echo The proxy may already be running. Close the existing npm start window first if you want to restart it.
  echo.
  pause
  exit /b 0
)

npm.cmd start
set EXIT_CODE=%ERRORLEVEL%

echo.
echo Proxy exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
