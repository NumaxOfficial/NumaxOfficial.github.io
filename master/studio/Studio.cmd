@echo off
rem Double-click this to start Numax Studio, then open http://localhost:8731/
cd /d "%~dp0.."
echo Starting Numax Studio on http://localhost:8731/
echo Close this window (or press Ctrl+C) to stop it.
echo.
start "" http://localhost:8731/
python studio\studio_server.py 8731
pause
