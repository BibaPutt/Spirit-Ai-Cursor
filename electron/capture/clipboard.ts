import { clipboard } from 'electron';

const MAX_CLIPBOARD_CHARS = 4000;

export function readClipboardText(): string {
  try {
    const text = clipboard.readText();
    if (!text) return '';
    return text.length > MAX_CLIPBOARD_CHARS
      ? text.slice(0, MAX_CLIPBOARD_CHARS) + '\n[truncated]'
      : text;
  } catch {
    return '';
  }
}
