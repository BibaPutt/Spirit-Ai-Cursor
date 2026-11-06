import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { getWorkspaceFolder } from '../../store/settings';
import type { ToolDefinition } from './index';

export const LIST_MAX_ENTRIES = 200;

// List a directory's entries (names + dir/file + size). Read-only.
// Absolute anywhere; relative stays inside the workspace. Use to see what
// files exist before reading/opening them — e.g. "list the files on screen"
// after focusing Explorer still needs see_screen/ui_read (pixels, not disk),
// but any KNOWN folder lists exactly here.
export function formatListing(dir: string, names: string[]): string {
  const lines = names.map((n) => {
    let suffix = '';
    try {
      const st = statSync(join(dir, n));
      suffix = st.isDirectory() ? '/' : ` (${formatBytes(st.size)})`;
    } catch {
      suffix = ' (?)';
    }
    return `- ${n}${suffix}`;
  });
  return `Directory ${dir} (${names.length} entries):\n${lines.join('\n')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const listDirTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List files and folders inside a directory (names, dir/file, sizes). Relative = workspace folder; absolute = exact location. Use to see what exists before read_file/open_file, or to answer "what files are in X". For files VISIBLE ON SCREEN in Explorer, use see_screen/ui_read instead (pixels, not disk).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list. Empty = workspace folder.' },
        },
      },
    },
  },
  uiLabel: (args) => {
    const p = String(args.path ?? '').trim();
    return p ? `Listing: ${p.slice(0, 40)}` : 'Listing workspace';
  },
  async execute(args) {
    const requested = String(args.path ?? '').trim();
    let dir: string;
    if (!requested) {
      dir = getWorkspaceFolder();
    } else if (isAbsolute(requested)) {
      dir = resolve(requested);
    } else {
      const workspace = getWorkspaceFolder();
      const target = resolve(workspace, requested);
      const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;
      if (target !== workspace && !target.startsWith(prefix)) {
        return 'Error: path escapes the Spirit workspace; pass an absolute path to list elsewhere.';
      }
      dir = target;
    }
    let names: string[];
    try {
      names = readdirSync(dir).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (err) {
      return `Error: cannot list ${dir || '(workspace)'} (${err instanceof Error ? err.message : String(err)}).`;
    }
    const capped = names.slice(0, LIST_MAX_ENTRIES);
    const more = names.length > capped.length ? `\n…(+${names.length - capped.length} more)` : '';
    return formatListing(dir, capped) + more;
  },
};
