// Web image search for the [IMAGE] subject lines in answers. No API key needed.
// The model only supplies a subject query; THIS module finds the real pictures
// through a cascade of free backends — DuckDuckGo image search first (best
// relevance for everyday and product queries), then a Bing image-search scrape,
// then Openverse and Wikimedia Commons as broad CC-licensed fallbacks — using
// the first that returns anything. Real results are pushed straight to the
// renderer via a sink; the model never transports URLs.
// Purely node — no Electron imports — so the parsing helpers are unit-testable.
//
// Security: the fixed search endpoints are all public hosts; every result URL
// is additionally filtered through the same SSRF ranges as page-fetch (plus a
// reserved-placeholder-domain filter), so a poisoned result can never point the
// renderer at an internal address. We only ever fetch the search endpoints in
// main — image bytes themselves are loaded by the renderer's <img> tags and
// never proxied.

import { isIP } from 'node:net';
import { isBlockedIPv4, isBlockedIPv6, isPublicHost } from '../capture/page-fetch';
import type { WebImage } from '../types';

export const MAX_IMAGES = 6;

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_500_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// RFC 2606 reserved / documentation-only names. Real search engines never
// return these, so their only appearance is a model fabricating URLs — drop
// them instead of rendering broken tiles.
const RESERVED_HOSTS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'example.co',
  'example',
  'invalid',
  'test',
]);

// Sync syntactic guard applied to every backend result: rejects non-http(s),
// local TLDs, reserved placeholders, and private IP literals WITHOUT DNS
// (results already passed the DNS check at search time; this blocks clearly
// bogus entries).
export function isPublicImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === 'metadata.google.internal') return false;
  if (RESERVED_HOSTS.has(host) || host.endsWith('.example')) return false;
  if (host.endsWith('.test') || host.endsWith('.invalid')) return false;
  const literal = isIP(host);
  if (literal === 4) return !isBlockedIPv4(host);
  if (literal === 6) return !isBlockedIPv6(host);
  return true;
}

// DuckDuckGo

// Pull the `vqd` token out of the image-search landing page. DDG requires it
// before the i.js endpoint will serve results.
export function extractDdgVqd(html: string): string | null {
  const m = html.match(/vqd=([\d-]+)/) ?? html.match(/vqd['"]?\s*[:=]\s*['"]?([\d-]+)/);
  return m ? m[1] : null;
}

function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s && isPublicImageUrl(s) ? s : null;
}

// Parse the JSON body of duckduckgo.com/i.js into a bounded image list.
// Pure, so vitest can feed it fixtures.
export function parseDdgResults(jsonText: string): WebImage[] {
  const out: WebImage[] = [];
  try {
    const parsed = JSON.parse(jsonText) as { results?: unknown };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const r of results) {
      if (out.length >= MAX_IMAGES) break;
      if (r === null || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const url = cleanUrl(rec.image);
      if (!url) continue;
      out.push({
        url,
        thumb: cleanUrl(rec.thumbnail) ?? url,
        title: cleanTitle(rec.title),
        source: cleanUrl(rec.url) ?? url,
      });
    }
  } catch {
    /* junk body — caller falls back */
  }
  return out;
}

async function searchDdg(query: string): Promise<WebImage[]> {
  const landing = await fetchText(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
  );
  const vqd = extractDdgVqd(landing);
  if (!vqd) return [];
  const json = await fetchText(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`,
    'json',
  );
  return parseDdgResults(json);
}

// Bing

function bingString(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

// Parse one Bing `m="..."` attribute payload into an image entry, or null.
export function parseBingM(raw: string): WebImage | null {
  try {
    const parsed = JSON.parse(unescapeHtml(raw)) as Record<string, unknown>;
    const url = cleanUrl(parsed.murl);
    if (!url) return null;
    const source = cleanUrl(parsed.purl) ?? url;
    return {
      url,
      thumb: cleanUrl(parsed.turl) ?? url,
      title: bingString(parsed.t),
      source,
    };
  } catch {
    return null;
  }
}

// Parse Bing image-search HTML. Pure, fixture-testable.
export function parseBingResults(html: string): WebImage[] {
  const out: WebImage[] = [];
  const attrRe = /m="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(html)) !== null) {
    if (out.length >= MAX_IMAGES) break;
    const img = parseBingM(m[1]);
    if (img) out.push(img);
  }
  return out;
}

async function searchBing(query: string): Promise<WebImage[]> {
  const html = await fetchText(
    `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large`,
  );
  return parseBingResults(html);
}

// Openverse

// Openverse (WordPress) — free open-media image search, no API key needed for
// anonymous requests (openverse.org itself runs that way). Response shape
// (verified live):
//   results[]: { title, url, thumbnail, foreign_landing_url, creator, ... }
export function parseOpenverseResults(jsonText: string): WebImage[] {
  const out: WebImage[] = [];
  try {
    const parsed = JSON.parse(jsonText) as { results?: unknown };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const r of results) {
      if (out.length >= MAX_IMAGES) break;
      if (r === null || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const url = cleanUrl(rec.url);
      if (!url) continue;
      out.push({
        url,
        thumb: cleanUrl(rec.thumbnail) ?? url,
        title: cleanTitle(rec.title),
        source: cleanUrl(rec.foreign_landing_url) ?? url,
      });
    }
  } catch {
    /* junk body — caller falls back */
  }
  return out;
}

async function searchOpenverse(query: string): Promise<WebImage[]> {
  const json = await fetchText(
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${MAX_IMAGES}`,
    'json',
  );
  return parseOpenverseResults(json);
}

// Wikimedia Commons

// MediaWiki Commons API — free, no key. Response shape (verified live):
//   query.pages { <pageid>: { title: "File:...", imageinfo: [{ url, thumburl,
//   descriptionurl }] } }
export function parseWikimediaResults(jsonText: string): WebImage[] {
  const out: WebImage[] = [];
  try {
    const parsed = JSON.parse(jsonText) as { query?: { pages?: Record<string, unknown> } };
    const pages = parsed.query?.pages;
    if (!pages || typeof pages !== 'object') return out;
    for (const raw of Object.values(pages)) {
      if (out.length >= MAX_IMAGES) break;
      if (raw === null || typeof raw !== 'object') continue;
      const page = raw as Record<string, unknown>;
      const info = Array.isArray(page.imageinfo) ? (page.imageinfo[0] as Record<string, unknown> | undefined) : undefined;
      if (!info) continue;
      const url = cleanUrl(info.url);
      if (!url) continue;
      const title = typeof page.title === 'string' ? page.title.replace(/^File:/i, '') : '';
      out.push({
        url,
        thumb: cleanUrl(info.thumburl) ?? url,
        title: cleanTitle(title),
        source: cleanUrl(info.descriptionurl) ?? url,
      });
    }
  } catch {
    /* junk body — caller falls back */
  }
  return out;
}

async function searchWikimedia(query: string): Promise<WebImage[]> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6',
    gsrlimit: String(MAX_IMAGES),
    prop: 'imageinfo',
    iiprop: 'url',
    iiurlwidth: '320',
    format: 'json',
  });
  const json = await fetchText(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, 'json');
  return parseWikimediaResults(json);
}

