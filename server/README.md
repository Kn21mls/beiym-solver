# Beyim Solver API

BYOK-бэкенд: пользователь регистрируется в Beyim Solver, вручную создаёт ключ Groq и сохраняет его на сервере. Ключ шифруется перед записью в SQLite.

Groq не предоставляет API для автоматического создания ключей. Пользователь делает это в `https://console.groq.com/keys` после входа в аккаунт Groq.

## Установка

```powershell
Set-Location 'C:\Users\Nout\Documents\ChatGPT\Beyim Solver'
.\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
```

## Запуск

Из корня проекта:

```powershell
.\Start-api.cmd
```

Или напрямую:

```powershell
Set-Location 'C:\Users\Nout\Documents\ChatGPT\Beyim Solver'
.\.venv\Scripts\python.exe -m uvicorn server.app:app --host 127.0.0.1 --port 8787
```

Для доступа с других устройств используйте `--host 0.0.0.0`, но тогда обязательно настройте HTTPS-прокси и ограничьте доступ.

## Переменные окружения

- `BEYIM_DATA_DIR` — каталог данных, по умолчанию `server/data`.
- `BEYIM_DB` — путь к SQLite, по умолчанию `server/data/app.db`.
- `BEYIM_SECRET_KEY` — ключ Fernet для шифрования Groq-ключей. Если не задан, ключ генерируется в `server/data/secret.key`.
- `BEYIM_SECRET_FILE` — путь к файлу сгенерированного ключа.

Для production задайте `BEYIM_SECRET_KEY` явно и храните его вне репозитория.

## Эндпоинты

- `GET /health`
- `GET /v1/onboarding/groq`
- `POST /v1/auth/register` — `{ "email": "...", "password": "..." }`
- `POST /v1/auth/login` — `{ "email": "...", "password": "..." }`
- `POST /v1/auth/logout` — Bearer token, отзывает текущую сессию
- `GET /v1/me` — Bearer token
- `PUT /v1/groq` — `{ "api_key": "gsk_..." }`
- `DELETE /v1/groq`
- `POST /v1/solve` — Bearer token, тело:
  ```json
  {
    "question": {
      "text": "Текст задания",
      "kind": "single",
      "options": [{ "text": "Вариант 1" }, { "text": "Вариант 2" }],
      "image": "data:image/jpeg;base64,..."
    },
    "model": "qwen/qwen3.8-27b",
    "min_confidence": 0.8,
    "timeout": 180,
    "num_predict": 768
  }
  ```
  Ответ: `{ "answer": { "answer_ids": [1], "text_answer": "", "explanation": "...", "confidence": 0.95, "needs_help": false } }`

## Безопасность

- Пароли хранятся как scrypt-хеши с солью.
- Токены сессий хранятся в виде SHA-256 хешей, срок жизни 30 дней.
- Groq-ключи шифруются Fernet.
- Не коммитьте `server/data`, `server/.env` и файлы ключей.
