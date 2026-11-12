#!/bin/bash
set -e
cd -- "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v npm >/dev/null 2>&1; then
  echo 'Установите Node.js LTS и снова откройте Build-Safari.command.'
  exit 1
fi

if [[ -z "${BEYIM_BETA_API:-}" ]]; then
  read -r -p 'HTTPS-адрес API Beyim Solver: ' BEYIM_BETA_API
  export BEYIM_BETA_API
fi

npm --prefix extension ci
npm --prefix extension run package:safari
open "$PWD/extension/safari/server-extension"
