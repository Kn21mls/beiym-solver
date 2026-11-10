@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run Install.cmd first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, cryptography" >nul 2>&1
if errorlevel 1 (
  echo API dependencies are missing. Run:
  echo   .venv\Scripts\python.exe -m pip install -r server\requirements.txt
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m uvicorn server.app:app --host 127.0.0.1 --port 8787
if errorlevel 1 pause
