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

>>"%MSGFILE%" echo Nothing goes in the post until a person has read it
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The ladder handed a certified letter straight to Lob the moment the rung
>>"%MSGFILE%" echo fired. The first person to read that letter was the buyer - after it had
>>"%MSGFILE%" echo been printed, mailed, billed to them, and filed as evidence. None of that
>>"%MSGFILE%" echo can be taken back, and the 30-day notice is the document a forfeiture case
>>"%MSGFILE%" echo leans on. A wrong figure on it is not a typo.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Certified letters are now drafted and held. The notice itself still goes out
>>"%MSGFILE%" echo instantly by app, email and text - the buyer is not kept waiting - but the
>>"%MSGFILE%" echo envelope waits for a review task on the dashboard: read it, edit anything
>>"%MSGFILE%" echo that reads wrong, then approve or stop it with a reason.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - Approving mails the EDITED copy, charges the flat rate once, files the PDF,
>>"%MSGFILE%" echo   and closes the task. Same idempotency key as before, so a double-click or
>>"%MSGFILE%" echo   two admins approving the same letter cannot mail or bill it twice.
>>"%MSGFILE%" echo - Stopping it requires a reason, which is kept: "why did we not mail the
>>"%MSGFILE%" echo   30-day notice" is a question with a statutory edge to it.
>>"%MSGFILE%" echo - Editing changes the LETTER only. The notice the buyer already read is left
>>"%MSGFILE%" echo   alone, and the record notes when the two differ.
>>"%MSGFILE%" echo - A blank textarea is not an edit. Mailing an empty page costs postage and
>>"%MSGFILE%" echo   proves nothing.
>>"%MSGFILE%" echo - The sweep re-notifies daily on anything still unread. It never mails on its
>>"%MSGFILE%" echo   own after a timeout - auto-sending would quietly undo the whole point.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The Lob invoice field now has a screen. Settings shows every letter that has
>>"%MSGFILE%" echo gone with a box for what Lob actually billed, plus totals; the same box sits
>>"%MSGFILE%" echo on each notice, next to the ledger line it explains. Typing it in never moves
>>"%MSGFILE%" echo the buyer's balance - that stays the flat published rate.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Mailing by hand goes through the same read-it-first screen, and now shows
>>"%MSGFILE%" echo what the BUYER pays rather than Lob's estimate, which is what it had been
>>"%MSGFILE%" echo quoting since the flat rate went in.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Three send sites had been maintaining their own copy of "send, file the PDF,
>>"%MSGFILE%" echo post the fee". They share one routine now.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 40 new tests, including that the ladder mails nothing on its own with Lob
>>"%MSGFILE%" echo connected, that Lob receives the corrected text, and that a stopped letter
>>"%MSGFILE%" echo bills nobody. 831 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Caught before shipping, by running the render functions rather than reading
>>"%MSGFILE%" echo them: a second "ago" helper redeclared a const that already existed further
>>"%MSGFILE%" echo down admin.html. That is a whole-file SyntaxError - the same white screen as
>>"%MSGFILE%" echo the v-loc bug, on the admin side this time.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Charge the fee for the method the buyer picked, and a flat rate for mail
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE FEE. The checkout endpoint computed calcFee(..., 'card') no matter what,
>>"%MSGFILE%" echo then opened a Stripe session offering card, bank transfer and Cash App. So a
>>"%MSGFILE%" echo buyer who chose bank transfer paid the CARD fee. On a $1,790.28 payment that
>>"%MSGFILE%" echo is $52.22 instead of $5.00 - about $47 too much, taken from someone already
>>"%MSGFILE%" echo behind. The app knew better: fee-quote returns card, ach and cashapp
>>"%MSGFILE%" echo separately, and calcFee honours an ACH rate with its own cap. The quote was
>>"%MSGFILE%" echo right; the charge ignored it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - "New card or bank" is now two buttons: Debit or credit card, and Bank
>>"%MSGFILE%" echo   transfer, labelled "Lower fee - takes a few business days".
>>"%MSGFILE%" echo - The buyer app sends the chosen method; the fee is computed for it; and the
>>"%MSGFILE%" echo   Stripe session is restricted to it, so the quote cannot be undercut at the
>>"%MSGFILE%" echo   last step.
>>"%MSGFILE%" echo - Choosing bank transfer now shows, before committing, that the payment is
>>"%MSGFILE%" echo   only "initiated" until the money lands, and that a late charge is based on
>>"%MSGFILE%" echo   the day the money ARRIVES, not the day it was started.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo THE MAIL. Postage was billed to the buyer at whatever Lob estimated, so the
>>"%MSGFILE%" echo same certified letter could cost two buyers different amounts. It is now a
>>"%MSGFILE%" echo flat published rate - $5 first class, $15 certified, both editable - and
>>"%MSGFILE%" echo what Lob actually billed is recorded separately from the invoice.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Three numbers kept apart on purpose: Lob's estimate at send time, Lob's real
>>"%MSGFILE%" echo invoice, and what the buyer was charged. Recording the invoice later never
>>"%MSGFILE%" echo re-bills anyone.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Those amounts were previously only settable in the setup wizard, so they
>>"%MSGFILE%" echo could never be changed once a company was running. They are on the company
>>"%MSGFILE%" echo endpoint now, and an omitted field keeps its value rather than zeroing it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Communications now opens collapsed, showing just an unread count, and does
>>"%MSGFILE%" echo not fetch the inbox until you open it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo 11 new tests. 791 passed, 0 failed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ---
>>"%MSGFILE%" echo.
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
