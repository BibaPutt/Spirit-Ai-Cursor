import { shell } from 'electron';
import type { ToolDefinition } from './index';

// `play_music` opens a music service search for the user's query.
// Defaults to YouTube web search; users who have set service='spotify'
// get Spotify's web search.

export const playMusicTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'play_music',
      description:
        'Search and open music for the user. Use when they say "play <song>", "listen to <artist>", or similar.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Artist, song, or playlist to play.' },
          service: {
            type: 'string',
            enum: ['youtube', 'spotify'],
            description: 'Which service to search. Defaults to youtube.',
          },
        },
        required: ['query'],
      },
    },
  },
  uiLabel: (args) => {
    const q = String(args.query ?? '').slice(0, 32);
    return q ? `Playing "${q}"` : 'Playing music';
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return 'Error: play_music requires a "query" argument.';
    const service = String(args.service ?? '').toLowerCase();
    let url: string;
    if (service === 'spotify') {
      url = `https://open.spotify.com/search/${encodeURIComponent(query)}`;
    } else {
      url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    }
    try {
      await shell.openExternal(url);
      return `Opened ${url}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
