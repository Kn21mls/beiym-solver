@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run Install.cmd first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m uvicorn server.beta:app --host 127.0.0.1 --port 8787 --workers 1 --no-proxy-headers
if errorlevel 1 pause
