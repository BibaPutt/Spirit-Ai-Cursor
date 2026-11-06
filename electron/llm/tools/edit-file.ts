import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { resolveFilePath } from './read-file';
import { buildEditDocxComPs, buildEditXlsxComPs, defaultPsRunner, hasComApp } from '../../files/office';
import type { ToolDefinition } from './index';

// Precise file edits without whole-file rewrites. Two modes:
//   1. replace: swap the FIRST exact occurrence of oldText with newText.
//   2. append: add text at the end (append: true, oldText ignored).
// Text-only (binary refused, like read_file). Mutating → approval-gated.
// Refuses to run when oldText matches zero times (typo guard) or more than
// once (ambiguity guard — the model must include more context), so edits
// never land in the wrong spot silently.

export function applyEdit(
  current: string,
  oldText: string,
  newText: string,
): { ok: true; updated: string } | { ok: false; error: string } {
  if (!oldText) return { ok: false, error: 'oldText is empty — nothing to replace.' };
  const first = current.indexOf(oldText);
  if (first === -1) return { ok: false, error: 'oldText not found in file — re-read it (read_file) and copy the exact block.' };
  if (current.indexOf(oldText, first + oldText.length) !== -1) {
    return { ok: false, error: 'oldText matches more than once — include more surrounding lines to make it unique.' };
  }
  return { ok: true, updated: current.slice(0, first) + newText + current.slice(first + oldText.length) };
}

export const editFileTool: ToolDefinition = {
  declaration: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit a file precisely: replace the FIRST exact occurrence of oldText with newText, or append text at the end (append:true). Read the file first with read_file and copy blocks exactly — ambiguous or missing matches are refused, never guessed. .docx/.xlsx edit via installed Office when present (else a free-endpoint pointer). Relative = workspace; absolute = anywhere. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit.' },
          oldText: { type: 'string', description: 'Exact block to replace (ignored when append is true).' },
          newText: { type: 'string', description: 'Replacement text, or text to append.' },
          append: { type: 'boolean', description: 'Append newText at end of file instead of replacing.' },
        },
        required: ['path', 'newText'],
      },
    },
  },
  uiLabel: (args) => {
    const p = String(args.path ?? '').trim();
    return p ? `Editing: ${p.slice(0, 40)}` : 'Editing file';
  },
  async execute(args) {
    let target: string;
    try {
      target = resolveFilePath(String(args.path ?? ''));
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!existsSync(target)) return `Error: file does not exist: ${target}. Create it with create_file first.`;
    const newText = String(args.newText ?? '');
    // Office formats via installed Office (COM): no local Office → honest
    // pointer at free web endpoints instead of a silent no-op.
    const ext = extname(target).toLowerCase();
    if (process.platform === 'win32' && (ext === '.docx' || ext === '.xlsx') && args.append !== true) {
      const progId = ext === '.docx' ? 'Word.Application' : 'Excel.Application';
      if (await hasComApp(progId)) {
        try {
          const oldText = String(args.oldText ?? '');
          if (!oldText) return 'Error: oldText is empty — nothing to replace.';
          const script =
            ext === '.docx'
              ? buildEditDocxComPs(target, oldText, newText)
              : buildEditXlsxComPs(target, oldText, newText);
          const { stdout } = await defaultPsRunner(script);
          return `Edited ${target} via Office (${stdout.trim() || 'saved'}). Verify with read_file.`;
        } catch (err) {
          return `Error: Office edit failed (${err instanceof Error ? err.message : String(err)}). Try a free web endpoint (e.g. ilovepdf/Office Online).`;
        }
      }
      return `Error: ${target} needs Microsoft ${ext === '.docx' ? 'Word' : 'Excel'} to edit, which is not installed — use a free web endpoint (e.g. ilovepdf, Office Online) or convert via read_file + create_file.`;
    }
    if (args.append === true) {
      try {
        const buf = readFileSync(target);
        if (buf.includes(0)) return `Error: ${target} looks binary — edit_file is text-only.`;
        const sep = buf.length > 0 && !buf.toString('utf-8').endsWith('\n') ? '\n' : '';
        writeFileSync(target, buf.toString('utf-8') + sep + newText, 'utf-8');
        return `Appended ${newText.length} chars to ${target}.`;
      } catch (err) {
        return `Error: cannot append to ${target} (${err instanceof Error ? err.message : String(err)}).`;
      }
    }
    const oldText = String(args.oldText ?? '');
    let current: string;
    try {
      const buf = readFileSync(target);
      if (buf.includes(0)) return `Error: ${target} looks binary — edit_file is text-only.`;
      current = buf.toString('utf-8');
    } catch (err) {
      return `Error: cannot read ${target} (${err instanceof Error ? err.message : String(err)}).`;
    }
    const applied = applyEdit(current, oldText, newText);
    if (!applied.ok) return `Error: ${applied.error}`;
    try {
      writeFileSync(target, applied.updated, 'utf-8');
    } catch (err) {
      return `Error: cannot write ${target} (${err instanceof Error ? err.message : String(err)}).`;
    }
    return `Edited ${target}: replaced ${oldText.length} chars with ${newText.length} chars.`;
  },
};
