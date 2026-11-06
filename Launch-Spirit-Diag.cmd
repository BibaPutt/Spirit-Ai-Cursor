@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "LOG=%CD%\launch-spirit-diag.log"

if exist "%LOG%" del "%LOG%"

echo.
echo  Capturing Spirit launcher output to:
echo    %LOG%
echo  (the console still shows everything live; the log just records it)
echo  When it crashes/closes, send me that .log file.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "cmd.exe /c 'Launch-Spirit.bat' 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } } | Tee-Object -FilePath '%LOG%'"

echo.
echo  === Launcher finished. Full log saved:
echo      %LOG%
echo.
pause