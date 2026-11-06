import { BrowserWindow, app, shell } from 'electron';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { getAppIconPathSync } from '../tray/icon';

export type LegalSection = 'terms' | 'privacy' | 'credits' | 'license';

const SECTIONS: Array<{ id: LegalSection; label: string; file: string; missing: string }> = [
  { id: 'terms', label: 'Terms of Service', file: 'TERMS.md', missing: 'TERMS.md was not found in this installation.' },
  { id: 'privacy', label: 'Privacy Policy', file: 'PRIVACY.md', missing: 'PRIVACY.md was not found in this installation.' },
  { id: 'credits', label: 'Credits', file: 'CREDITS.md', missing: 'CREDITS.md was not found in this installation.' },
  { id: 'license', label: 'License', file: 'LICENSE', missing: 'LICENSE was not found in this installation.' },
];

let legalWindow: BrowserWindow | null = null;

// Branded Legal window: Terms of Service, Privacy Policy, Credits and the
// software license, one tab each. Same approach as the About window — a
// `data:text/html` URL with an opaque origin — but the document text is
// loaded from the markdown files that ship with the app (repo root in dev,
// inside the asar when packaged; Electron's fs can read through the asar),
// so the in-app copy is the canonical copy, never a fork of it.

export async function showLegalWindow(section: LegalSection = 'terms'): Promise<void> {
  if (legalWindow && !legalWindow.isDestroyed()) {
    legalWindow.show();
    legalWindow.focus();
    await legalWindow.webContents.executeJavaScript(`window.selectTab && window.selectTab(${JSON.stringify(section)});`);
    return;
  }

  const docs = await Promise.all(
    SECTIONS.map(async (s) => ({ ...s, html: await loadSectionHtml(s.file, s.missing) })),
  );

  legalWindow = new BrowserWindow({
    width: 780,
    height: 660,
    minWidth: 560,
    minHeight: 420,
    title: 'Spirit — Legal',
    icon: getAppIconPathSync() || undefined,
    backgroundColor: '#0c0c0d',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  legalWindow.setMenuBarVisibility(false);

  legalWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  legalWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });

  const html = renderLegalHtml(docs, section);
  void legalWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  legalWindow.once('ready-to-show', () => {
    legalWindow?.show();
    legalWindow?.focus();
  });

  legalWindow.on('closed', () => {
    legalWindow = null;
  });
}

export function getLegalWindow(): BrowserWindow | null {
  return legalWindow;
}

export function destroyLegalWindow(): void {
  if (legalWindow && !legalWindow.isDestroyed()) {
    legalWindow.destroy();
  }
  legalWindow = null;
}

async function loadSectionHtml(file: string, missingMessage: string): Promise<string> {
  try {
    const text = await fsp.readFile(path.join(app.getAppPath(), file), 'utf8');
    return markdownToHtml(text);
  } catch {
    return `<p><em>${escapeHtml(missingMessage)} The legal documents ship with the app and with the source repository.</em></p>`;
  }
}

// ── minimal markdown renderer ──────────────────────────────────────────────
// The legal docs use a deliberately small markdown subset: headings, hr,
// paragraphs, flat lists, blockquotes, fenced code and pipe tables, plus
// inline bold / italic / code / links. HTML is escaped first, so nothing in
// the source can inject markup.

