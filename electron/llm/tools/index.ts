// Tool registry for OpenRouter function calling.
// Each tool has a JSON-schema declaration sent to the LLM, plus an executor
// that runs on the main process and returns a string result (which gets fed
// back into the agentic loop as a tool message).

import { fetchUrlTool } from './fetch-url';
import { noteAIActivity } from '../providers/round-retry';
import { openUrlTool } from './open-url';
import { copyClipboardTool } from './copy-clipboard';
import { saveDocumentTool } from './save-document';
import { revealInFinderTool } from './reveal-finder';
import { readClipboardTool } from './read-clipboard';
import { launchAppTool } from './launch-app';
import { playMusicTool } from './play-music';
import { searchWebTool } from './search-web';
import { setVolumeTool } from './set-volume';
import { typeTextTool } from './type-text';
import { pressKeyTool } from './press-key';
import { clickTool, doubleClickTool, moveMouseTool, scrollTool } from './mouse';
import { waitTool } from './wait';
import { seeScreenTool } from './see-screen';
import { describeRegionTool } from './describe-region';
import { uiReadTool } from './ui-read';
import { uiClickTool } from './ui-click';
import { readTableTool } from './read-table';
import { pasteTableTool } from './paste-table';
import { pasteImageTool } from './paste-image';
import { dragTool } from './drag';
import { getCursorPositionTool } from './get-cursor-position';
import { webSearchTool } from './web-search';
import { listAppsTool } from './list-apps';
import { listProcessesTool } from './list-processes';
import { layaDecideTool } from './laya-decide';
import { systemActionTool } from './system-action';
import { runCommandTool } from './run-command';
import { focusWindowTool } from './focus-window';
import { createFileTool } from './create-file';
import { openFileTool } from './open-file';
import { readFileTool } from './read-file';
import { editFileTool } from './edit-file';
import { listDirTool } from './list-dir';
import { compressFileTool } from './compress-file';
import { taskTool } from './task';
import { questionTool } from './question';

export type ToolDeclaration = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export type ToolExecutionContext = {
  // The latest streamed response text so far. Useful for tools like
  // save_document that want to operate on the in-flight answer.
  latestAssistantText: string;
  originalPrompt: string;
  // Original session request (first user message), so tools keep targeting
  // the user's real goal even on follow-up turns like "ok" / "yes".
  sessionGoal?: string;
  abort: AbortSignal;
  // Run a fenced sub-agent loop for one goal and return its final answer.
  // Set by the router when nested runs are available (depth-capped);
  // absent in unit tests and direct tool calls — always null-check.
  runSubtask?: (goal: string) => Promise<string>;
};

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<string>;

export type ToolDefinition = {
  declaration: ToolDeclaration;
  execute: ToolExecutor;
  // Short verb shown in the activity UI: "Fetching", "Opening", "Saving" ...
  uiLabel: (args: Record<string, unknown>) => string;
};

export const TOOLS: Record<string, ToolDefinition> = {
  fetch_url: fetchUrlTool,
  open_url: openUrlTool,
  copy_to_clipboard: copyClipboardTool,
  save_document: saveDocumentTool,
  reveal_in_finder: revealInFinderTool,
  read_clipboard: readClipboardTool,
  launch_app: launchAppTool,
  play_music: playMusicTool,
  search_web: searchWebTool,
  set_volume: setVolumeTool,
  type_text: typeTextTool,
  press_key: pressKeyTool,
  click: clickTool,
  double_click: doubleClickTool,
  move_mouse: moveMouseTool,
  scroll: scrollTool,
  wait: waitTool,
  see_screen: seeScreenTool,
  describe_region: describeRegionTool,
  ui_read: uiReadTool,
  ui_click: uiClickTool,
  read_table: readTableTool,
  paste_table: pasteTableTool,
  paste_image: pasteImageTool,
  drag: dragTool,
  get_cursor_position: getCursorPositionTool,
  web_search: webSearchTool,
  list_apps: listAppsTool,
  list_processes: listProcessesTool,
  laya_decide: layaDecideTool,
  system_action: systemActionTool,
  run_command: runCommandTool,
  focus_window: focusWindowTool,
  create_file: createFileTool,
  open_file: openFileTool,
  read_file: readFileTool,
  edit_file: editFileTool,
  list_dir: listDirTool,
  compress_file: compressFileTool,
  task: taskTool,
  question: questionTool,
};

export function getEnabledTools(): Record<string, ToolDefinition> {
  return TOOLS;
}

export function getToolDeclarations(): ToolDeclaration[] {
  return Object.values(TOOLS).map((t) => t.declaration);
}

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS[name];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) {
    return `Error: unknown tool "${name}".`;
  }
  try {
    noteAIActivity();
    return await tool.execute(args, ctx);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function describeToolForUI(
  name: string,
  args: Record<string, unknown>,
): string {
  const tool = TOOLS[name];
  if (!tool) return `Calling ${name}…`;
  return tool.uiLabel(args);
}
