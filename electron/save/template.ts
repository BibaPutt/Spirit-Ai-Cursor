import { marked } from 'marked';
import type { WebImage } from '../types';
import { sanitizeDiagramHtml } from '../llm/diagram-safe';
import { sanitizeMermaidCode } from '../llm/mermaid-clean';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// LLM-output HTML sanitizer (saved documents)
//
// Saved session docs are opened in the user's DEFAULT browser, where the
// renderer's CSP does not apply — so LLM-emitted HTML must be scrubbed before
// it is embedded. The live in-app path is protected by rehype-sanitize (see
// renderer/components/sanitizeSchemas.ts); this is a self-contained strict
// allowlist for the persisted-doc path so the Electron main bundle stays CJS.
//
// Rules:
//  - Unknown/dangerous tags are dropped; script-bearing tags are dropped WITH
//    their content (fail-closed: an unterminated <script> drops the rest).
//  - Attributes are allowlisted; every on* handler is removed.
//  - href/src must not carry a dangerous scheme. HTML entities are decoded
//    and ASCII whitespace/control chars stripped BEFORE the scheme check, so
//    "&#106;avascript:" or "java\tscript:" cannot slip past.
//  - Inline `style` is intentionally not allowed (no url(...) exfiltration).
//  - link/style/script tags are ALLOWED for template-injected CDN resources
//    (KaTeX, mermaid). These tags only appear in the outer document template,
//    never inside LLM-emitted body content.

const ALLOWED_TAGS = new Set([
  'main', 'header', 'footer', 'section', 'article', 'aside', 'nav',
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small',
  'sub', 'sup', 'kbd', 'code', 'pre', 'blockquote', 'figure', 'figcaption',
  'br', 'hr', 'img', 'details', 'summary',
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g',
  'text', 'tspan',
  ]);

// Dropped together with ALL of their content (script-bearing / active /
// exfiltration-capable elements). Template-injected CDN scripts (KaTeX,
// mermaid) live in the outer HTML template literal, NOT in the body content
// that flows through this sanitizer, so script blocking is safe here.
const BLOCKED_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'style', 'meta', 'base',
  'frame', 'frameset', 'form', 'input', 'button', 'select', 'textarea',
  'noscript', 'template', 'title', 'math', 'audio', 'video', 'source',
  'foreignobject',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'param', 'area', 'col', 'track']);

const SAFE_ATTRS = new Set([
  'class', 'classname', 'id', 'title', 'alt',
  'target', 'rel', 'download',
  'colspan', 'rowspan', 'align', 'valign', 'width', 'height',
  'viewbox', 'preserveaspectratio', 'xmlns', 'fill', 'fill-opacity', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity',
  'opacity', 'transform', 'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry',
  'x', 'y', 'x1', 'y1', 'x2', 'y2',
]);

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeUrl(raw: string, isSrc: boolean): string | null {
  let t = raw.trim();
  if (!t) return null;
  t = decodeEntities(t).replace(/[\u0000-\u0020\u007f]/g, '');
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(t);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return t;
    if (isSrc && scheme === 'data' && t.toLowerCase().startsWith('data:image/')) return t;
    if (!isSrc && (scheme === 'mailto' || scheme === 'tel')) return t;
    return null;
  }
  return t;
}

