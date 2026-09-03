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

>>"%MSGFILE%" echo A way to prove notifications actually arrive
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Every notification in the app fires as a side effect of something real -
>>"%MSGFILE%" echo money landing, an autopay switched off, a notice held. So the only way to
>>"%MSGFILE%" echo prove delivery worked was to stage a real event on a real loan, which
>>"%MSGFILE%" echo leaves a message in that buyer's thread forever.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Settings - Notifications now has "Send myself a test notification". It goes
>>"%MSGFILE%" echo to the caller alone and records nothing against any loan.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo It reports the transports separately from the record, because those are
>>"%MSGFILE%" echo different failures. A notification is always written to the feed, so a
>>"%MSGFILE%" echo plain 200 would look like success even when there is no subscribed device
>>"%MSGFILE%" echo to send it to - which is exactly the state the account was in. It now says
>>"%MSGFILE%" echo "recorded, but no device is subscribed" and explains where to turn them on.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 6 tests: recorded against the sender, honest when undeliverable, never
>>"%MSGFILE%" echo reaches a buyer, and buyers cannot fire one.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Make the held-notice test assert the invariant, not a row count
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The test counted notice rows before and after a manual sweep and required
>>"%MSGFILE%" echo them to be equal. But the app runs its own notice sweep five seconds after
>>"%MSGFILE%" echo boot and its autopay sweep at twenty, both well inside a suite run, so a
>>"%MSGFILE%" echo background sweep could add a row between the two counts. It failed about
>>"%MSGFILE%" echo one run in seven - the worst kind of test, since a real regression looks
>>"%MSGFILE%" echo identical to a bad roll of the dice.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo It now runs the sweep twice and asserts what actually matters: no stage is
>>"%MSGFILE%" echo ever recorded twice in the same period.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 780 passed, 0 failed.

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
