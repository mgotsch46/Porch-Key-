@echo off
setlocal
title Porch Pay - Make a signup token

echo.
echo  ========================================
echo   PORCH PAY - SIGNUP TOKEN
echo  ========================================
echo.
echo   A signup token is a long random secret - like a password,
echo   but for the server rather than a person. It does not exist
echo   yet. This makes one.
echo.
echo   It lets YOU add one new company to a server that is closed
echo   to everyone else. You will use it twice: once in Railway,
echo   once in DEMO-ACCOUNT.bat.
echo.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo   NODE IS NOT INSTALLED
  echo   Get it from https://nodejs.org - the LTS button - then run this again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%T in ('node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"') do set "TOK=%%T"

echo  ----------------------------------------
echo   YOUR TOKEN
echo  ----------------------------------------
echo.
echo     %TOK%
echo.
echo   It has been copied to your clipboard.
echo.
echo  ----------------------------------------
echo   WHAT TO DO WITH IT
echo  ----------------------------------------
echo.
echo   1. Open railway.app and sign in.
echo   2. Click your PorchPay project, then the service inside it.
echo   3. Click the "Variables" tab at the top.
echo   4. Click "+ New Variable".
echo   5. For the name, type:   SIGNUP_TOKEN
echo   6. For the value, paste the token (Ctrl+V).
echo   7. Click Add, then Deploy if it asks. Wait about 90 seconds.
echo.
echo   Leave SIGNUPS_OPEN set to false. Do not change it.
echo   That is the whole point - the door stays shut, and this
echo   token is the one key to it.
echo.
echo   8. Run DEMO-ACCOUNT.bat. When it asks for the token,
echo      paste the same thing again (Ctrl+V).
echo.
echo   Keep this window open until you have done step 6, or save
echo   the token in your password manager. It is not stored here.
echo.

echo %TOK%| clip
if errorlevel 1 echo   ^(Could not reach the clipboard - copy it from the screen instead.^)

pause
exit /b 0
