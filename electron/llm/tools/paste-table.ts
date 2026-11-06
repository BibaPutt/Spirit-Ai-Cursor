import { clipboard } from 'electron';
import { pasteComboForPlatform, pressKey } from '../../input/actions';
import { htmlTableToCsv } from './read-table';
import type { ToolDefinition } from './index';

// `paste_table` pastes a real table (Excel/Google Sheets style) into the
// focused app — Word, Google Docs, email, Notes, whatever is foreground.
// Writing BOTH the tab-separated text AND the HTML <table> to the clipboard
// before Ctrl+V is what makes the target app insert cells/columns instead of
// one long line of text.
//
// Without arguments it pastes whatever table is already on the clipboard
// (the common case: the user copied cells in Excel, then asks to paste them
// into a doc). With `rows` / `html` / `text` it builds the table from scratch.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(text: string): string {
  if (/[\t\n"]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildTableHtml(rows: string[][]): string {
  return (
    '<table border="1" cellpadding="2" cellspacing="0">' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>').join('') +
    '</table>'
  );
}

export function buildTableCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join('\t')).join('\n');
}

// Normalize a `rows` tool argument (array of arrays, or array of scalars)
// into a string matrix, dropping fully-empty rows.
function normalizeRows(input: unknown): string[][] {
  if (!Array.isArray(input)) return [];
  return input
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')]))
    .filter((r) => r.length > 0 && r.some((c) => c.trim() !== ''));
}

export const pasteTableTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'paste_table',
      description:
        'Paste a real table into the focused app (Word, Google Docs, email, etc.) as cells/columns, not plain text. If the user copied cells in Excel/Google Sheets, call paste_table() with NO arguments to paste what is already on the clipboard. To build a table yourself, pass rows as a list of lists (e.g. rows=[["Name","Score"],["Ann","9"]]) or a tab-separated text/HTML string. The previous clipboard contents are restored afterwards. Requires approval unless Auto-approve actions is on.',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            description: 'Table as a list of rows, each a list of cell values.',
            items: { type: 'array', items: { type: 'string' } },
          },
          html: {
            type: 'string',
            description: 'An HTML <table> string to paste as a table.',
          },
          text: {
            type: 'string',
            description: 'Tab-separated (or comma-separated) text to paste as a table.',
          },
        },
      },
    },
  },
  uiLabel: () => 'Pasting table',
  async execute(args) {
    const previous = clipboard.readText();
    let text = '';
    let html = '';

    if (args.rows) {
      const rows = normalizeRows(args.rows);
      if (rows.length === 0) return 'Error: paste_table rows must be a non-empty list of rows.';
      text = buildTableCsv(rows);
      html = buildTableHtml(rows);
    } else if (args.html) {
      html = String(args.html);
      text = htmlTableToCsv(html) ?? String(args.text ?? '');
    } else if (args.text) {
      text = String(args.text);
      html = '';
    } else {
      // No content given: paste the table already on the clipboard.
      const clipHtml = clipboard.readHTML();
      const clipText = clipboard.readText();
      if (clipHtml && htmlTableToCsv(clipHtml)) {
        html = clipHtml;
        text = htmlTableToCsv(clipHtml) as string;
      } else if (clipText) {
        text = clipText;
      }
    }

    if (!text && !html) {
      return 'Error: the clipboard is empty and no table content was provided. Copy cells in Excel/Sheets first, or pass rows / text / html to paste_table.';
    }

    const rowCount = text.split('\n').length;
    try {
      if (html) clipboard.write({ text, html });
      else clipboard.writeText(text);
      await pressKey(pasteComboForPlatform());
      // Let the paste land, then give the user their previous clipboard back.
      await new Promise((r) => setTimeout(r, 150));
      if (previous) {
        try {
          clipboard.writeText(previous);
        } catch {
          /* ignore */
        }
      }
      return `Pasted a ${rowCount}-row table into the focused app.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
