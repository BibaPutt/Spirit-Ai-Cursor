import { contextBridge, ipcRenderer } from 'electron';
import type {
  SpiritAPI,
  AutostartState,
  ClipboardContext,
  CursorPosition,
  LLMChunk,
  LLMDone,
  LLMError,
  LLMInterrupted,
  LLMReasoning,
  LearnedHint,
  LinkMeta,
  LocalModelInfo,
  PermissionsStatus,
  AnnotationStreamPayload,
  ProviderHealth,
  ProviderId,
  SaveResult,
  SelectionContext,
  AttachedFile,
  Settings,
  SuggestionChip,
  SkillInfo,
  ToolActivity,
  ToolApprovalRequest,
  LaunchableApp,
  WebImage,
} from './types';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: SpiritAPI = {
  onAIModeStart: (cb) => on<CursorPosition>('ai-mode:start', cb),
  onAIModeEnd: (cb) => on<void>('ai-mode:end', () => cb()),
  onCursorPosition: (cb) => on<CursorPosition>('cursor:position', cb),
  setCursorTrackingNeeded: (needed: boolean) => {
    ipcRenderer.send('cursor:tracking-needed', needed);
  },
  onLLMChunk: (cb) => on<LLMChunk>('llm:chunk', cb),
  onLLMDone: (cb) => on<LLMDone>('llm:done', cb),
  onLLMError: (cb) => on<LLMError>('llm:error', cb),
  onLLMInterrupted: (cb) => on<LLMInterrupted>('llm:interrupted', cb),
  onLLMFinal: (cb) => on<LLMChunk>('llm:final', cb),
  onLLMReasoning: (cb) => on<LLMReasoning>('llm:reasoning', cb),
  onAnnotationStream: (cb) => on<AnnotationStreamPayload>('annotations:stream', cb),

  queryLLM: (prompt: string) => ipcRenderer.invoke('llm:query', prompt),
  cancelAIMode: (opts?: { cancelStream?: boolean; keepOpen?: boolean }) =>
    ipcRenderer.invoke('ai-mode:cancel', opts),

  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,

  getPermissions: () => ipcRenderer.invoke('permissions:get') as Promise<PermissionsStatus>,
  openSystemSettings: (kind) => ipcRenderer.invoke('permissions:open', kind),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
  fetchLinkMeta: (url: string) => ipcRenderer.invoke('external:fetch-meta', url) as Promise<LinkMeta | null>,

  onSettingsOpen: (cb) => on<void>('settings:open', () => cb()),
  onClipboardContext: (cb) => on<ClipboardContext>('clipboard:context', cb),
  onSelectionContext: (cb) => on<SelectionContext>('selection:context', cb),
  attachFiles: (paths) => ipcRenderer.invoke('files:attach', paths) as Promise<AttachedFile[]>,
  onAttachedFiles: (cb) => on<AttachedFile[]>('files:attached', cb),
  dismissAttachedFiles: () => ipcRenderer.invoke('files:dismiss'),
  onAppContext: (cb) => on<string | null>('app:context', cb),
  onChipsResult: (cb) => on<SuggestionChip[]>('chips:result', cb),
  onChipsFallback: (cb) => on<SuggestionChip[]>('chips:fallback', cb),
  onChipsPending: (cb) => on<boolean>('chips:pending', cb),
  onNextChipsResult: (cb) => on<SuggestionChip[]>('chips:next', cb),
  onWebImagesResult: (cb) => on<WebImage[]>('images:result', cb),
  writeClipboard: (text: string) =>
    ipcRenderer.invoke('clipboard:write', text) as Promise<{ ok: boolean; error?: string }>,
  copyImageToClipboard: (dataUrl: string) =>
    ipcRenderer.invoke('clipboard:write-image', dataUrl) as Promise<{ ok: boolean; error?: string }>,
  copyRegionToClipboard: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('image:copy-region', rect) as Promise<{ ok: boolean; error?: string }>,
  dismissSelection: () => ipcRenderer.invoke('selection:dismiss'),
  insertText: (text: string) =>
    ipcRenderer.invoke('text:insert', text) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  onToolActivity: (cb) => on<ToolActivity>('llm:tool-activity', cb),
  onToolApprovalRequest: (cb) =>
    on<ToolApprovalRequest>('llm:tool-approval-request', cb),
  onToolApprovalCleared: (cb) => on<string>('llm:tool-approval-cleared', cb),
  respondToolApproval: (id: string, approved: boolean) =>
    ipcRenderer.send('llm:tool-approval-respond', id, approved),
  triggerAIMode: () => ipcRenderer.send('ai-mode:trigger'),
  reportRendererError: (message: string) =>
    ipcRenderer.send('renderer:error', String(message ?? '')),
  getAIModeState: () => ipcRenderer.invoke('ai-mode:sync'),
  transcribeAudio: (
      audioBase64: string,
      mimeType: string,
      options?: { prompt?: string; fast?: boolean; engine?: 'auto' | 'local' | 'cloud'; language?: string; voicePeak?: number },
    ) =>
      ipcRenderer.invoke('voice:transcribe', audioBase64, mimeType, options) as Promise<{
        text: string;
        language: string | null;
        quiet: boolean;
      }>,
  getSttStatus: () => ipcRenderer.invoke('voice:stt-status'),
  getSttModels: () =>
    ipcRenderer.invoke('voice:stt-models') as Promise<{
      models: Array<{ id: string; sizeMB: number; note: string; downloaded: boolean; partial: boolean; diskMB: number; active: boolean; recommended: boolean }>;
      recommendation: string;
      active: string;
    }>,
  switchSttModel: (id: string) =>
    ipcRenderer.invoke('voice:stt-switch-model', id) as Promise<{ ok: boolean; active: string }>,
  deleteSttModel: (id: string) =>
    ipcRenderer.invoke('voice:stt-delete-model', id) as Promise<{ ok: boolean; error?: string }>,
  warmStt: () => ipcRenderer.invoke('voice:stt-warm'),
  dismissClipboard: () => ipcRenderer.invoke('clipboard:dismiss'),

  queryLLMWithOptions: (prompt, options) =>
    ipcRenderer.invoke('llm:query-options', prompt, options),
  quit: () => ipcRenderer.send('app:quit'),
  openSettings: () => ipcRenderer.send('settings:request-open'),
  saveResponse: (payload) =>
    ipcRenderer.invoke('response:save', payload) as Promise<SaveResult>,
  pickWorkspaceFolder: () => ipcRenderer.invoke('workspace:pick') as Promise<string | null>,
  getAppVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadLatestSession: () => ipcRenderer.invoke('sessions:load-latest') as Promise<string | null>,
  revealSession: (path: string) => ipcRenderer.invoke('sessions:reveal', path),
  clearAllSessions: () => ipcRenderer.invoke('sessions:clear'),
  listMemories: () => ipcRenderer.invoke('memory:list'),
  deleteMemory: (id: string) => ipcRenderer.invoke('memory:delete', id) as Promise<boolean>,
  updateMemory: (id: string, text: string) =>
    ipcRenderer.invoke('memory:update', id, text) as Promise<boolean>,
  clearMemories: () => ipcRenderer.invoke('memory:clear') as Promise<boolean>,
  listSkills: () => ipcRenderer.invoke('skills:list') as Promise<SkillInfo[]>,
  setSkillEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('skills:setEnabled', id, enabled) as Promise<SkillInfo[]>,
  synthesizeSpeech: (text: string) => ipcRenderer.invoke('voice:synthesize', text) as Promise<
    | { audioBase64: string; mimeType: string; wordBoundaries: { text: string; offsetMs: number; durationMs: number }[] }
    | { error: string }
  >,

  setInteractive: (interactive: boolean) => {
    ipcRenderer.send('overlay:set-interactive', interactive);
  },

  setOverlayCaptureMode: (displayId: number, on: boolean) => {
    ipcRenderer.send('overlay:capture-mode', { displayId, on });
  },
  forwardClick: (x, y, displayId, opts) => {
    ipcRenderer.send('input:forward-click', { x, y, displayId, button: opts?.button });
  },
  forwardScroll: (delta, displayId) => {
    ipcRenderer.send('input:forward-scroll', { delta, displayId });
  },

  sendBoxBounds: (bounds) => ipcRenderer.send('box:bounds', bounds),
  setOverlaySettingsMode: (open: boolean) => ipcRenderer.send('overlay:settings-mode', open),

  captureSelection: (rect, displayId) =>
    ipcRenderer.invoke('selection:capture', { rect, displayId }) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  onSelectionDone: (cb) =>
    on<{ ok: true } | { ok: false; error: string }>('selection:done', cb),
  onSelectionArm: (cb) => on<boolean>('selection:arm', cb),

  // Paint-to-select: OCR a region the user dragged while the box was open.
  capturePaint: (rect, displayId) =>
    ipcRenderer.invoke('paint:capture', { rect, displayId }) as Promise<
      { ok: boolean; id: string; text: string; error?: string }
    >,
  removePaint: (id: string) => ipcRenderer.send('paint:remove', id),

  onExternalTyping: (cb) =>
    on<{ kind: 'key' | 'click' }>('user:external-typing', (payload) => cb(payload.kind)),

  onForwardedClickEaten: (cb) => on<number>('capture:forwarded-click-eaten', cb),

  testProviderKey: (provider, apiKey) =>
    ipcRenderer.invoke('provider:test-key', { provider, apiKey }) as Promise<
      { ok: true; label?: string } | { ok: false; error: string }
    >,

  detectLocalModels: (baseUrl, apiKey) =>
    ipcRenderer.invoke('provider:detect-local-models', { baseUrl, apiKey }) as Promise<
      { ok: true; models: LocalModelInfo[]; contextLength?: number } | { ok: false; error: string }
    >,

  testLocalAi: (baseUrl, apiKey) =>
    ipcRenderer.invoke('provider:test-local-ai', { baseUrl, apiKey }) as Promise<
      { ok: true; label?: string; contextLength?: number } | { ok: false; error: string }
    >,

  // Vision bridge: read/write the text-only-model screen-reading
  // config. The API key never leaves main unencrypted beyond this call.
  getVisionBridge: () =>
    ipcRenderer.invoke('vision-bridge:get') as Promise<
      { useBridge: boolean; url: string; model: string; hasKey: boolean }
    >,
  setVisionBridge: (payload: {
    useBridge: boolean;
    url: string;
    model: string;
    key?: string;
    clearKey?: boolean;
  }) => ipcRenderer.invoke('vision-bridge:set', payload) as Promise<boolean>,

  // Local `opencode serve` connection test and live model list.
  // Stateless: pass the current base URL (unsaved edits work without saving).
  testOpencode: (baseUrl) =>
    ipcRenderer.invoke('opencode:test', { baseUrl }) as Promise<
      { ok: true; label?: string } | { ok: false; error: string }
    >,

  detectOpencodeModels: (baseUrl) =>
    ipcRenderer.invoke('opencode:detect-models', { baseUrl }) as Promise<
      { ok: true; models: LocalModelInfo[] } | { ok: false; error: string }
    >,

  hasProviderKey: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:has-key', provider) as Promise<boolean>,
  hasAnyConfiguredProvider: () =>
    ipcRenderer.invoke('provider:has-any-configured') as Promise<boolean>,
  revealProviderKey: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:reveal-key', provider) as Promise<string>,
  revealChipsProviderKey: (provider: ProviderId) =>
    ipcRenderer.invoke('chips:reveal-key', provider) as Promise<string>,
  getProvidersHealth: () =>
    ipcRenderer.invoke('providers:health') as Promise<ProviderHealth[]>,
  onProvidersHealthChanged: (cb) => on<void>('providers:health-changed', () => cb()),
  onLearnedHint: (cb) => on<LearnedHint>('learned:hint', cb),

  autostartGet: () => ipcRenderer.invoke('autostart:get') as Promise<AutostartState>,
  autostartSet: (state: AutostartState) =>
    ipcRenderer.invoke('autostart:set', state) as Promise<AutostartState>,
  clearActiveSession: () => ipcRenderer.invoke('session:clear') as Promise<void>,

  launchApp: (appId: string) =>
    ipcRenderer.invoke('apps:launch', appId) as Promise<{ ok: true } | { ok: false; error: string }>,
  listLaunchableApps: () =>
    ipcRenderer.invoke('apps:list') as Promise<LaunchableApp[]>,

  platform: process.platform,
};

contextBridge.exposeInMainWorld('spirit', api);
