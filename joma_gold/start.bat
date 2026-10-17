@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo First run detected - installing dependencies...
  call install.bat
)
start "" http://127.0.0.1:8080
.venv\Scripts\python.exe app.py
pause
