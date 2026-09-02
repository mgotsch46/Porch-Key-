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

where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   GIT IS NOT INSTALLED
  echo   Get it from https://git-scm.com/download/win
  echo   Install with all defaults, then run PUSH.bat again.
  echo.
  pause
  exit /b 1
)

set "MSGFILE=%TEMP%\porchpay_commit_msg.txt"
if exist "%MSGFILE%" del /f /q "%MSGFILE%" >nul 2>&1

>>"%MSGFILE%" echo Show the push keys in Settings so they can be pinned in Railway
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Web push keys are generated at boot when they are not pinned, which
>>"%MSGFILE%" echo means every restart invalidates every existing subscription. There was
>>"%MSGFILE%" echo no way to read the generated pair back out of the running app, so there
>>"%MSGFILE%" echo was no way to pin it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - /api/admin/push-status now returns the private key as well, owner only,
>>"%MSGFILE%" echo   and only while the keys are still unpinned. Once VAPID_PRIVATE_KEY is
>>"%MSGFILE%" echo   set in the environment the endpoint stops disclosing it.
>>"%MSGFILE%" echo - Settings gains a Notifications section showing the public key, private
>>"%MSGFILE%" echo   key and subject in read-only click-to-select fields, with the three
>>"%MSGFILE%" echo   environment variable names spelled out next to them.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Also carries the notice, Lob, unapplied funds, Illinois track, ACH
>>"%MSGFILE%" echo pending-until-cleared and native push work from the previous commit.

echo  Staging changes...
git add -A
if errorlevel 1 goto failed

echo  Committing...
git commit -F "%MSGFILE%"

echo  Pushing to GitHub...
echo.
git push origin main
if errorlevel 1 goto failed

del /f /q "%MSGFILE%" >nul 2>&1

echo.
echo  ========================================
echo   DONE
echo  ========================================
echo.
echo   Railway is rebuilding. Wait about 90 seconds, then reload:
echo     https://porchpay-production.up.railway.app/admin
echo.
pause
exit /b 0

:failed
echo.
echo   SOMETHING WENT WRONG - copy everything above and send it to Claude.
echo.
echo   If it says "Authentication failed": do not type your GitHub password,
echo   it will not work. Choose the browser sign-in option instead.
echo.
pause
exit /b 1
