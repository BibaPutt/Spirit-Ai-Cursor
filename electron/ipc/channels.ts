export const CHANNELS = {
  AIModeStart: 'ai-mode:start',
  AIModeEnd: 'ai-mode:end',
  AIModeCancel: 'ai-mode:cancel',
  CursorPosition: 'cursor:position',
  // Renderer demand signal for cursor tracking. Payload: boolean — the sender
  // needs the cursor position for its own UI (AI mode, Settings/Memory modal).
  // Main keeps the tracking loop running while ANY overlay needs it and stops
  // it entirely when the last one drops, so a fully idle Spirit runs no poll.
  CursorTrackingNeeded: 'cursor:tracking-needed',
  LLMQuery: 'llm:query',
  LLMChunk: 'llm:chunk',
  LLMDone: 'llm:done',
  LLMError: 'llm:error',
  // A run that failed AFTER streaming text. Payload: LLMInterrupted — the
  // renderer keeps the partial answer and offers Continue/Retry.
  LLMInterrupted: 'llm:interrupted',
  // Authoritative final answer — REPLACES the streamed response in the UI.
  LLMFinal: 'llm:final',
  // Live chain-of-thought: main broadcasts reasoning_content deltas as a
  // reasoning-capable model thinks. Payload: LLMReasoning { delta }.
  LLMReasoning: 'llm:reasoning',
  // Annotation protocol (Phase 7): main broadcasts newly-completed
  // [POINT]/[BOX]/[ARROW] tags mapped to display-LOCAL coordinates as the
  // answer streams — the renderer draws the persistent overlay and animates a
  // fly-to. Payload: { annotations: ScreenAnnotation[] }; an empty array
  // clears the overlay and active tour.
  AnnotationStream: 'annotations:stream',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  SettingsOpen: 'settings:open',
  PermissionsGet: 'permissions:get',
  PermissionsOpen: 'permissions:open',
  OverlaySetInteractive: 'overlay:set-interactive',
  ExternalOpen: 'external:open',
  ClipboardContext: 'clipboard:context',
  ClipboardDismiss: 'clipboard:dismiss',
  // Explicit user tap on a generated-UI "copy" control (never automatic).
  ClipboardWrite: 'clipboard:write',
  // Mermaid diagram "Copy as PNG": renderer hands main a PNG data URL and main
  // puts it on the system clipboard as an image. Explicit user tap only.
  ClipboardWriteImage: 'clipboard:write-image',
  // [DIAGRAM] widget "Copy as PNG": renderer hands main the element's viewport
  // rect and main rasterizes the live pixels via webContents.capturePage (the
  // faithful paint — no DOM clone / style inlining). Explicit user tap only.
  // Payload: { x, y, width, height } in DIP.
  CopyRegionToClipboard: 'image:copy-region',
  SelectionContext: 'selection:context',
  SelectionDismiss: 'selection:dismiss',
  // Dropped-file attach: renderer posts absolute paths, main reads them
  // (text inline, images as vision blocks) and broadcasts AttachedFile[]
  // summaries for the chip row. Payload: string[] in, AttachedFile[] out.
  FilesAttach: 'files:attach',
  FilesAttached: 'files:attached',
  FilesDismiss: 'files:dismiss',
  // The app the user was in at trigger/submit time, captured on demand
  // (no background polling). Payload is a short preview string for the
  // renderer chip, or null when nothing could be read.
  AppContext: 'app:context',
  InsertText: 'text:insert',
  FetchLinkMeta: 'external:fetch-meta',
  LLMQueryOptions: 'llm:query-options',
  Quit: 'app:quit',
  OpenSettings: 'settings:request-open',
  SaveResponse: 'response:save',
  PickWorkspaceFolder: 'workspace:pick',
  AppVersion: 'app:version',
  ToolActivity: 'llm:tool-activity',
  ToolApprovalRequest: 'llm:tool-approval-request',
  ToolApprovalCleared: 'llm:tool-approval-cleared',
  ToolApprovalRespond: 'llm:tool-approval-respond',
  // Renderer crash/hang reports for the session log. Main-side logs never
  // show these — a blank box with zero log lines was undebuggable.
  RendererError: 'renderer:error',
  TriggerAIMode: 'ai-mode:trigger',
  // Renderer pulls current AI mode state on mount to catch missed push events.
  AIModeSync: 'ai-mode:sync',
  TranscribeAudio: 'voice:transcribe',
  // Phase 7: arm the local STT sidecar (spawn + model load) before the mic is
  // recording so the first live chunk hits a warm model. Returns SttStatus.
  SttWarm: 'voice:stt-warm',
  // Live local-STT model download/install status, polled by the renderer
  // while a transcription is in flight. Lets the capsule show
  // "STT setup 46%" on the first (model-downloading) use.
  SttStatus: 'voice:stt-status',
  // Speech-model manager (Settings → Voice): list with download state +
  // spec recommendation, switch (downloads if needed), 1-click delete.
  SttModels: 'voice:stt-models',
  SttSwitchModel: 'voice:stt-switch-model',
  SttDeleteModel: 'voice:stt-delete-model',
  ListSessions: 'sessions:list',
  LoadLatestSession: 'sessions:load-latest',
  RevealSession: 'sessions:reveal',
  ClearSessions: 'sessions:clear',
  SessionClear: 'session:clear',
  // /memory manager: list the long-term context-memory store and mutate it by
  // id. All explicit user taps in the overlay — never automatic.
  MemoryList: 'memory:list',
  MemoryDelete: 'memory:delete',
  MemoryUpdate: 'memory:update',
  MemoryClear: 'memory:clear',
  // Skills (Phase 5): read the bundled skill catalog with enabled state
  // (skills:list) and toggle one skill (skills:setEnabled, `(id, enabled)`).
  // Both return SkillInfo[] so the renderer re-syncs in one round-trip.
  SkillsList: 'skills:list',
  SkillsSetEnabled: 'skills:setEnabled',
  SynthesizeSpeech: 'voice:synthesize',
  BoxBounds: 'box:bounds',
  OverlaySettingsMode: 'overlay:settings-mode',
  SelectionCapture: 'selection:capture',
  SelectionDone: 'selection:done',
  SelectionArm: 'selection:arm',
  TestProviderKey: 'provider:test-key',
  // Probe a local OpenAI-compatible server's /v1/models endpoint.
  // Payload: { baseUrl, apiKey }. Doubles as the Local AI connection test.
  DetectLocalModels: 'provider:detect-local-models',
  // Lightweight Local AI connection test (reachability + context
  // window via /props). Payload: { baseUrl, apiKey }.
  TestLocalAi: 'provider:test-local-ai',
  // Read the vision bridge's current state (useBridge flag, URL,
  // model, whether a key is stored). Payload/none; returns
  // { useBridge, url, model, hasKey }.
  GetVisionBridge: 'vision-bridge:get',
  // Set the vision bridge (plain fields + optional encrypted key).
  // Payload: { useBridge, url, model, key? }. A non-empty key is encrypted and
  // stored; an empty key leaves the stored key untouched; passing
  // clearKey: true removes it.
  SetVisionBridge: 'vision-bridge:set',
  // Probe a local `opencode serve` instance for its live model list
  // via /config/providers. Payload: { baseUrl }.
  DetectOpencodeModels: 'opencode:detect-models',
  // Lightweight opencode server connection test (/global/health).
  // Payload: { baseUrl }.
  TestOpencode: 'opencode:test',
  RevealProviderKey: 'provider:reveal-key',
  // Chips-only provider map key reveal (the separate provider configured
  // just for "Suggest actions" chip generation).
  RevealChipsProviderKey: 'chips:reveal-key',
  HasProviderKey: 'provider:has-key',
  // Authoritative "is any enabled provider actually configured" from
  // the main process. Used by the renderer's status signal so we don't
  // rely on the renderer's potentially-stale providers state.
  HasAnyConfiguredProvider: 'provider:has-any-configured',
  ProvidersHealth: 'providers:health',
  ProvidersHealthChanged: 'providers:health-changed',
  // Self-knowledge hint (Hermes-style memory notice): main broadcasts when
  // the agent learns something durable — profile fact filled, memories saved,
  // app lesson recorded. Payload: { text }. Renderer shows a toast (gated by
  // the notifications setting). Fire-and-forget, never blocks the turn.
  LearnedHint: 'learned:hint',
  AutostartGet: 'autostart:get',
  AutostartSet: 'autostart:set',
  LaunchApp: 'apps:launch',
  ListLaunchableApps: 'apps:list',
  // Main process broadcasts when the user engages outside our
  // box. Payload: { kind: 'key' | 'click' } — 'key' is a printable
  // non-trigger keystroke captured by uIOhook, 'click' is an outside
  // mousedown. The renderer counts signals toward prompt-box
  // auto-dismiss; 'key' signals are additionally suppressed when our own
  // input has DOM+OS focus (user typing into us).
  ExternalTyping: 'user:external-typing',
  // Custom-cursor "capture mode": while AI mode is active the overlay owns
  // the mouse full-time (so `cursor: none` hides the OS arrow) and the
  // renderer forwards outside clicks/scrolls to the app underneath. Main
  // uses this flag to skip its own uiohook outside-click dismissal (the DOM
  // handles it once the overlay is interactive) and to avoid looping on the
  // synthetic events it posts while forwarding.
  OverlayCaptureMode: 'overlay:capture-mode',
  ForwardClick: 'input:forward-click',
  ForwardScroll: 'input:forward-scroll',
  // Capture mode: main caught a physical outside click that the overlay's DOM
  // missed because it landed inside the temporary click-through window while
  // a click-forward was being synthesized. Payload: the number of eaten
  // clicks to add to the renderer's double-click-to-dismiss counter.
  ForwardedClickEaten: 'capture:forwarded-click-eaten',
  // Paint-to-select: OCR a region the user dragged while the box is open.
  // The renderer invokes `paint:capture` with a display-local rect; main
  // captures it, runs tesseract, stores the text, and returns it. `paint:remove`
  // drops one selection (bubble X) so it leaves the prompt context.
  PaintCapture: 'paint:capture',
  PaintRemove: 'paint:remove',
  // Action suggestion chips, broadcast to every overlay
  // when main finishes (or cancels) generating them. Payload: SuggestionChip[].
  ChipsResult: 'chips:result',
  // Offline premade chips shown while a generation round is in flight. Unlike
  // ChipsResult this does NOT clear the pending underline — the sweep stays
  // until the real AI chips land. Payload: SuggestionChip[].
  ChipsFallback: 'chips:fallback',
  // Chips generation lifecycle signal: true while a generation round is in
  // flight (drives the accent underline sweep under the box), false when it
  // lands, is cancelled, or fails. Payload: boolean.
  ChipsPending: 'chips:pending',
  // Post-response "next actions" chips: after a query completes, main asks the
  // SAME provider for up to 3 follow-up actions and broadcasts them here.
  // Payload: SuggestionChip[].
  NextChipsResult: 'chips:next',
  // Post-response web images: main strips the [IMAGE] subject lines the
  // answering model wrote at the top of its answer, searches the real backends
  // for each subject, and broadcasts the pictures here.
  // Payload: WebImage[].
  WebImagesResult: 'images:result',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
