// Documentation content, split in two subdivisions: 'using' sections are the
// non-tech guides (first), 'under' sections are the code-level detail
// (second). Each section carries a plain-language intro and a markdown body. Source of truth: AI_CONTEXT.md
// and docs/01–17 in the repository — this page presents them; it does not
// fork them. Chrome (page title/lede/TOC label) is localized; section text
// is canonical English, like the legal page.

export type DevDocSection = {
  id: string;
  title: string;
  plain: string;
  md: string;
  /** Live demo rendered in place of a screenshot — the real Spirit UI. */
  demo?: 'box' | 'annotate' | 'tools';
  /** Which docs subdivision the section belongs to: 'using' (non-tech,
      first) or 'under' (tech, second). Untagged = 'under'. */
  group?: 'using' | 'under';
};

// Non-tech guides, first. Plain language throughout — no code unless it is
// something a user actually types.
const USING_SECTIONS: DevDocSection[] = [
  {
    id: 'g-start',
    group: 'using',
    title: 'Getting started',
    plain:
      'Install Spirit, add a model key, and ask your first question. Two minutes, no account.',
    md: `**1. Install.** Grab the build for your platform from the [download section](/#download) — a one-click installer on Windows, a drag-to-Applications image on macOS, an AppImage on Linux. The full walk-through lives in the [Manual](/docs.html#install).

**2. Add a key.** Open Settings and paste a key from any provider you use — OpenRouter (free models), Anthropic, OpenAI, Google Gemini — or point Spirit at a local model server. The key is encrypted with your operating system's keychain and never leaves your machine.

**3. Ask.** Hold **Alt + Space** anywhere, type a question about whatever is under your cursor, release. The answer appears beside your cursor.

That is the whole loop. Everything else on this page is optional depth.`,
  },
  {
    id: 'g-trigger',
    group: 'using',
    title: 'The trigger — hold, ask, release',
    demo: 'box',
    plain:
      'One gesture controls Spirit: hold the hotkey and the capsule opens at your cursor. Type or speak, let go, and the answer streams in right where you were looking.',
    md: `- **Hold** the trigger (Alt + Space by default, configurable in Settings). A pill appears at your cursor — not in a dock, not in a browser tab.
- **Ask** while holding: type, or press the mic and talk. The pill grows into the answer box.
- **Release** — the question sends. A small capture of the area around your cursor, the text on it, and the app you are in travel to the model you chose, and the answer types itself into place.
- **Esc** closes the box and cancels a running answer. Follow-ups within a couple of minutes stay in the same conversation.

The box anchors to your cursor with per-monitor awareness, so multi-screen setups just work. Change the key combo in Settings whenever your hands prefer something else.`,
  },
  {
    id: 'g-ask',
    group: 'using',
    title: 'Asking well — chips, commands, regions',
    plain:
      'You do not have to type everything. Spirit suggests questions based on your screen, understands slash commands, and lets you paint a region to ask about.',
    md: `- **Suggestion chips** — before you type, Spirit offers context-aware chips (summarize this document, extract the key points, list the data). After an answer, follow-up chips keep the thread going.
- **Slash commands** — start typing \`/\` for templates: \`/summary\`, \`/brief\`, \`/translate\`, \`/history\`, \`/lastsession\` and friends.
- **Paint to select** — drag on the backdrop behind the box to capture a region and ask about exactly that part of the screen.
- **Clipboard and selection** — if text is selected or the clipboard has something, Spirit offers it as context. Dismissable, always.
- **Annotations** — ask "where do I click to…?" and the answer draws the spot: a box, a chip or an arrow right over the app, with a fly-to tour.`,
  },
  {
    id: 'g-voice',
    group: 'using',
    title: 'Talking to Spirit',
    plain:
      'Hold the mic and speak — Spirit writes your words into the prompt. With the local speech model installed, your voice never leaves the computer. It answers out loud, highlighting each word as it is spoken.',
    md: `- **Voice input** — click the mic (or use the voice shortcut). Recording starts immediately; the model warms up behind the scenes. Pauses are stitched together, so thinking mid-sentence is fine.
- **Local vs cloud** — with the local speech model (Settings → Voice), transcription runs fully offline. Otherwise it uses your configured cloud provider.
- **Voice output** — answers can be read aloud in a natural voice; the exact word being spoken is highlighted, and playback can pause like any player.
- **Wake word** — enable "Hey Spirit" and the box opens itself when you say the phrase (on-device detection, nothing recorded).`,
  },
  {
    id: 'g-memory',
    group: 'using',
    title: 'What Spirit remembers',
    plain:
      'Every answer leaves behind short takeaways. Next time you ask something related, the relevant ones come back — so you never repeat yourself. You can see, edit and delete every memory.',
    md: `- **Takeaways** — after each answer, Spirit keeps the durable facts ("the release script is release.mjs", "row 14 was the wrong column"). Plain text, stored in a file in your workspace.
- **Recall** — when a new question smells related, matching takeaways quietly join the prompt. That is why Spirit "remembers" without any cloud account.
- **App lessons** — Spirit also keeps a few quirks per app ("this app's export dialog needs two clicks").
- **Sessions** — conversations are saved as readable files (JSON + HTML) in the workspace folder you picked. \`/history\` lists them; \`/lastsession\` continues the newest one.
- **Full control** — the Memory panel shows every takeaway; delete one, all of them, or just tell Spirit in plain words to forget something. Delete the file and memory resets completely.`,
  },
  {
    id: 'g-act',
    group: 'using',
    title: 'Letting Spirit act — approvals without fear',
    plain:
      'Spirit can click, type, open apps and run commands for you. Anything that changes something asks first with a plain approval card. You always see exactly what will happen before it does.',
    md: `- **Read-only is free** — looking at the screen, reading text, watching the cursor: that is how Spirit understands a question, and it never changes anything.
- **Actions ask** — clicking, typing, scrolling, opening apps, saving files: each shows an approval card with the exact action and its details. Approve once, allow similar actions for this answer, or deny.
- **Two tools always ask** — shell commands and system actions are high-impact. No setting ever skips their prompt.
- **You are the authorizer** — treat an approval like handing the mouse to a trusted friend for one second. If a proposed action deletes, sends or publishes something, read it twice.
- **Denying is safe** — a denied action just tells the model "no", and it adapts. Nothing breaks.`,
  },
  {
    id: 'g-privacy-plain',
    group: 'using',
    title: 'Your data in plain words',
    plain:
      'No telemetry, no analytics, no cloud storage, no account. Your conversations and memories are files on your machine. The only time data leaves is when you ask a question — then it goes to the AI provider you chose.',
    md: `- **Stays here** — settings, API keys (encrypted with your OS keychain), sessions, memory, saved documents: all local files. Delete them any time; uninstalling never silently wipes your workspace.
- **Leaves only on purpose** — a question sends the prompt plus the small screenshot/context it needs to the provider you configured. Use a local model and even that stays on the machine.
- **Voice** — with the local speech model, your voice is transcribed on your own computer.
- **No hidden network** — Spirit fetches nothing on its own except the pages you ask about and favicons for link previews. There is no Spirit server to send anything to.
- The full detail, with an exact table of what goes where, is in the [Privacy Policy](/legal.html#privacy).`,
  },
  {
    id: 'g-troubleshoot',
    group: 'using',
    title: 'When something is off',
    plain:
      'Most rough edges have a one-line fix. Start here before digging deeper.',
    md: `- **The box does not appear** — another app may own the hotkey. Change the trigger in Settings, or restart Spirit once as the last-launched app to test.
- **Answers are generic, not screen-aware** — the screen-capture permission is likely missing (macOS asks on first use; check System Settings → Privacy).
- **"Provider not configured" banner** — add a key in Settings or point Spirit at a local endpoint; the banner names the provider in the chain that failed.
- **Voice does not transcribe** — install the local speech model in Settings → Voice, or switch the engine to a cloud provider. The OS handles mic permission.
- **Annotations are offset** — multi-monitor? Arrange displays in the OS exactly as they are physically placed; annotation coordinates follow the OS layout.
- **Still stuck** — [open an issue](https://github.com/BibaPutt/Spirit-AI-Cursor/issues/new) with your platform, the steps and (in a dev build) the newest \`logs/session-*.log\`.`,
  },
];

