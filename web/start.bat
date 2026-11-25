@echo off
cd /d "%~dp0"
set "PY=python"
if exist "D:\python\python.exe" set "PY=D:\python\python.exe"
"%PY%" serve.py
pause
