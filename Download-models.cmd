@echo off
cd /d "%~dp0"
ollama pull qwen3:1.7b
if errorlevel 1 goto failed
ollama pull qwen3-vl:2b
if errorlevel 1 goto failed
if not exist ".venv\Scripts\python.exe" (
  echo Models ready. Run Install.cmd, then Start.cmd.
  if /I not "%~1"=="/auto" pause
  exit /b 0
)
echo Models ready. Checking text, image and memory release...
".venv\Scripts\python.exe" main.py --full-smoke-test --provider ollama
if errorlevel 1 goto checkfailed
echo Checks passed. Run Start.cmd.
if /I not "%~1"=="/auto" pause
exit /b 0
:checkfailed
echo Models installed, but the automatic check failed. Copy the error above for diagnosis.
if /I not "%~1"=="/auto" pause
exit /b 1
:failed
echo Download failed. Check Ollama and your connection, then run this file again to resume.
if /I not "%~1"=="/auto" pause
exit /b 1
