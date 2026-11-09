@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run Install.cmd first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -c "import playwright.sync_api" >nul 2>&1
if errorlevel 1 (
  echo Browser dependencies are missing or incompatible. Run Install.cmd, then Start.cmd again.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" main.py
if errorlevel 1 pause
