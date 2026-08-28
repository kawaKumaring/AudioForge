@echo off
rem ---------------------------------------------------------------
rem AudioForge launcher.
rem ASCII only + CRLF on purpose: Korean text here breaks under CP949
rem and LF-only line endings make cmd.exe split lines. All Korean
rem messages are printed by scripts/af-launch.mjs instead.
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

rem UTF-8 console so the Korean output from node renders correctly.
chcp 65001 >nul 2>&1

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [AudioForge] Node.js was not found on PATH.
  echo              Install Node.js 20+ and run this file again.
  echo              https://nodejs.org/
  echo.
  pause
  exit /b 2
)

rem Environment check -^> install if missing -^> verify -^> connect -^> launch.
rem npm install (first run only) happens inside af-launch.mjs, right before
rem the app starts, so diagnostic runs like --check stay cheap.
rem af-launch.mjs prints the cause and the resume steps when it stops.
node "scripts\af-launch.mjs" %*
set "AF_EXIT=%ERRORLEVEL%"

rem Keep the window open so a double-click user can read the reason.
rem Set AUDIOFORGE_NO_PAUSE=1 for scripted runs, otherwise pause blocks forever.
if not "%AF_EXIT%"=="0" (
  echo.
  echo [AudioForge] Stopped with exit code %AF_EXIT%. See the message above.
  echo.
  if not defined AUDIOFORGE_NO_PAUSE pause
)

endlocal & exit /b %AF_EXIT%
