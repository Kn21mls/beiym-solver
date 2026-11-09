@echo off
setlocal
cd /d "%~dp0"
rem Keep the tested Python ABI even when a newer Python becomes the default.
py -3.14 -m venv .venv
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
echo Installation complete. Open Start.cmd.
pause
exit /b 0
:failed
echo Installation failed. Check Python and internet connection.
echo This version requires Python 3.14. Check it with: py -3.14 --version
pause
exit /b 1
