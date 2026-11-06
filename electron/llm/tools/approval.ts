// Tools split into safe (auto-execute) and approval-required (need user
// confirmation). Safe tools only read data. Approval-required tools take
// actions on the user's machine (open URL, write clipboard, reveal in
// finder). save_document writes into the user's own Spirit workspace folder
// with an auto-generated name and opens the file — deliberately approval-free
// so long writes never stall on a popup (the file is reversible/self-adjacent
// to the saved answer).

const APPROVAL_REQUIRED = new Set<string>([
  'open_url',
  'copy_to_clipboard',
  'reveal_in_finder',
  'launch_app',
  // Music + web search both open external URLs in the user's browser.
  // Volume changes are low-risk and intentionally auto-approve.
  'play_music',
  'search_web',
  // Desktop input synthesis — typing, shortcuts and clicks take real
  // actions in the user's apps. Respects the Auto-approve actions toggle.
  'type_text',
  'press_key',
  'click',
  'double_click',
  'move_mouse',
  'scroll',
  // Clicking an element by number takes a real action in the user's apps —
  // same risk profile as `click`, so it needs the same approval.
  'ui_click',
  // Bringing a window to the foreground redirects where typing/clicking lands
  // — a focus change, same risk profile as move_mouse/click.
  'focus_window',
  // Pasting a table / image types into the user's document, and dragging
  // moves things — all real actions in the user's apps.
  'paste_table',
  'paste_image',
  'drag',
  // Deep-link intents (calendar/email/maps) open external apps pre-filled,
  // and run_command executes a command on the machine — both are real
  // actions, so they need the same green-button approval.
  'system_action',
  'run_command',
  // Writing a real file (create_file) and opening one (open_file) both touch
  // the user's machine the same way open_url/reveal_in_finder do.
  'create_file',
  'open_file',
  // Precise in-place edits can clobber user content — same gate as create.
  // (read_file, list_dir and compress_file stay approval-free: reads and
  // new-file outputs are reversible like save_document.)
  'edit_file',
  // A fenced sub-agent loop can act through its own tools (each still gated
  // individually) — the delegation itself needs a yes. The question tool only
  // shapes text — always safe.
  'task',
]);

export function getApprovalRequiredTools(): Set<string> {
  return APPROVAL_REQUIRED;
}

export function isApprovalRequired(toolName: string): boolean {
  return APPROVAL_REQUIRED.has(toolName);
}

// Small plain scrolls are never declined: low-risk, reversible view motion.
export const SMALL_SCROLL_DELTA_MAX = 5;

export function isSmallPlainScroll(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName !== 'scroll') return false;
  const keys = Object.keys(args ?? {});
  if (!keys.every((k) => k === 'delta')) return false;
  const d = Number((args as Record<string, unknown>).delta);
  return Number.isFinite(d) && d !== 0 && Math.abs(d) <= SMALL_SCROLL_DELTA_MAX;
}

// Tools destructive enough to always demand an explicit YES even inside a
// hybrid run-grant — historically run_command/system_action. Currently the
// run grant covers a whole task after one YES (see handlers.ts
// requestToolApproval); this set is kept for callers that want the stricter
// reading, and the DANGEROUS_RE blocklist in run-command.ts is the wall that
// never moves regardless of grants.
const HIGH_IMPACT = new Set<string>([
  'run_command',
  'system_action',
]);

export function isHighImpactTool(toolName: string): boolean {
  return HIGH_IMPACT.has(toolName);
}
