@echo off
cd /d %~dp0
if not exist node_modules\tsx\dist\cli.mjs (
  echo [!] Dependencies missing. Run: npm install
  pause
  exit /b 1
)
echo Starting QQ group bot... (close this window to stop it)
node --env-file-if-exists=.env node_modules\tsx\dist\cli.mjs src\index.ts
echo.
echo Bot exited (code %errorlevel%).
pause
