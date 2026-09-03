@echo off
setlocal enabledelayedexpansion
title Porch Pay - Create the App Review account

echo.
echo  ========================================
echo   PORCH PAY - APP REVIEW ACCOUNT
echo  ========================================
echo.
echo   Creates a brand new demo company on the live site, with a
echo   buyer whose loan is 17%% paid off and up to date.
echo.
echo   It does NOT touch SAA Property Management or any real
echo   buyer. It only creates new records.
echo.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo   NODE IS NOT INSTALLED
  echo   Get it from https://nodejs.org - choose the LTS button,
  echo   install with all the defaults, then run this again.
  echo.
  pause
  exit /b 1
)
if not exist "seed-demo.js" (
  echo   Cannot find seed-demo.js next to this file.
  pause
  exit /b 1
)

echo  ----------------------------------------
echo   THE KEY
echo  ----------------------------------------
echo   Your server has signups closed, which is correct - it holds
echo   real buyers' loan records. Instead of opening it to everyone,
echo   paste the SIGNUP_TOKEN you set in Railway.
echo.
set "TOKEN="
set /p TOKEN=  Paste the signup token: 
if "!TOKEN!"=="" (
  echo.
  echo   No token. See the instructions Claude gave you for adding
  echo   SIGNUP_TOKEN in Railway, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo  ----------------------------------------
echo   1 of 2: the BUYER login
echo  ----------------------------------------
echo   This is what you give Apple. A stranger signs in with it,
echo   on the same server that holds your real buyers' records.
echo   Make it a real password - at least 10 characters, with a
echo   number or symbol, and no words like "test" or "demo".
echo.
:askbuyer
set "BUYERPW="
set /p BUYERPW=  Buyer password: 
if "!BUYERPW!"=="" goto :askbuyer

echo.
echo  ----------------------------------------
echo   2 of 2: the SERVICER login
echo  ----------------------------------------
echo   Yours, for the demo company's admin site. Must be DIFFERENT
echo   from the buyer one, and different from your real SAA password.
echo.
:askadmin
set "ADMINPW="
set /p ADMINPW=  Servicer password: 
if "!ADMINPW!"=="" goto :askadmin

if "!ADMINPW!"=="!BUYERPW!" (
  echo.
  echo   Those are the same password. Guessing one would hand over
  echo   the admin site as well. Run this again with two different ones.
  echo.
  pause
  exit /b 1
)

set "PORCHPAY_SIGNUP_TOKEN=!TOKEN!"
set "PORCHPAY_BUYER_PW=!BUYERPW!"
set "PORCHPAY_ADMIN_PW=!ADMINPW!"

echo.
echo   Building the account. This posts seven years of payments,
echo   so give it a minute...
echo.

node seed-demo.js --url https://porchpay-production.up.railway.app
if errorlevel 1 goto :failed

echo.
echo  ========================================
echo   DONE
echo  ========================================
echo.
echo   Save both passwords in your password manager NOW.
echo   They are not stored anywhere.
echo.
echo   Next:
echo     1. Go to https://porchpay-production.up.railway.app/
echo        Sign in as  appreview@porchpay.app  with the BUYER password.
echo     2. Take six screenshots: Home, Pay, My Loan, Documents,
echo        Payment History, Messages.
echo     3. Put that email and password into App Store Connect
echo        under "Sign-In Required".
echo.
pause
exit /b 0

:failed
echo.
echo   NOTHING WAS CREATED - copy everything above and send it to Claude.
echo.
echo   "Signups are closed"     - the token did not match what is in
echo                              Railway. Check for a stray space.
echo   "already registered"     - this ran once before. Send me the
echo                              message and I will sort it out.
echo   A password complaint     - pick a stronger one and run again.
echo.
pause
exit /b 1
