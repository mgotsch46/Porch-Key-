@echo off
title Porch Pay - Firebase config files

echo.
echo  ========================================
echo   FIREBASE CONFIG FILES
echo  ========================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0firebase-files.ps1"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo   Nothing was written. Read the message above.
  echo.
  pause
  exit /b 1
)

echo  ========================================
echo   DONE - opening the values
echo  ========================================
echo.
echo   Paste each long code into Codemagic, then close Notepad
echo   and delete firebase-codemagic-values.txt
echo.
start "" notepad "%~dp0firebase-codemagic-values.txt"
pause
exit /b 0
