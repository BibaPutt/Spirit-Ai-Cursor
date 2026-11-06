import { shell } from 'electron';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from './index';

export const openUrlTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'open_url',
      description:
        'Open a URL in the user\'s default browser, or open a local file (file:// path) with its default app. Use this when the user asks to "open", "show me", or "go to" a website, or to open a saved document. Always confirm the intent is clear before opening multiple URLs.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'Absolute URL to open: https://, http://, or file:// pointing at a local file.',
          },
        },
        required: ['url'],
      },
    },
  },
  uiLabel: (args) => {
    const u = String(args.url ?? '');
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'file:') return `Opening ${fileURLToPath(u)}`;
      // Show scheme + host explicitly so a phishing URL like
      // https://google.com.attacker.com/... cannot hide behind "Opening
      // google.com". The user always sees the actual origin.
      return `Opening ${parsed.protocol}//${parsed.host}`;
    } catch {
      return 'Opening URL';
    }
  },
  async execute(args, ctx) {
    const url = String(args.url ?? '').trim();
    if (!url) return 'Error: open_url requires a "url" argument.';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (parsed.protocol === 'file:') {
      try {
        const path = fileURLToPath(parsed);
        await shell.openPath(path);
        return `Opened ${path} with its default app. Now call wait(1500), then use see_screen or ui_read before any further action so you act on the opened document.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Error: only http/https/file URLs can be opened.';
    }
    try {
      await shell.openExternal(parsed.href);
      return `Opened ${parsed.href} in the user's default browser. Now call wait(1500), then use see_screen or ui_read before any further action so you act on the loaded page.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
