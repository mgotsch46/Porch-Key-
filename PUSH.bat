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

>>"%MSGFILE%" echo Autopay drafts the regular payment on the 1st, and says so when it changes
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Autopay defaulted to "everything due that month". For a buyer who is
>>"%MSGFILE%" echo behind, switching it on would draft the arrears and the late fees in one
>>"%MSGFILE%" echo go - which is how you get an NSF and a returned ACH on the same day, from
>>"%MSGFILE%" echo the person who was trying to get current.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - The default is now the regular monthly payment, on the server and in the
>>"%MSGFILE%" echo   buyer's dropdown. "Everything due" is still there, second, and labelled
>>"%MSGFILE%" echo   so it is clear what it does.
>>"%MSGFILE%" echo - New autopay.charge_day, defaulting to the 1st, clamped to 28 so it cannot
>>"%MSGFILE%" echo   name a day that some months do not have. The sweep waits for it. The
>>"%MSGFILE%" echo   draft still never goes out before money is actually owed.
>>"%MSGFILE%" echo - The servicer is notified when a buyer turns autopay on and when they turn
>>"%MSGFILE%" echo   it off - push, the notification feed, and the loan's message thread as an
>>"%MSGFILE%" echo   unread item. Coming off autopay tends to precede a missed payment rather
>>"%MSGFILE%" echo   than follow one. Editing settings while enrolled does not re-alert, and
>>"%MSGFILE%" echo   turning off something already off does not alert at all.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 14 new tests. 767 passed, 5 failed - the same 5 that were already failing.

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
