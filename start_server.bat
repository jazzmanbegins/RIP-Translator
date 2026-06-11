@echo off
title RIP Translator - Whisper Server
cd /d "%~dp0"
echo ============================================
echo  RIP Translator - Whisper Server
echo  Close this window to stop the server
echo ============================================
echo.
python -u whisper_server.py
echo.
echo Server stopped. Press any key to close.
pause >nul
