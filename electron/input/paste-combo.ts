// The paste shortcut for the current platform: Cmd+V on macOS, Ctrl+V
// everywhere else (Windows/Linux). Deliberately dependency-free (no Electron)
// so every clipboard-paste path and vitest can share one source of truth —
// mac input synthesis must use Cmd+V or it holds Ctrl and pastes nothing.

export function pasteComboForPlatform(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'meta+v' : 'ctrl+v';
}
