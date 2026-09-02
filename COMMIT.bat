@echo off
setlocal
title Porch Pay - Commit today's work

cd /d "%~dp0"

echo.
echo  ========================================
echo   PORCH PAY - COMMITTING
echo  ========================================
echo.

echo  Clearing stale lock files...
del /f /q ".git\index.lock" >nul 2>&1
del /f /q ".git\HEAD.lock" >nul 2>&1
del /f /q ".git\refs\heads\main.lock" >nul 2>&1

where git >nul 2>&1
if errorlevel 1 (
  echo  ERROR: git is not installed or not on PATH.
  pause
  exit /b 1
)

echo.
echo  Files changed:
git --no-pager diff --stat
echo.

REM The sample PDFs are illustrations, not part of the app.
findstr /c:"sample-notices/" ".gitignore" >nul 2>&1
if errorlevel 1 echo sample-notices/>>".gitignore"

set "MSGFILE=%TEMP%\porchpay-commit-msg.txt"
> "%MSGFILE%" echo Notice correctness, Lob hardening, unapplied funds, and the Illinois track
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Six areas in one commit because they are interleaved inside server.js and
>>"%MSGFILE%" echo notices.js. Splitting by file would produce commits that do not run, since
>>"%MSGFILE%" echo server.js calls helpers added to lob.js, templates.js and notices.js here.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo NOTICE CORRECTNESS
>>"%MSGFILE%" echo The Michigan cure date was computed as due date plus eight days regardless of
>>"%MSGFILE%" echo when the notice went out, so a long grace period or a loan imported mid-default
>>"%MSGFILE%" echo produced a formal notice demanding cure by a date already past. Both dates are
>>"%MSGFILE%" echo now floored against the day the notice is written. Normal day-6 timing unchanged.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Default notices no longer put the balance or the words "notice of default" in a
>>"%MSGFILE%" echo text message, which lands on a lock screen in a household where the phone may be
>>"%MSGFILE%" echo shared. The text points at the app; every other channel carries the notice.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Generic notices signed off as "Loan Servicing" and now name the company.
>>"%MSGFILE%" echo Co-buyers are named on every notice, envelope and evidence document via one
>>"%MSGFILE%" echo borrowersFor helper. The evidence documents printed a "Purchaser(s)" label with
>>"%MSGFILE%" echo a single name in it.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Day-6 notices come from Servicing, everything after from Legal, with the
>>"%MSGFILE%" echo department and its address on the letterhead, signature and contact line.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo LOB
>>"%MSGFILE%" echo Certified mail is a per-rule flag rather than a hardcoded stage name, so
>>"%MSGFILE%" echo retiming the ladder cannot silently stop the mail. One mailingAddressFor answers
>>"%MSGFILE%" echo where a letter goes: buyer mailing address, else the property with its unit line.
>>"%MSGFILE%" echo Addresses are verified against USPS before postage is bought. A test key skips
>>"%MSGFILE%" echo verification and says so, because Lob cannot verify on test keys.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Serving a DC 101 on a test key is refused. It stamped a service date, started
>>"%MSGFILE%" echo the statutory cure clock and filed a court exhibit swearing to a tracking number,
>>"%MSGFILE%" echo for a letter that was never printed.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo A delivery-status sweep records USPS scans without anybody clicking. "re-routed"
>>"%MSGFILE%" echo is no longer treated as terminal: it means forwarded, and that is the letter
>>"%MSGFILE%" echo whose scan matters most. Multi-page letters are priced by real page count instead
>>"%MSGFILE%" echo of always one. lobFetch has a timeout so a hung request cannot stall the sweep.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Settings gains a one-click test letter to your own return address.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo MONEY
>>"%MSGFILE%" echo Unapplied money is held on the loan instead of folded into escrow. Escrow is
>>"%MSGFILE%" echo trust money held for a named person and an overpayment is not that. An allocation
>>"%MSGFILE%" echo dialog directs it to principal, interest, taxes, insurance, late fees, admin fees,
>>"%MSGFILE%" echo postage or other, with a note required on other.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo The reconcile report names the cause of each discrepancy rather than showing a
>>"%MSGFILE%" echo delta. Journal entries can be corrected and removed through reversals; the ledger
>>"%MSGFILE%" echo is never rewritten.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ILLINOIS
>>"%MSGFILE%" echo Illinois installment contracts leave the generic ladder: Notice of Default day 6,
>>"%MSGFILE%" echo Intent to Declare Forfeiture day 46, 5-Day Notice to Quit day 85, all certified,
>>"%MSGFILE%" echo with preparation and filing tasks at 75 and 91. The 90-day contract cure runs from
>>"%MSGFILE%" echo the date of default; the 30-day forfeiture cure runs from the Intent notice.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo MICHIGAN
>>"%MSGFILE%" echo The DC 101 carries the legal description and every purchaser. A stray question
>>"%MSGFILE%" echo mark appeared mid-sentence on every court copy, because the newline splitting the
>>"%MSGFILE%" echo certificate-of-service box was folded to an unencodable character. The day-6
>>"%MSGFILE%" echo notice itemises taxes and insurance the seller advanced. The certificate of
>>"%MSGFILE%" echo delivery records the mail channel with its tracking and scan.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo ALSO
>>"%MSGFILE%" echo Payment reminders are seeded by the sweep that sends them. They were only created
>>"%MSGFILE%" echo when somebody opened Settings, so on a company where nobody had, no reminder had
>>"%MSGFILE%" echo ever gone out.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Personal names are out of outbound documents. The DC 101 signed itself with
>>"%MSGFILE%" echo whoever happened to be logged in.
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo Suite: 753 passing, 5 failing, unchanged from 1b2baa1. Migrations verified
>>"%MSGFILE%" echo against a fresh directory and a pre-built snapshot.

git add -A
if errorlevel 1 (
  echo  ERROR: git add failed. Nothing was committed.
  pause
  exit /b 1
)

git commit -F "%MSGFILE%"
if errorlevel 1 (
  echo.
  echo  ERROR: commit failed. Nothing was pushed.
  del /f /q "%MSGFILE%" >nul 2>&1
  pause
  exit /b 1
)
del /f /q "%MSGFILE%" >nul 2>&1

echo.
echo  ========================================
echo   COMMITTED
echo  ========================================
git --no-pager log -1 --stat
echo.
echo  Nothing has been pushed yet.
echo  Run PUSH.bat when you are ready to deploy.
echo.
pause
