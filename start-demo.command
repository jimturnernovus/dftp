#!/bin/sh
# Starts the DFTP (Designer for the Page) demo and opens it in your browser.
# Double-click this file in Finder, or run it from a terminal. It needs
# Node.js 22 or newer. Press Ctrl+C in this window to stop it.

dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js 22 or newer from https://nodejs.org/ and try again."
  exit 1
fi

exec node "$dir/bin/dftp.mjs" --demo --open
