#!/bin/bash
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "Установка не завершена: $1"
  read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть..."
  exit 1
}

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || fail "Python 3 не найден. Установите Python 3.14 с https://www.python.org/downloads/macos/"

"$PYTHON" -m venv .venv || fail "не удалось создать окружение .venv"
./.venv/bin/python -m pip install --upgrade pip || fail "не удалось обновить pip"
./.venv/bin/python -m pip install -r requirements.txt || fail "не удалось установить зависимости"
./.venv/bin/python -m playwright install chromium || fail "не удалось скачать Chromium для Playwright"

echo
echo "Установка завершена. Откройте Start.command."
read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть..."
