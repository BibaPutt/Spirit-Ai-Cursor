# Spirit — Privacy Policy

**Effective date:** November 5, 2026
**Applies to:** Spirit AI Cursor Companion ("Spirit", "the App") version 2.0.0-alpha.0 and all subsequent releases.

## 0. The short version

Spirit has **no telemetry, no analytics and no cloud storage**. Everything
Spirit records — settings, sessions, memory — stays in files on your machine.
The only moments data leaves your computer are moments you cause: when Spirit
sends a prompt with screen context to **the AI provider you configured**, when
you use cloud voice transcription, or when a feature fetches a web resource
at your direction. There is no Spirit server. There is no account.

---

## 1. Scope

This policy covers the Spirit desktop application on macOS, Windows and
Linux, including its built-in components (the local speech-to-text sidecar,
the OCR pipeline and the bundled input driver). It does not cover AI
providers or websites you use through Spirit; those have their own policies
and are described in section 6.

## 2. What stays on your machine (always)

| Data | Where it lives | What it is |
|------|----------------|------------|
| Settings | Electron `userData` dir, `config.json` | Preferences, provider enablement, trigger key, theme |
| API keys | Same file, **encrypted** with the OS keyring (see §4) | Your provider credentials |
| Sessions | `<workspace>/sessions/*.json` and `*.html` | Your conversation transcripts, exportable and deletable |
| Context memory | `<workspace>/context-memory.json` | Short takeaways Spirit remembers between sessions (BM25 store, max 200 entries) |
| App lessons | `userData/app-lessons.json` | Per-app quirks Spirit learns (max 8 per app) |
| Documents you save | Wherever you pick | Files Spirit writes only when you approve `save_document` |
| Dev logs | `logs/session-*.log` (development builds only) | Debug logs, auto-rotated, never in packaged builds |

The workspace folder is **picked by you** (it defaults to a folder under your
user home). Moving or deleting these files is always safe: Spirit rebuilds
what it needs.

Spirit performs these checks/data flows **entirely locally**:

- Screenshot capture and cropping — done natively on-device (GDI on Windows,
  `desktopCapturer` elsewhere). The default capture is a small region around
  your cursor (512×384 px crop at JPEG quality 80); Spirit's own overlay
  windows are excluded from captures.
- OCR (Tesseract, on-device) — reads text out of the captured image.
- UI Automation / Accessibility walks (Windows UIA, macOS AX, OCR-only on
  Linux) — builds the scene graph of the app under your cursor locally.
- Foreground app detection, clipboard reading, text-selection capture,
  cursor tracking, global hotkey handling — local observation only.
- Local speech-to-text (optional) — a faster-whisper sidecar runs on your
  machine at `127.0.0.1:5100`; audio never leaves your machine when the local
  engine is used.
- Wake-word detection ("Hey Spirit") — audio energy analysis, on-device.

## 3. What leaves your machine, when, and to where

Nothing is transmitted by Spirit on its own initiative beyond the following,
each of which you trigger by asking a question or enabling a feature:

| Feature | Destination | What is sent |
|---------|-------------|--------------|
| AI answers | The provider(s) **you** configured — OpenRouter, Anthropic, OpenAI, Gemini, or your own local/OpenAI-compatible endpoint | Your question, the context Spirit assembled (screenshot crop, clipboard/selection text, app/tab context, relevant memories), and tool results during agentic runs |
| Cloud voice transcription (optional; engine set to `cloud` or `auto` with no local sidecar) | Gemini, then OpenAI Whisper, then OpenRouter (the first that is configured) | Chunks of your microphone recording |
| Text-to-speech | Microsoft's Edge "Read Aloud" neural voice service (via `msedge-tts`) | The text Spirit speaks aloud |
| Web search / grounding | Search endpoints used by the web-grounding feature | Your search query |
| Fetching a URL (you paste a link, or approve `fetch_url`/`open_url`) | That URL | The request itself |
| Link previews & favicons | The page being previewed; Google's favicon service | The domain of the link |
| Opening a saved HTML document | jsDelivr CDN (KaTeX, Mermaid) | A request for the library files the document loads to render math and diagrams |

Key points:

- **Provider chain**: if the first configured provider fails, Spirit falls
  back down the chain you enabled (OpenRouter → Anthropic → OpenAI →
  Gemini → Local). Only providers you enabled with your own keys are in the
  chain. To keep everything on-device, disable cloud providers and use a
  local endpoint.
- Spirit adds a **web search only when asked** (a tool call that requires
  your approval, or a model feature you enabled).
