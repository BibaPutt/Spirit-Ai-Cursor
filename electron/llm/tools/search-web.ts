import { shell } from 'electron';
import type { ToolDefinition } from './index';

// `search_web` opens a privacy-respecting DuckDuckGo search for the user.

export const searchWebTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Open a web search for the user. Use when they say "search for", "google", "look up online".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
        },
        required: ['query'],
      },
    },
  },
  uiLabel: (args) => {
    const q = String(args.query ?? '').slice(0, 32);
    return q ? `Searching "${q}"` : 'Searching the web';
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return 'Error: search_web requires a "query" argument.';
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    try {
      await shell.openExternal(url);
      return `Opened ${url}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
