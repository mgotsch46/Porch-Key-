@echo off
setlocal
cd /d "%~dp0"

echo Clearing stale lock files...
del /f /q ".git\index.lock" >nul 2>&1
del /f /q ".git\HEAD.lock" >nul 2>&1

echo Ignoring file-mode noise...
git config core.fileMode false

echo Staging...
git add notices.js payoff.js db.js email.js server.js public/admin.html public/tenant.html
if errorlevel 1 goto failed

echo Committing...
git commit -m "Payoff statements and the late-notice ladder" -m "Payoff: statements frozen once issued, on company letterhead with the logo, per diem carried forward from the statement date rather than double-counted, seven business day SLA, and buyers can request their own. Ladder: 5/15/30/45/60-day late notices firing in-app, by text and by email at the same time; 30 days and beyond send from the legal address. Stops on legal hold; a partial payment buys a configurable pause."

echo.
echo Pushing...
git push origin main
if errorlevel 1 goto failed

echo.
git log --oneline -1
echo.
echo DONE - Railway is rebuilding.
exit /b 0

:failed
echo.
echo SOMETHING WENT WRONG - copy the output above.
exit /b 1
