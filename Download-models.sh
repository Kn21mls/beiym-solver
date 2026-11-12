#!/usr/bin/env bash
set -u
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "$1"
  read -r -p "Нажмите Enter, чтобы закрыть..." _
  exit 1
}

command -v ollama >/dev/null 2>&1 || fail "Ollama не найдена. Установите её с https://ollama.com/download/linux"
ollama pull qwen3:1.7b || fail "Не удалось скачать qwen3:1.7b. Проверьте Ollama и интернет."
ollama pull qwen3-vl:2b || fail "Не удалось скачать qwen3-vl:2b. Проверьте Ollama и интернет."

if [ ! -x ".venv/bin/python" ]; then
  echo "Модели готовы. Запустите ./Install.sh, затем ./Start.sh."
  read -r -p "Нажмите Enter, чтобы закрыть..." _
  exit 0
fi

echo "Модели готовы. Проверяю текст, рисунок и освобождение памяти..."
./.venv/bin/python main.py --full-smoke-test --provider ollama \
  || fail "Модели установлены, но автопроверка не прошла. Скопируйте ошибку выше."
echo "Проверки пройдены. Запустите ./Start.sh."
read -r -p "Нажмите Enter, чтобы закрыть..." _
