export type AIModeState = 'idle' | 'triggering' | 'active_input' | 'active_loading' | 'active_response';

export type TemplateId =
  | 'summary'
  | 'brief'
  | 'translate'
  | 'explain'
  | 'code'
  | 'improve'
  | 'define'
  | 'solve'
  | 'reply'
  | 'identify';

export type CursorPosition = {
  x: number;
  y: number;
  displayId: number;
  // Standard OS cursor under the pointer (e.g. 'text', 'link', 'horz'). Main
  // probes it while the overlay hides the OS arrow; the renderer's
  // SpiritCursor picks the matching Bibata shape.
  shape: string;
  // When the pointer sits on a classic (non-client) scrollbar, the orientation
  // that scrollbar belongs to — 'vert' / 'horz', else null. Lets the renderer
  // suppress the custom cursor over vertical scrollbars (their own arrows are
  // enough) while keeping it over horizontal ones.
  scrollbar?: 'vert' | 'horz' | null;
  // Main-clock timestamp of the broadcast. Lets the renderer tell a parked
  // cursor (fresh heartbeat) from dead tracking (stale) — stale pos must
  // never hold fullscreen capture on a display the pointer already left.
  t: number;
};

// Live [UI]/[QUESTIONS]/[MERMAID]/[DIAGRAM] block placeholder state sent with
// streaming chunks. While the model is emitting a block (or right after one
// closed but the final answer hasn't replaced the stream yet), the renderer
// shows a small titled tile instead of the raw payload. null/undefined = no
// block to show.
export type UiLiveBlock =
  | { kind: 'ui' | 'questions' | 'mermaid' | 'diagram'; title: string }
  // Partial OpenUI Lang source; the real OpenUI Renderer draws it live.
  | { kind: 'openui'; title: string; code: string };

export type LLMChunk = {
  // Run that produced this chunk. Lets the renderer drop chunks from a
  // superseded run instead of mixing them into the fresh answer.
  runId: string;
  // The streamed text with in-progress block JSON masked out (renderer
  // REPLACES its live text with this on every chunk — it is not a delta).
  text: string;
  uiLive?: UiLiveBlock | null;
};

// A single screen annotation in LOCAL overlay coordinates (the target overlay
// window's workArea origin — i.e. absolute screen DIP minus the overlay's
// display origin). Coordinates arrive source-mapped on the main side: [POINT]
// pixel tags go through mapPointToScreen, [BOX] pixel tags through
// mapBoxToScreen, [BOX:el#] tags resolve to the exact scene-element frame, and
// [ARROW] endpoints through mapArrowToScreen. `seq` is the stable per-run
// story order number the renderer shows on chips ("1 · Save button").
export type ScreenAnnotation =
  | { kind: 'point'; x: number; y: number; label: string; seq: number }
  | { kind: 'box'; x: number; y: number; w: number; h: number; label: string; seq: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; label: string; seq: number };

// Annotation protocol stream (Phase 7). Main broadcasts newly-completed
// [POINT]/[BOX]/[ARROW] tags as the answering model streams them, mapped into
// display-local coordinates. An empty `annotations` array clears the overlay
// and any active fly-to tour (sent on submit, final answer and error).
export type AnnotationStreamPayload = {
  annotations: ScreenAnnotation[];
};

// Authoritative final answer from the router, sent at the end of a run to
// REPLACE whatever text streamed via LLMChunk (which may include model
// tool-call junk that was cleaned out). Same payload shape as LLMChunk. When
// the answering model emitted [UI] / [QUESTIONS] / [MERMAID] blocks, `ui`
// carries the inline segments — the renderer interleaves them at their exact
// positions instead of showing a flat markdown blob.
export type LLMFinal = LLMChunk & {
  ui?: UiSegment[];
  // Authoritative annotation set of this run (display-local) for per-turn
  // replay. Absent when the run drew nothing.
  annotations?: ScreenAnnotation[];
};

export type LLMError = {
  runId: string;
  message: string;
  code?: string;
};

// A run that failed AFTER producing text. Unlike LLMError the partial answer
// is kept on screen (and in history) so the user can Continue or Retry instead
// of losing a long response to a transient upstream fault.
export type LLMInterrupted = {
  runId: string;
  message: string;
  code?: string;
  // Cleaned partial answer committed to the session (annotation tags and
  // in-progress UI blocks already stripped).
  text: string;
};

// Live chain-of-thought delta from a reasoning-capable model, broadcast while
// it thinks (before the answer streams). The renderer appends deltas.
export type LLMReasoning = {
  runId: string;
  delta: string;
};

// Terminal event for one run. Carries the run id so the renderer can tell
// its own run's end from a trailing done of the run it just superseded.
export type LLMDone = {
  runId: string;
};

// One committed Q+A turn, built renderer-side when a run completes. The box
// renders the whole conversation, not just the latest answer.
export type LLMCompletion = {
  runId: string;
  prompt: string;
  wasWeb: boolean;
  response: string;
  uiSegments: UiSegment[];
  // Snapshot of this run's web images + annotations so past turns replay
  // their full media, not just text.
  images?: WebImage[];
  annotations?: ScreenAnnotation[];
};

