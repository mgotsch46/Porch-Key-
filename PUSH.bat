@echo off
setlocal
title Porch Pay - Deploy

echo.
echo  ========================================
echo   PORCH PAY - DEPLOYING YOUR CHANGES
echo  ========================================
echo.

cd /d "%~dp0"

echo  Clearing stale lock files...
del /f /q ".git\index.lock" >nul 2>&1
del /f /q ".git\HEAD.lock" >nul 2>&1
del /f /q ".git\objects\maintenance.lock" >nul 2>&1
del /f /q ".git\refs\heads\main.lock" >nul 2>&1

echo  Checking for git...
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ---------------------------------------------------
  echo   GIT IS NOT INSTALLED
  echo.
  echo   Download it here:  https://git-scm.com/download/win
  echo   Install with all the default options.
  echo   Then close this window and run PUSH.bat again.
  echo  ---------------------------------------------------
  echo.
  pause
  exit /b 1
)

echo  Staging changes...
git add -A
if errorlevel 1 goto failed

echo  Committing...
git commit -m "Reports, property workflow, autopay, login throttling; fix admin redirect loop"

echo  Pushing to GitHub...
echo.
echo  (A browser window may open asking you to sign in to GitHub. Approve it.)
echo.
git push origin main
if errorlevel 1 goto failed

echo.
echo  ========================================
echo   DONE
echo  ========================================
echo.
echo   Railway is rebuilding now. Wait about 90 seconds, then open:
echo.
echo     https://porchpay-production.up.railway.app/admin
echo.
echo   Email:    marisa@reneweqllc.com
echo   Password: Dmsaa121252$
echo.
echo   The blinking will be gone.
echo.
echo   AFTERWARDS: in Railway, delete the variables
echo   RESET_OWNER_PASSWORD and RESET_OWNER_EMAIL.
echo.
pause
exit /b 0

:failed
echo.
echo  ========================================
echo   SOMETHING WENT WRONG
echo  ========================================
echo.
echo   Copy everything above this line and send it to Claude.
echo.
echo   If it says "Authentication failed": do not type your GitHub
echo   password - it will not work. Choose the browser sign-in option.
echo   If there is no browser option, install Git for Windows from
echo   https://git-scm.com/download/win which includes the credential
echo   manager that handles this properly.
echo.
pause
exit /b 1
