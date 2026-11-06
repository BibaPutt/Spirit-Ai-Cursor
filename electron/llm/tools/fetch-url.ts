import { fetchLinkMeta } from '../link-meta';
import { fetchPageText } from '../../capture/page-fetch';
import type { ToolDefinition } from './index';

const FETCH_TIMEOUT_MS = 12_000;

export const fetchUrlTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch a public web page (or JSON/text resource) and return its title, description, and main text content. Use this when the user asks about a specific URL, when you need to verify or expand on a link visible in the screenshot, or when you need fresh information from a known source.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Absolute https:// or http:// URL to fetch.',
          },
        },
        required: ['url'],
      },
    },
  },
  uiLabel: (args) => {
    const u = String(args.url ?? '');
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      return `Reading ${host}`;
    } catch {
      return 'Fetching URL';
    }
  },
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!url) return 'Error: fetch_url requires a "url" argument.';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Error: invalid URL "${url}".`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Error: only http/https URLs are allowed.`;
    }

    const [meta, content] = await Promise.allSettled([
      fetchLinkMeta(parsed.href),
      fetchPageText(parsed.href, { timeoutMs: FETCH_TIMEOUT_MS }),
    ]);

    const parts: string[] = [`URL: ${parsed.href}`];
    if (meta.status === 'fulfilled' && meta.value) {
      if (meta.value.title) parts.push(`Title: ${meta.value.title}`);
      if (meta.value.description) parts.push(`Description: ${meta.value.description}`);
      if (meta.value.siteName) parts.push(`Site: ${meta.value.siteName}`);
    }
    if (content.status === 'fulfilled' && content.value) {
      parts.push('', 'Content:', content.value);
    } else if (content.status === 'rejected') {
      parts.push(
        `(could not extract body: ${
          content.reason instanceof Error ? content.reason.message : String(content.reason)
        })`,
      );
    }
    return parts.join('\n');
  },
};