// Self-knowledge hint payload (Hermes-style memory notice) — short human
// line about what the agent just learned ("Noted your name"). Renderer
// toasts it.
export type LearnedHint = {
  text: string;
  kind?: 'memory' | 'profile' | 'lesson';
};

export type ToolActivity =
  | {
      kind: 'start';
      id: string;
      name: string;
      label: string;
      args: unknown;
    }
  | {
      kind: 'end';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
    };

export type ToolApprovalRequest = {
  id: string;
  name: string;
  label: string;
  args: Record<string, unknown>;
};

export type ProviderId = 'openrouter' | 'anthropic' | 'openai' | 'gemini' | 'localai' | 'opencode';

// Speech-to-text engine for voice input. 'local' uses the bundled
// faster-whisper sidecar (offline, multilingual); 'cloud' uses the
// configured Gemini/OpenAI/OpenRouter provider; 'auto' (default) tries
// the local sidecar first and falls back to cloud when it is missing,
// not installed, or still loading its model.
export type STTEngine = 'auto' | 'local' | 'cloud';

// When the one-tap "suggest actions" chips may appear. 'both' (default):
// always, matching the old boolean-on. 'voice': only while the mic capsule is
// the box's focus. 'type': only while the user is typing. 'off': never —
// also skips chip generation entirely.
export type ChipVisibility = 'both' | 'voice' | 'type' | 'off';
export type ChipsSource = 'smart' | 'premade' | 'custom';

// A model reported by a local OpenAI-compatible server's `/v1/models`
// endpoint. `vision`/`tools`/`web` are populated when the server publishes
// capability metadata for the model (e.g. llama.cpp's `capabilities.vision`);
// otherwise they stay undefined so the UI falls back to manual toggles.
export type LocalModelInfo = {
  id: string;
  vision?: boolean;
  tools?: boolean;
  web?: boolean;
};

// Renderer-visible diagnostic for a provider's stored key. `brokenDecrypt`
// is true when an encrypted key exists on disk but cannot be decrypted —
// the Windows DPAPI failure mode that strands returning users with no
// working provider. Surfaced via a banner so the user has an
// actionable next step instead of a silent "no provider configured" state.
export type ProviderHealth = {
  provider: ProviderId;
  hasKey: boolean;
  enabled: boolean;
  brokenDecrypt: boolean;
  reason:
    | 'none'
    | 'keychain-unavailable'
    | 'keychain-denied'
    | 'corrupt-ciphertext';
};

export type UserProfile = {
  name: string;
  role: string;
  preferredLanguage: string;
  // User's target language for the "Translate to" chips (Settings → Profile).
  // Empty means the translate chip falls back to the generic prompt.
  translateLanguage: string;
};

export type ProviderSettings = {
  // The renderer-facing IPC returns empty string here to avoid
  // triggering a keychain prompt at settings-load time. Use `hasKey` for
  // "is a key configured" checks and the RevealProviderKey IPC for an
  // explicit user-visible reveal.
  apiKey: string;
  enabled: boolean;
  hasKey?: boolean;
  // Local AI provider only (OpenAI-compatible servers: LM Studio, llama.cpp,
  // Ollama /v1, Jan, vLLM, ...). `apiKey` is optional for local servers.
  // The server's base URL, e.g. "http://localhost:1234/v1".
  baseUrl?: string;
  // The model Spirit uses. Chosen from `availableModels` or typed manually.
  model?: string;
  // Models auto-detected from `GET {baseUrl}/v1/models`, with per-model
  // capability metadata when the server provides it.
  availableModels?: LocalModelInfo[];
  // Capability toggles. Auto-set from the selected model's metadata when
  // detected, otherwise manual. `supports()` in the localai provider reads
  // these to gate vision/tools/web.
  vision?: boolean;
  tools?: boolean;
  web?: boolean;
  // Server-side context window in tokens (llama.cpp's n_ctx, detected via
  // GET {baseUrl}/props). When present the localai provider truncates the
  // message history to fit so llama.cpp doesn't reject long sessions with
  // "request exceeds the available context size". Manual override welcome.
  contextLength?: number;
  // Vision bridge (backend): lets TEXT-ONLY local models "see" via a separate
  // vision-capable endpoint. Stores are plain config fields; the bridge's API
  // key lives encrypted in providersSecure.visionBridge (getVisionBridgeKey /
  // setVisionBridgeKey in settings.ts) — never in this plaintext map.
  useVisionBridge?: boolean;
  visionBridgeUrl?: string;
  visionBridgeModel?: string;
};

export type TriggerHotkey =
  | 'MetaRight'
  | 'CtrlRight'
  | 'AltRight'
  | 'ShiftRight'
  | 'MetaLeft'
  | 'CtrlLeft'
  | 'AltLeft'
  | 'ShiftLeft'
  | 'MetaEither'
  | 'CtrlEither';

