#!/usr/bin/env bash
set -u
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "Установка не завершена: $1"
  read -r -p "Нажмите Enter, чтобы закрыть..." _
  exit 1
}

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || fail "Python 3 не найден. Debian/Ubuntu: sudo apt install python3 python3-venv python3-tk"
echo "Использую $("$PYTHON" --version 2>&1)"
"$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
  || fail "Нужен Python 3.10 или новее (рекомендуется 3.14)."
"$PYTHON" -c 'import tkinter' 2>/dev/null \
  || fail "Tkinter не найден. Debian/Ubuntu: sudo apt install python3-tk; Fedora: sudo dnf install python3-tkinter; Arch: sudo pacman -S tk"

"$PYTHON" -m venv .venv || fail "не удалось создать окружение .venv (Debian/Ubuntu: sudo apt install python3-venv)"
./.venv/bin/python -m pip install --upgrade pip || fail "не удалось обновить pip"
./.venv/bin/python -m pip install -r requirements.txt || fail "не удалось установить зависимости"
./.venv/bin/python -m playwright install chromium || fail "не удалось скачать Chromium для Playwright"

echo
echo "Установка завершена. Запустите ./Start.sh"
echo "Если Chromium не стартует из-за системных библиотек, выполните: ./.venv/bin/python -m playwright install-deps"
read -r -p "Нажмите Enter, чтобы закрыть..." _
