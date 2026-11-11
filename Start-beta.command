#!/bin/bash
set -e
cd -- "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ ! -x .venv/bin/python ]]; then
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || {
    echo 'Установите Python 3.10 или новее и снова откройте Start-beta.command.'
    exit 1
  }
  python3 -m venv .venv
fi

python=./.venv/bin/python
if ! "$python" -c 'import server.beta, uvicorn' >/dev/null 2>&1; then
  "$python" -m pip install -r server/requirements.txt
fi

if [[ -z "${GROQ_API_KEY:-}" ]]; then
  read -r -s -p 'Ключ Groq Free: ' GROQ_API_KEY
  printf '\n'
  export GROQ_API_KEY
fi
if [[ -z "$GROQ_API_KEY" ]]; then
  echo 'Введите ключ Groq Free, чтобы запустить сервер.'
  exit 1
fi

exec "$python" -m uvicorn server.beta:app --host 127.0.0.1 --port 8787 --workers 1 --no-proxy-headers
