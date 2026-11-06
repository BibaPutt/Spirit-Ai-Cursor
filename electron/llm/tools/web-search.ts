import { searchWebGround } from '../web-ground';
import type { ToolDefinition } from './index';

// `web_search` fetches REAL search results (DuckDuckGo HTML, Bing fallback)
// as plain text into the conversation — the model answers from them. Runs
// internally in the background: no browser opens, no URL is shown, nothing
// is "read aloud". Read-only, never requires approval.

export const webSearchTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information and return the real results as text you can read. Use this whenever you are uncertain about facts, current events, prices, versions, people, places, or anything that may have changed since your knowledge cutoff. The search runs internally in the background — the user only sees a "Reading search results…" indicator. Never open a browser for this; just call web_search and answer from the results.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for. Be specific and factual.',
          },
        },
        required: ['query'],
      },
    },
  },
  uiLabel: (args) => {
    const q = String(args.query ?? '').trim();
    return q ? `Reading search results for "${q.slice(0, 32)}"` : 'Reading search results';
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return 'Error: web_search requires a "query" argument.';
    const grounded = await searchWebGround(query, 5);
    if (!grounded) {
      return 'Error: the search returned no readable results (blocked or empty). Try a different query, or fetch_url on a known page.';
    }
    return grounded;
  },
};
