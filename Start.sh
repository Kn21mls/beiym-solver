#!/usr/bin/env bash
set -u
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "$1"
  read -r -p "Нажмите Enter, чтобы закрыть..." _
  exit 1
}

[ -x ".venv/bin/python" ] || fail "Сначала запустите ./Install.sh"
./.venv/bin/python -c "import playwright.sync_api" >/dev/null 2>&1 \
  || fail "Зависимости браузера не установлены. Запустите ./Install.sh"

./.venv/bin/python main.py
status=$?
if [ "$status" -ne 0 ]; then
  read -r -p "Нажмите Enter, чтобы закрыть..." _
fi
exit "$status"