- No screenshot, clipboard content, transcription or session file is ever
  uploaded to any Spirit-operated service, because **no Spirit-operated
  service exists**.

## 4. API keys and encryption

Provider API keys are stored in `config.json` inside your profile's
`userData` directory, encrypted with Electron's `safeStorage`, which uses the
operating system's credential store — macOS Keychain, Windows DPAPI or
libsecret on Linux. Keys are never logged, never transmitted anywhere except
to the provider they belong to, and a missing OS keyring is surfaced in the
app as a warning banner rather than silently falling back to plaintext.

## 5. Data retention and deletion

- **Sessions** persist in your workspace until you delete them
  (`/history` lists them; deleting the files deletes the data). Sessions are
  local files, not backups.
- **Context memory** holds at most 200 takeaways; you can view, edit and
  delete every entry from the Memory panel, and the model itself can be told
  to update or forget items. Deleting `context-memory.json` resets memory
  completely.
- **Dev logs** (development builds only) rotate automatically and never
  leave the machine.
- **Uninstalling** removes the program. Your workspace and `config.json` are
  your data; delete them to erase everything. The Windows uninstaller offers
  the standard "keep app data" choice.

## 6. Third parties you involve

When Spirit sends a prompt to a provider or fetches a URL, that third party
receives the data described above under their terms and privacy policy. We
do not receive any of it, cannot see it, and have no agreements with these
providers — they are your configuration choices. Notable third parties:

- **AI providers** (OpenRouter, Anthropic, OpenAI, Google, your local
  server) — receive prompts + context to generate answers.
- **Microsoft Edge Read Aloud** — receives text Spirit speaks for TTS.
- **Google favicon service** — receives only link domains to render
  preview icons.
- **Websites you fetch** — receive ordinary HTTP requests from your
  machine, carrying standard request metadata (e.g. your IP, as with any
  network request).

## 7. Permissions the App asks for

- **macOS**: Accessibility (to detect the trigger key system-wide), Screen
  Recording (to capture the region under your cursor), Microphone (voice
  input), Apple Events (tray coordination). Each is requested by the OS with
  a purpose string you can review in System Settings, and each can be denied
  — the corresponding feature simply degrades.
- **Windows/Linux**: no special OS permission gates; the App observes
  global input only while running, and stops when it quits.

The global input hook listens for the trigger gesture and (optionally)
wake-word-adjacent keyboard activity; it is used to detect the hold-to-ask
trigger, not to record keystrokes. Hooked input is never written to disk.

## 8. Children

Spirit is not directed at children under 13 (or the higher digital-consent
age in your jurisdiction), and we do not knowingly collect data from them —
there being no collection at all. If a child uses Spirit, the data flows are
the local ones described above plus whatever providers their configured keys
involve.

## 9. Your rights (GDPR, CCPA/CPRA, and friends)

Because Spirit processes your data **locally and only on your instruction**,
you are the controller of your own data and we act as no one's processor.
Practically, every right a data-protection law gives you — access,
portability (the files are plain JSON/HTML), rectification, erasure,
restriction — you exercise directly on your machine:

- **Access/export**: open `sessions/*.json`, `context-memory.json`,
  `config.json`.
- **Erasure**: delete the workspace folder, use the Memory panel to delete
  individual memories, or uninstall and delete app data.
- **Objection**: disable any context source (screenshot, clipboard,
  selection, memory) in settings.

If a future release ever adds any networked service operated by us, this
policy will be updated first, and that release will seek any consent the law
requires before activating it.

## 10. Security

- API keys encrypted at rest via the OS keyring (§4).
- Renderer is sandboxed with `contextIsolation` on, `nodeIntegration` off,
  and a strict CSP; the renderer has no outbound network access.
- URL fetching includes SSRF protection (DNS resolution checks and
  redirect-hop limits) so a prompt cannot make Spirit probe your local
  network.
- Documents Spirit saves pass through a strict HTML allowlist sanitizer.
- LLM-generated UI/diagram HTML is rendered from an allowlist.

No software is perfectly secure; running tools that type and click on your
behalf carries inherent risk, which is exactly why approval prompts exist
(see the Terms of Service, §5).

## 11. Changes to this policy

If our practices change, this policy changes with them and the effective
date above moves. Any change that introduces data collection beyond what is
described here will be announced in release notes and gated behind your
consent.

## 12. Contact

Privacy questions can be raised through the channel where you obtained
Spirit (the project repository or the distributor's contact address).
