@echo off
setlocal EnableDelayedExpansion
>nul chcp 65001
title Spirit AI - Cursor Companion
color 0B
cls

echo.

if exist "%~dp0spirit-banner.txt" (
    type "%~dp0spirit-banner.txt"
) else (
    echo             S P I R I T   A I
    echo           AI-AWARE CURSOR COMPANION
    echo.
)
echo.

echo             [*] Initializing neural interface...
echo.

timeout /t 1 /nobreak >nul


echo.
echo             [01]  NODE RUNTIME
echo.
echo             ^> Checking environment...

where node >nul 2>nul

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo             [X] Node.js not found.
    echo.
    echo             Spirit AI requires Node.js v18+
    echo             https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v" %%i in ('node --version') do set NODE_VER=%%i
for /f "tokens=1 delims=v." %%i in ('node --version') do set NODE_MAJOR=%%i

echo             [OK] Node.js !NODE_VER!

if !NODE_MAJOR! LSS 18 (
    echo.
    echo             [X] Node.js v18 or newer is required.
    echo             Current version: !NODE_VER!
    echo.
    pause
    exit /b 1
)

echo             [OK] Runtime compatible.
timeout /t 1 /nobreak >nul


echo.
echo             [02]  SPIRIT CORE
echo.
echo             ^> Locating project files...

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%Spirit-Ai-Cursor"

if not exist "%PROJECT_DIR%\package.json" (
    set "PROJECT_DIR=%SCRIPT_DIR%"

    if not exist "!PROJECT_DIR!\package.json" (
        echo.
        echo             [X] package.json not found.
        echo             Make sure this launcher is inside
        echo             the Spirit AI project folder.
        echo.
        pause
        exit /b 1
    )

    for %%A in ("!PROJECT_DIR!.") do set "PROJECT_DIR=%%~fA"
)

echo             [OK] Spirit Core located.
echo             [OK] !PROJECT_DIR!

timeout /t 1 /nobreak >nul


echo.
echo             [03]  SYNAPTIC LINKS
echo.
echo             ^> Checking dependencies...

pushd "%PROJECT_DIR%"

:: electron\path.txt only exists once npm install fully completed. A cancelled
:: or interrupted install still leaves node_modules/ on disk, so checking the
:: bare folder would wrongly skip setup and crash at launch.
if exist "%PROJECT_DIR%\node_modules\electron\path.txt" goto deps_ok

echo             [..] Installing npm modules...
echo             [..] This may take a few minutes.
echo             [..] (Native binaries + optional STT auto-setup run here)
echo.

set "INSTALL_OK=0"

call npm install --no-audit --no-fund

if !errorlevel! EQU 0 set "INSTALL_OK=1"

if "!INSTALL_OK!"=="1" goto deps_done

echo.
echo             [!] Standard installation failed.
echo             [..] Retrying with legacy peer deps...
echo.

call npm install --legacy-peer-deps --no-audit --no-fund

if !errorlevel! EQU 0 set "INSTALL_OK=1"

if "!INSTALL_OK!"=="1" goto deps_done

echo.
echo             [X] Dependency installation FAILED.
echo             [X] Check the npm error above, then run
echo             [X] this launcher again (resumes where it stopped).
echo.
pause
exit /b 1

:deps_done
echo.
echo             [OK] Dependencies installed.
goto deps_next

:deps_ok
echo             [OK] node_modules detected.
echo             [OK] Dependencies already installed.

:deps_next
timeout /t 1 /nobreak >nul


echo.
echo             [04]  OPTICAL GHOST (OCR)
echo.
echo             ^> Locating Tesseract OCR...

set "TESS_FOUND=0"
if exist "%PROGRAMFILES%\Tesseract-OCR\tesseract.exe" set "TESS_FOUND=1"
if exist "%PROGRAMFILES(x86)%\Tesseract-OCR\tesseract.exe" set "TESS_FOUND=1"
where tesseract >nul 2>nul && set "TESS_FOUND=1"

if "!TESS_FOUND!"=="1" (
    echo             [OK] Tesseract OCR found. Screen reading ready.
) else (
    echo             [..] Tesseract OCR not installed.
    echo             [..] Reading screens will be limited, but the
    echo             [..] app still runs. To enable full OCR:
    echo.
    echo             ^> Install:  https://github.com/UB-Mannheim/tesseract/wiki
    echo             ^> (default location under "Program Files\Tesseract-OCR")
    echo.
)

timeout /t 1 /nobreak >nul


echo.
echo             [05]  NEURAL CORE
echo.
echo             ^> Checking build freshness...
echo.

set "STAMP=%PROJECT_DIR%\node_modules\.cache\spirit-build-stamp"
set "NEEDS_BUILD=0"

:: DEV MODE: Launch-Spirit.bat dev — skips the production build entirely and
:: runs `npm run dev` (vite hot-reload + electron auto-launch, verified working).
:: Renderer edits appear instantly, main-process edits auto-restart. No build,
:: no waiting. Close the window to stop everything.
if /i "%~1"=="dev" goto dev_mode

if not exist "%STAMP%" (
    set "NEEDS_BUILD=1"
) else (
    for /f %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\check-build.ps1" "%STAMP%" "%PROJECT_DIR%"') do set "NEEDS_BUILD=%%i"
)

if "!NEEDS_BUILD!"=="1" (
    echo             ^> Building Spirit AI - sources changed...
    echo             ^> Compiling renderer...
    echo             ^> Preparing main process...
    echo.

    call npm run build

    if not !errorlevel! EQU 0 (
        echo.
        echo             [X] Build FAILED.
        echo             [X] The source has type/compile errors or a missing
        echo             [X] dependency. Fix it, then rerun this launcher.
        echo.
        pause
        exit /b 1
    )

    if not exist "%PROJECT_DIR%\node_modules\.cache" mkdir "%PROJECT_DIR%\node_modules\.cache"
    type nul > "%STAMP%"
    echo             [OK] Build completed.
) else (
    echo             [OK] Build cache fresh - starting directly.
)

timeout /t 1 /nobreak >nul


echo.
echo             [OK] Cursor companion active
echo             [OK] System tray connected
echo             [OK] Neural interface ready
echo.
echo             [06]  NEURAL LINK PORTS
echo.
echo             ^> Where Spirit runs and talks:
echo             ^>   App .......... Electron desktop overlay (no port)
echo             ^>   Opencode ..... http://127.0.0.1:4096
echo             ^>   Local AI ..... http://localhost:8082 (chips/configurable)
echo             ^>   Dev server ... http://localhost:5155 (npm run dev only)
echo.
echo             Hold Right-Ctrl to activate AI mode.
echo.
echo             Waking Spirit AI... console stays open,
echo             live logs appear below. Close the app to return here.
echo.

call npx electron .
goto launch_end

:dev_mode
echo.
echo             [DEV] Hot-reload mode - no build, instant changes.
echo             ^> Edit code, Alt-Tab to Spirit, already updated.
echo             ^> Close this window to stop everything.
echo.

call npm run dev

echo.
echo             Dev server stopped.
pause

:launch_end
popd
exit /b 0

echo.
echo             Spirit AI has closed.
echo             Press any key to exit this window.
echo.
pause

popd
exit /b 0