export type Settings = {
  // legacy: keep openrouterApiKey writable for old config files
  openrouterApiKey: string;
  primaryModel: string;
  fallbackModel: string;
  webSearch: boolean;
  workspaceFolder: string;
  providers: Record<ProviderId, ProviderSettings>;
  autoApproveTools: boolean;
  memorySaveEnabled: boolean;
  // Long-term context memory (mem0-style). When on, Spirit extracts durable
  // facts (preferences, projects, personal details, key takeaways) from each
  // turn using its own configured AI, stores them in the workspace, and
  // injects the most relevant ones into later prompts. Off by default.
  contextMemoryEnabled: boolean;
  maxContextTokens: number;
  // Auto context (default on): budget follows the serving model's window.
  autoContext: boolean;
  // Annotation final pass (default off): re-decide + re-broadcast boxes
  // after the answer lands. Off = live boxes only.
  annotFinalPass: boolean;
  voiceLanguage: string;
  // Speech-to-text engine: 'auto' | 'local' | 'cloud'. See STTEngine.
  sttEngine: STTEngine;
  // Local STT model id (Settings → Voice list). Empty = built-in default.
  sttModel: string;
  // One-line voice context (Whisper initial_prompt). Empty = off.
  sttInitialPrompt: string;
  // Personal word fixes, one "a -> b" per line. Empty = off.
  sttWordOverrides: string;
  triggerHotkey: TriggerHotkey;
  userProfile: UserProfile;
  // When false (the default), the user profile is never injected into the
  // system prompt and is never sent to the chosen provider. The settings UI
  // shows a toggle so users can opt in explicitly. EU defaults ship off.
  personalizePrompts: boolean;
  dismissOnDoubleClick: boolean;
  // Voice-first mode. When on, triggering Spirit auto-starts the
  // microphone, the transcript auto-submits, and the response gets read
  // back via TTS so the user can run a hands-free conversation loop. Off
  // by default — voice is still available manually via the mic icon.
  audioMode: boolean;

  // User-controlled theme preference. 'system' (default) follows
  // prefers-color-scheme; 'light' / 'dark' force the UI regardless of
  // the OS setting. Some users want to keep macOS in light mode for
  // every other app but use Spirit dark (or vice versa); the
  // previous implementation hard-coupled the two with no override.
  themePreference: 'system' | 'light' | 'dark';

  // Trigger Spirit by wiggling the mouse left-right-left within ~700ms.
  // Default on. Disable in Settings → Behaviour.
  mouseWiggleEnabled: boolean;

  // Wiggle sensitivity (Settings → Behaviour). `high` is the original tuning
  // (small shake fires it — easy to trigger); `low` needs a big deliberate
  // shake. Default `high` preserves existing behavior.
  wiggleSensitivity: 'low' | 'normal' | 'high';

  // Action suggestions. `chipVisibility` controls when one-
  // tap action chips appear: 'both' (default) shows them whenever the box is
  // open, 'voice' only while the mic capsule is active, 'type' only while
  // typing, 'off' never (also skips generation). Chips are generated TEXT-ONLY
  // from the OCR'd region + any on-screen selection + the foreground app/tab —
  // never includes the screenshot.
  chipVisibility: ChipVisibility;

  // Where suggestion chips come from. 'smart' (default): AI-generated from
  // screen context via the chips provider chain. 'premade': the built-in
  // offline set, no provider call. 'custom': the user's own list below.
  chipsSource: ChipsSource;
  // User-defined chips used when chipsSource is 'custom'. Label shows on the
  // pill, prompt is the hidden instruction sent on tap. Max 6, shown first 3.
  customChips: Array<{ label: string; prompt: string; icon?: string }>;
  // Which provider produces the "Suggest actions" chips. True (the default):
  // the same provider chain as normal queries. False: a SEPARATE provider set
  // (`chipsProviders`) is used ONLY for chip generation, so the cheap
  // text-only chip call can point at a different key/model than the main
  // queries without touching the main provider config.
  chipsUseMainProvider: boolean;
  // The chips-only provider map. Ignored unless `chipsUseMainProvider` is
  // false. Same shape and key encryption as the main `providers` map.
  chipsProviders: Record<ProviderId, ProviderSettings>;

  // Performance / accessibility escape hatch for glassmorphism. When true,
  // the overlay falls back to a solid background instead of backdrop-blur.
  // Detected automatically from macOS "Reduce transparency" pref.
  // DEPRECATED: kept for migration — use glassMode/glassIntensity instead.
  // `reducedTransparency: true` migrates to `glassMode: 'clear'`.
  reducedTransparency: boolean;

  // Glass look (Hermes-style translucency). `glassMode: 'glass'` keeps text
  // crisp and thins only the panel surfaces over the native blur material;
  // 'clear' fades the whole window including text (cheaper, legacy feel).
  glassMode: 'clear' | 'glass';
  // Tint kept on the surface, 0-100 (Hermes default 29). In clear mode this
  // drives window opacity instead of tint.
  glassIntensity: number;
  // Extra whole-window fade in glass mode, 0-100 (default 0 = opaque).
  glassFade: number;
  // Native blur material. macOS vibrancy names; Windows maps them to
  // acrylic/tabbed/mica. Linux has no material → glass row hidden.
  glassMaterial: 'under-window' | 'popover' | 'titlebar' | 'header';
  // 'sidebar' = glass rail only, opaque content (Finder shape, default).
  // 'window' = whole panel glass.
  glassScope: 'window' | 'sidebar';

  // Default screenshot crop dimensions around the cursor. Reduced from
  // 1024x768 to cut vision-token cost by ~75%. Users who want
  // a wider crop can still drag a rectangle.
  screenshotCropW: number;
  screenshotCropH: number;

  // Manual calibration nudge (screen DIP pixels) applied to GUESSED
  // annotation coordinates (raw img->screen mapped points/boxes/arrows).
  // Never applied to element-snapped/box-el frames (those are real bounds).
  // Positive X = right, positive Y = down. Default 0; users dial this in
  // when the model's pixel guesses consistently land off target.
  annotOffsetX: number;
  annotOffsetY: number;

  // Which calendar service `system_action` opens for "add to my calendar":
  // 'google' (Google Calendar template) or 'outlook' (Outlook.com compose).
  calendarProvider: 'google' | 'outlook';

  // Show subtle notifications for tool actions (completion, errors).
  notificationsEnabled: boolean;

  // Delete all memory when Spirit closes.
  clearMemoryOnQuit: boolean;

  // Ghost mode (stealth). When on, every Spirit window is excluded from
  // screen capture on Windows/macOS and the tray icon is hidden. Linux has
  // no equivalent capture-exclusion API; tray/taskbar hiding still applies.
  ghostMode: boolean;
  // Sub-toggle: hide Spirit from the taskbar (Windows/Linux) and Dock
  // (macOS). Only meaningful while ghostMode is on.
  ghostHideTaskbar: boolean;

  // User-defined keyboard shortcuts. Keys are action names, values are
  // Electron accelerator strings (e.g. "CommandOrControl+Shift+S").
  customShortcuts: Record<string, string>;

  // Per-tool permission rules (allow skips the card, deny blocks outright).
  // Absent key = default approval flow. Managed programmatically for now.
  permissionRules: Record<string, 'allow' | 'deny'>;
};

