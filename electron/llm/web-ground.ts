// Grounding search: when the model ANNOUNCES a web search but never calls the
// tool ("I need to perform a web search…"), the router completes the announced
// intent itself — this module fetches REAL search results and returns them as
// readable text the model can answer from. Only server-rendered endpoints (no
// API key, no JS): DuckDuckGo's HTML endpoint first, Bing as fallback. Purely
// node — no Electron imports — so the parsers are unit-testable.

import { fetchText } from './web-images';

const MAX_RESULTS = 5;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(raw: string): string {
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatResults(
  entries: Array<{ title: string; url: string; snippet: string }>,
  query: string,
): string {
  const body = entries
    .map((e, i) => `${i + 1}. ${e.title} — ${e.url}\n   ${e.snippet}`)
    .join('\n');
  return `[GROUNDED_SEARCH query="${query}"]\n${body}`;
}

// DuckDuckGo's non-JS endpoint. Each result: a `result__a` anchor holding the
// title + href, followed by a `result__snippet` anchor with the snippet.
export function parseDdgGrounding(
  html: string,
  query: string,
  maxResults = MAX_RESULTS,
): string {
  const entries: Array<{ title: string; url: string; snippet: string }> = [];
  const re =
    /(<a\b(?=[^>]*class="result__a")[^>]*>)([\s\S]*?)<\/a>[\s\S]*?(<a\b(?=[^>]*class="result__snippet")[^>]*>)([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && entries.length < maxResults) {
    const href = m[1].match(/href="([^"]+)"/);
    const title = stripTags(m[2]);
    if (!href || !title) continue;
    entries.push({
      title,
      url: decodeEntities(href[1]),
      snippet: stripTags(m[4]),
    });
  }
  return entries.length > 0 ? formatResults(entries, query) : '';
}

// Bing server-rendered results: <li class="b_algo"> blocks with an <h2><a>
// title and a <p> snippet.
export function parseBingGrounding(
  html: string,
  query: string,
  maxResults = MAX_RESULTS,
): string {
  const entries: Array<{ title: string; url: string; snippet: string }> = [];
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) !== null && entries.length < maxResults) {
    const block = bm[1];
    const href = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/);
    const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (!href || !title) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const t = stripTags(title[1]);
    if (!t) continue;
    entries.push({
      title: t,
      url: decodeEntities(href[1]),
      snippet: snippet ? stripTags(snippet[1]) : '',
    });
  }
  return entries.length > 0 ? formatResults(entries, query) : '';
}

// Fetch real search results for `query` as readable text. Every URL goes
// through the same SSRF/public-host guard as the rest of the app.
export async function searchWebGround(
  query: string,
  maxResults = MAX_RESULTS,
): Promise<string> {
  const q = query.trim();
  if (!q) return '';
  const ddg = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  const fromDdg = parseDdgGrounding(ddg, q, maxResults);
  if (fromDdg) return fromDdg;
  const bing = await fetchText(
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${maxResults}`,
  );
  return parseBingGrounding(bing, q, maxResults);
}