function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // fenced code block
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(`<pre><code>${buf.map(escapeHtml).join('\n')}</code></pre>`);
      continue;
    }

    // heading
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 5); // # → h2 (h1 is the window title)
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // pipe table: header row followed by a |---| separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = (row: string) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const headers = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        '<table><thead><tr>' +
          headers.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>',
      );
      continue;
    }

    // blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // list (- item / 1. item), flat
    const li = /^\s*([-*]|\d+\.)\s+/;
    if (li.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const buf: string[] = [];
      while (i < lines.length && li.test(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(li, ''))}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${buf.join('')}</ol>` : `<ul>${buf.join('')}</ul>`);
      continue;
    }

    // paragraph: gather until blank line or another block construct
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('>') &&
      !li.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return out.join('\n');
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_m, code: string) => `<code>${escapeHtml(code)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
      if (href.startsWith('http://') || href.startsWith('https://')) {
        return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
      }
      return escapeHtml(label);
    });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLegalHtml(docs: Array<{ id: LegalSection; label: string; html: string }>, initial: LegalSection): string {
  const tabs = docs
    .map((d) => `<button class="tab" data-section="${d.id}">${d.label}</button>`)
    .join('');
  const panes = docs
    .map((d) => `<div class="pane" id="pane-${d.id}">${d.html}</div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Spirit — Legal</title>
<style>
  :root {
    --bg: #0c0c0d;
    --panel: #16161a;
    --ink: #f5f5f4;
    --ink-soft: rgba(245, 245, 244, 0.72);
    --ink-faint: rgba(245, 245, 244, 0.42);
    --spirit-accent: #0a84ff;
    --spirit-accent-soft: rgba(10, 132, 255, 0.12);
    --border: rgba(245, 245, 244, 0.08);
    --code-bg: rgba(245, 245, 244, 0.06);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fafaf9;
      --panel: #ffffff;
      --ink: #18181b;
      --ink-soft: rgba(24, 24, 27, 0.7);
      --ink-faint: rgba(24, 24, 27, 0.45);
      --spirit-accent: #6aaf3a;
      --spirit-accent-soft: rgba(106, 175, 58, 0.14);
      --border: rgba(24, 24, 27, 0.08);
      --code-bg: rgba(24, 24, 27, 0.06);
    }
  }
  * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: -apple-system, system-ui, 'Segoe UI', Inter, sans-serif;
    background: var(--bg);
    color: var(--ink);
    display: flex;
    flex-direction: column;
  }
  header {
    -webkit-app-region: drag;
    padding: 18px 24px 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header .brand {
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
    margin-right: 8px;
  }
  header .brand .ai { color: var(--spirit-accent); }
  .tab {
    -webkit-app-region: no-drag;
    appearance: none;
    background: transparent;
    color: var(--ink-soft);
    border: 1px solid transparent;
    font: inherit;
    font-size: 12.5px;
    padding: 7px 14px;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .tab:hover { background: var(--spirit-accent-soft); color: var(--ink); }
  .tab.active {
    background: var(--spirit-accent-soft);
    color: var(--spirit-accent);
    border-color: var(--spirit-accent);
  }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 8px 28px 36px;
    -webkit-app-region: no-drag;
  }
  .pane { display: none; max-width: 680px; margin: 0 auto; }
  .pane.active { display: block; }
  h2 { font-size: 20px; letter-spacing: -0.015em; margin: 18px 0 4px; }
  h3 { font-size: 15.5px; margin: 22px 0 6px; color: var(--spirit-accent); }
  h4 { font-size: 13.5px; margin: 18px 0 4px; }
  p, li { font-size: 13px; line-height: 1.65; color: var(--ink-soft); }
  strong { color: var(--ink); font-weight: 600; }
  em { color: var(--ink-soft); }
  a { color: var(--spirit-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  hr { border: none; border-top: 1px solid var(--border); margin: 22px 0; }
  code {
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace;
    font-size: 11.5px;
    background: var(--code-bg);
    border-radius: 4px;
    padding: 1px 5px;
  }
  pre {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  pre code { background: transparent; padding: 0; font-size: 11px; line-height: 1.5; }
  ul, ol { padding-left: 22px; margin: 8px 0; }
  li { margin: 4px 0; }
  li::marker { color: var(--ink-faint); }
  blockquote {
    margin: 10px 0;
    padding: 8px 14px;
    border-left: 3px solid var(--spirit-accent);
    background: var(--spirit-accent-soft);
    border-radius: 0 8px 8px 0;
    color: var(--ink-soft);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 12px;
  }
  th, td {
    text-align: left;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    line-height: 1.5;
  }
  th { color: var(--ink); font-weight: 600; font-size: 11.5px; }
  td { color: var(--ink-soft); }
  tr:last-child td { border-bottom: none; }
  footer {
    -webkit-app-region: no-drag;
    padding: 10px 28px 14px;
    border-top: 1px solid var(--border);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    text-align: center;
  }
</style>
</head>
<body>
  <header>
    <span class="brand">Spirit <span class="ai">AI</span></span>
    ${tabs}
  </header>
  <main>
    ${panes}
  </main>
  <footer>
    No telemetry · No analytics · No cloud — effective November 5, 2026
  </footer>
  <script>
    (function () {
      var tabs = document.querySelectorAll('.tab');
      var panes = document.querySelectorAll('.pane');
      window.selectTab = function (id) {
        tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.section === id); });
        panes.forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + id); });
        document.querySelector('main').scrollTop = 0;
      };
      tabs.forEach(function (t) {
        t.addEventListener('click', function () { window.selectTab(t.dataset.section); });
      });
      window.selectTab(${JSON.stringify(initial)});
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { window.close(); }
      });
    })();
  </script>
</body>
</html>`;
}
