import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const fn = vi.fn(() => ({}));
  const display = {
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
  };
  return {
    app: {
      isPackaged: false,
      getName: () => 'Spirit',
      getVersion: () => 'test',
      getPath: () => join(tmpdir(), 'spirit-test'),
      whenReady: () => Promise.resolve(),
      on: fn,
      quit: fn,
    },
    BrowserWindow: class {},
    dialog: { showOpenDialog: fn, showSaveDialog: fn, showMessageBox: fn },
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
    shell: { openExternal: fn, openPath: fn, showItemInFolder: fn },
    nativeImage: { createFromPath: fn, createFromBuffer: fn, createEmpty: fn },
    clipboard: {
      readText: () => '',
      writeText: fn,
      writeHTML: fn,
      readHTML: () => '',
      readRTF: () => '',
      write: fn,
      readImage: () => ({ isEmpty: () => true }),
    },
    contextBridge: { exposeInMainWorld: fn },
    ipcRenderer: { on: fn, invoke: fn, send: fn, removeListener: fn },
    ipcMain: { handle: fn, on: fn },
    desktopCapturer: { getSources: vi.fn(() => Promise.resolve([])) },
    Menu: { buildFromTemplate: () => ({ popup: fn }), setApplicationMenu: fn },
    Tray: class {},
    net: { request: fn },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: fn, decryptString: fn },
    systemPreferences: { getAccentColor: fn },
    globalShortcut: { register: () => true, unregister: fn, unregisterAll: fn },
  };
});

// Minimal stand-in for the real scene module (which walks UIA + OCR via
// PowerShell — never run in unit tests). goalTokens / goalScoreFor mirror the
// real implementations so the honesty-gate math under test matches production.
vi.mock('../electron/capture/scene', () => {
  const GOAL_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'you', 'your', 'please', 'could', 'would',
    'should', 'click', 'press', 'tap', 'open', 'find', 'look', 'get', 'grab',
    'make', 'set', 'put', 'take', 'want', 'need', 'can', 'this', 'that',
    'there', 'here', 'button', 'link', 'tab', 'page', 'now', 'just', 'then',
    'also', 'have', 'has', 'from', 'into', 'after', 'before', 'about', 'what',
    'when', 'where', 'which', 'some', 'any', 'one', 'two', 'very', 'will',
    'going', 'downloads', 'internet', 'browser',
  ]);
  const goalTokens = (goal: string): string[] => {
    const words = goal
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
    return [...new Set(words)].filter((w) => !GOAL_STOPWORDS.has(w));
  };
  const goalScoreFor = (name: string, tokens: string[]): number => {
    const n = name.toLowerCase();
    let score = 0;
    for (const t of tokens) if (n.includes(t)) score++;
    return score;
  };
  return {
    goalTokens,
    goalScoreFor,
    buildScene: vi.fn(),
    buildClickTargetsMenu: vi.fn(),
    formatScene: () => '',
    resolveElementById: () => undefined,
  };
});

vi.mock('../electron/llm/tools', () => ({
  TOOLS: {},
  describeToolForUI: () => '',
  getToolDeclarations: () => [],
  getTool: () => undefined,
  executeTool: vi.fn(),
}));

// Registry is mocked so direct goal routing ("open spotify") never shells out
// to real `Get-StartApps` during unit tests.
vi.mock('../electron/apps/registry', () => ({
  discoverApps: vi.fn(async () => []),
  searchApps: vi.fn(() => []),
}));

vi.mock('../electron/llm/tools/approval', () => ({
  getApprovalRequiredTools: () => new Set(['ui_click', 'paste_table', 'paste_image', 'drag']),
  isApprovalRequired: () => true,
}));

vi.mock('../electron/input/focus', () => ({
  captureForeground: vi.fn(async () => null),
  restoreForeground: vi.fn(async () => {}),
}));

vi.mock('../electron/capture/app-context', () => ({
  refreshAgentTargetHwnd: vi.fn(async () => {}),
}));

vi.mock('../electron/llm/web-ground', () => ({
  searchWebGround: vi.fn(async () => ''),
}));