export type SessionSummary = {
  id: string;
  startedAt: number;
  endedAt: number;
  firstPrompt: string;
  turnCount: number;
  // Paths are stored relative to the workspace folder so the renderer never
  // sees the user's home directory. The main process resolves them at the
  // moment of reveal and enforces workspace containment. Relative form also
  // means a shared session JSON can move between machines without leaking
  // the original owner's filesystem layout.
  jsonRelativePath: string;
  htmlRelativePath: string | null;
};

// A single long-term context-memory entry (structural mirror of the main
// process's ContextMemoryItem). Kept structural so the renderer type doesn't
// couple to the memory module's runtime graph.
export type MemoryItem = {
  id: string;
  text: string;
  hash: string;
  attributedTo: 'user' | 'assistant';
  createdAt: number;
  updatedAt: number;
  linkedMemoryIds: string[];
  sources: string[];
};

export type LinkMeta = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  host: string;
};

// A bundled skill (Phase 5). `enabled` is the resolved state (settings, else
// frontmatter default); `defaultEnabled` is what it would be on first run.
export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  apps?: string[];
  enabled: boolean;
  defaultEnabled: boolean;
};

// One web image in the answer's scrollable image row. `url` is the full-size
// image, `thumb` a smaller thumbnail (falls back to `url`), `source` the page
// the image was found on (falls back to `url`). Rendered by the renderer;
// never proxied — image bytes load directly from their host.
export type WebImage = {
  url: string;
  thumb: string;
  title: string;
  source: string;
};

export type SaveResult =
  | { ok: true; path: string; format: 'md' | 'html' | 'pdf' }
  | { ok: false; canceled?: boolean; error?: string };

export type ClipboardContext = {
  preview: string | null;
  length: number;
};

// Captured text selection (the efficient UIA read, or the Ctrl+C fallback).
// Same shape as ClipboardContext so the renderer chip can reuse the layout.
export type SelectionContext = {
  preview: string | null;
  length: number;
};

// A file dropped onto the prompt box, read by main (text inline, images as
// vision blocks). `ok:false` entries carry a human `note`, never throw.
export type AttachedFile = {
  path: string;
  name: string;
  kind: 'text' | 'image' | 'skipped';
  note?: string;
};

// One paint-to-select region: a display-local rect the user dragged a box
// around while the box was open, plus the OCR'd text. `status` drives the
// renderer bubble ("reading…" until capturePaint resolves).
export type PaintSelection = {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  text: string;
  status: 'reading' | 'done' | 'error';
  error?: string;
};

// One action suggestion. `icon` is a raw icon word from
// the model (e.g. "summarize"); the renderer fuzzy-matches it to the installed
// Tabler icon set and falls back to sparkles.
export type SuggestionChip = {
  label: string;
  icon: string;
  // Hidden instruction sent to the LLM when the chip is tapped. The label is
  // only the display text; when present, `prompt` is what actually gets
  // submitted (e.g. "Suggest a reply" carries a crafted prompt that wraps the
  // deliverable in [REPLY] tags). Falls back to the label when absent.
  prompt?: string;
  // True = tapping the chip runs the query with web search forced on (used by
  // the offline search-category chips so they do a REAL web search in the box
  // instead of just asking the model from memory).
  web?: boolean;
};

