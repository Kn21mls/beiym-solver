#!/bin/bash
set -e
cd -- "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v npm >/dev/null 2>&1; then
  echo 'Установите Node.js LTS и снова откройте Build-Safari.command.'
  exit 1
fi

npm --prefix extension ci
npm --prefix extension run package:safari
open "$PWD/extension/safari/web-extension"
