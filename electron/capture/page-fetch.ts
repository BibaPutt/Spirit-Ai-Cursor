// SSRF-safe page-text fetch, shared by the fetch_url tool and the scene's
// "webfetch instead of OCR" reading path (ui_read when the user just wants to
// READ a page, not act on it). Purely node (no Electron imports), so both the
// main-process tool and the scene builder can use it.
//
// Security model (identical to the old fetch-url tool): every host — the
// initial one AND every redirect hop — must resolve only to public addresses.
// Private / loopback / link-local / cloud-metadata / CGNAT ranges are refused,
// so a URL captured from the user's browser can never be used to probe the
// local network.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 800_000;
const DEFAULT_MAX_CHARS = 6_000;
const MAX_REDIRECTS = 5;

// Generic Chrome User-Agent per platform. We intentionally do NOT advertise
// Spirit in the UA: the tool fetches arbitrary user-requested URLs, and
// fingerprinting the user's traffic to those servers as "Spirit user"
// would leak the fact that they use this app to every site visited. Provider
// API calls (OpenAI, Anthropic, etc.) still send the Spirit UA because
// those are the user's chosen service relationships where attribution is
// appropriate.
function chromeUserAgent(): string {
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }
  if (process.platform === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

const USER_AGENT = chromeUserAgent();

// Block any IP that resolves into a private / loopback / link-local /
// cloud-metadata range. Applied to the initial host AND to every redirect hop.
// Exported so the web-images module can reuse the exact same ranges when it
// sanity-checks image URLs handed back by an image-search endpoint.
export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed treated as blocked
  }
  const [a, b] = parts;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local + cloud metadata (169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 reserved
  if (a === 0) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 multicast
  if (a >= 224) return true;
  return false;
}

export function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped IPv6 — recheck as v4
  const v4mapped = lower.match(/^::ffff:([0-9a-f.:]+)$/);
  if (v4mapped) {
    const candidate = v4mapped[1];
    if (isIP(candidate) === 4) return isBlockedIPv4(candidate);
  }
  return false;
}

export async function isPublicHost(hostname: string): Promise<boolean> {
  if (!hostname) return false;
  // Reject obviously local names early.
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (hostname.endsWith('.local')) return false;
  if (hostname === 'metadata.google.internal') return false;

  // If the hostname is itself an IP, validate it directly.
  const literal = isIP(hostname);
  if (literal === 4) return !isBlockedIPv4(hostname);
  if (literal === 6) return !isBlockedIPv6(hostname);

  // Otherwise resolve and check every record.
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

// Manually follow redirects so we can re-check each hop against the SSRF
// allow-list. Native fetch's `redirect: 'follow'` skips that check.
async function safeFetch(initial: URL, signal: AbortSignal): Promise<Response> {
  let current = initial;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublicHost(current.hostname))) {
      throw new Error(`Blocked: host ${current.hostname} resolves to a private or loopback address.`);
    }
    const res = await fetch(current.href, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8',
        'Accept-Language': 'en;q=0.9',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new Error(`Redirect to invalid URL: ${loc}`);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`Redirect to disallowed scheme: ${next.protocol}`);
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`);
}

function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n…[truncated]';
}

function extractTextFromHtml(html: string): string {
  // 1. Strip script/style.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  // 2. Strip remaining tags but keep paragraph breaks.
  const text = stripped
    .replace(/<(br|p|div|li|h[1-6]|tr|td|article|section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // 3. Collapse whitespace.
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

async function fetchTextContent(url: string, signal: AbortSignal, maxChars: number): Promise<string> {
  const initial = new URL(url);
  const res = await safeFetch(initial, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ct = res.headers.get('content-type') ?? '';

  // For JSON / plain text we return as-is (clamped).
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    const text = await res.text();
    return clamp(text, maxChars);
  }

  // For HTML, stream until we have enough.
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let html = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (html.length >= MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  return clamp(extractTextFromHtml(html), maxChars);
}

export interface FetchPageTextOptions {
  timeoutMs?: number;
  maxChars?: number;
}

// Fetch an http(s) URL and return its readable text content, clamped. Throws
// on invalid/scheme/SSRF problems, HTTP errors and timeouts — callers decide
// how to fall back.
export async function fetchPageText(
  url: string,
  opts: FetchPageTextOptions = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https URLs are allowed');
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    return await fetchTextContent(parsed.href, controller.signal, opts.maxChars ?? DEFAULT_MAX_CHARS);
  } finally {
    clearTimeout(timer);
  }
}
