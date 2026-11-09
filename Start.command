#!/bin/bash
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "$1"
  read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть..."
  exit 1
}

[ -x ".venv/bin/python" ] || fail "Сначала запустите Install.command."
./.venv/bin/python -c "import playwright.sync_api" >/dev/null 2>&1 \
  || fail "Зависимости браузера не установлены. Запустите Install.command."

./.venv/bin/python main.py
status=$?
if [ "$status" -ne 0 ]; then
  read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть..."
fi
exit "$status"