// AI-generated custom UI
// The answering model can emit a `[UI]` block containing a JSON component
// tree. The renderer maps it to real React components themed with the current
// accent color + dark/light mode. `UiNode` is deliberately LOOSE (all fields
// optional, unknown fields ignored) so a weak model's sloppy output still
// renders instead of failing — strict bounds live in custom-ui-parse.ts.
export type UiNode = {
  // Component type (canonical name or a short alias, e.g. 'btn' → 'button').
  t: string;
  title?: string;
  label?: string;
  text?: string;
  icon?: string;
  // Shade/variant name: strong | accent | soft | ghost | neutral |
  // success | warning | danger. Never a raw color — the renderer maps the
  // name to the current accent.
  variant?: string;
  // Form control name — collected values feed button actions via {name}.
  name?: string;
  default?: unknown;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  // Button action: 'send' (submit prompt), 'copy' (clipboard), 'reset' (form).
  action?: string;
  // Prompt submitted on 'send'. {name} placeholders are replaced with the
  // control's current value before submission.
  prompt?: string;
  options?: Array<{ label?: string; value?: unknown } | string>;
  items?: unknown[];
  children?: UiNode[];
  cols?: number;
  min?: number;
  max?: number;
  step?: number;
  href?: string;
  delta?: string;
  headers?: string[];
  rows?: Array<Array<string | number>>;
  active?: string | number;
};

export type UiQuestionType =
  | 'radio'
  | 'slider'
  | 'multi'
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'toggle'
  | 'number'
  | 'date';

// One question of a `[QUESTIONS]` wizard block. The wizard shell (progress,
// next/back/skip, confirmation screen) is app-built — the model only fills in
// the blanks: the question text, answer type and options.
export type UiQuestion = {
  q: string;
  type?: UiQuestionType;
  name?: string;
  options?: Array<{ label: string; value: string } | string>;
  default?: unknown;
  required?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
};

export type UiQuestionSet = {
  title?: string;
  questions: UiQuestion[];
};

// One ordered slice of a final answer with AI-generated UI. `text` segments
// render as markdown; `ui` / `questions` / `mermaid` render as themed cards,
// `diagram` as a sanitized HTML widget — all at their exact inline positions.
export type UiSegment =
  | { kind: 'text'; text: string }
  | { kind: 'ui'; block: UiNode }
  | { kind: 'questions'; questions: UiQuestionSet }
  | { kind: 'mermaid'; code: string }
  | { kind: 'diagram'; title: string; html: string }
  // OpenUI Lang program rendered by @openuidev/react-lang (real OpenUI).
  | { kind: 'openui'; code: string };


// Foreground-app context captured on demand at trigger/submit time (never
// polled). Cross-platform: GetForegroundWindow on Windows, System Events on
// macOS, xdotool on Linux. For browsers the window `title` carries the
// active tab, which app-context.ts extracts into the LLM line; `url` (when
// the OS exposes it — Windows UIA) carries the active tab's full URL.
// How a context snapshot was obtained. `fresh` is a live read of the app the
// user is in right now; `fallback` is a previously-captured context re-used
// when a fresh read failed (the LLM is told it is approximate); `fromHistory`
// is reserved for contexts pulled from the committed session rather than the
// live capture path.
export type AppContextSource = 'fresh' | 'fallback' | 'fromHistory';

export type AppContext = {
  title: string;
  process: string;
  pid: number;
  // Windows only: user32 HWND (decimal string) of the foreground window, used
  // as a belt-and-suspenders self-capture check against Spirit's own windows.
  hwnd?: string;
  // Active browser tab URL, when Spirit could read it from the OS.
  url?: string;
  // Live label of the CURRENT browser tab, read from the tab strip
  // (Windows UIA only). Some browsers — notably Arc — freeze their UIA
  // Document/address-bar value at the first tab opened after launch, so
  // `url` can be stale; `activeTab` tracks tab switches and is the
  // authoritative "what tab is the user on" signal. app-context.ts
  // reconciles the two via reconcileActiveTab.
  activeTab?: string;
  // Epoch-ms wall-clock time this snapshot was captured. Stamped by the
  // capture entry points (captureForegroundApp / captureTopmostAppContext /
  // contextAtPoint); the LLM-facing renderer (appContextTextFrom) turns it
  // into a "CONTEXT AS OF <time>" header so the model can judge how fresh the
  // observation is.
  capturedAt?: number;
  // Provenance of this snapshot, for the same freshness labeling. Absent on
  // legacy objects / test fixtures (treated as an untimed capture).
  source?: AppContextSource;
  // True when this is a re-used capture (a `fallback` source): the read that
  // produced it happened earlier, so the LLM must treat it as approximate —
  // the current app/tab may have changed since.
  stale?: boolean;
};

export type PermissionsStatus = {
  accessibility: boolean;
  screenRecording: boolean;
};

export type AutostartState = {
  openAtLogin: boolean;
  openAsHidden: boolean;
};

export type LaunchableApp = {
  id: string;
  label: string;
  available: boolean;
};

// Live state of the local faster-whisper sidecar (first-use model download).
// `phase`: 'idle' | 'downloading' | 'installing' | 'ready' | 'unavailable'.
export type SttStatus = {
  phase: string;
  // 0..100 byte-level download progress, null when not downloading.
  progress: number | null;
  model: string | null;
  ready: boolean;
  // Optional (older main builds omit it): true once the sidecar is spawned +
  // healthy, even while the model is still loading (ready false).
  available?: boolean;
  // Set when the model download gave up after retries (phase 'error').
  // The sidecar wipes the partial cache itself; the UI shows this + retry.
  downloadError?: string | null;
};

