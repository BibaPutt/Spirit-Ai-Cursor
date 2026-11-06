param(
    [string]$StampPath,
    [string]$ProjectDir
)

# Launch-Spirit.bat build freshness check.
# Prints 1 if the app sources are newer than the last successful build stamp
# (or the stamp is missing), 0 if everything is up to date. Read-only: never
# touches the stamp — the batch files create it after a successful build.

$stampFile = Get-Item -LiteralPath $StampPath -ErrorAction SilentlyContinue
if (-not $stampFile) {
    Write-Output 1
    exit 0
}

$dirs = @(
    (Join-Path $ProjectDir 'electron'),
    (Join-Path $ProjectDir 'renderer'),
    (Join-Path $ProjectDir 'tests'),
    (Join-Path $ProjectDir 'assets'),
    (Join-Path $ProjectDir 'cursors')
)

$stampTime = $stampFile.LastWriteTime
$changed = $false
foreach ($dir in $dirs) {
    if (Test-Path -LiteralPath $dir) {
        $hit = Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $stampTime }
        if ($hit) {
            $changed = $true
            break
        }
    }
}

foreach ($file in @('package.json', 'vite.config.ts', 'electron-builder.yml')) {
    $path = Join-Path $ProjectDir $file
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).LastWriteTime -gt $stampTime) {
        $changed = $true
        break
    }
}

if ($changed) { Write-Output 1 } else { Write-Output 0 }