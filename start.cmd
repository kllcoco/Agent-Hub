@echo off
setlocal
cd /d "%~dp0"
if not exist "data" mkdir "data"
echo Starting Agent Hub on http://127.0.0.1:8787 ...
node server.mjs