import type {
  AgentContext,
  ProviderClient,
  ProviderRoundResult,
  RequestRequirements,
  StreamHandlers,
} from '../electron/llm/providers/types';
import { runAgenticLoopWithProvider, runAgentParts } from '../electron/llm/providers/router';
import { executeTool } from '../electron/llm/tools';
import { searchWebGround } from '../electron/llm/web-ground';
import { buildClickTargetsMenu, buildScene } from '../electron/capture/scene';
import { refreshAgentTargetHwnd } from '../electron/capture/app-context';
import { discoverApps, searchApps } from '../electron/apps/registry';

const req: RequestRequirements = { web: false, vision: false, allowTools: true, tier: 'fast' };

function makeCtx(goal: string): AgentContext {
  return {
    latestAssistantText: '',
    originalPrompt: goal,
    sessionGoal: goal,
    abort: new AbortController().signal,
    requireToolApproval: async () => true,
  };
}

function makeHandlers(): StreamHandlers {
  return {
    onChunk: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onDone: () => {},
    onError: () => {},
    onFinalAnswer: vi.fn(),
  };
}

function fakeProvider(rounds: ProviderRoundResult[]): ProviderClient {
  let i = 0;
  return {
    id: 'localai',
    displayName: 'Fake',
    pickModel: () => 'fake-model',
    supports: () => true,
    runRound: vi.fn(async () => {
      const r = rounds[Math.min(i, rounds.length - 1)];
      i++;
      return r;
    }),
  };
}

const downloadNow = {
  id: 'el82',
  type: 'text',
  name: 'Download Now',
  bounds: [0, 0, 100, 20] as [number, number, number, number],
  center: [933, 533] as [number, number],
  enabled: true,
  clickable: false,
  source: 'ocr' as const,
};

