@echo off
cd /d "%~dp0"
echo ============================================
echo  RIP Translator - One-time Setup
echo  (Run this ONCE, then never again)
echo ============================================
echo.

set BAT=%~dp0start_server.bat

echo Registering ripwhisper:// protocol handler...
reg add "HKCU\Software\Classes\ripwhisper"                          /ve /t REG_SZ /d "URL:RIP Whisper Protocol" /f >nul
reg add "HKCU\Software\Classes\ripwhisper"                          /v "URL Protocol" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\ripwhisper\shell\open\command"       /ve /t REG_SZ /d "cmd /c start \"RIP Whisper\" \"%BAT%\"" /f >nul

echo.
echo Done! You can now start the server directly from the extension popup.
echo.
pause