export type SpiritAPI = {
  onAIModeStart: (cb: (pos: CursorPosition) => void) => () => void;
  onAIModeEnd: (cb: () => void) => () => void;
  onCursorPosition: (cb: (pos: CursorPosition) => void) => () => void;
  onLLMChunk: (cb: (chunk: LLMChunk) => void) => () => void;
  onLLMDone: (cb: (done: LLMDone) => void) => () => void;
  onLLMError: (cb: (err: LLMError) => void) => () => void;
  onLLMInterrupted: (cb: (ev: LLMInterrupted) => void) => () => void;
  onLLMFinal: (cb: (final: LLMFinal) => void) => () => void;
  // Live chain-of-thought (reasoning_content) deltas while a reasoning model
  // thinks. Main broadcasts each delta; the renderer appends to its panel.
  onLLMReasoning: (cb: (reasoning: LLMReasoning) => void) => () => void;
  // Annotation protocol: main streams mapped [POINT]/[BOX]/[ARROW] targets as
  // the answer streams (display-local coords). Empty payload clears overlay+tour.
  onAnnotationStream: (cb: (payload: AnnotationStreamPayload) => void) => () => void;

  queryLLM: (prompt: string) => Promise<void>;
  cancelAIMode: (opts?: { cancelStream?: boolean; keepOpen?: boolean }) => Promise<void>;

  getSettings: () => Promise<Settings>;
  setSettings: (patch: Partial<Settings>) => Promise<Settings>;

  getPermissions: () => Promise<PermissionsStatus>;
  openSystemSettings: (kind: 'accessibility' | 'screen-recording') => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  fetchLinkMeta: (url: string) => Promise<LinkMeta | null>;

  onSettingsOpen: (cb: () => void) => () => void;
  onClipboardContext: (cb: (ctx: ClipboardContext) => void) => () => void;
  onToolActivity: (cb: (activity: ToolActivity) => void) => () => void;
  onToolApprovalRequest: (cb: (req: ToolApprovalRequest) => void) => () => void;
  onToolApprovalCleared: (cb: (id: string) => void) => () => void;
  respondToolApproval: (id: string, approved: boolean) => void;
  dismissClipboard: () => Promise<void>;
  onSelectionContext: (cb: (ctx: SelectionContext) => void) => () => void;
  dismissSelection: () => Promise<void>;
  attachFiles: (paths: string[]) => Promise<AttachedFile[]>;
  onAttachedFiles: (cb: (files: AttachedFile[]) => void) => () => void;
  dismissAttachedFiles: () => Promise<void>;
  // Foreground app preview string (e.g. "Microsoft Edge · weather - Google
  // Search"), broadcast at trigger and on each send. Null when AI mode ends
  // or nothing could be read.
  onAppContext: (cb: (preview: string | null) => void) => () => void;
  // Action-suggestion chips: main broadcasts the latest generation result
  // (possibly empty when generation was cancelled or nothing useful was found).
  onChipsResult: (cb: (chips: SuggestionChip[]) => void) => () => void;
  // Offline premade chips: the instant placeholder published while a
  // generation round is in flight. Does not clear the pending underline.
  onChipsFallback: (cb: (chips: SuggestionChip[]) => void) => () => void;
  // Chips generation lifecycle: true while a round is in flight (accent
  // underline sweep under the box), false once it lands / is cancelled.
  onChipsPending: (cb: (pending: boolean) => void) => () => void;
  // Post-response "next actions": main asks the same provider for follow-up
  // chips after a query completes and broadcasts them here.
  onNextChipsResult: (cb: (chips: SuggestionChip[]) => void) => () => void;
  // Post-response web images: main strips the [IMAGE] subject lines the
  // answering model wrote at the top of its answer, searches the real backends
  // for each subject, and broadcasts the pictures here.
  onWebImagesResult: (cb: (images: WebImage[]) => void) => () => void;
  // Write text to the system clipboard. Only ever called from an explicit
  // user tap on a generated-UI "copy" control (never automatically).
  writeClipboard: (text: string) => Promise<{ ok: boolean; error?: string }>;
  // Put an image (PNG data URL) on the system clipboard. Used by the Mermaid
  // diagram's "Copy as PNG" button — again, only on an explicit tap.
  copyImageToClipboard: (dataUrl: string) => Promise<{ ok: boolean; error?: string }>;
  // [DIAGRAM] widget "Copy as PNG": main rasterizes the widget's viewport rect
  // via webContents.capturePage and writes the real pixels to the clipboard.
  // Only ever called from an explicit tap on the widget's copy control.
  copyRegionToClipboard: (rect: { x: number; y: number; width: number; height: number }) =>
    Promise<{ ok: boolean; error?: string }>;
  insertText: (
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  triggerAIMode: () => void;
  getAIModeState: () => Promise<{ active: boolean }>;
  transcribeAudio: (
    audioBase64: string,
    mimeType: string,
    options?: { prompt?: string; fast?: boolean; engine?: 'auto' | 'local' | 'cloud'; language?: string; voicePeak?: number },
  ) => Promise<{ text: string; language: string | null; quiet: boolean }>;
  // Local STT sidecar model-download status, polled while transcribing.
  getSttStatus: () => Promise<SttStatus>;
  // Speech-model manager (Settings → Voice list).
  getSttModels: () => Promise<{
    models: Array<{ id: string; sizeMB: number; note: string; downloaded: boolean; partial: boolean; diskMB: number; active: boolean; recommended: boolean }>;
    recommendation: string;
    active: string;
  }>;
  switchSttModel: (id: string) => Promise<{ ok: boolean; active: string }>;
  deleteSttModel: (id: string) => Promise<{ ok: boolean; error?: string }>;
  // Phase 7: pre-warm the sidecar (spawn + model load) when the mic arms so the
  // first live chunk hits a warm model. Returns the current SttStatus.
  warmStt: () => Promise<SttStatus>;

  queryLLMWithOptions: (
    prompt: string,
    options: {
      web?: boolean;
      templateId?: TemplateId;
      // Opt-in clipboard: when false (default), this turn does NOT
      // attach clipboard text even if there is some. Lets the user
      // explicitly decide whether the LLM should see their clipboard
      // via the chip toggle, instead of the polled auto-attach that
      // surprised users during unrelated queries.
      includeClipboard?: boolean;
      // True when the submit came from tapping a suggestion chip: the chip is
      // a follow-up to the ongoing conversation, so it must continue the
      // active session instead of starting a new one.
      fromChip?: boolean;
      // Renderer-generated run id (else main mints one). Lets the box
      // correlate every event to its own run and ignore superseded ones.
      runId?: string;
    },
  ) => Promise<void>;
  quit: () => void;
  openSettings: () => void;
  // Fire-and-forget renderer crash report for the session log.
  reportRendererError?: (message: string) => void;
  saveResponse: (payload: { prompt: string; markdown: string; web: boolean; images?: WebImage[] }) => Promise<SaveResult>;
  pickWorkspaceFolder: () => Promise<string | null>;
  getAppVersion: () => Promise<string>;

  listSessions: () => Promise<SessionSummary[]>;
  loadLatestSession: () => Promise<string | null>;
  revealSession: (path: string) => Promise<void>;
  clearAllSessions: () => Promise<{ removed: number }>;
  // /memory manager: read the long-term context-memory store and mutate it by
  // id. All explicit user taps in the overlay.
  listMemories: () => Promise<MemoryItem[]>;
  deleteMemory: (id: string) => Promise<boolean>;
  updateMemory: (id: string, text: string) => Promise<boolean>;
  clearMemories: () => Promise<boolean>;
  // Skills (Phase 5): read the bundled catalog with enabled state, and toggle
  // one skill. Both return the full catalog so the renderer re-syncs in one
  // round-trip.
  listSkills: () => Promise<SkillInfo[]>;
  setSkillEnabled: (id: string, enabled: boolean) => Promise<SkillInfo[]>;
  synthesizeSpeech: (text: string) => Promise<
    | { audioBase64: string; mimeType: string; wordBoundaries: { text: string; offsetMs: number; durationMs: number }[] }
    | { error: string }
  >;

  setInteractive: (interactive: boolean) => void;

  // Renderer demand signal for cursor tracking. Sent true while this overlay
  // has something to draw from the pointer position (AI mode, Settings/Memory
  // modal) and false when it doesn't. Main runs the tracking loop only while
  // at least one overlay needs it — a fully idle Spirit runs no poll at all.
  setCursorTrackingNeeded: (needed: boolean) => void;

  // Custom-cursor capture mode. The renderer marks the display where the box
  // lives as "capturing" while AI mode is active (overlay owns the mouse so
  // `cursor: none` hides the OS arrow). Main uses this to skip its own
  // uiohook outside-click dismissal and to ignore synthetic forward events.
  setOverlayCaptureMode: (displayId: number, on: boolean) => void;
  // Forward an outside click/scroll (capture mode swallowed the user's
  // physical input, so Spirit replays it into the app underneath). Coords are
  // display-local.
  forwardClick: (x: number, y: number, displayId: number, opts?: { button?: 'left' | 'right' }) => void;
  forwardScroll: (delta: number, displayId: number) => void;

  // Tell main the current box bounds (in display-local coords) so the global
  // mouse hook can detect outside-click dismiss. Pass null when the box is
  // hidden or temporarily covered (e.g. Settings open).
  sendBoxBounds: (
    bounds:
      | { left: number; top: number; right: number; bottom: number; displayId: number }
      | null,
  ) => void;
  // Signal that the Settings panel is opening/closing so main can lower the
  // overlay alwaysOnTop level — otherwise the screen-saver-level window blocks
  // the user from Cmd+Tabbing to their browser to copy an API key.
  setOverlaySettingsMode: (open: boolean) => void;

  // User-defined rectangle screenshot. The renderer hands main the display-
  // local rect (work-area frame); main re-captures from that region and
  // substitutes it for the default cursor-centered crop. ok=false means the
  // capture itself failed (permission missing, weird rect, etc.).
  captureSelection: (
    rect: { x: number; y: number; width: number; height: number },
    displayId: number,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSelectionDone: (
    cb: (result: { ok: true } | { ok: false; error: string }) => void,
  ) => () => void;
  // Main broadcasts true when the user presses the trigger key while AI mode
  // is already open (= "arm selection mode"), and false on release. The
  // renderer uses this to force the overlay interactive so the drag-to-select
  // pointer handlers can fire.
  onSelectionArm: (cb: (armed: boolean) => void) => () => void;

  // Paint-to-select: OCR a display-local region the user dragged while the box
  // was open. Returns the extracted text (best-effort; error carries a
  // human-readable message when OCR/tesseract is unavailable).
  capturePaint: (
    rect: { x: number; y: number; width: number; height: number },
    displayId: number,
  ) => Promise<{ ok: boolean; id: string; text: string; error?: string }>;
  // Drop a paint selection (bubble X) so its text leaves the prompt context.
  removePaint: (id: string) => void;

  // Broadcast when the user engages outside our box. `kind` is
  // 'key' for a printable non-trigger keystroke captured by uIOhook, or
  // 'click' for an outside mousedown. Renderer counts both toward
  // prompt-box auto-dismiss, and uses 'key' vs 'click' to decide whether
  // to suppress the signal when our own input has focus (only 'key' is
  // suppressible).
  onExternalTyping: (cb: (kind: 'key' | 'click') => void) => () => void;

  // Capture mode: main caught physical outside clicks that the overlay's DOM
  // missed (they landed inside the temporary click-through window while a
  // click-forward was being synthesized). The renderer adds `count` to its
  // double-click-to-dismiss accumulator so a fast double-click still closes
  // the box even though its second click never hit the DOM.
  onForwardedClickEaten: (cb: (count: number) => void) => () => void;

  // Validate an API key against the provider's account/list-models endpoint.
  // For OpenRouter the `label` includes the remaining credit balance
  // (e.g. "$3.42 left"). For the other providers `label` is "connected".
  // ok=false carries a short human-readable error.
  testProviderKey: (
    provider: ProviderId,
    apiKey: string,
  ) => Promise<{ ok: true; label?: string } | { ok: false; error: string }>;

  // Probe a local OpenAI-compatible server's `GET {baseUrl}/v1/models`
  // and return the models it hosts. Used by the Local AI provider's
  // Connect / Detect button to populate the model dropdown; the same call
  // doubles as the connection test (the server either answers with models or
  // the base URL / key is wrong).
  detectLocalModels: (
    baseUrl: string,
    apiKey: string,
  ) => Promise<
    { ok: true; models: LocalModelInfo[]; contextLength?: number } | { ok: false; error: string }
  >;

  // Lightweight Local AI connection test (separate from Detect,
  // which also lists models). Probes the server and, when it exposes one,
  // reports the context window size (llama.cpp's n_ctx via /props).
  testLocalAi: (
    baseUrl: string,
    apiKey: string,
  ) => Promise<{ ok: true; label?: string; contextLength?: number } | { ok: false; error: string }>;

  // Vision bridge config: read the current state (the plain fields
  // ride on the localai settings read by the normal settings flow; this IPC
  // confirms the toggle/url/model plus whether an API key is stored without
  // decrypting it).
  getVisionBridge: () => Promise<{
    useBridge: boolean;
    url: string;
    model: string;
    hasKey: boolean;
  }>;
  // Persist the vision bridge. A non-empty `key` is encrypted into
  // visionBridgeSecure; `clearKey: true` removes it; otherwise the stored key
  // is left untouched.
  setVisionBridge: (payload: {
    useBridge: boolean;
    url: string;
    model: string;
    key?: string;
    clearKey?: boolean;
  }) => Promise<boolean>;

  // Opencode server connection test. Probes `GET {baseUrl}/global/health`.
  testOpencode: (
    baseUrl: string,
  ) => Promise<{ ok: true; label?: string } | { ok: false; error: string }>;

  // Live model discovery for a local `opencode serve` instance via
  // `GET {baseUrl}/config/providers`. Refetch any time to pick up models added
  // or enabled in opencode without a restart.
  detectOpencodeModels: (
    baseUrl: string,
  ) => Promise<{ ok: true; models: LocalModelInfo[] } | { ok: false; error: string }>;

  hasProviderKey: (provider: ProviderId) => Promise<boolean>;
  hasAnyConfiguredProvider: () => Promise<boolean>;
  revealProviderKey: (provider: ProviderId) => Promise<string>;
  // Same as revealProviderKey but for the chips-only provider map (the
  // separate provider set configured for "Suggest actions" chips).
  revealChipsProviderKey: (provider: ProviderId) => Promise<string>;
  // List every provider's decrypt-health state. Renderer banner
  // uses this to tell the user which key needs re-entry instead of the
  // generic "no provider configured" empty state.
  getProvidersHealth: () => Promise<ProviderHealth[]>;
  // Fires when main has just written a provider patch — banner re-polls
  // immediately instead of waiting for its 30s heartbeat.
  onProvidersHealthChanged: (cb: () => void) => () => void;
  // Self-knowledge hint (Hermes-style memory notice): fired when the agent
  // learns something durable (profile fact, memories, app lesson).
  onLearnedHint: (cb: (hint: LearnedHint) => void) => () => void;

  autostartGet: () => Promise<AutostartState>;
  autostartSet: (state: AutostartState) => Promise<AutostartState>;
  clearActiveSession: () => Promise<void>;

  launchApp: (appId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  listLaunchableApps: () => Promise<LaunchableApp[]>;

  platform: NodeJS.Platform;
};

declare global {
  interface Window {
    spirit: SpiritAPI;
  }
}
