@echo off
cd /d "%~dp0"
REM Starts the server hidden via the VBS helper
cscript //nologo run-hidden.vbs
echo Server start requested (hidden).
