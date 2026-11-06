// Friendly status labels for the chain progress header.
// Pure module (no React) so it is unit-testable. Keys are tool names from
// electron/llm/tools plus the synthetic "thinking"/"reasoning" states.
export const CHAIN_LABELS: Record<string, string> = {
  see_screen: 'Looking at your screen',
  ui_read: 'Reading the screen',
  describe_region: 'Reading a screen region',
  focus_window: 'Focusing window',
  type_text: 'Typing…',
  click: 'Clicking…',
  double_click: 'Double-clicking…',
  ui_click: 'Clicking…',
  move_mouse: 'Moving the mouse…',
  press_key: 'Pressing a key…',
  scroll: 'Scrolling…',
  drag: 'Dragging…',
  wait: 'Waiting…',
  open_url: 'Opening a page…',
  fetch_url: 'Reading a page…',
  web_search: 'Searching the web…',
  search_web: 'Searching the web…',
  launch_app: 'Opening an app…',
  list_apps: 'Listing apps…',
  list_processes: 'Listing processes…',
  run_command: 'Running a command…',
  system_action: 'Running a system action…',
  create_file: 'Creating a file…',
  open_file: 'Opening a file…',
  read_file: 'Reading a file…',
  edit_file: 'Editing a file…',
  list_dir: 'Listing files…',
  compress_file: 'Compressing files…',
  save_document: 'Saving…',
  reveal_in_finder: 'Opening the workspace…',
  read_clipboard: 'Reading the clipboard…',
  copy_to_clipboard: 'Copying…',
  read_table: 'Reading a table…',
  paste_table: 'Pasting a table…',
  paste_image: 'Pasting an image…',
  get_cursor_position: 'Finding the cursor…',
  play_music: 'Playing music…',
  set_volume: 'Setting volume…',
  laya_decide: 'Deciding…',
  task: 'Working on a subtask…',
  question: 'Asking a question…',
  thinking: 'Thinking…',
  reasoning: 'Thinking…',
};

function argText(args: unknown, keys: string[]): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const o = args as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 40);
  }
  return '';
}

// Map a tool/step kind to its friendly label, enriching with the target
// app/window when the args carry one. Falls back to the main-process label
// (already friendly) and finally a prettified tool name. Never empty.
export function chainLabelFor(name: string, args?: unknown, fallbackLabel?: string): string {
  const key = String(name ?? '').trim().toLowerCase();
  if (key === 'focus_window') {
    const target = argText(args, ['app', 'window', 'title']);
    return target ? `Focusing ${target}` : (CHAIN_LABELS.focus_window ?? 'Focusing window');
  }
  if (key === 'type_text') {
    const target = argText(args, ['app', 'window', 'title']);
    return target ? `Typing into ${target}` : (CHAIN_LABELS.type_text ?? 'Typing…');
  }
  if (key in CHAIN_LABELS) return CHAIN_LABELS[key];
  const fb = String(fallbackLabel ?? '').trim();
  if (fb) return fb.length > 60 ? fb.slice(0, 60) : fb;
  if (!key) return CHAIN_LABELS.thinking ?? 'Thinking…';
  return key
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export type ChainActivityLike = {
  name: string;
  args?: unknown;
  label?: string;
  status?: string;
};

// Current activity for the header: the running step, else the latest step,
// else null (caller falls back to Thinking/reasoning).
export function currentChainLabel(activities: ChainActivityLike[]): string | null {
  if (!activities || activities.length === 0) return null;
  const running = [...activities].reverse().find((a) => a.status === 'running');
  const row = running ?? activities[activities.length - 1];
  return chainLabelFor(row.name, row.args, row.label);
}