// public API

// The model only supplies the query — it never sees or transports the URLs.
// These hooks let the tool push a real result straight to the renderer.
let sink: ((images: WebImage[]) => void) | null = null;
export function setWebImagesSink(fn: ((images: WebImage[]) => void) | null): void {
  sink = fn;
}
export function emitWebImages(images: WebImage[]): void {
  if (images.length > 0) sink?.(images);
}

// Search the web for images of `query`. Walks the backend cascade in order —
// DuckDuckGo, Bing, Openverse, Wikimedia Commons — and uses the first that
// returns anything. Every result is checked against the SSRF ranges and the
// reserved-placeholder filter. The result is cached per query for 10 minutes.
export async function searchWebImages(query: string): Promise<WebImage[]> {
  const q = query.trim();
  if (!q) return [];
  const cached = cacheGet(q);
  if (cached) return cached;

  let images: WebImage[] = [];
  for (const [name, fn] of [
    ['duckduckgo', () => searchDdg(q)],
    ['bing', () => searchBing(q)],
    ['openverse', () => searchOpenverse(q)],
    ['wikimedia', () => searchWikimedia(q)],
  ] as const) {
    if (images.length > 0) break;
    try {
      images = await fn();
    } catch (err) {
      console.warn(`[web-images] ${name} search failed:`, err instanceof Error ? err.message : err);
    }
  }

  cacheSet(q, images);
  return images;
}

// plumbing

export async function fetchText(url: string, accept: 'html' | 'json' = 'html'): Promise<string> {
  const parsed = new URL(url);
  if (!(await isPublicHost(parsed.hostname))) {
    throw new Error(`Blocked: host ${parsed.hostname} resolves to a private or loopback address.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          accept === 'json'
            ? 'application/json,text/plain;q=0.8'
            : 'text/html,application/xhtml+xml',
        'Accept-Language': 'en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const reader = res.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let body = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      if (body.length > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

const cache = new Map<string, { images: WebImage[]; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 100;

function cacheGet(query: string): WebImage[] | null {
  const key = query.toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.images;
  return null;
}

function cacheSet(query: string, images: WebImage[]): void {
  const key = query.toLowerCase().trim();
  cache.set(key, { images, ts: Date.now() });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