function filterAttrs(attrBlock: string): string {
  const ATTR_RE = /([a-zA-Z][a-zA-Z0-9_.:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  const kept: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrBlock))) {
    const rawName = m[1];
    const lower = rawName.toLowerCase();
    if (lower.startsWith('on')) continue;
    if (lower === 'style' || lower === 'srcdoc' || lower === 'formaction') continue;
    const value = m[2] !== undefined ? m[2].replace(/^(['"])(.*)\1$/s, '$2') : null;
    if (lower === 'href' || lower === 'src') {
      if (value === null) continue;
      const safe = safeUrl(value, lower === 'src');
      if (safe === null) continue;
      kept.push(`${rawName}="${escapeAttr(safe)}"`);
      continue;
    }
    if (!SAFE_ATTRS.has(lower)) continue;
    if (value === null) kept.push(rawName);
    else kept.push(`${rawName}="${escapeAttr(value)}"`);
  }
  return kept.length ? ' ' + kept.join(' ') : '';
}

export function sanitizeHtml(html: string): string {
  const TAG_RE =
    /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const open: string[] = [];
  let out = '';
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    if (open.length === 0) out += html.slice(lastIndex, m.index);
    lastIndex = TAG_RE.lastIndex;
    const raw = m[0];
    if (raw.startsWith('<!--')) continue;
    const isClose = raw.startsWith('</');
    const name = (m[1] || '').toLowerCase();
    const selfClose = /\/\s*>$/.test(raw) || VOID_TAGS.has(name);
    if (BLOCKED_TAGS.has(name)) {
      if (!isClose) open.push(name);
      else {
        const i = open.lastIndexOf(name);
        if (i !== -1) open.splice(i, 1);
      }
      continue;
    }
    if (open.length > 0) continue; // inside a dropped element
    if (isClose) {
      if (ALLOWED_TAGS.has(name)) out += `</${name}>`;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    out += `<${name}${filterAttrs(m[2] || '')}${selfClose ? ' /' : ''}>`;
  }
  if (open.length === 0) out += html.slice(lastIndex);
  return out;
}

// Block pre-processing — extract [MERMAID], [QUESTIONS], [UI] blocks and
// LaTeX delimiters BEFORE marked.parse() so they are not mangled.

const BLOCK_RE = /\[\s*(ui|questions|mermaid|diagram)\s*\]([\s\S]*?)\[\s*\/\s*\1\s*\]/gi;

interface ExtractedBlock {
  placeholder: string;
  html: string;
}

function unwrapFence(s: string): string {
  return s.replace(/^```(?:json|javascript|js|mermaid|html|xml|diagram)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

function esc(s: string): string {
  return escapeHtml(s);
}

function renderMermaidHtml(code: string): string {
  const raw = unwrapFence(code);
  if (!raw) return '';
  // Sanitize through the same shared cleaner as the live renderer, so a
  // model-emitted fragment (unquoted paren labels, space IDs, stray color
  // directives) renders in the saved document instead of failing mermaid.run.
  const clean = sanitizeMermaidCode(raw);
  return `<div class="ai-mermaid">${esc(clean)}</div>`;
}

function renderDiagramHtml(inner: string): string {
  const raw = unwrapFence(inner);
  if (!raw) return '';
  // The `%% <title>` first line is data for the app, not part of the diagram.
  const body = raw.replace(/^%%[^\n]*\n?/m, '').trim();
  if (!body) return '';
  const safe = sanitizeDiagramHtml(body);
  if (!safe) return '';
  return `<div class="ai-diagram">${safe}</div>`;
}

function renderQuestionsHtml(inner: string): string {
  const raw = unwrapFence(inner);
  if (!raw) return '';
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return `<div class="ai-callout ai-callout--info">Questions (could not render)</div>`; }

  const title = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed.title ?? '') : '';
  const questions: any[] = Array.isArray(parsed)
    ? parsed
    : (parsed.questions ?? parsed.items ?? (typeof parsed === 'object' && parsed.q ? [parsed] : []));

  if (!questions.length) return '';

  let h = '<div class="ai-questions">';
  if (title) h += `<div class="ai-questions__title">${esc(title)}</div>`;
  h += '<ol class="ai-questions__list">';
  for (const q of questions) {
    const qText = esc(q.q ?? q.question ?? q.label ?? q.text ?? '');
    const type = esc(q.type ?? 'text');
    const ph = q.placeholder ? esc(q.placeholder) : '';
    const required = q.required ? ' <span class="ai-questions__req">*</span>' : '';

    h += `<li class="ai-questions__item">`;
    h += `<div class="ai-questions__q">${qText}${required}</div>`;
    h += `<div class="ai-questions__type">Type: ${type}</div>`;

    if (Array.isArray(q.options) && q.options.length) {
      h += '<ul class="ai-questions__options">';
      for (const opt of q.options) {
        const label = typeof opt === 'string' ? opt : (opt.label ?? opt.value ?? '');
        h += `<li>${esc(label)}</li>`;
      }
      h += '</ul>';
    }
    if (ph) h += `<div class="ai-questions__ph">Placeholder: ${ph}</div>`;
    if (q.min !== undefined || q.max !== undefined) {
      h += `<div class="ai-questions__range">Range: ${q.min ?? '—'} to ${q.max ?? '—'}${q.step ? ` (step ${q.step})` : ''}</div>`;
    }
    h += '</li>';
  }
  h += '</ol></div>';
  return h;
}

function renderUiNodeHtml(node: any, depth = 0): string {
  if (!node || typeof node !== 'object') return '';
  const t: string = (node.t ?? node.type ?? node.tag ?? 'text').toLowerCase().replace(/^ui[-:]/, '');
  const children: string = Array.isArray(node.children)
    ? node.children.map((c: any) => renderUiNodeHtml(c, depth + 1)).join('')
    : '';

  switch (t) {
    case 'card': case 'section': case 'container':
      return `<div class="ai-card">${node.title ? `<div class="ai-card__title">${esc(node.title)}</div>` : ''}${children}</div>`;
    case 'heading': {
      const raw = (node.t ?? node.type ?? node.tag ?? '').toLowerCase().replace(/^ui[-:]/, '');
      const level = raw === 'h1' ? 1 : raw === 'h3' ? 3 : 2;
      return `<h${level} class="ai-card__heading">${node.icon ? esc(node.icon) + ' ' : ''}${esc(node.text ?? node.label ?? '')}</h${level}>`;
    }
    case 'text': case 'label': case 'paragraph':
      return `<p class="ai-card__text">${esc(node.text ?? node.label ?? '')}</p>`;
    case 'badge': case 'tag': case 'pill': {
      const v = node.variant ?? 'neutral';
      return `<span class="ai-badge ai-badge--${esc(v)}">${esc(node.text ?? '')}</span>`;
    }
    case 'code':
      return `<pre class="ai-card__code"><code>${esc(node.text ?? '')}</code></pre>`;
    case 'list': case 'ul': case 'ol': {
      const items: string = Array.isArray(node.items)
        ? node.items.map((it: any) => `<li>${typeof it === 'string' ? esc(it) : esc(String(it))}</li>`).join('')
        : children;
      return `<ul class="ai-card__list">${items}</ul>`;
    }
    case 'kv': case 'key-value': {
      const items: any[] = Array.isArray(node.items) ? node.items : [];
      let h = '<table class="ai-card__kv">';
      for (const it of items) {
        h += `<tr><td class="ai-card__kv-label">${esc(it.label ?? '')}</td><td class="ai-card__kv-value">${esc(String(it.value ?? ''))}</td></tr>`;
      }
      h += '</table>';
      return h;
    }
    case 'table': {
      const headers: string[] = Array.isArray(node.headers) ? node.headers : [];
      const rows: any[][] = Array.isArray(node.rows) ? node.rows : [];
      let h = '<table class="ai-card__table">';
      if (headers.length) {
        h += '<thead><tr>' + headers.map((hdr: string) => `<th>${esc(hdr)}</th>`).join('') + '</tr></thead>';
      }
      h += '<tbody>' + rows.map((row: any[]) =>
        '<tr>' + row.map((cell: any) => `<td>${esc(String(cell ?? ''))}</td>`).join('') + '</tr>'
      ).join('') + '</tbody></table>';
      return h;
    }
    case 'stat': {
      const delta = node.delta ? `<span class="ai-card__stat-delta">${esc(node.delta)}</span>` : '';
      return `<div class="ai-card__stat"><span class="ai-card__stat-value">${esc(String(node.text ?? ''))}</span>${node.label ? `<span class="ai-card__stat-label">${esc(node.label)}</span>` : ''}${delta}</div>`;
    }
    case 'steps': {
      const items: any[] = Array.isArray(node.items) ? node.items : [];
      let h = '<ol class="ai-card__steps">';
      items.forEach((it: any, i: number) => {
        h += `<li class="ai-card__step"><span class="ai-card__step-num">${i + 1}</span><span>${esc(typeof it === 'string' ? it : (it.text ?? String(it)))}</span></li>`;
      });
      h += '</ol>';
      return h;
    }
    case 'divider': case 'hr':
      return '<hr class="ai-card__divider">';
    case 'progress': {
      const pct = parseFloat(String(node.text ?? '0'));
      return `<div class="ai-card__progress"><div class="ai-card__progress-label">${esc(node.label ?? '')} ${isNaN(pct) ? '' : pct + '%'}</div><div class="ai-card__progress-bar"><div class="ai-card__progress-fill" style="width:${isNaN(pct) ? 0 : pct}%"></div></div></div>`;
    }
    case 'button': case 'btn':
      return `<div class="ai-card__button">${esc(node.label ?? node.text ?? 'Button')}</div>`;
    case 'link':
      return `<a class="ai-card__link" href="${esc(node.href ?? '#')}">${esc(node.text ?? node.label ?? node.href ?? '')}</a>`;
    case 'quote':
      return `<blockquote class="ai-card__quote">${esc(node.text ?? '')}</blockquote>`;
    case 'grid':
      return `<div class="ai-card__grid">${children}</div>`;
    case 'mermaid':
      return renderMermaidHtml(node.text ?? node.code ?? '');
    default:
      return children || `<div class="ai-card">${esc(node.text ?? node.label ?? '')}</div>`;
  }
}

function renderUiHtml(inner: string): string {
  const raw = unwrapFence(inner);
  if (!raw) return '';
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return ''; }

  if (Array.isArray(parsed)) {
    return '<div class="ai-ui">' + parsed.map((n: any) => renderUiNodeHtml(n)).join('') + '</div>';
  }
  if (typeof parsed === 'object' && parsed !== null) {
    // single node or {t:"card", children:[...]}
    return '<div class="ai-ui">' + renderUiNodeHtml(parsed) + '</div>';
  }
  return '';
}

/**
 * Pre-process markdown: extract [MERMAID], [QUESTIONS], [UI] blocks into
 * placeholder HTML divs, and protect LaTeX delimiters from marked.
 */
function preprocessBlocks(markdown: string): string {
  let idx = 0;
  const blocks: ExtractedBlock[] = [];

  const result = markdown.replace(BLOCK_RE, (_match, kind: string, inner: string) => {
    const k = kind.toLowerCase();
    let html = '';
    if (k === 'mermaid')  html = renderMermaidHtml(inner);
    else if (k === 'diagram') html = renderDiagramHtml(inner);
    else if (k === 'questions') html = renderQuestionsHtml(inner);
    else if (k === 'ui')  html = renderUiHtml(inner);

    if (!html) return '';
    const ph = `\n\n<div class="__spirit_block_${idx}"></div>\n\n`;
    blocks.push({ placeholder: ph, html });
    idx++;
    return ph;
  });

  // Protect LaTeX: wrap $$...$$ and $...$ in invisible markers so marked
  // doesn't eat the dollar signs or treat them as emphasis markers.
  // KaTeX CDN client-side script will find and render these on page load.
  let processed = result
    .replace(/\$\$\n?([\s\S]+?)\n?\$\$/g, '<span class="katex-render" data-display="true">$1</span>')
    .replace(/\$([^\$\n]+?)\$/g, '<span class="katex-render">$1</span>');

  // Replace placeholders with actual block HTML
  for (let i = blocks.length - 1; i >= 0; i--) {
    processed = processed.replace(
      `<div class="__spirit_block_${i}"></div>`,
      blocks[i].html,
    );
  }

  return processed;
}

// Detect whether the response is already rich HTML (Gemini may emit HTML
// directly for /summary etc.) or needs markdown rendering.
function looksLikeHtml(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) return true;
  const tagMatches = trimmed.match(/<\/?(?:div|section|article|table|h[1-6]|p|ul|ol|li|figure|aside|nav|header|footer|main|span|button|input|form|svg)\b/gi);
  if (!tagMatches) return false;
  return tagMatches.length > Math.max(2, trimmed.length / 400);
}

export async function renderHtmlDocument(opts: {
  prompt: string;
  markdown: string;
  web: boolean;
  images?: WebImage[];
  generatedAt: Date;
}): Promise<string> {
  const isHtml = looksLikeHtml(opts.markdown);
  let body: string;
  if (isHtml) {
    body = sanitizeHtml(opts.markdown);
  } else {
    const preprocessed = preprocessBlocks(opts.markdown);
    body = sanitizeHtml(await marked.parse(preprocessed, { gfm: true, breaks: false }));
  }
  const ts = opts.generatedAt.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const safePrompt = escapeHtml(opts.prompt);
  const webBadge = opts.web
    ? '<span class="ai-badge ai-badge--web">web-grounded</span>'
    : '';

  // Web search images — render as a responsive figure grid above the answer body
  const images = opts.images ?? [];
  let imagesHtml = '';
  if (images.length > 0) {
    imagesHtml = '<div class="ai-images">';
    for (const img of images) {
      const alt = esc(img.title || '');
      const src = esc(img.url);
      const caption = esc(img.source ? new URL(img.source).hostname : '');
      imagesHtml += `<figure class="ai-images__item">` +
        `<img src="${src}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">` +
        (caption ? `<figcaption>${caption}</figcaption>` : '') +
        `</figure>`;
    }
    imagesHtml += '</div>';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="generator" content="Spirit">
<title>Spirit · ${safePrompt.slice(0, 80)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" integrity="sha384-n8MVd4RsNIU0tQ2/19qBfSVFSH4TSKRXaHlMz2bSQ4FZOR2N0MFJYQ55I7Y0y" crossorigin="anonymous">
<style>
  :root {
    --bg: #fafaf9;
    --paper: #ffffff;
    --ink: #18181b;
    --ink-soft: rgba(24, 24, 27, 0.68);
    --ink-faint: rgba(24, 24, 27, 0.45);
    --spirit-accent: #2563eb;
    --spirit-accent-soft: rgba(37, 99, 235, 0.14);
    --spirit-accent-strong: rgba(37, 99, 235, 0.32);
    --border: rgba(24, 24, 27, 0.09);
    --border-strong: rgba(24, 24, 27, 0.18);
    --code-bg: rgba(24, 24, 27, 0.045);
    --warn: #b45309;
    --warn-soft: rgba(180, 83, 9, 0.1);
    --info: #1d4ed8;
    --info-soft: rgba(29, 78, 216, 0.08);
    --danger: #b91c1c;
    --danger-soft: rgba(185, 28, 28, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0c0d;
      --paper: #16161a;
      --ink: #f5f5f4;
      --ink-soft: rgba(245, 245, 244, 0.72);
      --ink-faint: rgba(245, 245, 244, 0.42);
      --spirit-accent: #0a84ff;
      --spirit-accent-soft: rgba(10, 132, 255, 0.12);
      --spirit-accent-strong: rgba(10, 132, 255, 0.3);
      --border: rgba(245, 245, 244, 0.1);
      --border-strong: rgba(245, 245, 244, 0.18);
      --code-bg: rgba(245, 245, 244, 0.06);
      --warn: #fbbf24;
      --warn-soft: rgba(251, 191, 36, 0.08);
      --info: #93c5fd;
      --info-soft: rgba(147, 197, 253, 0.08);
      --danger: #fca5a5;
      --danger-soft: rgba(252, 165, 165, 0.08);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, system-ui, 'Segoe UI', Inter, sans-serif; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  body { padding: 48px 0; }
  .ai-doc {
    width: 210mm;
    min-height: 297mm;
    max-width: calc(100vw - 32px);
    margin: 0 auto;
    background: var(--paper);
    padding: 22mm 22mm 18mm 22mm;
    box-shadow: 0 24px 80px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04);
    border-radius: 8px;
    position: relative;
  }
  .ai-doc__header { border-bottom: 1px solid var(--border); padding-bottom: 18px; margin-bottom: 28px; }
  .ai-doc__brand { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-soft); }
  .ai-doc__brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--spirit-accent); box-shadow: 0 0 0 4px var(--spirit-accent-soft); }
  .ai-doc__title { margin: 14px 0 0 0; font-size: 30px; line-height: 1.18; letter-spacing: -0.015em; font-weight: 650; color: var(--ink); }
  .ai-doc__meta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; color: var(--ink-faint); align-items: center; }
  .ai-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-weight: 600; font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase; }
  .ai-badge--web { background: var(--spirit-accent-soft); color: var(--spirit-accent); }
  .ai-badge--strong { background: var(--spirit-accent); color: var(--paper); }
  .ai-badge--soft { background: var(--spirit-accent-soft); color: var(--spirit-accent); }
  .ai-badge--neutral { background: var(--code-bg); color: var(--ink-soft); }
  .ai-badge--success { background: rgba(22, 163, 74, 0.1); color: #16a34a; }
  .ai-badge--warning { background: var(--warn-soft); color: var(--warn); }
  .ai-badge--danger { background: var(--danger-soft); color: var(--danger); }
  .ai-badge--ghost { background: transparent; color: var(--ink-soft); border: 1px solid var(--border); }
  .ai-doc__body { font-size: 14.5px; }
  .ai-doc__body h1, .ai-doc__body h2, .ai-doc__body h3 { color: var(--ink); letter-spacing: -0.008em; line-height: 1.25; margin: 1.6em 0 0.6em; }
  .ai-doc__body h1 { font-size: 24px; }
  .ai-doc__body h2 { font-size: 19px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .ai-doc__body h3 { font-size: 16px; color: var(--ink-soft); }
  .ai-doc__body p { margin: 0.75em 0; color: var(--ink); }
  .ai-doc__body a { color: var(--spirit-accent); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
  .ai-doc__body a:hover { text-decoration-thickness: 2px; }
  .ai-doc__body ul, .ai-doc__body ol { margin: 0.85em 0; padding-left: 1.5em; }
  .ai-doc__body li { margin: 0.3em 0; }
  .ai-doc__body li::marker { color: var(--spirit-accent); }
  .ai-doc__body code { background: var(--code-bg); padding: 1.5px 6px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  .ai-doc__body pre { background: var(--code-bg); padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 1em 0; border: 1px solid var(--border); }
  .ai-doc__body pre code { background: transparent; padding: 0; }
  .ai-doc__body blockquote { border-left: 3px solid var(--spirit-accent); padding-left: 14px; margin: 1em 0; color: var(--ink-soft); font-style: italic; }
  .ai-doc__body hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
  .ai-doc__body table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 13.5px; }
  .ai-doc__body th, .ai-doc__body td { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
  .ai-doc__body th { font-weight: 600; background: var(--code-bg); }
  .ai-doc__body tr:hover td { background: var(--spirit-accent-soft); }
  /* Card primitives */
  .ai-doc__body .card, .ai-doc__body .ai-card { border: 1px solid var(--border); background: var(--paper); border-radius: 10px; padding: 16px 18px; margin: 1em 0; }
  .ai-card__title { font-weight: 650; font-size: 15px; margin-bottom: 8px; color: var(--ink); }
  .ai-card__heading { font-weight: 600; font-size: 14px; margin: 0.5em 0 0.3em; color: var(--ink); }
  .ai-card__text { margin: 0.3em 0; color: var(--ink-soft); }
  .ai-card__code { background: var(--code-bg); padding: 10px 12px; border-radius: 6px; font-size: 12.5px; overflow-x: auto; margin: 0.5em 0; }
  .ai-card__code code { background: transparent; padding: 0; }
  .ai-card__list { margin: 0.5em 0; padding-left: 1.4em; }
  .ai-card__list li { margin: 0.2em 0; }
  .ai-card__kv { border-collapse: collapse; width: 100%; font-size: 13px; margin: 0.5em 0; }
  .ai-card__kv td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .ai-card__kv-label { font-weight: 600; color: var(--ink-soft); width: 40%; }
  .ai-card__kv-value { color: var(--ink); }
  .ai-card__table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 0.5em 0; }
  .ai-card__table th { background: var(--code-bg); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  .ai-card__table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .ai-card__stat { display: inline-flex; flex-direction: column; padding: 10px 16px; border-radius: 10px; background: var(--code-bg); margin: 0.3em 0.5em 0.3em 0; min-width: 90px; }
  .ai-card__stat-value { font-size: 20px; font-weight: 650; line-height: 1; color: var(--ink); }
  .ai-card__stat-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); margin-top: 3px; }
  .ai-card__stat-delta { font-size: 11px; color: var(--spirit-accent); margin-top: 2px; }
  .ai-card__steps { list-style: none; padding: 0; margin: 0.5em 0; }
  .ai-card__step { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; }
  .ai-card__step-num { flex: 0 0 26px; width: 26px; height: 26px; border-radius: 50%; background: var(--spirit-accent-soft); color: var(--spirit-accent); display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 12px; }
  .ai-card__divider { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
  .ai-card__progress { margin: 0.5em 0; }
  .ai-card__progress-label { font-size: 12.5px; color: var(--ink-soft); margin-bottom: 4px; }
  .ai-card__progress-bar { height: 6px; background: var(--code-bg); border-radius: 3px; overflow: hidden; }
  .ai-card__progress-fill { height: 100%; background: var(--spirit-accent); border-radius: 3px; transition: width 0.3s ease; }
  .ai-card__button { display: inline-flex; padding: 6px 16px; border-radius: 8px; background: var(--spirit-accent); color: var(--paper); font-weight: 600; font-size: 13px; }
  .ai-card__link { color: var(--spirit-accent); text-decoration: underline; text-underline-offset: 2px; }
  .ai-card__quote { border-left: 3px solid var(--spirit-accent); padding-left: 12px; color: var(--ink-soft); font-style: italic; margin: 0.5em 0; }
  .ai-card__grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin: 0.5em 0; }
  .ai-doc__body .callout { border-left: 3px solid var(--spirit-accent); background: var(--spirit-accent-soft); padding: 12px 14px; border-radius: 0 8px 8px 0; margin: 1em 0; }
  .ai-doc__body .callout--warn { border-left-color: var(--warn); background: var(--warn-soft); color: var(--ink); }
  .ai-doc__body .callout--info { border-left-color: var(--info); background: var(--info-soft); color: var(--ink); }
  .ai-doc__body .callout--danger { border-left-color: var(--danger); background: var(--danger-soft); color: var(--ink); }
  .ai-doc__body .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin: 1em 0; }
  .ai-doc__body .step { display: flex; gap: 12px; padding: 10px 0; }
  .ai-doc__body .step__num { flex: 0 0 28px; width: 28px; height: 28px; border-radius: 50%; background: var(--spirit-accent-soft); color: var(--spirit-accent); display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 12.5px; }
  .ai-doc__body .kpi { display: inline-flex; flex-direction: column; padding: 12px 16px; border-radius: 10px; background: var(--code-bg); margin-right: 12px; min-width: 110px; }
  .ai-doc__body .kpi__value { font-size: 22px; font-weight: 650; line-height: 1; color: var(--ink); }
  .ai-doc__body .kpi__label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-faint); margin-top: 4px; }
  .ai-doc__body svg { max-width: 100%; height: auto; }
  /* Mermaid diagrams */
  .ai-mermaid { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 1em 0; text-align: center; overflow-x: auto; }
  .ai-mermaid svg { max-width: 100%; height: auto; }
  .ai-diagram { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 1em 0; overflow-x: auto; font-size: 13.5px; line-height: 1.5; }
  .ai-diagram .dg-flow { display: flex; flex-direction: column; gap: 0.4rem; }
  .ai-diagram .dg-flow-h { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: stretch; }
  .ai-diagram .dg-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .ai-diagram .dg-col { display: flex; flex-direction: column; gap: 0.4rem; }
  .ai-diagram .dg-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem; }
  .ai-diagram .dg-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.5rem; }
  .ai-diagram .dg-stack { display: flex; flex-direction: column; gap: 0.3rem; }
  .ai-diagram .dg-box { background: var(--code-bg); border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; min-width: 0; }
  .ai-diagram .dg-accent { background: var(--spirit-accent-soft); border-color: var(--spirit-accent-strong); }
  .ai-diagram .dg-title { font-size: 13px; font-weight: 650; margin: 0 0 2px; }
  .ai-diagram .dg-box-title { font-size: 11.5px; font-weight: 600; margin: 0 0 2px; }
  .ai-diagram .dg-box-sub { font-size: 11.5px; color: var(--ink-soft); margin: 0; }
  .ai-diagram .dg-label { font-size: 10px; font-weight: 650; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-faint); margin: 0 0 1px; }
  .ai-diagram .dg-muted { color: var(--ink-soft); }
  .ai-diagram .dg-badge { display: inline-flex; align-items: center; gap: 4px; background: var(--spirit-accent-soft); color: var(--spirit-accent); border: 1px solid var(--spirit-accent-strong); border-radius: 999px; padding: 2px 9px; font-size: 10.5px; font-weight: 600; }
  .ai-diagram .dg-chip { display: inline-flex; background: var(--code-bg); border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; font-size: 10.5px; font-weight: 500; }
  .ai-diagram .dg-tag { display: inline-flex; background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; font-size: 10px; color: var(--ink-soft); }
  .ai-diagram .dg-number { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; border-radius: 50%; background: var(--spirit-accent-soft); border: 1px solid var(--spirit-accent-strong); color: var(--spirit-accent); font-size: 10.5px; font-weight: 700; }
  .ai-diagram .dg-arrow, .ai-diagram .dg-arrow-h { position: relative; flex: none; margin: 0 auto; }
  .ai-diagram .dg-arrow { width: 14px; height: 16px; }
  .ai-diagram .dg-arrow::before { content: ''; position: absolute; left: 6px; top: 0; bottom: 3px; width: 1px; background: var(--ink-faint); }
  .ai-diagram .dg-arrow::after { content: ''; position: absolute; left: 3px; bottom: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid var(--ink-faint); }
  .ai-diagram .dg-arrow-h { width: 22px; height: 14px; margin: 0 2px; }
  .ai-diagram .dg-arrow-h::before { content: ''; position: absolute; left: 0; right: 3px; top: 6px; height: 1px; background: var(--ink-faint); }
  .ai-diagram .dg-arrow-h::after { content: ''; position: absolute; right: 0; top: 2px; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 5px solid var(--ink-faint); }
  .ai-diagram .dg-rule { border: none; border-top: 1px solid var(--border); margin: 0.5rem 0; }
  .ai-diagram .dg-step { display: flex; align-items: flex-start; gap: 0.55rem; }
  .ai-diagram .dg-layer { border-left: 2px solid var(--spirit-accent-strong); padding-left: 0.6rem; }
  .ai-diagram .dg-tree { border-left: 1px solid var(--border); margin-left: 0.35rem; padding-left: 0.7rem; display: flex; flex-direction: column; gap: 0.3rem; }
  .ai-diagram .dg-term { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline; }
  .ai-diagram .dg-term-desc { color: var(--ink); }
  /* Question wizards */
  .ai-questions { border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin: 1em 0; background: var(--paper); }
  .ai-questions__title { font-weight: 650; font-size: 15px; margin-bottom: 12px; color: var(--ink); }
  .ai-questions__list { list-style: none; padding: 0; margin: 0; counter-reset: qcounter; }
  .ai-questions__item { counter-increment: qcounter; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .ai-questions__item:last-child { border-bottom: none; }
  .ai-questions__item::before { content: counter(qcounter) "."; font-weight: 600; color: var(--spirit-accent); margin-right: 8px; font-size: 13px; }
  .ai-questions__q { font-weight: 500; color: var(--ink); font-size: 14px; }
  .ai-questions__req { color: var(--danger); font-weight: 700; }
  .ai-questions__type { font-size: 11.5px; color: var(--ink-faint); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.03em; }
  .ai-questions__options { list-style: disc; padding-left: 1.5em; margin: 6px 0 0; font-size: 13px; color: var(--ink-soft); }
  .ai-questions__options li { margin: 2px 0; }
  .ai-questions__ph { font-size: 12px; color: var(--ink-faint); font-style: italic; margin-top: 3px; }
  .ai-questions__range { font-size: 12px; color: var(--ink-faint); margin-top: 3px; }
  /* KaTeX display math */
  .ai-doc__body .katex-display { margin: 1em 0; overflow-x: auto; }
  .ai-doc__body .katex { font-size: 1.05em; }
  /* UI blocks wrapper */
  .ai-ui { margin: 0.5em 0; }
  /* Web search image grid */
  .ai-images { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin: 0 0 1.2em; }
  .ai-images__item { margin: 0; display: flex; flex-direction: column; }
  .ai-images__item img { width: 100%; height: 160px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); background: var(--code-bg); }
  .ai-images__item figcaption { font-size: 10.5px; color: var(--ink-faint); margin-top: 4px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media print {
    body { padding: 0; background: white; }
    .ai-doc { box-shadow: none; border-radius: 0; width: auto; min-height: auto; max-width: none; margin: 0; padding: 18mm; }
    .ai-doc__title { font-size: 24px; }
    .ai-doc__body { font-size: 12.5pt; }
  }
  @page { size: A4; margin: 16mm; }
</style>
</head>
<body>
  <main class="ai-doc">
    <header class="ai-doc__header">
      <div class="ai-doc__brand"><span class="dot"></span> Spirit</div>
      <h1 class="ai-doc__title">${safePrompt || 'Response'}</h1>
      <div class="ai-doc__meta">
        <span>${ts}</span>
        ${webBadge}
      </div>
    </header>
    <article class="ai-doc__body">${imagesHtml}${body}</article>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js" integrity="sha384-XjKyOOlGwcjNTAIQHIpgOno0Ola1RsJZz2i9a7aHRQGMrpliZnzzDWhCv5MIkp" crossorigin="anonymous"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" crossorigin="anonymous"><\/script>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // KaTeX: render all .katex-render spans
      if (typeof katex !== 'undefined') {
        document.querySelectorAll('.katex-render').forEach(function(el) {
          try {
            katex.render(el.textContent || '', el, {
              displayMode: el.getAttribute('data-display') === 'true',
              throwOnError: false,
              strict: false,
            });
          } catch(e) { el.style.display = 'block'; el.style.color = 'var(--danger)'; el.textContent = '[LaTeX error]'; }
        });
      }
      // Mermaid: render all .ai-mermaid blocks
      if (typeof mermaid !== 'undefined') {
        try {
          mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
          mermaid.run({ nodes: document.querySelectorAll('.ai-mermaid') });
        } catch(e) {
          document.querySelectorAll('.ai-mermaid').forEach(function(el) {
            el.innerHTML = '<pre style="text-align:left;color:var(--ink-soft);font-size:12px;">' + el.textContent + '</pre>';
          });
        }
      }
    });
  <\/script>
</body>
</html>`;
}
