# Installs the Python dependencies the local STT sidecar needs
# (electron/voice/local-whisper.py): Flask + faster-whisper.
# Runs automatically from `npm i` via scripts/install-stt.js.
$ErrorActionPreference = 'Stop'

function Find-Python {
  foreach ($c in @('python', 'python3')) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { return $c }
  }
  return $null
}

$py = Find-Python
if (-not $py) {
  Write-Host ''
  Write-Host '  Local STT needs Python 3.9+.' -ForegroundColor Yellow
  Write-Host '  Install it from https://www.python.org (tick "Add to PATH"),' -ForegroundColor Yellow
  Write-Host '  then re-run: npm i' -ForegroundColor Yellow
  Write-Host '  Voice input will fall back to Cloud STT until then.' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

# Fast path: deps already present -> skip pip entirely (no output wall, no
# long no-op pip run on every `npm i`). `pip show` writes a WARNING to stderr
# when a package is missing; with $ErrorActionPreference='Stop' that native
# stderr record aborted the whole installer (local STT stayed uninstalled).
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$flaskProbe = (& $py -m pip show flask 2>&1) -join "`n"
$whisperProbe = (& $py -m pip show faster-whisper 2>&1) -join "`n"
$ErrorActionPreference = $prevEap
$haveFlask = $flaskProbe -match '(?m)^Name:\s*flask'
$haveWhisper = $whisperProbe -match '(?m)^Name:\s*faster-whisper'

if ($haveFlask -and $haveWhisper) {
  Write-Host '  Local STT deps already installed - skipping.'
  exit 0
}

Write-Host "Installing local STT dependencies (flask, faster-whisper) via $py ..."
Write-Host '  (quiet; first run downloads the wheels, may take a few minutes)'
& $py -m pip install --quiet --disable-pip-version-check --no-warn-script-location --user flask faster-whisper
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '  Local STT ready. X-Turbo uses the model X-Whisper already' -ForegroundColor Green
Write-Host '  installed when present; otherwise it downloads once (~1.6 GB).' -ForegroundColor Green
Write-Host ''
exit 0
