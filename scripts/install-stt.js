// npm postinstall hook for the local STT sidecar dependencies.
//
// Runs the platform-native installer script (install-stt.ps1 on Windows,
// install-stt.sh elsewhere) which pip-installs flask + faster-whisper for
// the local-whisper.py sidecar. The install is OPTIONAL: a machine without
// python (or without network) still completes `npm i`, and Spirit's voice
// pipeline falls back to Cloud STT until the deps are present.
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const isWin = process.platform === 'win32';
const script = path.join(__dirname, isWin ? 'install-stt.ps1' : 'install-stt.sh');

console.log(`[install-stt] running ${path.basename(script)}`);

const args = isWin
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
  : [script];

let res;
try {
  res = spawnSync(isWin ? 'powershell' : 'bash', args, {
    // stdin ignored: a console ^C (e.g. user pausing to read output) must
    // not cascade into pip and abort `npm i`.
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    timeout: 300000,
    killSignal: 'SIGTERM',
  });
} catch (err) {
  console.log(`[install-stt] skipped (${err.code || err.message}) - voice will use Cloud STT for now.`);
  process.exit(0);
}

if (res.error) {
  console.log('[install-stt] skipped (sidecar setup timed out) - voice will use Cloud STT for now.');
} else if (res.status !== 0) {
  console.log('[install-stt] STT setup incomplete - voice will use Cloud STT for now.');
}

// Never fail `npm i`; STT is an optional enhancement.
process.exit(0);
