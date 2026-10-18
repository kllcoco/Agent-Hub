@echo off
setlocal
cd /d "%~dp0"
if not exist "data" mkdir "data"
echo Starting Agent Hub worker (models stay OFF until a switch is enabled in the dashboard)...
node worker.mjs
