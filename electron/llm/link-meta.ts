import { URL } from 'node:url';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LinkMeta } from '../types';

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 512_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Spirit/1.0 Safari/605.1.15';

// SSRF guard: same allow-list as fetch-url. Reject loopback / private /
// link-local / cloud-metadata destinations so a malicious URL passed by the
// renderer (or appearing in a model-rendered link) cannot probe the local
// network.
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}
function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;
  if (lower.startsWith('ff')) return true;
  const v4mapped = lower.match(/^::ffff:([0-9a-f.:]+)$/);
  if (v4mapped) {
    const candidate = v4mapped[1];
    if (isIP(candidate) === 4) return isBlockedIPv4(candidate);
  }
  return false;
}
async function isPublicHost(hostname: string): Promise<boolean> {
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (hostname.endsWith('.local')) return false;
  if (hostname === 'metadata.google.internal') return false;
  const literal = isIP(hostname);
  if (literal === 4) return !isBlockedIPv4(hostname);
  if (literal === 6) return !isBlockedIPv6(hostname);
  try {
    const records = await lookup(hostname, { all: true });
    if (records.length === 0) return false;
    for (const r of records) {
      if (r.family === 4 && isBlockedIPv4(r.address)) return false;
      if (r.family === 6 && isBlockedIPv6(r.address)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const cache = new Map<string, { meta: LinkMeta | null; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function fetchLinkMeta(rawUrl: string): Promise<LinkMeta | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const cached = cache.get(parsed.href);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.meta;

  const meta = await fetchAndExtract(parsed);
  cache.set(parsed.href, { meta, ts: Date.now() });
  return meta;
}

async function fetchAndExtract(parsed: URL): Promise<LinkMeta | null> {
  if (!(await isPublicHost(parsed.hostname))) {
    console.warn('[link-meta] blocked private/loopback host:', parsed.hostname);
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en;q=0.9',
      },
    });
    if (!res.ok) return null;
    // Recheck the post-redirect hostname (`fetch` does not expose hop hosts,
    // but `res.url` is the final URL after all redirects, so we can validate
    // it before reading the body).
    try {
      const finalUrl = new URL(res.url);
      if (!(await isPublicHost(finalUrl.hostname))) {
        console.warn('[link-meta] blocked redirect to private host:', finalUrl.hostname);
        return null;
      }
    } catch {
      return null;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.length > MAX_HTML_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      if (/<\/head>/i.test(html)) break;
    }
    return extractMeta(html, parsed);
  } catch (err) {
    console.warn('[link-meta] fetch failed', parsed.href, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function metaTag(html: string, attr: string, value: string): string | null {
  const re = new RegExp(
    `<meta[^>]*\\b${attr}=["']${escapeRe(value)}["'][^>]*content=["']([^"']+)["']`,
    'i',
  );
  const direct = html.match(re);
  if (direct) return decodeEntities(direct[1]);
  const reverse = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*\\b${attr}=["']${escapeRe(value)}["']`,
    'i',
  );
  const rev = html.match(reverse);
  return rev ? decodeEntities(rev[1]) : null;
}

function extractMeta(html: string, parsed: URL): LinkMeta {
  const title =
    metaTag(html, 'property', 'og:title') ??
    metaTag(html, 'name', 'twitter:title') ??
    extractTitle(html);

  const description =
    metaTag(html, 'property', 'og:description') ??
    metaTag(html, 'name', 'twitter:description') ??
    metaTag(html, 'name', 'description');

  const rawImage =
    metaTag(html, 'property', 'og:image') ??
    metaTag(html, 'property', 'og:image:url') ??
    metaTag(html, 'name', 'twitter:image') ??
    metaTag(html, 'name', 'twitter:image:src');

  const siteName = metaTag(html, 'property', 'og:site_name');

  return {
    url: parsed.href,
    title: title ? clean(title) : null,
    description: description ? clean(description).slice(0, 220) : null,
    image: rawImage ? resolveUrl(rawImage, parsed) : null,
    siteName: siteName ? clean(siteName) : null,
    host: parsed.hostname.replace(/^www\./, ''),
  };
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clean(decodeEntities(m[1])) : null;
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));
}

function resolveUrl(src: string, base: URL): string | null {
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}
