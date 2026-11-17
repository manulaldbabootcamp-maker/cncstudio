@echo off
REM ---------------------------------------------------------------------------
REM  CNC Studio - always launch the latest version from GitHub.
REM
REM  Double-click this file. It pulls whatever is newest, rebuilds, and starts
REM  the app. If the PC is offline or GitHub is unreachable it says so and
REM  starts the copy already on disk, so the shop is never stopped by the
REM  network.
REM
REM  First run on a new PC needs: Git, Node.js, and `npm install` in electron\.
REM  See README for that one-time setup.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title CNC Studio

echo.
echo   Checking GitHub for updates...
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo   [!] This folder is not a git clone - cannot update. Starting as-is.
  goto :launch
)

REM Refuse to clobber local edits: stop and let a person decide.
git diff --quiet && git diff --cached --quiet
if errorlevel 1 (
  echo   [!] There are uncommitted changes in this folder.
  echo       Not pulling, so nothing of yours is lost. Starting as-is.
  echo.
  goto :launch
)

git pull --ff-only
if errorlevel 1 (
  echo.
  echo   [!] Could not reach GitHub, or the branch has diverged.
  echo       Starting the version already on this PC.
  echo.
  goto :launch
)

REM A pull can bring in new dependencies.
if not exist "electron\node_modules" (
  echo.
  echo   Installing dependencies, one moment...
  pushd electron && call npm install && popd
)

:launch
for /f "delims=" %%v in ('git rev-parse --short HEAD 2^>nul') do set REV=%%v
echo   Starting CNC Studio  [%REV%]
echo.
cd electron
call npm start
