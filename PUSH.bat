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

>>"%MSGFILE%" echo Fail the build if a flagged permission ever reaches the manifest
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Neither app needs contacts, storage, media, phone numbers, the installed
>>"%MSGFILE%" echo app list or location. But the Android manifest is generated at build time
>>"%MSGFILE%" echo and a dependency can merge a permission in without anyone editing a file,
>>"%MSGFILE%" echo and on Play those permissions are what get a lending app auto-classified
>>"%MSGFILE%" echo as predatory. Reading the source is not enough; the merged manifest is.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - Android: after bundleRelease, every merged AndroidManifest is scanned for
>>"%MSGFILE%" echo   22 flagged permissions and the build fails if one is present. It also
>>"%MSGFILE%" echo   prints the full permission list, and fails when it cannot find a manifest
>>"%MSGFILE%" echo   at all rather than passing on a missing file.
>>"%MSGFILE%" echo - iOS: the same gate on Info.plist usage-description keys, which is what
>>"%MSGFILE%" echo   lets an iOS app ask in the first place.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Remove location sharing entirely, and name every processor in the policy
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Location was optional, off by default and consented — but it was still the
>>"%MSGFILE%" echo most sensitive thing the app touched, and the least load-bearing. Removing
>>"%MSGFILE%" echo it takes a permission prompt off both stores' review, deletes a category
>>"%MSGFILE%" echo from both privacy questionnaires, and costs nothing anyone was using.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - Gone from the buyer app: the ask screen, the Settings toggle, the pings.
>>"%MSGFILE%" echo - Gone from the server: both tenant endpoints, the admin read, the distance
>>"%MSGFILE%" echo   helper, and the location section of the data export.
>>"%MSGFILE%" echo - Gone from Admin: the "where the buyer's phone has been" card.
>>"%MSGFILE%" echo - Gone from the builds: NSLocationWhenInUseUsageDescription on iOS and
>>"%MSGFILE%" echo   ACCESS_COARSE_LOCATION on Android. Neither app asks for anything now.
>>"%MSGFILE%" echo - Deleting code does not delete data: the migration drops location_pings
>>"%MSGFILE%" echo   outright and clears every consent flag. Verified against a volume with
>>"%MSGFILE%" echo   real pings in it, and it is idempotent on reboot.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The privacy policy named only Stripe. Twilio, Lob, Firebase, the email
>>"%MSGFILE%" echo provider and the geocoders were all hiding behind "hosting and
>>"%MSGFILE%" echo infrastructure providers". Each is now named with what it receives.
>>"%MSGFILE%" echo Terms section 5 is gone and the rest renumbered.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Six tests now assert the endpoints are gone and the table dropped, rather
>>"%MSGFILE%" echo than the fourteen that used to assert location worked.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
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