const sceneWith = (elements: unknown[]) => ({
  windowTitle: 'Arc',
  elements,
  monitor: { width: 1920, height: 1080 },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('honesty gate — never claim a click goal is done without acting', () => {
  it('marks the run failed with an honest fallback when no action happened', async () => {
    // No matching element on screen, model claims success in plain text.
    vi.mocked(buildScene).mockResolvedValue(sceneWith([]) as never);
    vi.mocked(buildClickTargetsMenu).mockReturnValue([]);
    const provider = fakeProvider([
      { contentText: 'Done! The file has been downloaded.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('click download now'), () => {},
    );
    expect(result.status).toBe('failed');
    expect(result.answer).toContain('could not complete');
  });

  it('clicks the goal target directly and answers truthfully', async () => {
    vi.mocked(buildScene).mockResolvedValue(sceneWith([downloadNow]) as never);
    vi.mocked(buildClickTargetsMenu).mockReturnValue([downloadNow]);
    vi.mocked(executeTool).mockResolvedValue('Clicked el82 (text "Download Now") at (933, 533).');
    const provider = fakeProvider([
      { contentText: 'Done!', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('click download now'), () => {},
    );
    expect(result.status).toBe('done');
    expect(executeTool).toHaveBeenCalledWith('ui_click', { id: 'el82' }, expect.anything());
    // The router clicked the goal target itself and then pushed a verification
    // instruction so the model confirms the result instead of the router
    // fabricating "Done — I clicked the …" text.
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(2);
    const verify = lastUserText(messagesForRound(provider, 1));
    expect(verify).toContain('see_screen() or ui_read()');
    expect(result.answer).toBe('Done!');
  });

  it('does not force a click for a question-shaped goal', async () => {
    vi.mocked(buildScene).mockResolvedValue(sceneWith([]) as never);
    const provider = fakeProvider([
      { contentText: 'The gear icon in the top-right corner opens Settings.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('how do I open the settings'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toContain('gear icon');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('keeps a text answer when the CURRENT prompt is a question even if the session goal carries an action verb', async () => {
    // Regression for the real-world log: turn 1 set a session goal with an
    // action verb ("create a table ..."), turn 2 is a question ("what laptops
    // does msi sell"). The merged goal ("create a table ... what laptops ...")
    // still contains "create", so the OLD gate fired, tried to click a goal
    // element, found none, and REPLACED the model's real answer with a click
    // failure. The gate must judge the current prompt, not the merged text.
    vi.mocked(buildScene).mockResolvedValue(sceneWith([]) as never);
    vi.mocked(searchApps).mockReturnValue([]);
    const ctx = makeCtx('create a table of MSI laptops');
    ctx.originalPrompt = 'what laptops does msi sell';
    const provider = fakeProvider([
      {
        contentText: 'MSI sells the Katana, Raider, and Vector gaming laptops.',
        toolCalls: [],
        finishReason: null,
      },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), ctx, () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toBe('MSI sells the Katana, Raider, and Vector gaming laptops.');
    expect(executeTool).not.toHaveBeenCalled();
    expect(discoverApps).not.toHaveBeenCalled();
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(1);
  });
});

describe('successful actions satisfy the gate', () => {
  it('accepts the model answer when a ui_click actually succeeded', async () => {
    vi.mocked(executeTool).mockResolvedValue('Clicked el2 (text "Download Now") at (933, 533).');
    const provider = fakeProvider([
      {
        contentText: 'Clicking the download button.',
        toolCalls: [{ id: 'c1', name: 'ui_click', args: { id: 'el2' } }],
        finishReason: null,
      },
      { contentText: 'The file is downloading now.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('click download now'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toContain('downloading now');
    expect(executeTool).toHaveBeenCalledWith('ui_click', { id: 'el2' }, expect.anything());
  });

  it('redirects a failed model ui_click to the goal target', async () => {
    vi.mocked(buildScene).mockResolvedValue(sceneWith([downloadNow]) as never);
    vi.mocked(buildClickTargetsMenu).mockReturnValue([downloadNow]);
    vi.mocked(executeTool)
      .mockResolvedValueOnce('Error: no element found for id "el0".')
      .mockResolvedValueOnce('Clicked el82 (text "Download Now") at (933, 533).');
    const provider = fakeProvider([
      {
        contentText: 'Clicking now.',
        toolCalls: [{ id: 'c1', name: 'ui_click', args: { id: 'el0' } }],
        finishReason: null,
      },
      { contentText: 'The download started.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('click download now'), () => {},
    );
    expect(result.status).toBe('done');
    expect(executeTool).toHaveBeenCalledWith('ui_click', { id: 'el82' }, expect.anything());
  });
});

describe('runAgentParts — split multi-step goals', () => {
  it('runs each part as its own loop and joins the parts\' real output (no fabricated checklist)', async () => {
    vi.mocked(executeTool).mockResolvedValue('Launched excel.');
    const provider = fakeProvider([
      // part 1: launch_app + final text
      {
        contentText: 'Opening excel.',
        toolCalls: [{ id: 'c1', name: 'launch_app', args: { app: 'excel' } }],
        finishReason: null,
      },
      { contentText: 'Excel is open.', toolCalls: [], finishReason: null },
      // part 2: a REAL paste action + its final text (a bare "Table pasted."
      // claim would trip the honesty gate — and rightly so)
      {
        contentText: 'Pasting the table.',
        toolCalls: [{ id: 'c2', name: 'paste_table', args: {} }],
        finishReason: null,
      },
      { contentText: 'Table pasted.', toolCalls: [], finishReason: null },
    ]);
    const handlers = makeHandlers();
    const result = await runAgentParts(
      provider, '', [], req, [], new AbortController().signal,
      handlers, makeCtx('1. open excel 2. paste a table'), () => {},
    );
    expect(result.status).toBe('done');
    // The final answer is the parts' own real output — never a fabricated
    // "1. Done — …" / "N of M tasks done" checklist.
    expect(result.answer).toContain('Excel is open.');
    expect(result.answer).toContain('Table pasted.');
    expect(result.answer).not.toContain('Done —');
    expect(result.answer).not.toContain('tasks done');
    expect(handlers.onFinalAnswer).toHaveBeenCalledWith(result.answer);
  });
});

type FlatMsg = { role: string; content: unknown };

// The last user-role message the router pushed into the message array for a
// given provider round — this is where the conditional post-action instruction
// lands, so it is the observable surface for the screen-was-changed behavior.
function lastUserText(msgs: FlatMsg[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return (m.content as Array<{ type: string; text?: string }>)
          .map((p) => (p.type === 'text' ? p.text ?? '' : ''))
          .join('');
      }
    }
  }
  return '';
}

// The last tool-role message the router pushed into the message array for a
// given provider round — where the web_search budget penalty lands.
function lastToolText(msgs: FlatMsg[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'tool' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function messagesForRound(provider: ProviderClient, roundIndex: number): FlatMsg[] {
  const calls = vi.mocked(provider.runRound).mock.calls;
  const msgs = calls[roundIndex]?.[1];
  return (msgs as FlatMsg[]) ?? [];
}

describe('ui_read cache invalidation after screen-changing actions', () => {
  it('re-walks the scene after a successful ui_click instead of replaying the cache', async () => {
    vi.mocked(executeTool)
      .mockResolvedValueOnce('1. "Download Now" button (el1)\n2. "Close" button (el2)')
      .mockResolvedValueOnce('Clicked el2 (text "Download Now") at (933, 533).')
      .mockResolvedValueOnce('1. "Download Now" button (el3)\n2. "Cancel" button (el4)');
    const provider = fakeProvider([
      {
        contentText: 'Reading then clicking.',
        toolCalls: [
          { id: 'c1', name: 'ui_read', args: {} },
          { id: 'c2', name: 'ui_click', args: { id: 'el2' } },
        ],
        finishReason: null,
      },
      {
        contentText: 'Verifying the new state.',
        toolCalls: [{ id: 'c3', name: 'ui_read', args: {} }],
        finishReason: null,
      },
      { contentText: 'Done.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('click download now'), () => {},
    );
    expect(result.status).toBe('done');
    // ui_read executed TWICE: the successful ui_click invalidated the first
    // result, so the second call re-walked the tree. Without invalidation it
    // would have been short-circuited by the "screen unchanged" cache path.
    const uiReadCalls = vi.mocked(executeTool).mock.calls.filter(([name]) => name === 'ui_read');
    expect(uiReadCalls).toHaveLength(2);
    expect(vi.mocked(refreshAgentTargetHwnd)).not.toHaveBeenCalled();
  });

  it('injects the screen-changed instruction after a click', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce('Clicked el2 (text "Download Now") at (933, 533).');
    const provider = fakeProvider([
      {
        contentText: 'Clicking.',
        toolCalls: [{ id: 'c1', name: 'ui_click', args: { id: 'el2' } }],
        finishReason: null,
      },
      { contentText: 'The download started.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('click download now'), () => {},
    );
    expect(result.status).toBe('done');
    const round2 = lastUserText(messagesForRound(provider, 1));
    expect(round2).toContain('A screen-changing action ran');
    expect(round2).not.toContain('The numbered element list above is the CURRENT screen.');
  });

  it('keeps the current-screen instruction when a round only reads', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce('1. "Download Now" button (el1)\n2. "Close" button (el2)');
    const provider = fakeProvider([
      {
        contentText: 'Reading the screen.',
        toolCalls: [{ id: 'c1', name: 'ui_read', args: {} }],
        finishReason: null,
      },
      { contentText: 'I can see the download button.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('what is on screen'), () => {},
    );
    expect(result.status).toBe('done');
    const round2 = lastUserText(messagesForRound(provider, 1));
    expect(round2).toContain('The numbered element list above is the CURRENT screen.');
    expect(round2).not.toContain('A screen-changing action ran');
  });

  it('refreshes the agent action target after launch_app succeeds', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce('Launched excel.');
    const provider = fakeProvider([
      {
        contentText: 'Launching.',
        toolCalls: [{ id: 'c1', name: 'launch_app', args: { app: 'excel' } }],
        finishReason: null,
      },
      { contentText: 'Excel is open.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('open excel'), () => {},
    );
    expect(result.status).toBe('done');
    // The launched app became the new foreground — the router must point the
    // next see_screen/ui_read/ui_click at it instead of the trigger-time one.
    expect(vi.mocked(refreshAgentTargetHwnd)).toHaveBeenCalled();
    expect(lastUserText(messagesForRound(provider, 1))).toContain('A screen-changing action ran');
  });
});

describe('[IMAGE] nudge when the user asked for pictures', () => {
  it('pushes ONE rewrite round when the final answer has no [IMAGE] lines', async () => {
    const provider = fakeProvider([
      { contentText: 'Cows are large mammals.', toolCalls: [], finishReason: null },
      { contentText: '[IMAGE] a Holstein cow grazing\n\nCows are large mammals.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('show me pictures of a cow'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toContain('[IMAGE] a Holstein cow grazing');
    const nudge = lastUserText(messagesForRound(provider, 1));
    expect(nudge).toContain('no [IMAGE] lines');
    expect(nudge).toContain('[IMAGE] cow');
    // The nudge ran only once — the rewritten answer was accepted.
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(2);
  });

  it('does not nudge when the user never asked for pictures', async () => {
    const provider = fakeProvider([
      { contentText: 'Cows are large mammals.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('tell me about cows'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toBe('Cows are large mammals.');
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(1);
  });

  it('does not nudge when the answer already has [IMAGE] lines', async () => {
    const provider = fakeProvider([
      { contentText: '[IMAGE] a cow\n\nCows are large mammals.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('show me pictures of a cow'), () => {},
    );
    expect(result.status).toBe('done');
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(1);
  });
});

describe('announced-but-unexecuted web search is grounded', () => {
  beforeEach(() => {
    vi.mocked(searchWebGround).mockResolvedValue(
      '[GROUNDED_SEARCH query="msi laptops"]\n1. MSI Laptops — https://msi.com\n   Gaming laptops with RTX GPUs.',
    );
  });

  it('completes the announced search and forces a grounded answer', async () => {
    const provider = fakeProvider([
      {
        contentText:
          'To find information about MSI laptops, I need to perform a web search, as the current terminal window is showing build logs.',
        toolCalls: [],
        finishReason: null,
      },
      {
        contentText:
          'MSI (Micro-Star International) makes gaming laptops with RTX GPUs, such as the Katana and Raider series.\n[NEXT_ACTIONS]\n[{"label":"Compare MSI series","icon":"list"}]\n[/NEXT_ACTIONS]',
        toolCalls: [],
        finishReason: null,
      },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('msi laptops'), () => {},
    );
    expect(result.status).toBe('done');
    // The narration was NOT finalized — the grounded round's real answer is.
    expect(result.answer).toContain('Katana');
    expect(result.answer).not.toContain('I need to perform a web search');
    expect(searchWebGround).toHaveBeenCalledTimes(1);
    const groundedMsg = lastUserText(messagesForRound(provider, 1));
    expect(groundedMsg).toContain('[GROUNDED_SEARCH query="msi laptops"]');
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(2);
  });

  it('grounds a "Since you asked for X, I will search the web" final', async () => {
    const provider = fakeProvider([
      {
        contentText: 'Since you asked for msi laptops, I will search the web to provide current info.',
        toolCalls: [],
        finishReason: null,
      },
      { contentText: 'MSI makes the Katana and Raider gaming laptops.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('msi laptops'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toContain('Katana');
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(2);
  });

  it('does not ground a direct answer, and does not ground twice', async () => {
    const provider = fakeProvider([
      { contentText: 'MSI is a Taiwanese laptop maker.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('what is msi'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toBe('MSI is a Taiwanese laptop maker.');
    expect(searchWebGround).not.toHaveBeenCalled();
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(1);
  });
});

describe('info-lookup loop guard — repeated re-searching is capped and forced to answer', () => {
  it('runs up to 10 web_searches, escalating a penalty from the 6th, and takes the real answer', async () => {
    vi.mocked(executeTool).mockResolvedValue(
      '[GROUNDED_SEARCH query="msi"]\n1. MSI Katana — https://msi.com\n   Gaming laptop.',
    );
    const provider = fakeProvider([
      { contentText: '', toolCalls: [{ id: 'c1', name: 'web_search', args: { query: 'latest MSI laptops' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c2', name: 'web_search', args: { query: 'latest MSI laptops comparison' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c3', name: 'web_search', args: { query: 'latest MSI laptops 2026' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c4', name: 'web_search', args: { query: 'latest MSI laptops comparison table' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c5', name: 'web_search', args: { query: 'latest MSI laptops specs' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c6', name: 'web_search', args: { query: 'latest MSI laptops prices' } }], finishReason: null },
      { contentText: 'The latest MSI laptops are the Katana and Raider series.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('latest MSI laptops comparison table'), () => {},
    );
    expect(result.status).toBe('done');
    // Searches 1..6 all ran — web_search's budget is 10, not the shared info
    // cap. The 6th (first past the free quota of 5) carries the penalty.
    const searches = vi.mocked(executeTool).mock.calls.filter(([name]) => name === 'web_search');
    expect(searches).toHaveLength(6);
    expect(lastToolText(messagesForRound(provider, 5))).toContain('Penalty (search 6/10)');
    expect(result.answer).toBe('The latest MSI laptops are the Katana and Raider series.');
  });

  it('strips a forced-final "call: web_search(...)" text (space variant) from the answer', async () => {
    vi.mocked(executeTool).mockResolvedValue(
      '[GROUNDED_SEARCH query="msi"]\n1. MSI Katana — https://msi.com\n   Gaming laptop.',
    );
    const provider = fakeProvider([
      { contentText: 'Searching.', toolCalls: [{ id: 'c1', name: 'web_search', args: { query: 'msi laptops' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c2', name: 'web_search', args: { query: 'msi laptops' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c3', name: 'web_search', args: { query: 'msi laptops' } }], finishReason: null },
      { contentText: 'call: web_search(query="latest MSI laptops comparison 2026")', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('latest MSI laptops comparison table'), () => {},
    );
    expect(result.answer).not.toContain('call: web_search');
    expect(result.answer).not.toContain('web_search(');
  });

  it('re-calls the model once when the "final" is vacuous intent-talk despite fetched results', async () => {
    vi.mocked(executeTool).mockResolvedValue(
      '[GROUNDED_SEARCH query="msi"]\n1. MSI Katana — https://msi.com\n   Gaming laptop.',
    );
    const provider = fakeProvider([
      // Real search succeeds and puts results in the conversation.
      { contentText: '', toolCalls: [{ id: 'c1', name: 'web_search', args: { query: 'latest msi laptops' } }], finishReason: null },
      // Model "final" is just a promise to search — must NOT be accepted.
      { contentText: 'I will search the web for the latest MSI laptops.', toolCalls: [], finishReason: null },
      // After the nudge the model writes the real answer from the results.
      { contentText: 'The latest MSI laptops are the Katana and Raider series.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('latest MSI laptops comparison table'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toBe('The latest MSI laptops are the Katana and Raider series.');
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(3);
  });

  it('strips a brace-variant text tool call (call:websearch{...}) from the answer', async () => {
    vi.mocked(executeTool).mockResolvedValue(
      '[GROUNDED_SEARCH query="msi"]\n1. MSI Katana — https://msi.com\n   Gaming laptop.',
    );
    const provider = fakeProvider([
      { contentText: '', toolCalls: [{ id: 'c1', name: 'web_search', args: { query: 'msi laptops' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c2', name: 'web_search', args: { query: 'msi laptops' } }], finishReason: null },
      { contentText: '', toolCalls: [{ id: 'c3', name: 'web_search', args: { query: 'msi laptops' } }], finishReason: null },
      { contentText: 'call:websearch{questry:msi latets laptops}', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('latest MSI laptops comparison table'), () => {},
    );
    expect(result.answer).not.toContain('call:websearch');
    expect(result.answer).not.toContain('websearch{');
  });
});

describe('direct goal routing — the router performs the matching tool when the model claims done without acting', () => {
  const spotify = { name: 'Spotify', kind: 'name' as const, ref: 'C:\\Users\\purpo\\AppData\\Roaming\\Spotify\\Spotify.exe' };

  it('launches an app by its real registry name when the goal is "open X"', async () => {
    vi.mocked(searchApps).mockReturnValue([spotify]);
    vi.mocked(executeTool).mockResolvedValue('Opened Spotify.');
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('open spotify'), () => {},
    );
    expect(result.status).toBe('done');
    expect(executeTool).toHaveBeenCalledWith('launch_app', { app: 'Spotify' }, expect.anything());
    expect(vi.mocked(refreshAgentTargetHwnd)).toHaveBeenCalled();
  });

  it('does not launch a made-up app — the name must resolve in the registry', async () => {
    vi.mocked(searchApps).mockReturnValue([]);
    const provider = fakeProvider([
      { contentText: 'Opened the super app.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('open the super app'), () => {},
    );
    // The honesty gate refuses the model's fabricated "Opened the super app."
    // — the app is not in the registry and nothing on screen matches, so the
    // run ends honestly failed instead of lying.
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.answer).toContain('could not');
  });

  it('opens a URL directly for an "open <url>" goal', async () => {
    vi.mocked(executeTool).mockResolvedValue('Opened https://example.com.');
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('open https://example.com'), () => {},
    );
    expect(result.status).toBe('done');
    expect(executeTool).toHaveBeenCalledWith('open_url', { url: 'https://example.com' }, expect.anything());
  });

  it('routes an email goal to system_action email with the real address', async () => {
    vi.mocked(executeTool).mockResolvedValue('Opened email to sarah@acme.com.');
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('email sarah@acme.com about the Q3 report'), () => {},
    );
    expect(result.status).toBe('done');
    expect(executeTool).toHaveBeenCalledWith(
      'system_action',
      expect.objectContaining({ kind: 'email', recipient: 'sarah@acme.com' }),
      expect.anything(),
    );
  });

  it('routes a calendar goal to system_action calendar_event with a clean title', async () => {
    vi.mocked(executeTool).mockResolvedValue('Opened calendar.');
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('add dinner to my calendar tomorrow'), () => {},
    );
    expect(result.status).toBe('done');
    expect(executeTool).toHaveBeenCalledWith(
      'system_action',
      expect.objectContaining({ kind: 'calendar_event', title: 'dinner' }),
      expect.anything(),
    );
  });

  it('a declined direct action is never retried and the run ends honestly', async () => {
    vi.mocked(searchApps).mockReturnValue([spotify]);
    const ctx = makeCtx('open spotify');
    ctx.requireToolApproval = async () => false;
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
      { contentText: 'I could not open Spotify — the action was declined.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), ctx, () => {},
    );
    expect(result.status).toBe('done');
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.answer).toContain('could not');
    const declineNote = lastUserText(messagesForRound(provider, 1));
    expect(declineNote).toContain('declined');
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(2);
  });

  it('does not direct-route an ordinary question', async () => {
    const provider = fakeProvider([
      { contentText: 'Cows are large mammals.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('tell me about cows'), () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toBe('Cows are large mammals.');
    expect(executeTool).not.toHaveBeenCalled();
    expect(discoverApps).not.toHaveBeenCalled();
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(1);
  });
});

describe('repeat-guarded intents — same intent once, different title still runs', () => {
  it('dedups a repeated calendar_event with the same title but runs a different one', async () => {
    vi.mocked(executeTool).mockResolvedValue('Opened calendar.');
    const provider = fakeProvider([
      {
        contentText: '',
        toolCalls: [{ id: 'c1', name: 'system_action', args: { kind: 'calendar_event', title: 'Dinner', start: '2026-08-17T19:00' } }],
        finishReason: null,
      },
      {
        contentText: '',
        toolCalls: [{ id: 'c2', name: 'system_action', args: { kind: 'calendar_event', title: 'Dinner', start: '2026-08-17T20:00' } }],
        finishReason: null,
      },
      {
        contentText: '',
        toolCalls: [{ id: 'c3', name: 'system_action', args: { kind: 'calendar_event', title: 'Lunch', start: '2026-08-18T12:00' } }],
        finishReason: null,
      },
      { contentText: 'Added the events.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), makeCtx('add dinner to my calendar'), () => {},
    );
    expect(result.status).toBe('done');
    const calls = vi.mocked(executeTool).mock.calls.filter(([name]) => name === 'system_action');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({ kind: 'calendar_event', title: 'Dinner' });
    expect(calls[1][1]).toMatchObject({ kind: 'calendar_event', title: 'Lunch' });
  });
});

describe('direct-route actions are recorded in the tool-loop dedup maps', () => {
  const spotify = { name: 'Spotify', kind: 'name' as const, ref: 'C:\\Users\\purpo\\AppData\\Roaming\\Spotify\\Spotify.exe' };

  it('replays a direct-route success when the model re-emits the identical call (no double approval)', async () => {
    vi.mocked(searchApps).mockReturnValue([spotify]);
    vi.mocked(executeTool).mockResolvedValue('Opened Spotify.');
    const ctx = makeCtx('open spotify');
    const approval = vi.fn(async () => true);
    ctx.requireToolApproval = approval;
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
      // The weak model, told to verify, re-emits the exact same launch_app call.
      {
        contentText: '',
        toolCalls: [{ id: 'c1', name: 'launch_app', args: { app: 'Spotify' } }],
        finishReason: null,
      },
      { contentText: 'Spotify is open.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), ctx, () => {},
    );
    expect(result.status).toBe('done');
    // The direct route executed launch_app ONCE; the model's re-emission was
    // replayed from `done` instead of prompting a second approval.
    const launchCalls = vi.mocked(executeTool).mock.calls.filter(([name]) => name === 'launch_app');
    expect(launchCalls).toHaveLength(1);
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it('does not re-approve a direct-route action that failed; the repeat is give-up-skipped', async () => {
    vi.mocked(searchApps).mockReturnValue([spotify]);
    vi.mocked(executeTool).mockResolvedValue('Error: Spotify is not installed.');
    const ctx = makeCtx('open spotify');
    const approval = vi.fn(async () => true);
    ctx.requireToolApproval = approval;
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
      // Model repeats the launch that just failed.
      {
        contentText: '',
        toolCalls: [{ id: 'c1', name: 'launch_app', args: { app: 'Spotify' } }],
        finishReason: null,
      },
      { contentText: 'Could not open Spotify.', toolCalls: [], finishReason: null },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), ctx, () => {},
    );
    // Exactly one execute + one approval total: the direct route ran once, the
    // model's repeat was skipped (failedAttempts), never re-approved.
    const launchCalls = vi.mocked(executeTool).mock.calls.filter(([name]) => name === 'launch_app');
    expect(launchCalls).toHaveLength(1);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.answer).toContain('could not complete');
  });

  it('ends with the decline message, not "Download Now", when a declined tool is re-emitted', async () => {
    vi.mocked(searchApps).mockReturnValue([spotify]);
    const ctx = makeCtx('open spotify');
    ctx.requireToolApproval = async () => false;
    const provider = fakeProvider([
      { contentText: 'Done.', toolCalls: [], finishReason: null },
      // Uncooperative model: re-emits the declined tool with no text at all.
      {
        contentText: '',
        toolCalls: [{ id: 'c1', name: 'launch_app', args: { app: 'Spotify' } }],
        finishReason: null,
      },
    ]);
    const result = await runAgenticLoopWithProvider(
      provider, '', [], req, [], new AbortController().signal,
      makeHandlers(), ctx, () => {},
    );
    expect(result.status).toBe('done');
    expect(result.answer).toContain('declined');
    expect(result.answer).not.toContain('Download Now');
    expect(executeTool).not.toHaveBeenCalled();
    expect(vi.mocked(provider.runRound)).toHaveBeenCalledTimes(2);
  });
});
