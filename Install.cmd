@echo off
setlocal
cd /d "%~dp0"
py -3 -m venv .venv
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
echo Installation complete. Open Start.cmd.
pause
exit /b 0
:failed
echo Installation failed. Check Python and internet connection.
pause
exit /b 1
