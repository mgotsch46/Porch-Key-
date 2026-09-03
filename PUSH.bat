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

>>"%MSGFILE%" echo Fix the white screen every buyer got at sign-in
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Removing the location feature deleted the v-loc screen but left its id in
>>"%MSGFILE%" echo the list show() iterates. $('v-loc') returned null and .classList threw -
>>"%MSGFILE%" echo before the loop reached v-app. So the app never un-hid itself and every
>>"%MSGFILE%" echo buyer, on web and on iOS, got a white screen the moment they signed in.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The parse check I ran at the time could not have caught this: the file was
>>"%MSGFILE%" echo syntactically perfect. It only failed when the line actually ran. Nor did
>>"%MSGFILE%" echo grepping for "location" - the dead reference was the string 'v-loc' and the
>>"%MSGFILE%" echo functions were named locUi and sendPing, none of which contain that word.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo show() now skips a view that is not in the document instead of throwing on
>>"%MSGFILE%" echo it, so a missing screen can never take the whole app down again.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Swept all three pages for the same class of bug - every id referenced
>>"%MSGFILE%" echo through $() against every id defined in the markup. tenant, admin and staff
>>"%MSGFILE%" echo are clean; v-loc was the only one.

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
