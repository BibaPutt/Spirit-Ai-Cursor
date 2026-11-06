// Pure, dependency-free sanitizer for [DIAGRAM] blocks — the HTML the model
// emits by filling the fixed .dg-* template vocabulary (see the
// diagram-design skill). The block payload must never be able to run script,
// load external resources, or exfiltrate anything in either the live overlay
// (renderer innerHTML) or the saved-document path (main-process template).
// Same pure contract → unit-tested mirror: no Electron/host imports.
//
// The model is told to only ever use the .dg-* classes; everything else has
// no styling, so the strict allowlist below costs nothing visually. Unknown
// tags are unwrapped (their text survives), active/embedding tags are dropped
// WITH their content, attributes are allowlisted, and `class` is limited to
// the dg-*/spirit-* vocabulary that the app's thin CSS skin actually styles.

// Only these class prefixes carry styling. Anything else is stripped so the
// model can never smuggle in app/z-index/utility classes.
export const DIAGRAM_CLASS_RE = /^(?:dg-|spirit-)[a-zA-Z0-9_-]*(\s+(?:dg-|spirit-)[a-zA-Z0-9_-]*)*$/;

// Elements that keep their children but lose their own tag/attributes
// (anchors with a href would otherwise be a link/scheme vector).
const UNWRAP_TAGS = new Set(['a']);

// Elements rendered as-is (attributes strictly filtered).
const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'section', 'header', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'small',
  'br', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'svg', 'g', 'rect', 'circle', 'line', 'path', 'polyline', 'polygon',
  'text', 'tspan',
]);

// Dropped together with ALL of their content (script-bearing / active /
// exfiltration-capable). This list deliberately includes <title> (a stray
// document title could override the page) and <style> (no layout injection).
const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'select', 'textarea', 'frame', 'frameset',
  'noscript', 'template', 'head', 'body', 'title', 'math',
  'audio', 'video', 'source', 'picture', 'img', 'canvas', 'slot',
]);

const VOID_TAGS = new Set(['br', 'hr']);

const SVG_TAGS = new Set([
  'svg', 'g', 'rect', 'circle', 'line', 'path', 'polyline', 'polygon',
  'text', 'tspan',
]);

// Geometry/presentation attrs for SVG elements (pure layout, no URLs).
const SVG_ATTRS = new Set([
  'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'viewbox', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-opacity', 'opacity', 'transform',
]);

// Attrs allowed on ANY allowed element (values escaped on output).
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'width', 'height', 'colspan', 'rowspan']);

const TAG_TOKEN_RE = /<!--[\s\S]*?-->|<[^>]*>/g;
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9_.:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function escapeAttrValue(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function filterAttrs(tag: string, attrsBlock: string): string {
  const kept: string[] = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrsBlock))) {
    const rawName = m[1];
    const lower = rawName.toLowerCase();
    const value = m[2] !== undefined ? m[2].replace(/^(['"])(.*)\1$/s, '$2') : null;
    if (value === null) continue; // attribute-value-less attrs are never needed
    const v = value.trim();
    if (!v) continue;
    // No URL material anywhere (internal or external): color/fill/url(ref)
    // refs and any javascript: form are actively removed.
    if (/url\(/i.test(v) || /javascript:/i.test(v)) continue;
    if (lower === 'class') {
      if (!DIAGRAM_CLASS_RE.test(v)) continue;
    } else if (lower === 'id') {
      if (!/^[A-Za-z][\w:.-]*$/.test(v)) continue;
    } else if (GLOBAL_ATTRS.has(lower)) {
      // title / width / height / colspan / rowspan — inert values
    } else if (SVG_TAGS.has(tag) && SVG_ATTRS.has(lower)) {
      // svg geometry/presentation attr
    } else {
      continue;
    }
    kept.push(`${rawName}="${escapeAttrValue(v)}"`);
  }
  return kept.length ? ' ' + kept.join(' ') : '';
}

// Sanitize a model-emitted [DIAGRAM] block's inner HTML. Safe for the renderer
// overlay (dangerouslySetInnerHTML) and for embedding in a saved document.
export function sanitizeDiagramHtml(raw: string): string {
  const s = raw ?? '';
  const out: string[] = [];
  let skipName: string | null = null;
  let skipDepth = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TAG_TOKEN_RE.lastIndex = 0;
  while ((m = TAG_TOKEN_RE.exec(s))) {
    if (skipDepth === 0) out.push(s.slice(lastIndex, m.index));
    lastIndex = TAG_TOKEN_RE.lastIndex;
    const token = m[0];
    if (token.startsWith('<!--')) continue;
    const isClose = token.startsWith('</');
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const selfClose = /\/\s*>$/.test(token);

    if (skipDepth > 0) {
      if (name === skipName) {
        if (isClose) {
          skipDepth--;
          if (skipDepth === 0) skipName = null;
        } else if (!selfClose) {
          skipDepth++;
        }
      }
      continue;
    }

    if (BLOCKED_TAGS.has(name)) {
      if (!isClose) {
        skipName = name;
        skipDepth = 1;
      }
      continue;
    }

    if (isClose) {
      if (ALLOWED_TAGS.has(name)) out.push(`</${name}>`);
      continue;
    }

    if (UNWRAP_TAGS.has(name)) continue; // <a>…</a> → text only
    if (!ALLOWED_TAGS.has(name)) continue; // unknown tags unwrap

    // Attrs block = everything between the tag name and the closing '>'.
    let attrsBlock = token.slice(nameMatch[0].length);
    if (attrsBlock.endsWith('/>')) attrsBlock = attrsBlock.slice(0, -2);
    else if (attrsBlock.endsWith('>')) attrsBlock = attrsBlock.slice(0, -1);
    if (VOID_TAGS.has(name) || selfClose) {
      out.push(`<${name}${filterAttrs(name, attrsBlock)} />`);
    } else {
      out.push(`<${name}${filterAttrs(name, attrsBlock)}>`);
    }
  }
  if (skipDepth === 0) out.push(s.slice(lastIndex));
  return out.join('').trim();
}