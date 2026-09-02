@echo off
setlocal
title Porch Pay - Commit today's work

echo.
echo  ========================================
echo   PORCH PAY - COMMITTING
echo  ========================================
echo.

cd /d "%~dp0"

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

REM Sample PDFs are illustrations, not part of the app.
if exist ".gitignore" (
  findstr /c:"sample-notices/" ".gitignore" >nul 2>&1
  if errorlevel 1 echo sample-notices/>> ".gitignore"
)

git add -A
if errorlevel 1 (
  echo  ERROR: git add failed.
  pause
  exit /b 1
)

git commit -F - <<COMMITMSG
Notice correctness, Lob hardening, unapplied funds, and the Illinois track

Six areas, in one commit because they are interleaved inside server.js and
notices.js — splitting by file would produce commits that do not run, since
server.js calls helpers added to lob.js, templates.js and notices.js here.

NOTICE CORRECTNESS
The Michigan cure date was computed as due-date plus eight days regardless of
when the notice actually went out, so a long grace period or a loan imported
mid-default produced a formal notice demanding cure by a date already past.
Both dates are now floored against the day the notice is written; normal
day-6 timing is unchanged.

Default notices no longer put the balance or the words "notice of default"
in a text message — that lands on a lock screen in a household where the
phone may be shared. The text points at the app; every other channel carries
the notice in full.

Generic notices signed off as "Loan Servicing" and now name the company.
Co-buyers are named on every notice, envelope and evidence document via one
borrowersFor helper; the evidence documents were printing a "Purchaser(s)"
label with a single name in it.

Day-6 notices come from Servicing, everything after from Legal, with the
department and its address on the letterhead, the signature and the contact
line. Addresses come from the configured email identities.

LOB
Certified mail is a per-rule flag rather than a hardcoded stage name, so
retiming the ladder cannot silently stop the mail. One mailingAddressFor
answers where a letter goes — buyer's mailing address, else the property
with its unit line. Addresses are verified against USPS before postage is
bought; a test key skips verification and says so, because Lob cannot verify
on test keys and a false clean answer is worse than none.

Serving a DC 101 on a test key is refused: it stamped a service date, started
the statutory cure clock and filed a court exhibit swearing to a tracking
number, for a letter that was never printed.

A delivery-status sweep records USPS scans without anybody clicking.
"re-routed" is no longer treated as terminal — it means forwarded, and that
is the letter whose scan matters most. Multi-page letters are priced by
their real page count instead of always one. lobFetch has a timeout, so a
hung request cannot stall the nightly sweep.

Settings gains a one-click test letter to your own return address.

MONEY
Unapplied money is held on the loan instead of being folded into escrow —
escrow is trust money held for a named person and an overpayment is not
that. An allocation dialog directs it to principal, interest, taxes,
insurance, late fees, admin fees, postage or other, with a note required on
other. Taxes and insurance cross into the trust fund properly.

The reconcile report names the cause of each discrepancy rather than showing
a delta. Journal entries can be corrected and removed through reversals; the
ledger is never rewritten.

ILLINOIS
Illinois installment contracts leave the generic ladder: Notice of Default
day 6, Intent to Declare Forfeiture day 46, 5-Day Notice to Quit day 85, all
certified, with preparation and filing tasks at 75 and 91. The 90-day
contract cure runs from the date of default; the 30-day forfeiture cure runs
from the Intent notice.

MICHIGAN
The DC 101 carries the legal description and every purchaser. A stray "?"
appeared mid-sentence on every court copy, because the newline splitting the
certificate-of-service box was folded to an unencodable character. The day-6
notice itemises taxes and insurance the seller advanced. The certificate of
delivery records the mail channel with its tracking and scan.

ALSO
Payment reminders are seeded by the sweep that sends them. They were only
created when somebody opened Settings, so on a company where nobody had,
no reminder had ever gone out.

Personal names are out of outbound documents — the DC 101 signed itself with
whoever was logged in.

Suite: 753 passing, 5 failing, unchanged from 1b2baa1. Migrations verified
against a fresh directory and a pre-built snapshot.
COMMITMSG

if errorlevel 1 (
  echo.
  echo  ERROR: commit failed. Nothing was pushed.
  pause
  exit /b 1
)

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
