@echo off
rem Double-click this to start Numax Studio. It opens your browser itself,
rem once the server is actually listening.
cd /d "%~dp0.."
echo Starting Numax Studio...
echo Close this window (or press Ctrl+C) to stop it.
echo.
python studio\studio_server.py 8731
echo.
echo Studio has stopped.
pause
