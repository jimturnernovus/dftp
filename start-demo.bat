@echo off
rem Starts the DFTP (Designer for the Page) demo and opens it in your browser.
rem Double-click this file, or run it from a terminal. It needs Node.js 22
rem or newer. Press Ctrl+C in this window to stop it.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

node "%~dp0bin\dftp.mjs" --demo --open
if errorlevel 1 pause
