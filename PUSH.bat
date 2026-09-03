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

>>"%MSGFILE%" echo Stop labelling every online payment "Card"
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo postStripePayment read session.payment_method_types[0] to decide how the
>>"%MSGFILE%" echo buyer paid. That array is the list of methods we ALLOW, with card first -
>>"%MSGFILE%" echo not the one they chose. So every online payment was recorded as Card,
>>"%MSGFILE%" echo including the bank transfers, and the buyer's history showed a row reading
>>"%MSGFILE%" echo "Card - bank transfers take a few business days to clear".
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Wrong in the ledger, not just on screen: the method is what tells a buyer
>>"%MSGFILE%" echo how they paid and what the servicer sees on the row.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - retrieveSession now expands payment_intent.latest_charge, so the redirect
>>"%MSGFILE%" echo   path reads the method off the charge, which is the only place it is true.
>>"%MSGFILE%" echo - The webhook payload does not carry the charge, so it falls back to the one
>>"%MSGFILE%" echo   thing that is certain there: only a delayed-notification method leaves a
>>"%MSGFILE%" echo   completed session unpaid, and the only one we offer is ACH.
>>"%MSGFILE%" echo - Six cases checked against the shapes Stripe actually sends, including the
>>"%MSGFILE%" echo   unexpanded-id case where payment_intent is a string.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Also: the pending sentence no longer promises "bank transfers take a few
>>"%MSGFILE%" echo business days" on a card, and the payment method label and its description
>>"%MSGFILE%" echo were rendering as one run-together string - "New card or bankDebit, credit,
>>"%MSGFILE%" echo or bank transfer" - because both were inline spans in a flex row.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
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