export const DEV_DOCS: DevDocSection[] = [
  ...USING_SECTIONS,
  {
    id: 'overview',
    title: 'Overview — what Spirit is',
    plain:
      'Spirit is a desktop app that lives next to your cursor. Hold a key, ask a question, and it answers with awareness of whatever is on your screen at that spot. It can also act for you — click, type, open apps — but only when you approve.',
    md: `Spirit is an **Electron 30** desktop app (React 18 + Vite 5 + TypeScript 5, Tailwind CSS 3) for macOS, Windows and Linux. The product loop:

1. User holds the trigger key → a global input hook detects the gesture → an overlay pill appears at the cursor.
2. Spirit captures context: a screenshot crop, clipboard/text selection, foreground app and tab.
3. The user types (or picks a chip / template / speaks).
4. The main process builds messages, runs the provider chain, and streams the answer back.
5. The model may call **tools** during the answer — every mutating tool is gated behind an approval prompt.
6. On completion: markers are stripped, takeaways are remembered, the session is persisted, follow-up chips appear.

Key architectural decisions:

- **One overlay window per display** — transparent, always-on-top, frameless; click-through unless interactive.
- **The main process owns all native work** (screenshots, hooks, tools, LLM). The renderer is a thin presenter.
- **No telemetry, no analytics, no cloud storage.** Everything is local files plus the providers you configure.
- A **~2-minute session window** keeps follow-ups attached to the same conversation.`,
  },
  {
    id: 'trigger-flow',
    title: 'Trigger-to-answer flow',
    plain:
      'This is the journey of a single question: from the moment you press the hotkey to the moment the answer finishes typing itself in front of you.',
    md: `End-to-end path (all in \`electron/\` unless noted):

\`\`\`
hold trigger → input/trigger.ts (state machine)
             → input/global-hook.ts (uiohook-napi)
             → broadcastAIModeStart → renderer shows the pill
submit       → llm:query-options (IPC)
             → ipc/handlers.ts runQuery (+ memory recall)
             → llm/providers/router.ts (chain + agentic loop)
             → llm:chunk / llm:final streamed back
onDone       → memory takeaways, session persist, next chips
\`\`\`

Hard rule: **never block the trigger-to-box path on slow work.** Startup captures (screenshot, chips, app context) are fire-and-forget/lazy, and the screenshot/chips are delayed 400 ms so the pill's entrance animation never stutters.

The trigger state machine (\`input/trigger.ts\`, ~18 KB) owns gesture semantics — hold-to-ask, click vs hold, drag-to-screenshot while held — and \`input/cursor.ts\` tracks the cursor adaptively (30/15/7 Hz) so the box anchors precisely (see \`renderer/lib/positioning.ts\`).`,
  },
  {
    id: 'capture',
    title: 'Screen reading — capture, OCR, scene graph',
    plain:
      'Spirit "sees" by taking a small screenshot around your cursor, reading the text in it with OCR, and asking the operating system what app, window and UI elements are there. None of this leaves your machine by itself.',
    md: `Three layers, all local:

| Layer | File(s) | How |
|---|---|---|
| Pixels | \`capture/screenshot.ts\`, \`native-capture.ts\` | Native GDI \`CopyFromScreen\` on Windows (~10–50 ms, no main-thread freeze); \`desktopCapturer\` elsewhere. Default crop **512×384 @ JPEG q80** around the cursor; Spirit's own overlays are excluded. |
| Text | \`capture/ocr.ts\` | Tesseract \`--oem 1\`, PSM 6, grayscale + contrast stretch + 2× upscale; falls back to PSM 3. |
| UI tree | \`capture/scene.ts\` (~894 lines) | Windows UIA walk / macOS AX walk / OCR-only on Linux. Produces \`SceneElement\`s with content-addressed stable IDs (\`el\` + 8-hex sha256), two text layers (OCR words with coords + web text), \`formatScene()\` for the model, and \`buildClickTargetsMenu()\` ranked click targets. |

Supporting cast: \`app-context.ts\` (~43 KB) captures foreground app name, bundle ID, window title and active browser tab (\`active-tab.ts\` reconciliation), with \`isSelfContext()\` guarding against reading Spirit's own windows. \`foreground-watcher.ts\` is event-driven (no polling). On Windows, \`ps-worker.ts\` keeps two persistent PowerShell \`-STA\` workers (CONTEXT + SELECTION pools) with a base64 line protocol, warmed at launch to dodge cold-start latency.`,
  },
  {
    id: 'input-engine',
    title: 'Input engine — how Spirit clicks and types',
    plain:
      'When you approve an action, Spirit moves the cursor, clicks, types and scrolls for you. There are two engines: a built-in one that talks to the OS directly, and a faster vendored driver. If the driver ever fails, Spirit quietly falls back without breaking your question.',
    md: `Router: \`input/engine.ts\` → \`getInputEngine()\`. All LLM tools call \`perform*\` functions — never \`actions.ts\` directly.

| Engine | When | Backend |
|---|---|---|
| \`NativeEngine\` | default fallback | \`actions.ts\`: PowerShell + user32 (Win), CoreGraphics (Mac), xdotool (Linux) |
| \`CuaDriverInputEngine\` | preferred when \`resources/bin/cua-driver.exe\` exists **and** MCP health-check passes | vendored \`cua-driver mcp\` daemon via \`input/cua-driver-client.ts\` |

Rules:

- Any connect/call failure degrades to native **for the rest of the session**; a driver missing one specific action falls back per-action only.
- \`move_mouse\` stays native in both engines.
- Disable the driver with \`SPIRIT_CUA_DRIVER=0\`; override its path with \`SPIRIT_CUA_DRIVER_PATH\`.
- Protocol: line-delimited JSON-RPC 2.0 over stdio, \`2024-11-05\`.

Coverage: click, double_click, type_text, scroll, press_key (bare keys + combos), drag, get_cursor_position (read-only, never degrades). Argument planning lives in \`input/driver-tool-args.ts\` (pure, unit-tested): \`scope: "desktop"\`, \`session: "spirit"\`, delivery mode, screen-absolute coordinates — returns null when unrepresentable, which triggers native fallback. Escalation logic is in \`engine-decision.ts\` (also pure + tested).`,
  },
  {
    id: 'annotations',
    title: 'Annotations — arrows and boxes on your screen',
    demo: 'annotate',
    plain:
      'Sometimes the best answer is pointing. The model can draw arrows, boxes and dots directly over your apps — here is how a sentence from an AI becomes a shape floating over your screen.',
    md: `The model emits inline tags in image-pixel space while streaming:

\`\`\`
[POINT:x,y:label:screenN]          single point
[BOX:x,y,w,h:label:screenN]        rectangle
[BOX:el#:label]                    resolves a scene element's real frame
[ARROW:x1,y1:x2,y2:label:screenN]  arrow between two points
\`\`\`

Pipeline:

1. \`llm/point.ts\` — \`createAnnotationScanner()\` parses tags out of the stream.
2. \`llm/scene-cache.ts\` — \`resolveSceneElementFrame()\` maps \`[BOX:el#]\` to UIA/AX/OCR bounds.
3. Image pixels → absolute screen DIP (the same space clicks use), with affine shift / near-snap / group-fit corrections in \`llm/annotation-resolver.ts\` and element-label matching in \`annotation-snap.ts\`.
4. \`broadcastAnnotations\` subtracts each overlay's \`workArea\` origin → display-local coordinates.
5. \`annotations:stream\` → \`useAnnotations\` (dedup by seq) → \`ScreenAnnotations.tsx\` + \`PointCursor.tsx\` (fly-to tour).

Clear events: on submit, final answer and error — \`broadcastAnnotations(sender, [])\`.`,
  },
  {
    id: 'providers',
    title: 'AI providers and the router',
    plain:
      'Spirit does not include AI — you bring your own key. You can stack several providers; if the first is down or rate-limited, the next one takes over automatically. Use a local model and nothing ever leaves your machine.',
    md: `Chain order: **OpenRouter → Anthropic → OpenAI → Gemini → LocalAI** (+ \`opencode\`). \`llm/providers/registry.ts\` holds \`PROVIDER_ORDER\`; \`resolveProviderChain()\` builds the ordered list from settings (enabled + has key).

The orchestrator is \`llm/providers/router.ts\` (~2,302 lines): \`runPlainCompletion(...)\` streams chunks/tool calls, retries transient failures (408/425/429/5xx), and drives the **agentic loop** — while the model emits tool calls: \`executeTool\` (with approval) → append result → continue, until the model stops or \`ROUND_TIMEOUT_MS\` (150 s).

| Provider | Models | Web | Notes |
|---|---|---|---|
| OpenRouter | \`google/gemma-4-26b-a4b-it:free\` (fast), \`google/gemma-4-31b-it:free\` (capable) | Yes (\`:online\`) | Free models only; one retry on 400/408/425/429 |
| Anthropic | \`claude-haiku-4-5\`, \`claude-sonnet-4-6\` | No | Messages API, SSE |
| OpenAI | \`gpt-5-mini\`, \`gpt-5\` | No | \`reasoning_effort\` |
| Gemini | \`gemini-2.5-flash/pro\` | Yes | \`streamGenerateContent?alt=sse\` |
| LocalAI | any OpenAI-compatible server | No | self-calibrating overflow retry |

Shared SSE parser: \`openai-stream.ts\`. Key validation: \`test-key.ts\`. Budgets: \`llm/models.ts\` — \`MAX_TOKENS=2048\`. Web grounding: \`llm/web-ground.ts\` + \`web-images.ts\`.`,
  },
  {
    id: 'tools',
    title: 'Tools and the approval system',
    demo: 'tools',
    plain:
      'Spirit can act, not just answer — 27 tools from "read my clipboard" to "run a shell command". Anything that changes something asks you first with an approval card. Two dangerous tools always ask, no matter what you have allowed before.',
    md: `Registry: \`llm/tools/index.ts\` — each tool has a JSON-schema declaration, a main-process executor and a UI label. Approval gates: \`llm/tools/approval.ts\` — \`APPROVAL_REQUIRED\` + \`HIGH_IMPACT\` sets.

| Tool | Purpose | Approval |
|---|---|---|
| \`fetch_url\` / \`open_url\` | fetch / open a link | Yes |
| \`copy_to_clipboard\` / \`save_document\` / \`reveal_in_finder\` | write clipboard, save answer, show file | Yes |
| \`launch_app\` / \`play_music\` / \`search_web\` / \`web_search\` | act on the system / web | Yes |
| \`type_text\` / \`press_key\` / \`click\` / \`double_click\` / \`scroll\` / \`drag\` | input synthesis | Yes |
| \`paste_table\` / \`paste_image\` / \`focus_window\` | clipboard tables, images, window focus | Yes |
| \`ui_click\` | click a scene element by ID | Yes |
| \`system_action\` / \`run_command\` | system actions / shell | **HIGH_IMPACT — always prompts** |
| \`read_clipboard\` / \`set_volume\` / \`wait\` / \`move_mouse\` / \`see_screen\` / \`ui_read\` / \`read_table\` / \`list_apps\` / \`get_cursor_position\` | read-only / soft | No |

Flow: \`getApprovalRequiredTools()\` gates mutating tools; \`HIGH_IMPACT\` (\`run_command\`, \`system_action\`) prompts **even inside a hybrid run-grant**. Wire: \`llm:tool-approval-request\` → user decides → \`llm:tool-approval-respond\`; UI in \`ToolApproval.tsx\` + \`useToolApprovals\`.`,
  },
  {
    id: 'memory',
    title: 'Memory — takeaways, sessions, app lessons',
    plain:
      'Spirit remembers. Every answer leaves behind short "takeaways" it can recall later when relevant, your conversations are saved as files you can open, and it even learns the quirks of the apps you use.',
    md: `Three systems, all local:

**Context memory** — \`memory/contextMemory.ts\`, a zero-dependency mem0-style **BM25** port (~500-line core). After each answer the assistant emits a \`Key takeaways:\` section → parsed into \`ExtractedMemory\` items (no extra LLM calls) → stored with BM25 scores. On a new query, \`recallMemories\` scores everything and injects top matches as a \`<!--SPIRIT-MEMORY-->\` RAG block. The model itself can \`[update <id>]\` / \`[delete <id>]\`. Scoring: BM25 with query-length-tuned k1/b, normalized 0..1. Storage: \`<workspace>/context-memory.json\`, atomic writes (temp + rename). Limits: \`MAX_MEMORIES=200\`, \`COMPRESS_THRESHOLD=150\`, \`KEEP_RECENT=60\`. **\`tests/contextMemory.test.ts\` (37 tests) is the regression net.**

**Sessions** — \`memory/sessions.ts\`: \`ActiveSession\` persisted to \`<workspace>/sessions/*.json\` + \`.html\`; truncation keeps system + latest turns within a token budget; ~2-min TTL window means re-triggering inside it continues the same conversation. \`/lastsession\` restores; \`/history\` lists.

**App lessons** — \`memory/app-lessons.ts\`: per-app quirks between \`APP_LESSONS_START/END\` markers, \`MAX_LESSONS_PER_APP=8\`, stored in \`userData/app-lessons.json\`.`,
  },
  {
    id: 'voice',
    title: 'Voice — speaking and listening',
    plain:
      'Hold the mic and talk; Spirit transcribes and answers out loud in a natural voice. With the local speech model installed, your voice never leaves the computer. It can even wake when you say "Hey Spirit".',
    md: `**TTS** — \`voice/tts.ts\`: \`synthesizeSpeech(text)\` → \`{ audioBase64, mimeType }\` via \`msedge-tts\` (Edge neural voices, default \`en-US-AriaNeural\`), with word-boundary metadata so \`useTTS\` can highlight the spoken word (\`renderer/lib/ttsWords.ts\` alignment; \`ttsText.ts\` strips markdown/LaTeX for speech).

**STT routing** — \`voice/transcribe.ts\`: \`'local'\` → faster-whisper sidecar; \`'cloud'\` → Gemini → OpenAI Whisper → OpenRouter; \`'auto'\` → sidecar first, cloud fallback.

**Local sidecar** — \`voice/local-stt.ts\` + \`local-whisper.py\`: Flask on \`127.0.0.1:5100\`, lazy model load, lifecycle managed by the app; installed by \`scripts/install-stt.js\` (postinstall).

**Voice input flow (tail-finalization):** hold mic → \`voice:stt-warm\` fires immediately (model loads behind the permission prompt) → recording slices every 1500 ms, each transcribed \`fast: true\` with running text as prompt → slices **stitch** via \`mergeTranscript\` (boundary-aware dedupe, \`renderer/lib/voiceMerge.ts\`) → on release only the last two slices transcribe with \`fast: false, beam_size=5\` → merged → delivered. Voice commands route to slash commands (\`voiceCommands.ts\`); wake word (\`useWakeWord\`) is energy-based, "Hey Spirit", 6 s cooldown.`,
  },
  {
    id: 'renderer',
    title: 'Renderer — the pill, hooks and IPC bridge',
    plain:
      'Everything you see — the pill that follows your cursor, the answer box, the settings — is one small React app. It never touches the network or your files directly; every capability goes through a tightly guarded bridge.',
    md: `Root orchestrator: \`renderer/App.tsx\` (~1,778 lines) — display identity, theme (**inverted dark: \`html.dark\` = LIGHT UI**), permissions, AI mode, LLM state, auto-dismiss (30 s idle bumped on engagement, 120 s after done, 3+ external signals in 5 s), capture mode and backdrop gestures (drag = paint-to-select, trigger-held drag = screenshot, wheel = scroll, right-click = menu).

Interaction hub: \`components/PromptInput.tsx\` (~2,586 lines, \`BOX_WIDTH=380\`) — submit, slash commands, drag positioning, chips, TTS, voice, web images, link cards, UI segments, tool approvals.

16 hooks under \`renderer/hooks/\` (\`useLLMQuery\` state machine: idle/loading/streaming/done/error; \`useChips\`, \`useTTS\`, \`useVoiceInput\`, \`useAnnotations\`, \`useSettings\`, …). Notable components: \`Markdown.tsx\` (react-markdown + KaTeX + mermaid), \`QuestionWizard.tsx\` (\`[QUESTIONS]\` flow), \`CustomUi.tsx\` (\`[UI]\` JSON tree), \`MermaidDiagram.tsx\`, \`DiagramWidget.tsx\`.

**The bridge:** \`lib/ipc.ts\` wraps \`window.spirit\` (built by \`electron/preload.ts\`'s \`contextBridge\`, ~80 methods) in a \`Proxy<SpiritAPI>\`. CSP-enforced; the renderer has **no outbound network**. Channel names follow \`Module:Action\` (\`memory:list\`, \`llm:query\`); changing \`SpiritAPI\` means updating \`types.ts\` → \`preload.ts\` → \`handlers.ts\` → renderer consumers. Errors cross IPC as \`{ ok: true } | { ok: false; error: string }\`.`,
  },
  {
    id: 'security',
    title: 'Security and privacy engineering',
    plain:
      'The promises on the Privacy page are enforced in code: your keys are encrypted with your operating system keyring, the UI sandbox cannot reach the internet, links cannot be used to probe your network, and AI-generated files pass a strict sanitizer.',
    md: `- **API keys at rest**: Electron \`safeStorage\` — macOS Keychain / Windows DPAPI / Linux libsecret (\`store/secure-keys.ts\`). \`encrypted: false\` means "warning, not encrypted" — there is **no plaintext fallback**; a broken keyring surfaces a \`ProviderHealthBanner\` instead.
- **Sandbox**: renderer with \`contextIsolation\`, \`nodeIntegration: false\`, strict CSP, zero outbound network. All native capability flows through the preload bridge.
- **SSRF guard**: \`page-fetch.ts\` DNS-resolves and checks redirect hops — a prompt cannot make Spirit probe your local network.
- **Document export**: \`save/template.ts\` renders answers into an A4 HTML template behind a **strict LLM-HTML allowlist** sanitizer; \`diagram-safe.ts\` allowlists diagram HTML; \`custom-ui-parse.ts\` extracts \`[UI]/[QUESTIONS]/[MERMAID]/[DIAGRAM]\` blocks.
- **Chips safety**: \`chips-parse.ts\` rejects suggestions containing \`SAFETY_MARKER\`.
- **No telemetry, no analytics, no cloud storage** — there is no Spirit server to send anything to.`,
  },
  {
    id: 'storage',
    title: 'Storage — what lives where',
    plain:
      'Everything Spirit keeps is in two places you control: an app-data folder for settings and a workspace folder you picked for your sessions and memory. Delete them and Spirit simply starts fresh.',
    md: `| Data | Location | Notes |
|---|---|---|
| Settings (\`config.json\`) | Electron \`userData\` dir | hand-rolled store (\`store/settings.ts\`), no electron-store dependency for settings |
| API keys | same file, \`safeStorage\`-encrypted | see Security |
| Sessions | \`<workspace>/sessions/*.json\` + \`.html\` | transcripts you can open in a browser |
| Context memory | \`<workspace>/context-memory.json\` | atomic writes |
| App lessons | \`userData/app-lessons.json\` | per-app quirks |
| Dev logs | \`logs/session-*.log\` | dev builds only, auto-rotated, max 10 |

The **workspace folder is user-picked** (defaults under the user home). All writes are atomic (temp + rename) and routed through the store modules — nothing else in the app touches disk. Uninstalling removes the program; the workspace and \`config.json\` are your data (the Windows uninstaller's "keep app data" choice defaults to keep).`,
  },
  {
    id: 'packaging',
    title: 'Building and packaging',
    plain:
      'How Spirit goes from source code to the installers on the Download page: one command per platform, with code signing and notarization switched on by environment variables only — no secrets ever live in the repository.',
    md: `Toolchain: Vite 5 bundles the renderer to \`dist/\`; \`vite-plugin-electron\` compiles main + preload to \`dist-electron/\`; **electron-builder 24** packages (\`electron-builder.yml\`).

| Command | Output |
|---|---|
| \`npm run dist:win\` | **Windows NSIS** one-click installer, x64 (\`Spirit-Setup-<version>.exe\`) |
| \`npm run dist:mac\` | **macOS DMG + ZIP**, arm64 + x64 (\`Spirit-<version>-<arch>\`) |
| \`npm run dist:linux\` | **Linux AppImage**, x64 (\`Spirit-<version>-<arch>.AppImage\`) |
| \`npm run dist:all\` | all of the above (each on its host OS) |

Packaging facts worth knowing:

- \`asar: true\`; \`uiohook-napi\`, \`node-gyp-build\`, \`sharp\`, \`@img\` are **asarUnpacked** (compiled .node addons). The vendored \`cua-driver.exe\`, bundled \`skills/*.md\` and the OmniParser sidecar ship via \`extraResources\`.
- The legal documents (\`TERMS.md\`, \`PRIVACY.md\`, \`CREDITS.md\`, \`LICENSE\`) are packed at the asar root — the in-app Legal window reads them via \`app.getAppPath()\`, and this website raw-imports the same files.
- **Signing is env-gated**: Windows \`CSC_LINK\` + \`CSC_KEY_PASSWORD\`; macOS \`CSC_IDENTITY\` + \`APPLE_ID\` / \`APPLE_TEAM_ID\` / \`APPLE_APP_SPECIFIC_PASSWORD\` (notarization is opt-in; missing vars = unsigned/unnotarized local build). \`build/entitlements.mac.plist\` (JIT + hardened runtime) is required by the mac target.
- Releases publish to GitHub \`BibaPutt/Spirit-AI-Cursor\` (\`electron-builder --publish always\` with \`GH_TOKEN\`); without it, artifacts land in \`release/\`.
- Quality gates: \`npm run gate:fast\` (incremental typecheck + changed tests) after any change; \`npm run gate\` (full typecheck + tests + production build) before commit.`,
  },
  {
    id: 'testing',
    title: 'Testing and quality gates',
    plain:
      'Spirit tests the thinking parts — the parsers, scorers and planners — with fast unit tests, and any change must pass a type check plus those tests before it counts as done.',
    md: `Vitest 4, jsdom, unit tests on **pure logic** — parsers, scoring, prompting, voice commands, memory. Contract-tested, internals mocked (\`electron\` module mocked in nearly every suite; \`userData\` routed to a temp dir).

| Suite | Covers |
|---|---|
| \`contextMemory.test.ts\` (37) | BM25 params, recall, takeaways, dedupe, compress — **the regression net** |
| \`chips.test.ts\` | chip parsing, \`SAFETY_MARKER\`, NEXT_ACTIONS |
| \`point.test.ts\` | annotation parsing, scanning, mapping |
| \`stream-clean.test.ts\` | final answer cleaning (**user-owned**) |
| \`routerInteraction.test.ts\` | router/provider interaction (**user-owned**) |
| \`driver-tool-args.test.ts\` | pure arg planning for cua-driver |
| \`input-engine.test.ts\` | engine selection, delivery-mode escalation |

Gates: \`npm run gate:fast\` = typecheck + changed tests (seconds — run after **any** change); \`npm run gate\` = full typecheck + full suite + production build (before commit/push). New pure logic gets a test under \`tests/\`.

**Never modify**: \`electron/llm/chips-fallback.ts\`, \`electron/llm/stream-clean.ts\` (+ its tests), \`tests/routerInteraction.test.ts\`. Live integration tests (\`live-*.test.ts\`) need real servers (e.g. a local Qwen on :8084) and fail with connection errors when those are down — environmental, not regressions.`,
  },
  {
    id: 'debugging',
    title: 'Debug logging',
    plain:
      'When Spirit misbehaves in a development build, every run leaves a diary: what you asked, what the model saw, which tools ran. Packaged builds write none of this.',
    md: `Location: \`logs/session-YYYYMMDD-HHMMSS-PID.log\` (dev only, auto-rotated, max 10).

| Tag | Meaning |
|---|---|
| \`[main]\` | lifecycle, global hook, AI-mode start/end |
| \`[run]\` | **the input for a turn** — sources, tokens, verbatim text |
| \`[agentic]\` | model loop — round sizes, tool plans/results, final answer |
| \`[router]\` | context size vs budget |
| \`[memory]\` | recall hits |
| \`[chips]\` | chip generation |
| \`[overlay]\` | overlay show/hide |
| \`[tts]\` / \`[transcribe]\` | voice pipeline |
| \`[forward-click]\` / \`[forward-scroll]\` | synthesized input |
| \`[resource]\` | memory/CPU (dev only) |

**The golden rule:** \`imgParts\` + \`sources\` + \`relevance\` = what the model saw. If an unrelated follow-up still shows \`imgParts>0\`, the relevance gate failed. Full guide: \`docs/17-debug-logging.md\` in the repository.`,
  },
  {
    id: 'source',
    title: 'Source map — where things live',
    plain:
      'A map of the repository for developers and the curious: which folder does what, and where to look for the interesting bits.',
    md: `\`\`\`
SPIRIT-deep/
├── electron/            Main process (TypeScript)
│   ├── main.ts            bootstrap, lifecycle, hook wiring
│   ├── preload.ts         contextBridge → window.spirit (~80 methods)
│   ├── apps/              app discovery + launcher + deep links
│   ├── capture/           screenshot, OCR, scene graph, app context
│   ├── input/             trigger, global hook, cursor, input engines
│   ├── ipc/               channels + handlers (~90 channels)
│   ├── llm/               prompt, providers/, tools/, annotations, chips
│   ├── memory/            context memory, sessions, app lessons
│   ├── save/              document export (+ sanitizer)
│   ├── store/             settings + encrypted keys
│   ├── voice/             TTS, STT routing, whisper sidecar
│   ├── windows/           overlays, About, Legal windows
│   └── tray/  system/  dev/
├── renderer/            React overlay (thin presenter)
│   ├── components/        PromptInput, SettingsPanel, annotations, …
│   ├── hooks/  lib/  i18n/  styles/
├── tests/               Vitest suites (pure logic)
├── docs/                architecture deep-dives (01–17)
├── site/                this website (Vite + React multi-page)
├── cursors/  assets/  resources/  scripts/  build/
\`\`\`

Repository: [github.com/BibaPutt/Spirit-AI-Cursor](https://github.com/BibaPutt/Spirit-AI-Cursor) · License: BSL-1.1 — see [Terms & Credits](/legal.html).`,
  },
];
