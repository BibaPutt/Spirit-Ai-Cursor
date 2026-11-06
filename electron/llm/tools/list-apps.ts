import { discoverApps, searchApps } from '../../apps/registry';
import type { ToolDefinition } from './index';

// `list_apps` searches the user's installed applications by name — read-only,
// never requires approval. The model uses it when it is unsure an app exists
// or what the exact name is, before calling launch_app.

export const listAppsTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'list_apps',
      description:
        'List the desktop applications installed on the user\'s machine, optionally filtered by a name query. Use this when you are unsure an app is installed, or what its exact name is, before calling launch_app.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional fragment of the app name to search for (e.g. "spot", "word", "calc"). Omit to list the most common installed apps.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of apps to return (default 10).',
          },
        },
      },
    },
  },
  uiLabel: (args) => {
    const q = String(args.query ?? '').trim();
    return q ? `Looking up installed apps matching "${q}"` : 'Looking up installed apps';
  },
  async execute(args) {
    const apps = await discoverApps();
    const query = String(args.query ?? '').trim();
    const limit = Number(args.limit) || 10;
    if (!query) {
      const top = apps.slice(0, Math.min(limit, 25));
      return (
        `Installed apps (${apps.length} total, showing ${top.length}):\n` +
        top.map((a) => `- ${a.name}`).join('\n')
      );
    }
    const matches = searchApps(apps, query, Math.min(limit, 25));
    if (matches.length === 0) {
      return `No installed app matches "${query}". ${apps.length} apps discovered total.`;
    }
    return (
      `Installed apps matching "${query}" (${matches.length} found):\n` +
      matches.map((a) => `- ${a.name}`).join('\n')
    );
  },
};
