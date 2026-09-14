@echo off
REM AutoApply launcher. Double-click this file to start AutoApply.
setlocal
cd /d "%~dp0"

set "PY=backend\venv\Scripts\python.exe"
set "PORT=8000"

echo Starting AutoApply...
echo.

REM 1. AutoApply needs Python 3.11 or newer on the computer.
where py >nul 2>&1
if errorlevel 1 (
    where python >nul 2>&1
    if errorlevel 1 goto :need_python
    set "LAUNCHER=python"
) else (
    set "LAUNCHER=py -3"
)

REM 2. AutoApply runs on its own private copy of Python kept in backend\venv.
"%PY%" -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>&1
if not errorlevel 1 goto :have_python
if exist "backend\venv" rmdir /s /q "backend\venv"
echo Preparing AutoApply. This takes a few minutes the first time.
%LAUNCHER% -m venv backend\venv
if errorlevel 1 goto :prepare_failed
"%PY%" -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>&1
if errorlevel 1 goto :need_python

:have_python
REM 3. Install the files AutoApply needs, unless they are already in place.
"%PY%" -c "import fastapi, dotenv, uvicorn" >nul 2>&1
if not errorlevel 1 goto :have_files
echo Installing AutoApply's files. This takes a few minutes.
"%PY%" -m pip install -q -r backend\requirements.txt
if errorlevel 1 goto :install_failed

:have_files
REM 4. Private settings file, created from the template on first run.
if exist "backend\.env" goto :have_settings
copy /y "backend\.env.example" "backend\.env" >nul
echo Created the AutoApply settings file.

:have_settings
for /f "tokens=2 delims==" %%p in ('findstr /b /c:"AUTOAPPLY_PORT=" "backend\.env" 2^>nul') do set "PORT=%%p"
set "URL=http://127.0.0.1:%PORT%"

REM 5. If AutoApply is already running, just show it.
"%PY%" -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)" "%URL%/api/health" >nul 2>&1
if not errorlevel 1 (
    echo AutoApply is already running. Opening your browser.
    start "" "%URL%/dashboard"
    goto :done
)

REM 6. Start AutoApply, open the browser once it answers, and keep running.
echo Starting AutoApply...
start "" /b "%PY%" -m backend.main

set "READY="
for /l %%i in (1,1,60) do (
    if not defined READY (
        "%PY%" -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)" "%URL%/api/health" >nul 2>&1
        if not errorlevel 1 set "READY=1"
        if not defined READY timeout /t 1 /nobreak >nul 2>&1
    )
)
if not defined READY goto :start_failed

start "" "%URL%/dashboard"
echo.
echo AutoApply is open in your browser.
echo Keep this window open while you use AutoApply. Close it to stop AutoApply.

:watch
timeout /t 3 /nobreak >nul 2>&1
"%PY%" -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)" "%URL%/api/health" >nul 2>&1
if not errorlevel 1 goto :watch

echo.
echo AutoApply has stopped. Close this window.
pause >nul
goto :done

:need_python
echo.
echo AutoApply needs Python 3.11 or newer. Install it from https://python.org, then double-click this file again.
goto :failed

:prepare_failed
echo.
echo AutoApply could not be prepared. Check your internet connection, then double-click this file again.
goto :failed

:install_failed
echo.
echo AutoApply could not finish installing its files. Check your internet connection, then double-click this file again.
goto :failed

:start_failed
echo.
echo AutoApply could not start. Close this window, then double-click this file again.

:failed
echo.
pause >nul
endlocal
exit /b 1

:done
endlocal
exit /b 0
