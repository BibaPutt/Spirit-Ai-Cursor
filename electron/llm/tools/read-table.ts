import { clipboard } from 'electron';
import type { ToolDefinition } from './index';

// `read_table` turns a table the user copied (from Excel, Google Sheets,
// Numbers…) into tab-separated text the model can read and reason over.
// Copied spreadsheets put an HTML table on the clipboard; that is the most
// reliable source, with plain text and RTF as fallbacks. Read-only — never
// requires approval, and the router's honesty gate treats it like ui_read.

const MAX_CHARS = 8000;

function stripHtmlTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\t+$/gm, '')
    .trim();
}

// Quote a single cell for TSV/CSV output: cells containing a tab, newline or
// quote get wrapped in quotes with embedded quotes doubled.
function csvCell(text: string): string {
  if (/[\t\n"]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

// Extract the first <table> from clipboard HTML (Excel/Sheets paste a full
// HTML table with <table>, <tr>, <td>/<th>) and convert it to tab-separated
// text. Returns null when there is no table markup at all.
export function htmlTableToCsv(html: string): string | null {
  const table = /<table[\s\S]*?<\/table>/i.exec(html);
  if (!table) return null;
  const rows: string[][] = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(table[0])) !== null) {
    const cells = (m[0].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(stripHtmlTags);
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return null;
  return rows.map((r) => r.map(csvCell).join('\t')).join('\n');
}

// Convert an RTF table (\\cell ends a cell, \\row ends a row — what Excel and
// Word put on the clipboard for tables) into tab-separated text. Returns null
// when the RTF contains no table markup.
export function rtfTableToCsv(rtf: string): string | null {
  if (!/\\cell/i.test(rtf)) return null;
  const text = rtf
    // Drop \* destination groups (e.g. {\*\generator Excel}) entirely.
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\par\b/gi, '\n')
    .replace(/\\tab\b/gi, '\t')
    .replace(/\\cell\b/gi, '\t')
    .replace(/\\row\b/gi, '\n')
    // Hex-escaped characters, e.g. \'e9 for é.
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    // Control-word destinations / prefixes (\*group, \rowd, \cellx5000 …).
    .replace(/\\\*/g, '')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '');
  const rows = text
    .split('\n')
    .map((r) => r.split('\t').map((c) => c.trim()))
    .filter((r) => r.length > 0 && r.some((c) => c.length > 0));
  return rows.length > 0 ? rows.map((r) => r.map(csvCell).join('\t')).join('\n') : null;
}

// Looks like a table rather than a paragraph: the text has tab-separated
// columns or a pipe table pattern.
function looksLikeTable(text: string): boolean {
  return /(?:[^\n]\t|\t[^\n])/.test(text);
}

export const readTableTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'read_table',
      description:
        'Read the table currently on the clipboard as tab-separated text. Use this when the user copied cells in a spreadsheet (Excel, Google Sheets, Numbers) and wants you to read, transform, or paste that data. Read-only; never requires approval.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  uiLabel: () => 'Reading the clipboard table',
  async execute() {
    const html = clipboard.readHTML();
    const text = clipboard.readText();
    const rtf = clipboard.readRTF();
    if (html) {
      const csv = htmlTableToCsv(html);
      if (csv) {
        return csv.length > MAX_CHARS
          ? `Clipboard table (from HTML, ${csv.length} chars, truncated to ${MAX_CHARS}):\n${csv.slice(0, MAX_CHARS)}\n…[truncated]`
          : `Clipboard table (from HTML):\n${csv}`;
      }
    }
    if (text && looksLikeTable(text)) {
      return text.length > MAX_CHARS
        ? `Clipboard table (from text, ${text.length} chars, truncated to ${MAX_CHARS}):\n${text.slice(0, MAX_CHARS)}\n…[truncated]`
        : `Clipboard table (from text):\n${text}`;
    }
    if (rtf) {
      const csv = rtfTableToCsv(rtf);
      if (csv) {
        return csv.length > MAX_CHARS
          ? `Clipboard table (from RTF, ${csv.length} chars, truncated to ${MAX_CHARS}):\n${csv.slice(0, MAX_CHARS)}\n…[truncated]`
          : `Clipboard table (from RTF):\n${csv}`;
      }
    }
    return 'The clipboard does not contain a table. Copy a cell range in Excel or Google Sheets first, then call read_table() again.';
  },
};
