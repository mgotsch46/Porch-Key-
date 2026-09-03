@echo off
setlocal enabledelayedexpansion
title Porch Pay - Find the Apple push key

echo.
echo  ========================================
echo   LOOKING FOR YOUR APPLE PUSH KEY
echo  ========================================
echo.
echo  Apple names these files AuthKey_XXXXXXXXXX.p8
echo  The 10 characters are the Key ID.
echo.
echo  We are looking for either of these two:
echo      AuthKey_P59FPK5K3P.p8     ^(Deal Flow Pro Push^)
echo      AuthKey_YS2D63RVJH.p8     ^(Expo Push Notifications Key^)
echo.
echo  Searching. This can take a minute or two - please wait.
echo.

set "OUT=%~dp0p8-search-results.txt"
> "%OUT%" echo APPLE PUSH KEY SEARCH
>> "%OUT%" echo Run on %DATE% at %TIME%
>> "%OUT%" echo.
>> "%OUT%" echo Your Apple Team ID:  58M49NYZQY
>> "%OUT%" echo.
>> "%OUT%" echo Keys registered in your Apple account:
>> "%OUT%" echo   P59FPK5K3P   Deal Flow Pro Push
>> "%OUT%" echo   YS2D63RVJH   Expo Push Notifications Key
>> "%OUT%" echo.
>> "%OUT%" echo ============================================================
>> "%OUT%" echo ANY .p8 FILES FOUND
>> "%OUT%" echo ============================================================
>> "%OUT%" echo.

set "FOUND=0"

echo  [1 of 3] Searching your user folder...
for /f "delims=" %%F in ('dir /b /s "%USERPROFILE%\*.p8" 2^>nul') do (
  echo    FOUND: %%F
  >> "%OUT%" echo %%F
  set "FOUND=1"
)

echo  [2 of 3] Searching OneDrive and shared folders...
if exist "%USERPROFILE%\OneDrive" (
  for /f "delims=" %%F in ('dir /b /s "%USERPROFILE%\OneDrive\*.p8" 2^>nul') do (
    echo    FOUND: %%F
    >> "%OUT%" echo %%F
    set "FOUND=1"
  )
)

echo  [3 of 3] Searching the rest of the C: drive...
for /f "delims=" %%F in ('dir /b /s "C:\*.p8" 2^>nul') do (
  echo    FOUND: %%F
  >> "%OUT%" echo %%F
  set "FOUND=1"
)

if "%FOUND%"=="0" (
  >> "%OUT%" echo   ^(none found anywhere on this computer^)
  >> "%OUT%" echo.
  >> "%OUT%" echo ============================================================
  >> "%OUT%" echo NOT ON THIS COMPUTER - OTHER PLACES TO LOOK
  >> "%OUT%" echo ============================================================
  >> "%OUT%" echo.
  >> "%OUT%" echo 1. EXPO. If the Expo key was made by EAS, Expo still has it.
  >> "%OUT%" echo    Open a terminal in that project and run:  eas credentials
  >> "%OUT%" echo    Choose iOS, then Push Notifications, then download the key.
  >> "%OUT%" echo.
  >> "%OUT%" echo 2. Another computer, a phone backup, or a password manager.
  >> "%OUT%" echo    Search those for  .p8  or  AuthKey.
  >> "%OUT%" echo.
  >> "%OUT%" echo 3. Whoever built Deal Flow Pro, if that was not you. They
  >> "%OUT%" echo    downloaded that key and may still have it.
  >> "%OUT%" echo.
  >> "%OUT%" echo If none of those work, tell Claude. The last resort is
  >> "%OUT%" echo revoking one key to free a slot - but that switches off push
  >> "%OUT%" echo for whichever app was using it, so decide deliberately.
) else (
  >> "%OUT%" echo.
  >> "%OUT%" echo ============================================================
  >> "%OUT%" echo WHAT TO DO NEXT
  >> "%OUT%" echo ============================================================
  >> "%OUT%" echo.
  >> "%OUT%" echo Look at the file name. If it is AuthKey_P59FPK5K3P.p8 or
  >> "%OUT%" echo AuthKey_YS2D63RVJH.p8, that is the one you need.
  >> "%OUT%" echo.
  >> "%OUT%" echo In Firebase:  Project settings - Cloud Messaging tab -
  >> "%OUT%" echo APNs Authentication Key - Upload.
  >> "%OUT%" echo   Key file:  the .p8 above
  >> "%OUT%" echo   Key ID:    the 10 characters in the file name
  >> "%OUT%" echo   Team ID:   58M49NYZQY
  >> "%OUT%" echo.
  >> "%OUT%" echo Do NOT revoke anything. Nothing breaks doing it this way.
)

echo.
echo  ========================================
echo   DONE - opening results
echo  ========================================
echo.
start "" notepad "%OUT%"
pause
exit /b 0
