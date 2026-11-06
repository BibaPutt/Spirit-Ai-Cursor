import { shell } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { getWorkspaceFolder } from '../../store/settings';
import type { ToolDefinition } from './index';

const MAX_BYTES = 2 * 1024 * 1024;

// Relative paths are scoped to the user's Spirit workspace; absolute paths are
// allowed (they let the model drop files anywhere the user asked, e.g. the
// Desktop). Traversal that escapes the workspace is refused for relatives.
function resolveOutputPath(requested: string): string {
  if (isAbsolute(requested)) return resolve(requested);
  const workspace = getWorkspaceFolder();
  const target = resolve(workspace, requested);
  const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;
  if (target !== workspace && !target.startsWith(prefix)) {
    throw new Error('path escapes the Spirit workspace; use an absolute path to write elsewhere');
  }
  return target;
}

export const createFileTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'create_file',
      description:
        'Write content you produced to a real file on disk and (optionally) open it in the default app. The content is written VERBATIM — no template, no wrapper. A relative path is saved inside the Spirit workspace folder; an absolute path can save anywhere (e.g. C:\\Users\\me\\Desktop\\deck.pptx and the file keeps the exact extension you give: .html, .md, .py, .json, .csv, .txt, .pptx...). Text formats work directly; for BINARY formats like .pptx/.xlsx/.docx write the binary artifact with run_command (PowerShell COM automation) instead, or use create_file with a plain-text source (.py/.ps1) then run it. Returns the real absolute path of the file so you can cite it. Use when the user asks to "create/make/save a file", "write a script", "export to CSV", or give a filename and content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Filename or path. Relative paths land in the Spirit workspace folder; absolute paths write exactly there. Extension is kept: dashboard.html stays dashboard.html.',
          },
          content: {
            type: 'string',
            description: 'The exact bytes/text to write. Omit only to create an empty file.',
          },
          open: {
            type: 'boolean',
            description: 'When true, open the file with its default app after writing (links open in browser, .html in browser). Default false.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  uiLabel: (args) => {
    const p = String(args.path ?? '').trim();
    return p ? `Creating file: ${p}` : 'Creating file';
  },
  async execute(args) {
    const requested = String(args.path ?? '').trim();
    if (!requested) return 'Error: create_file requires a "path" argument.';
    const content = String(args.content ?? '');
    if (content.length > MAX_BYTES) {
      return `Error: content is too large (max ${MAX_BYTES} bytes). Write it in smaller parts or use run_command.`;
    }
    // Text-only tool: a NUL byte means the content is a binary buffer that
    // would be mangled as a string — the model must generate those via script.
    if (content.includes('\u0000')) {
      return 'Error: this content is binary (contains NUL bytes). create_file writes text only — generate binary formats like .pptx/.xlsx/.docx with run_command (PowerShell COM) instead.';
    }

    let target: string;
    try {
      target = resolveOutputPath(requested);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (args.open === true) {
      try {
        await shell.openPath(target);
      } catch {
        /* opening is best-effort; the creation itself succeeded */
      }
    }
    const opened = args.open === true ? ' and opened it with its default app' : '';
    return `Created ${target} (${content.length} bytes)${opened}. The absolute path is ${target} — cite it when reporting back to the user.`;
  },
};