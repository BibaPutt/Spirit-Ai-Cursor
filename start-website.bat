@echo off
setlocal
cd /d "%~dp0website"
set PORT=8080
set URL=http://localhost:%PORT%/

echo Starting SPIRIT website at %URL%
echo Close this window to stop the server.
echo.

where python >nul 2>nul
if %errorlevel%==0 (
  start "" "%URL%"
  python -m http.server %PORT%
  goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
  start "" "%URL%"
  py -m http.server %PORT%
  goto :eof
)

where npx >nul 2>nul
if %errorlevel%==0 (
  start "" "%URL%"
  npx --yes serve -l %PORT% .
  goto :eof
)

echo Python and Node were not found. Opening index.html directly.
start "" "%~dp0website\index.html"
