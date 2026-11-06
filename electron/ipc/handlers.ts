import { app, dialog, ipcMain, screen, shell, BrowserWindow, clipboard, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { onBeforeQuit } from '../lifecycle';
import { CHANNELS } from './channels';
import { getAllOverlays, getOverlayEntries, getOverlayForDisplay, isOverlayInteractive, restoreOverlaysAfterWake, setOverlayInteractive, setAllOverlaysAlwaysOnTop, setContentProtectionEnabled, setOverlaysSkipTaskbar } from '../windows/overlay';
import { lastAIActivityAt, noteAIActivity } from '../llm/providers/round-retry';
import { getPermissions, openSystemSettings, resetScreenRecordingCache } from '../permissions';
import { endAIMode, getAIModeState, setActiveBoxBounds, setCaptureMode, startAIModeManually } from '../input/trigger';
import { setCursorTrackingNeeded } from '../input/cursor';
import { focusOverlayWindow } from '../input/focus';
import {
  getChipsChainFingerprint,
  getDecryptedChipsProviderKey,
  getDecryptedProviderKey,
  getGhostHideTaskbar,
  getGhostMode,
  getLocalAiConfig,
  getPermissionRules,
  getProvidersHealth,
  getSettings,
  getSettingsLight,
  getWorkspaceFolder,
  applyLearnedProfile,
  hasLocalAiServer,
  hasOpencodeServer,
  hasProviderKey,
  hasVisionBridgeKey,
  setSettings,
  setVisionBridgeKey,
  writeLocalAiConfig,
} from '../store/settings';
import { getAutostart, setAutostart } from '../autostart';
import { launchApp, listLaunchableApps } from '../apps/launcher';
import {
  captureAroundCursor,
  captureRectFromDisplay,
  captureScreenForSubmit,
  getCropDimensions,
  getLastNativeScreenshot,
} from '../capture/screenshot';
import { capOcrText, ocrImageB64Text, ocrRegionText } from '../capture/ocr';
import { frameHash } from '../capture/frame-hash';
import { generateChipSuggestions, summarizeSessionContext } from '../llm/chips';
import {
  cacheKeyFor,
  isReplyChipLabel,
  normalizeChipContext,
  parseNextActionsFromAnswer,
  stripAppLogNoise,
  stripReplyPayload,
  textSimilarity,
  withReplyChip,
} from '../llm/chips-parse';
import { fallbackChipsFor } from '../llm/chips-fallback';
import { parseImageRequestsFromAnswer } from '../llm/web-images-parse';
import { extractUiBlocks, resolveUiMarkers } from '../llm/custom-ui-parse';
import { liveUiFrom } from '../llm/live-ui';
import { emitWebImages, searchWebImages, setWebImagesSink } from '../llm/web-images';
import { readClipboardText } from '../capture/clipboard';
import { captureSelectedText } from '../capture/selection';
import {
  appContextTextFrom,
  captureForegroundApp,
  captureTopmostAppContext,
  conversationKindFromContext,
  enrichContextByHandle,
  isBrowserContext,
  isSelfContext,
  previewFromAppContext,
  resolveAgentTargetHwnd,
  setExternalForeground,
} from '../capture/app-context';
import {
  isAppContextWatcherRunning,
  startAppContextWatcher,
  stopAppContextWatcher,
} from '../capture/foreground-watcher';
import { forwardClickAt, forwardScroll } from '../input/actions';
import { performType } from '../input/engine';
import { PROVIDER_IDS } from '../store/secure-keys';
import { streamCompletion, type StreamHandle } from '../llm/providers/router';
import { wouldUseVisionModel } from '../llm/providers/registry';
import { detectLocalModels, testLocalAiServer, testProviderKey } from '../llm/providers/test-key';
import { detectOpencodeModels, testOpencodeServer } from '../llm/providers/test-key';
import { fetchLinkMeta } from '../llm/link-meta';
import { saveResponse, withOverlaysLowered } from '../save/save';
import { getTemplate } from '../llm/templates';
import { transcribeAudio, type TranscribeOptions } from '../voice/transcribe';
import { deleteSttModel, getActiveSttModel, getSttStatus, listSttModels, startLocalStt, switchSttModel } from '../voice/local-stt';
import { synthesizeSpeech } from '../voice/tts';
import { describeToolForUI } from '../llm/tools';
import { isHighImpactTool } from '../llm/tools/approval';
import {
  annotationImageNote,
  coversNearlyWholeFrame,
  createAnnotationScanner,
  getCurrentPointGeo,
  findUnparseableAnnotationTokens,
  imageScale,
  isArrowOutOfImageBounds,
  isBoxOutOfImageBounds,
  isOutOfImageBounds,
  isPhysicalSpaceEvidence,
  isScreenSpaceEvidence,
  mapArrowToScreen,
  mapBoxToScreen,
  mapPointToScreen,
  maskAnnotationTags,
  physicalImageScale,
  physicalSpaceConsensus,
  rescalePhysicalTagToImage,
  rescaleTagToImage,
  screenSpaceConsensus,
  beginAnnotationRuler,
  fitGeoForTag,
  getLaunchPointGeo,
  setCurrentPointGeo,
  stripAnnotations,
  type AnnotationTag,
  type PointGeo,
} from '../llm/point';
import { matchElementByLabel } from '../llm/annotation-snap';
import { agentToDip } from '../llm/annotation-resolver';
import { latexToUnicodeText } from '../llm/latex-text';
import { ocrGroundFromScreenshotB64 } from '../llm/ocr-ground';
import { mergeSceneLayers } from '../llm/scene-merge';
import { correctAnnotGroup, type ResolvedGeom } from '../llm/point-refine';
import { agentUnitsPerDip, buildScene, type SceneElement } from '../capture/scene';
import {
  detectFromBase64,
  groundingElements,
  resolveGroundingProvider,
} from '../capture/visual-grounding';
import { clearSceneElements, getSceneElements, rememberSceneElements, resolveSceneElementFrame } from '../llm/scene-cache';
import { ThoughtTagExtractor, splitThoughtTags } from '../llm/thought-tags';
import type { ScreenAnnotation } from '../types';
import {
  clearAllSessions,
  estimateTokens,
  getMaxContextTokens,
  listSessions,
  loadLatestSessionMarkdown,
  maskTurnOneOnPivot,
  newSessionId,
  persistSession,
  resolveSessionRelativePath,
  shouldPersist,
  truncateForBudget,
  truncateForBudgetKeepLast,
  type ActiveSession,
} from '../memory/sessions';
import {
  clearMemories,
  deleteMemory,
  extractProfileUpdates,
  getAllMemories,
  isContextMemoryEnabled,
  rememberTakeaways,
  splitRememberSection,
  stripMemoryBlock,
  updateMemory,
  withMemoryBlock,
  type ExtractedMemory,
} from '../memory/contextMemory';
import { appLessonsBlockFor, clearAppLessons, stripAppLessonsBlock, touchAppLessons } from '../memory/app-lessons';
import { noteSubmit, clearPreferences, preferencesLine } from '../memory/preferences';
import { buildMessages, buildUserProfileLine, withUserProfileLine, SYSTEM_PROMPT, type ContentBlock, type Message } from '../llm/prompt';
import { initSkillsRuntime, getSkillsCatalog, setSkillEnabled, promptWithSkills } from '../llm/skills';
import { describeScreenshot, isVisionBridgeEnabled, SUBMIT_TIMEOUT_MS } from '../llm/vision-bridge';
import {
  classifyScreenRelevance,
  classifyTopicPivot,
  SCREEN_ANNOTATION_ASK_RE,
} from '../llm/relevance';

// First-turn directive (deterministic, computed in main). Weak local models
// ignore the system-prompt "screen is only context" rule, so when the user's
// first question does not reference the screen, this note rides with the
// question text itself. Follow-up turns send the prompt verbatim — no
// per-turn notes, so the conversation keeps its natural flow.
const SCREEN_UNRELATED_NOTE =
  "[The user's question does not reference what is on their screen. Answer the question itself — treat the on-screen context as irrelevant unless the question explicitly asks about it.]";
import type {
  AppContext,
  AttachedFile,
  CursorPosition,
  ProviderId,
  ProviderSettings,
  Settings,
  SuggestionChip,
  TemplateId,
  ToolActivity,
  ToolApprovalRequest,
  WebImage,
} from '../types';

// Visual grounding (Phase: OmniParser sidecar / GroundingDINO ONNX). Lazy:
// provider resolved once on first need; detections cached per screenshot
// geometry so multi-group runs reuse one inference. Entirely skipped when the
// disabled flag is set or no provider is installed.
let groundingProvider: Awaited<ReturnType<typeof resolveGroundingProvider>> | null = null;
const groundingCache = new Map<string, Promise<SceneElement[] | null>>();
const groundingEnabled = (): boolean => process.env.SPIRIT_VISUAL_GROUNDING !== '0';

// Detect screen elements for a screenshot geometry from the live provider.
// Returns scene-space elements (same grid as UIA/OCR), or null when disabled /
// unavailable. The outer promise is cached so identical geometries share the
// inference; duplicate groups resolve off the same promise.
function groundedElementsFor(imageB64: string, geo: PointGeo): Promise<SceneElement[] | null> {
  const key = `${geo.imgW}x${geo.imgH}@${geo.absLeft},${geo.absTop}:${geo.winW}x${geo.winH}` +
    (geo.region ? `:r${geo.region.x},${geo.region.y},${geo.region.w},${geo.region.h}` : '');
  const cached = groundingCache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<SceneElement[] | null> => {
    if (!groundingEnabled()) return null;
    if (!groundingProvider) groundingProvider = await resolveGroundingProvider();
    if (groundingProvider.source === 'none') return null;
    const objects = await detectFromBase64(groundingProvider, imageB64, geo.imgW, geo.imgH);
    if (!objects || objects.length === 0) return null;
    console.log(
      `[annotate] grounding: ${objects.length} frame(s) via ${groundingProvider.source}` +
        ` (${groundingProvider.lastError() ?? 'ok'})`,
    );
    return groundingElements(objects, geo);
  })();
  groundingCache.set(key, promise);
  return promise;
}

let currentStream: StreamHandle | null = null;

// One submitted run: stream handle, cancel flag, and exactly-once terminal.
// Chunks/finals/errors check `cancelled` so a superseded run's late events
// can never pollute the fresh run's UI.
type StreamRun = {
  id: string;
  stream: StreamHandle | null;
  cancelled: boolean;
  terminalSent: boolean;
  sendDone: () => void;
  sendError: (message: string, code?: unknown) => void;
  // Terminal for a run that streamed text and then failed: the renderer keeps
  // the partial answer and offers Continue/Retry instead of an empty error.
  sendInterrupted: (message: string, code?: unknown, partialText?: string) => void;
};
let currentStreamRun: StreamRun | null = null;
let pendingScreenshot: {
  b64: string;
  ts: number;
  // Set for a user-dragged selection rectangle: the rect + display key the
  // image came from, so runQuery can build a real image→screen geometry for
  // it (annotation tags land on the rect instead of being dropped).
  rect?: { x: number; y: number; width: number; height: number };
  displayId?: number;
} | null = null;
let pendingScreenshotError: string | null = null;
// In-flight lazy screenshot capture, so an instant submit can await it instead
// of silently dropping the screenshot. Always resolves (never rejects) — the
// outcome lands in pendingScreenshot / pendingScreenshotError.
let pendingScreenshotPromise: Promise<void> | null = null;
// OCR text of the pending screenshot, computed fire-and-forget at capture time.
// Text-only models can't see the attached image, so the first-turn prompt also
// carries this readback so they can still "see" the screen. Guarded by the same
// capture generation so a stale read can never outlive its capture.
let pendingScreenshotOcr: string | null = null;
let pendingScreenshotOcrPromise: Promise<void> | null = null;
// Monotonic capture generation. Bumped on every new capture AND on clear, so a
// capture that outlives its trigger/session (e.g. a lazy capture still running
// when the user dismisses and re-triggers) can never overwrite the newer one.
let pendingScreenshotCaptureId = 0;
// True when the pending screenshot came from the user dragging a selection
// rectangle (deliberate scoping) rather than the auto cursor-crop. The submit
// flow must never override a manual selection with a fresh auto-capture.
let pendingScreenshotManual = false;
let pendingClipboard: string = '';
// Set when a drag-rectangle selection capture lands BEFORE a session is
// active. The next session-start consumes the flag and marks the session
// `suppressClipboardOnce`, so the first turn ignores clipboard. Without
// this guard the deliberately-scoped screenshot got mixed with stray
// clipboard text and the LLM would conflate "what I drew a box around"
// with "what I had in my clipboard".
let pendingSuppressClipboard = false;
// When the user clicks the X on the clipboard chip we remember the exact text
// they dismissed. The 400ms poller treats that text as "already seen" so it
// doesn't keep re-pushing the same clipboard into the box. As soon as the
// clipboard *changes* (user copies something new), the dismissed flag clears
// and the new value gets surfaced again. Submits while dismissed go in WITHOUT
// clipboard context so the LLM doesn't get text the user explicitly hid.
let dismissedClipboard: string | null = null;
// Text the user had selected on screen when the box opened (captured via
// UIA or the Ctrl+C fallback). Auto-attached to the prompt — no opt-in
// toggle, mirroring Python spirit. Clicking the X on the selected-text
// bubble sets selectionSuppressed so this session ignores it.
let pendingSelection: string = '';
let selectionSuppressed = false;
// Paint-to-select regions: while the box is open the user can drag a box over
// anything on screen; each committed region is OCR'd and appended here (in
// order). Main is authoritative for the prompt — the renderer's bubble row is
// purely visual and mirrors this list via the paint:capture / paint:remove
// IPC. Cleared when AI mode ends, like the other pending contexts.
let pendingPaintSelections: {
  id: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
}[] = [];

export function clearPendingPaintSelections(): void {
  pendingPaintSelections = [];
}

export function removePendingPaintSelection(id: string): void {
  pendingPaintSelections = pendingPaintSelections.filter((p) => p.id !== id);
}

import {
  attachedImages,
  attachedTextBlock,
  mimeForExt,
  readAttachedFiles,
  type AttachedItem,
} from '../files/attach';

// Dropped-file attach: files the user drags onto the prompt box, read by
// main at drop time (text inline, images as vision blocks). Persists until
// dismissed or the session ends — like the text selection, but explicit.
let pendingAttached: AttachedItem[] = [];

export function clearPendingAttached(): void {
  pendingAttached = [];
}

// Action suggestion chips. Generated from TEXT ONLY (OCR
// of the current region + on-screen selection + foreground app/tab) via the
// active provider — no screenshot, no vision tokens, no tools. Smartly cached
// so "same content" never costs an LLM call:
//   - exact hit on the normalized context hash → reuse (re-selecting the same
//     region/app is free),
//   - fuzzy hit (normalized edit distance ≥ threshold) → reuse (OCR jitter,
//     tiny tab-title churn),
//   - otherwise one fast-tier call, then cache + persist to disk so a fresh
//     app run reuses yesterday's suggestions for the same context.
// A monotonic token invalidates a still-running generation the moment the
// user submits, dismisses, or re-selects.
let chipsToken = 0;
type ChipsCacheEntry = { norm: string; sessionCtx: string; chainFp: string; chips: SuggestionChip[] };
const chipsCache = new Map<string, ChipsCacheEntry>();
const CHIPS_CACHE_MAX = 40;
const CHIPS_FUZZY_THRESHOLD = 0.93;
let chipsCacheLoaded = false;
// Set synchronously the moment the quit-time memory wipe starts, so a late
// chips generation or session end during teardown can't re-create a file we
// just deleted.
let quitMemoryWipeDone = false;

function chipsCacheFile(): string {
  try {
    return join(app.getPath('userData'), 'chip-cache.json');
  } catch {
    return '';
  }
}

function loadChipsCache(): void {
  if (chipsCacheLoaded) return;
  chipsCacheLoaded = true;
  const file = chipsCacheFile();
  if (!file) return;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as Array<{
      k: string;
      n?: string;
      s?: string;
      f?: string;
      c: SuggestionChip[];
    }>;
    if (!Array.isArray(data)) return;
    for (const e of data) {
      if (!e || typeof e.k !== 'string' || !Array.isArray(e.c)) continue;
      chipsCache.set(e.k, {
        norm: typeof e.n === 'string' ? e.n : '',
        sessionCtx: typeof e.s === 'string' ? e.s : '',
        chainFp: typeof e.f === 'string' ? e.f : '',
        chips: e.c.slice(0, 3),
      });
      if (chipsCache.size >= CHIPS_CACHE_MAX) break;
    }
  } catch {
    /* no cache yet / unreadable — start empty */
  }
}

function persistChipsCache(): void {
  if (quitMemoryWipeDone) return;
  const file = chipsCacheFile();
  if (!file) return;
  try {
    // Privacy: only the sha1 key (`k`), provider fingerprint and the chips
    // themselves go to disk. The raw screen text (`n`) and the conversation
    // summary (`s`) stay in memory for exact/fuzzy reuse this run — writing
    // them persisted unredacted screen + chat content in chip-cache.json.
    // Legacy files that still carry n/s are re-written sanitized on the
    // next generation; a loaded entry with no raw text simply can't win the
    // fuzzy loop (similarity vs '' is 0), exact-key hits still work.
    const data = [...chipsCache.entries()].map(([k, v]) => ({ k, f: v.chainFp, c: v.chips }));
    writeFileSync(file, JSON.stringify(data), 'utf-8');
  } catch {
    /* disk write failure is non-fatal */
  }
}

// Region the current chips were derived from (cursor-centered at box-open, or
// the user's drag rectangle). Re-OCR'd — and regenerated — when the foreground
// app or tab changes while the box is open.
let lastChipsRect: {
  rect: { x: number; y: number; width: number; height: number };
  displayId: number;
} | null = null;

// AI-mode end: drop the region reference AND invalidate any in-flight
// generation so a stale run can't leak into the next session.
export function clearPendingChips(): void {
  chipsToken++;
  nextChipsToken++;
  lastChipsRect = null;
  lastChipsRegionText = null;
}

// Submit / stream start: invalidate in-flight generations only. The region
// reference stays so app-switch regeneration can still reuse it.
export function cancelPendingChips(): void {
  chipsToken++;
  // The line under the box stops sweeping the moment the user submits.
  broadcastChipsPending(false);
}

// Post-response "next actions" chips: token-invalidated like the region chips.
let nextChipsToken = 0;

function cancelPendingNextChips(): void {
  nextChipsToken++;
  // A submit clears the old "next actions" row immediately.
  broadcastNextChips([]);
}

// Post-response web images. The model never touches URLs — it writes up to
// three plain `[IMAGE] <subject>` lines, and main searches the real backends
// here, then pushes the pictures to the renderer (they appear above the
// answer). `webImagesArmed` is true only while a run is active, so a broadcast
// can never repaint after a cancel or once the run has finished.
let webImagesToken = 0;
let webImagesArmed = false;

function cancelPendingWebImages(): void {
  webImagesToken++;
  webImagesArmed = false;
  broadcastWebImages([]);
}

function broadcastChipsResult(chips: SuggestionChip[]): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.ChipsResult, chips);
  }
}

// Offline premade chips. Deliberately a DIFFERENT channel from ChipsResult so
// the renderer can show them without clearing the pending underline — the
// sweep stays on until the real AI chips land.
function broadcastChipsFallback(chips: SuggestionChip[]): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.ChipsFallback, chips);
  }
}

// Drives the accent underline sweep under the box while a generation round is
// in flight. Broadcast to every overlay (only the one showing the box renders
// it).
function broadcastChipsPending(pending: boolean): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.ChipsPending, pending);
  }
}

function broadcastNextChips(chips: SuggestionChip[]): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.NextChipsResult, chips);
  }
}

function broadcastWebImages(images: WebImage[]): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.WebImagesResult, images);
  }
}

// The user's preferred reply language, when set, rides on every reply/respond
// chip so the tapped action answers in that language (the chat context on
// screen is always allowed to win). No language → chips unchanged.
function patchReplyLanguage(chips: SuggestionChip[], language: string): SuggestionChip[] {
  const lang = (language ?? '').trim();
  if (!lang) return chips;
  return chips.map((c) =>
    isReplyChipLabel(c.label)
      ? { ...c, prompt: `${c.prompt}\nReply in ${lang} unless the conversation itself is in another language.` }
      : c,
  );
}

// The renderer's image row is fed exclusively through emitWebImages; forward
// them, but only while a run is active.
setWebImagesSink((images) => {
  if (webImagesArmed) broadcastWebImages(images);
});

function buildChipContext(regionText: string): string {
  const appCtx = lastAppContext ? appContextTextFrom(lastAppContext) : '';
  const selection = selectionSuppressed ? '' : pendingSelection;
  // The OCR region and the on-screen selection can capture the app's OWN debug
  // log (the dev console the app runs from); strip that noise before it
  // reaches the chip model, or the model echoes its previous outputs back.
  const region = stripAppLogNoise(regionText);
  const sel = stripAppLogNoise(selection);
  return [region, sel, appCtx].map((s) => s.trim()).filter(Boolean).join('\n\n');
}

// How long before the offline premade chips fade in on a cache miss, so a
// tab/app change doesn't swap the chips to instant content — the pending
// underline sweeps first, then the premade chips appear, like a real round.
const CHIPS_FALLBACK_DELAY_MS = 2000;
// Rapid-switch throttle: when the user flips apps/tabs at least this many
// times within the window, the AI generation round is held back a beat. A
// switch every second gets superseded a second later, so firing one model call
// per flip burns tokens for chips that never get seen — the delay coalesces the
// storm into one real generation (the renderer shows premade chips + the
// progress underline while it waits).
const CHIPS_RAPID_SWITCH_THRESHOLD = 4;
const CHIPS_RAPID_SWITCH_WINDOW_MS = 5000;
const CHIPS_RAPID_AI_DELAY_MS = 2500;

// Region OCR text from the current box-open, captured once at launch and reused
// by same-window app-context regenerations (pure enrichment: fields filling in,
// no window/tab change) so they don't re-capture the same region.
let lastChipsRegionText: string | null = null;
// Consecutive quick app/tab switches (see regenerateChipsOnAppChange). Drives
// the rapid-switch AI throttle above.
let rapidSwitchCount = 0;
let lastRapidSwitchAt = 0;

async function generateChipsFrom(regionText: string): Promise<void> {
  broadcastChipsPending(true);
  const norm = normalizeChipContext(buildChipContext(regionText));
  if (!norm) {
    console.warn('[chips] empty context, no chips');
    broadcastChipsResult([]);
    broadcastChipsPending(false);
    return;
  }
  console.log(`[chips] region ${frameHash(regionText)}`);
  const token = ++chipsToken;
  // "A bit of summarised context": the running session's last few exchanges
  // condensed, so one chip can continue the task the user is mid-way through.
  const sessionCtx = activeSession ? summarizeSessionContext(activeSession.messages) : '';
  console.log(`[chips] sessionCtx=${sessionCtx ? frameHash(sessionCtx) : '(none)'}`);
  // Which provider chain chips currently resolve to. Part of the cache key so
  // switching providers (or the main/chips toggle) invalidates chips that were
  // generated under the old chain.
  const chainFp = getChipsChainFingerprint();
  console.log(`[chips] chainFp=${chainFp}`);
  // Cache key includes the session context: the same screen with a different
  // conversation must NOT reuse chips built for the earlier conversation.
  const key = cacheKeyFor(`${chainFp}\u0001${sessionCtx ? `${norm}\u0001${sessionCtx}` : norm}`);
  loadChipsCache();
  // Deterministic reply-chip guarantee: when a chat/email is on screen, the
  // "Suggest a reply" chip is enforced regardless of what the chip model emitted.
  const conversation = lastAppContext ? conversationKindFromContext(lastAppContext) : null;

  let chips: SuggestionChip[] | null = null;
  const cached = chipsCache.get(key);
  if (cached) {
    chips = cached.chips;
  } else {
    // Fuzzy reuse: a normalized context within the similarity threshold IS the
    // same content (OCR jitter, a tab title that changed by a word) — skip the
    // LLM call and reuse the closest cached suggestions. The conversation
    // context must match exactly — a different conversation is never "the same
    // content" no matter how similar the screen text.
    for (const entry of chipsCache.values()) {
      if (entry.chainFp === chainFp && entry.sessionCtx === sessionCtx && textSimilarity(norm, entry.norm) >= CHIPS_FUZZY_THRESHOLD) {
        chips = entry.chips;
        break;
      }
    }
    if (chips === null) {
      // Offline placeholder: on a cache miss, schedule the premade chips so the
      // row is never empty while the generation round is in flight. The short
      // delay keeps a tab/app change from swapping to instant content — the
      // pending underline sweeps first, then the premade chips appear. This
      // broadcast NEVER clears pending (separate channel), so the underline
      // stays until the AI result lands and replaces them. Token-guarded, and
      // cancelled if the real result publishes first.
      const light = getSettingsLight();
      const instant = withReplyChip(
        fallbackChipsFor(norm, {
          translateTo: light.userProfile.translateLanguage,
          calendarProvider: light.calendarProvider,
        }),
        conversation,
      );
      let fallbackSent = false;
      setTimeout(() => {
        if (token === chipsToken && !fallbackSent) {
          fallbackSent = true;
          broadcastChipsFallback(patchReplyLanguage(instant, light.userProfile.preferredLanguage));
        }
      }, CHIPS_FALLBACK_DELAY_MS);
      // Rapid-switch throttle: after several quick app/tab flips, hold the AI
      // round back a beat so flitting doesn't spawn a superseded generation per
      // switch. The renderer keeps showing the premade chips + progress
      // underline while it waits; the next switch cancels this round (token
      // guard below), so only the settled context actually generates.
      if (rapidSwitchCount >= CHIPS_RAPID_SWITCH_THRESHOLD) {
        await new Promise((resolve) => setTimeout(resolve, CHIPS_RAPID_AI_DELAY_MS));
      }
      if (token !== chipsToken) return;
      try {
        chips = await generateChipSuggestions(norm, sessionCtx);
      } catch (err) {
        console.error('[chips] generation failed:', err);
        chips = [];
      }
      if (token !== chipsToken) return;
      // Generation failed or produced nothing → keep the offline premade row
      // instead of wiping the chips that were already on screen.
      if (!chips.length) chips = instant;
      // The real result is about to be published; drop the pending fallback
      // broadcast so it can't clobber the freshly-arrived AI chips.
      fallbackSent = true;
    }
    chips = withReplyChip(chips, conversation);
    chipsCache.set(key, { norm, sessionCtx, chainFp, chips });
    if (chipsCache.size > CHIPS_CACHE_MAX) {
      const oldest = chipsCache.keys().next().value;
      if (oldest !== undefined) chipsCache.delete(oldest);
    }
    persistChipsCache();
  }

  if (token === chipsToken) {
    const final = withReplyChip(chips, conversation);
    console.log(
      `[chips] result: ${final.map((c) => `"${c.label}"`).join(', ') || '(none)'} | source=${
        cached ? 'cache' : 'generated'
      }`,
    );
    broadcastChipsResult(patchReplyLanguage(final, getSettingsLight().userProfile.preferredLanguage));
  }
  broadcastChipsPending(false);
}

// Post-response "next actions": the main answer's model already appended a
// [NEXT_ACTIONS] block. We strip it out of the text sent to the renderer and
// publish the parsed chips — NO extra LLM call. Synchronous so it runs in
// onFinalAnswer, right before the clean answer is delivered.
function publishNextChipsFromAnswer(rawAnswer: string): string {
  if (getSettingsLight().chipVisibility === 'off') {
    // Setting off: still strip the block so it never shows, but show no row.
    const { cleanText } = parseNextActionsFromAnswer(rawAnswer);
    return cleanText;
  }
  const token = ++nextChipsToken;
  const { chips, cleanText } = parseNextActionsFromAnswer(rawAnswer);
  if (token === nextChipsToken) broadcastNextChips(chips);
  return cleanText;
}

// Post-response cleanup: parse any `[IMAGE] <subject>` lines the model wrote,
// strip them from the answer text, and search the real backends for each
// subject — the pictures are pushed to the renderer and shown above the
// answer. A subject is only a search query, never a URL, so the model cannot
// fabricate links. Returns the answer text with all image lines removed.
async function stripWebImagesFromAnswer(rawAnswer: string): Promise<string> {
  const { subjects, cleanText } = parseImageRequestsFromAnswer(rawAnswer);
  if (webImagesArmed && subjects.length > 0) {
    for (const subject of subjects) {
      const images = await searchWebImages(subject);
      if (images.length > 0) emitWebImages(images);
    }
  }
  return cleanText;
}

// Cursor-centered chips region, same dims as the screenshot crop. Rect is
// work-area local (like the renderer's drag rects), which
// captureRectFromDisplay / cropRectFromThumb expect.
function chipsRegionAt(
  cursor: { x: number; y: number },
  display: Electron.Display,
): { rect: { x: number; y: number; width: number; height: number }; displayId: number } {
  const { w, h } = getCropDimensions();
  const wa = display.workAreaSize;
  const ax = cursor.x - display.workArea.x;
  const ay = cursor.y - display.workArea.y;
  return {
    rect: {
      x: Math.max(0, Math.min(wa.width - w, Math.round(ax - w / 2))),
      y: Math.max(0, Math.min(wa.height - h, Math.round(ay - h / 2))),
      width: w,
      height: h,
    },
    displayId: display.id,
  };
}

// Box-open: cursor-centered region, same dims as the screenshot crop. Called
// from main.ts onStart shortly after the box appears. Rect is work-area local
// (like the renderer's drag rects), which ocrRegionText/captureRectFromDisplay
// expect.
export function beginSuggestionChips(cursor: { x: number; y: number }): void {
  if (getSettingsLight().chipVisibility === 'off') return;
  const display = screen.getDisplayNearestPoint(cursor);
  lastChipsRect = chipsRegionAt(cursor, display);
  void regenerateChipsFromRegion();
}

async function regenerateChipsFromRegion(): Promise<void> {
  const region = lastChipsRect;
  if (!region) return;
  const { text } = await ocrRegionText(region.rect, region.displayId);
  await generateChipsFrom(text ?? '');
}

// Box-open lazy work: capture the trigger screenshot for the preview chip and
// one region OCR for the suggestion chips. On Windows BOTH captures run in the
// persistent GDI worker (native path), so the main thread — which drives the
// 33ms cursor heartbeat — is never blocked by desktopCapturer. The AI-bound
// screen TEXT is NOT OCR'd here: it's read fresh at SUBMIT time (runQuery →
// captureScreenForSubmit + ocrImageB64Text), so the model always sees the
// current screen, never the stale trigger-time crop. The suggestion chips DO
// get one region OCR at launch (cached in lastChipsRegionText) because they
// must suggest live content — and regenerateChipsOnAppChange re-OCRs again
// when the user switches app or tab so the chips follow what's on screen now.
// Falls back to the original desktopCapturer per-call paths when the native
// read fails, so their specific error messages still surface.
export async function runLaunchCapture(
  cursor: { x: number; y: number },
): Promise<void> {
  const display = screen.getDisplayNearestPoint(cursor);
  const wantChips = getSettingsLight().chipVisibility !== 'off';
  pendingScreenshot = null;
  pendingScreenshotError = null;
  pendingScreenshotManual = false;
  // Generation taken up front: a clear/re-trigger while the capture is in
  // flight invalidates this run, exactly like capturePendingScreenshot.
  const gen = ++pendingScreenshotCaptureId;

  const cursorCrop = await captureAroundCursor(cursor);
  if (gen !== 0 && gen !== pendingScreenshotCaptureId) return;

  if (cursorCrop) {
    pendingScreenshot = { b64: cursorCrop, ts: Date.now() };
  } else {
    pendingScreenshotError = 'Screen capture returned empty.';
  }

  if (wantChips) {
    lastChipsRect = chipsRegionAt(cursor, display);
    // One region OCR for the chips (reused by same-window context
    // regenerations). Captured via the same native path.
    const regionB64 = await captureRectFromDisplay(lastChipsRect.rect, lastChipsRect.displayId);
    void (async () => {
      const text = regionB64 ? await ocrImageB64Text(regionB64) : '';
      if (gen !== 0 && gen !== pendingScreenshotCaptureId) return;
      lastChipsRegionText = text || null;
      await generateChipsFrom(text || '');
    })();
  }
}

// Foreground app/window/tab changed while the box is open (watcher →
// updateAppContext): regenerate the chips so they suggest live content for
// whatever the user is in now.
async function regenerateChipsOnAppChange(
  prev: AppContext | null,
  next: AppContext | null,
): Promise<void> {
  if (currentStream) return;
  if (getSettingsLight().chipVisibility === 'off') return;
  const windowKey = (a: AppContext | null) => (a ? `${a.pid}|${a.hwnd ?? ''}` : '');
  const tabKey = (a: AppContext | null) => (a ? `${a.url ?? ''}|${a.activeTab ?? ''}` : '');
  // Different window OR tab → the region on screen shows different content →
  // re-OCR it so the chips follow. (Tab switches reuse the same window, so the
  // URL/tab identity is the live-content discriminator.)
  if (windowKey(prev) !== windowKey(next) || tabKey(prev) !== tabKey(next)) {
    // Count consecutive quick switches (within the window) for the AI throttle.
    const now = Date.now();
    rapidSwitchCount =
      now - lastRapidSwitchAt <= CHIPS_RAPID_SWITCH_WINDOW_MS ? rapidSwitchCount + 1 : 1;
    lastRapidSwitchAt = now;
    // Hide the previous context's chips IMMEDIATELY — the box never shows stale
    // suggestions for the app the user just left. The pending underline starts
    // sweeping now and the premade chips fade in ~2s later (generateChipsFrom),
    // so the switch reads as "re-loading" rather than a flicker swap.
    broadcastChipsPending(true);
    broadcastChipsFallback([]);
    await regenerateChipsFromRegion();
    return;
  }
  // Same window + same tab, just fields filling in (e.g. the trigger-time URL
  // walk landing): reuse the launch region OCR — no re-capture.
  if (lastChipsRegionText) await generateChipsFrom(lastChipsRegionText);
}
// Foreground-app context (which app + tab the user is in). Captured ONCE at
// trigger time (BEFORE the overlay takes focus, so it reads the app the user
// was actually in), then kept fresh by foreground-watcher.ts WHILE the box is
// open (1s cadence, self-skipping). Submits read `lastAppContext` directly —
// no blocking subprocess on the send path, and never Spirit itself.
let lastAppContext: AppContext | null = null;
// Last preview actually broadcast to the renderer, so re-broadcasting the
// same app/tab (e.g. every watcher tick while the user stays put) is a no-op
// instead of waking the renderer chip once per second.
let lastBroadcastAppPreview: string | null = null;
// The app-context key of the last turn whose history was actually COMMITTED to
// the active session (set in onDone, not at submit). Conflicting-observation
// self-invalidation: the next submit compares its fresh snapshot against this
// and, when they differ, tells the model the CURRENT context is authoritative
// over whatever app/tab earlier turns in the conversation showed.
let lastTurnAppContextKey = '';

// Compact identity of an app-context snapshot used to detect that the user
// switched app/window/tab between turns. url+activeTab are included because a
// tab switch is a real context change even when the process/title barely move.
function appContextKey(ctx: AppContext): string {
  return [ctx.process, ctx.title, ctx.url ?? '', ctx.activeTab ?? ''].join('|');
}

// Re-label a re-used context so the LLM is told it is approximate, not a live
// read. Returns a copy — the stored snapshot itself keeps its original
// provenance.
function staleCopyOf(ctx: AppContext): AppContext {
  return { ...ctx, source: 'fallback', stale: true };
}
let activeSession: ActiveSession | null = null;

// True when a fresh trigger (wiggle / hotkey / right-hold) opened the box since
// the last submit. Context-isolation rule: every box-open is a NEW task, so a
// stale goal (e.g. a hidden "Suggest a reply" prompt) can never leak into a
// question the user asks on another screen. Only a short continuation fragment
// ("ok", "windows", "the second one") resumes the previous session. Cleared on
// submit so follow-ups typed into the still-open box always continue the
// session.
let triggerOpenedSinceSubmit = false;

export function noteTriggerOpened(): void {
  triggerOpenedSinceSubmit = true;
}

const pendingApprovals = new Map<string, (approved: boolean) => void>();

// Auto-deny timer for each pending approval. The approval card is
// non-blocking UI; without a deadline a stuck/abandoned run would leave the
// tool-call promise hanging forever (and its caller parked). 60s is generous
// for a human to read the card and hit ✓/✗.
const APPROVAL_TIMEOUT_MS = 60_000;
const approvalTimeouts = new Map<string, NodeJS.Timeout>();

function denyPendingApprovals(): void {
  for (const [id, resolve] of pendingApprovals) {
    const timer = approvalTimeouts.get(id);
    if (timer) clearTimeout(timer);
    pendingApprovals.delete(id);
    approvalTimeouts.delete(id);
    resolve(false);
  }
}

// Per-provider API-key prefix + minimum-length validation. Catches the
// "I typed a placeholder and Save accepted it" case the user hit on
// macOS dev. Keys that pass this check are still verified end-to-end
// by the Test button (provider:test-key IPC) — the prefix check is a
// fast first-pass shape check, not an authenticity check.
function validateProviderKey(
  provider: ProviderId,
  apiKey: string,
): { ok: true } | { ok: false; error: string } {
  const key = (apiKey ?? '').trim();
  // Local AI keys are optional and vary by server (LM Studio may accept any
  // non-empty string, llama.cpp a token, Ollama none) — skip the shape checks.
  if (provider !== 'localai' && key.length < 16) {
    return { ok: false, error: 'API key looks too short. Paste the full key.' };
  }
  switch (provider) {
    case 'openrouter':
      // OpenRouter keys are `sk-or-v1-…` (current) and historical `sk-or-…`.
      if (!/^sk-or-/.test(key)) {
        return { ok: false, error: 'OpenRouter keys start with "sk-or-".' };
      }
      break;
    case 'anthropic':
      if (!/^sk-ant-/.test(key)) {
        return { ok: false, error: 'Anthropic keys start with "sk-ant-".' };
      }
      break;
    case 'openai':
      // OpenAI tokens: `sk-…` or org-scoped `sk-proj-…`. Reject anything
      // else so a paste-error doesn't end up encrypted into the store.
      if (!/^sk-/.test(key)) {
        return { ok: false, error: 'OpenAI keys start with "sk-".' };
      }
      break;
    case 'gemini':
      // Google AI Studio API keys are alphanumeric+dashes, typically
      // 39 chars and start with "AIza". Be a bit lenient on length.
      if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) {
        return { ok: false, error: 'Gemini keys are 20+ alphanumeric chars.' };
      }
      break;
    case 'localai':
      // Local AI keys are optional and vary by server (LM Studio may accept
      // any non-empty string, llama.cpp may want an admin token, Ollama none).
      // There is no universal shape to check — skip validation entirely.
      break;
  }
  return { ok: true };
}

// Rolling session window: the conversation survives the box closing, so a
// follow-up answer like "windows" lands in the SAME session (with the model's
// own previous question in context) instead of starting fresh and getting
// re-asked. Every submit extends the window again — as long as the user keeps
// using the task, the session never expires. Only an explicit close / app
// quit / a full TTL of inactivity ends it.
const SESSION_IDLE_TTL_MS = 120_000;
let sessionEndTimer: NodeJS.Timeout | null = null;

function clearSessionEndTimer(): void {
  if (sessionEndTimer) {
    clearTimeout(sessionEndTimer);
    sessionEndTimer = null;
  }
}

// Restart the idle timer so the current session stays alive for another TTL.
// Called on every submit and on trigger end.
export function extendSessionWindow(): void {
  if (!activeSession) return;
  clearSessionEndTimer();
  sessionEndTimer = setTimeout(() => {
    sessionEndTimer = null;
    void finalizeActiveSession();
  }, SESSION_IDLE_TTL_MS);
}

function startNewSession(imageB64: string, clip: string, screenshotOcr = ''): void {
  clearSessionEndTimer();
  // A fresh session has no committed turns — the previous session's context
  // key must not trigger an invalidation note on the new session's first turn.
  lastTurnAppContextKey = '';
  activeSession = {
    id: newSessionId(),
    startedAt: Date.now(),
    imageB64,
    screenshotOcr,
    clipboard: clip,
    selection: '',
    messages: [],
    firstPrompt: '',
    turnCount: 0,
    templateId: null,
    web: false,
  };
}

async function endActiveSession(): Promise<void> {
  clearSessionEndTimer();
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  if (session.turnCount === 0) return;
  if (shouldPersist() && !quitMemoryWipeDone) {
    await persistSession(session);
  }
}

// /clear: hard reset of the CURRENT session + its context. Stops any in-flight
// stream/chips, drops every piece of pending context so the next submit
// recaptures fresh (screenshot, clipboard, selection), invalidates in-flight
// captures via generation bump, and wipes the recalled long-term context
// memory — otherwise a fact learned earlier (the "cow" case) keeps getting
// re-injected into unrelated questions by withMemoryBlock.
export async function resetCurrentSession(): Promise<void> {
  cancelCurrentStream();
  cancelPendingChips();
  cancelPendingNextChips();
  clearSessionEndTimer();
  activeSession = null;
  triggerOpenedSinceSubmit = false;
  lastTurnAppContextKey = '';
  pendingScreenshot = null;
  pendingScreenshotError = null;
  pendingScreenshotOcr = null;
  pendingScreenshotManual = false;
  pendingScreenshotCaptureId++;
  pendingClipboard = '';
  dismissedClipboard = null;
  pendingSuppressClipboard = false;
  pendingSelection = '';
  selectionSuppressed = false;
  clearPendingPaintSelections();
  clearPendingAttached();
  clearSceneElements();
  broadcastNextChips([]);
  try {
    await clearMemories();
  } catch {
    /* memory wipe is best-effort — never fail /clear over it */
  }
}

export function triggerAIModeFromMenu(): void {
  // Bring at least one overlay to front and start AI mode as if uiohook
  // detected the long-press. This is what the tray icon uses.
  startAIModeManually();
}

export function cancelCurrentStream(): void {
  // Run-aware cancel: the superseded run is marked so its late chunks never
  // pollute the fresh run, and a terminal is always sent so the UI closes.
  const run = currentStreamRun;
  if (run) {
    run.cancelled = true;
    if (run.stream) {
      console.log('[chips/ai] cancelling in-flight stream');
      try {
        run.stream.cancel();
      } finally {
        run.sendDone();
      }
    } else {
      run.sendDone();
    }
  } else if (currentStream) {
    console.log('[chips/ai] cancelling in-flight stream');
    currentStream.cancel();
    currentStream = null;
    broadcastToOverlays(CHANNELS.LLMDone, { runId: randomUUID() });
  }
  // Aborting the run leaves any unanswered approval cards orphaned — deny
  // them so their tool promises resolve (false) instead of hanging forever.
  denyPendingApprovals();
  // Clear the web-image row too: a cancel (ESC, ✕, or a new submit) must not
  // leave the previous run's pictures up.
  cancelPendingWebImages();
}

// Fire-and-forget OCR of a captured screenshot, used as a text fallback for
// models that can't see images. Runs in parallel with the user typing their
// prompt; submit awaits it (capped) only if still in flight. Guarded by the
// capture generation so a stale read is never stored.
function kickPendingScreenshotOcr(b64: string, captureId: number): Promise<void> {
  pendingScreenshotOcr = null;
  pendingScreenshotOcrPromise = (async () => {
    try {
      const text = await ocrImageB64Text(b64);
      if (captureId !== pendingScreenshotCaptureId) return;
      pendingScreenshotOcr = text || null;
    } catch {
      pendingScreenshotOcr = null;
    }
  })();
  return pendingScreenshotOcrPromise;
}

export async function capturePendingScreenshot(cursor: { x: number; y: number }): Promise<void> {
  pendingScreenshot = null;
  pendingScreenshotError = null;
  pendingScreenshotManual = false;
  const captureId = ++pendingScreenshotCaptureId;
  const run = (async (): Promise<void> => {
    try {
      const b64 = await captureAroundCursor(cursor);
      if (captureId !== pendingScreenshotCaptureId) return;
      pendingScreenshot = { b64, ts: Date.now() };
      kickPendingScreenshotOcr(b64, captureId);
    } catch (err) {
      if (captureId !== pendingScreenshotCaptureId) return;
      pendingScreenshotError = err instanceof Error ? err.message : 'Screenshot failed';
      console.error('[handlers] pending screenshot failed:', pendingScreenshotError);
    }
  })();
  pendingScreenshotPromise = run;
  return run;
}

export function clearPendingScreenshot(): void {
  pendingScreenshot = null;
  pendingScreenshotError = null;
  pendingScreenshotPromise = null;
  pendingScreenshotOcr = null;
  pendingScreenshotOcrPromise = null;
  pendingScreenshotManual = false;
  // Invalidate any lazy capture still in flight so a stale image can't land
  // for a future session.
  pendingScreenshotCaptureId++;
  pendingSuppressClipboard = false;
}

export async function finalizeActiveSession(): Promise<void> {
  await endActiveSession();
}

// On app quit, persist any live session immediately (don't wait for the idle
// TTL, which would never fire if the process exits first) — unless the user
// asked for memory to be wiped on quit, in which case writing the session
// would be the opposite of the promise.
onBeforeQuit(() => {
  clearSessionEndTimer();
  if (getSettings().clearMemoryOnQuit) {
    // "Delete all memory when Spirit closes": drop the live session without
    // persisting, then wipe every store the memory panel reads — L0 session
    // transcripts, L1 long-term context, app lessons, the chip cache (raw
    // screen text) and the legacy workspace spill dir. Best-effort: quit
    // must never block or throw on any of it; pending fs work drains before
    // the event loop does.
    quitMemoryWipeDone = true;
    activeSession = null;
    void (async () => {
      try {
        await clearMemories();
      } catch {
        /* best-effort */
      }
      try {
        const { removed } = await clearAllSessions();
        if (removed) console.log(`[lifecycle] clearMemoryOnQuit: removed ${removed} session file(s)`);
      } catch {
        /* best-effort */
      }
      try {
        clearAppLessons();
      } catch {
        /* best-effort */
      }
      try {
        clearPreferences();
      } catch {
        /* best-effort */
      }
      try {
        chipsCache.clear();
        chipsCacheLoaded = true; // never reload the file we just dropped
        const f = chipsCacheFile();
        if (f) rmSync(f, { force: true });
      } catch {
        /* best-effort */
      }
      try {
        rmSync(join(getWorkspaceFolder(), '.spirit', 'spills'), { recursive: true, force: true });
      } catch {
        /* legacy spill dir may not exist */
      }
    })();
    return;
  }
  void finalizeActiveSession();
});

const CLIPBOARD_PREVIEW_LEN = 80;

export function snapshotClipboard(): { preview: string | null; length: number } {
  pendingClipboard = readClipboardText();
  const length = pendingClipboard.length;
  if (length === 0) return { preview: null, length: 0 };
  const oneLine = pendingClipboard.replace(/\s+/g, ' ').trim();
  const preview = oneLine.length > CLIPBOARD_PREVIEW_LEN
    ? oneLine.slice(0, CLIPBOARD_PREVIEW_LEN) + '…'
    : oneLine;
  return { preview, length };
}

export function clearPendingClipboard(): void {
  pendingClipboard = '';
  dismissedClipboard = null;
}

// Called when the user clicks the X on the clipboard chip. We don't actually
// touch the OS pasteboard (that would be hostile); we just remember the
// dismissed text so the poller and the next submit both ignore it. The flag
// auto-clears as soon as the clipboard contents differ.
export function dismissCurrentClipboard(): void {
  dismissedClipboard = readClipboardText();
  pendingClipboard = '';
}

// Polled by main while AI mode is active so the renderer can show the user's
// freshly copied text (Cmd+C) without them having to re-trigger the box.
// Returns the new preview payload when the clipboard text actually changed,
// or null when nothing changed (so we don't flood the IPC channel every tick).
export function pollClipboardIfChanged(): { preview: string | null; length: number } | null {
  const fresh = readClipboardText();
  // While a dismissed snapshot is active, swallow polls until the OS clipboard
  // actually changes. The moment it does, we clear the dismissal and let the
  // new value flow through normally.
  if (dismissedClipboard !== null) {
    if (fresh === dismissedClipboard) return null;
    dismissedClipboard = null;
  }
  if (fresh === pendingClipboard) return null;
  pendingClipboard = fresh;
  const length = fresh.length;
  if (length === 0) return { preview: null, length: 0 };
  const oneLine = fresh.replace(/\s+/g, ' ').trim();
  const preview = oneLine.length > CLIPBOARD_PREVIEW_LEN
    ? oneLine.slice(0, CLIPBOARD_PREVIEW_LEN) + '…'
    : oneLine;
  return { preview, length };
}

export function broadcastClipboardContext(payload: { preview: string | null; length: number }): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.ClipboardContext, payload);
  }
}

function selectionPreview(text: string): { preview: string | null; length: number } {
  const length = text.length;
  if (length === 0) return { preview: null, length };
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const preview =
    oneLine.length > CLIPBOARD_PREVIEW_LEN
      ? oneLine.slice(0, CLIPBOARD_PREVIEW_LEN) + '…'
      : oneLine;
  return { preview, length };
}

// Capture the user's on-screen text selection at AI-mode start. Read via
// accessibility APIs only (Windows UIA, macOS AX) — Spirit never presses
// Ctrl+C and never touches the clipboard. `cursor` is the trigger cursor
// position, used on Windows to pin the target window BEFORE the overlay takes
// focus (see capture/selection.ts). Broadcasts the resulting preview to the
// overlays.
export async function snapshotSelection(cursor?: { x: number; y: number }): Promise<void> {
  selectionSuppressed = false;
  let text = '';
  try {
    text = await captureSelectedText({ cursor });
  } catch (err) {
    console.error('[handlers] selection capture failed:', err);
  }
  pendingSelection = text;
  broadcastSelectionContext(selectionPreview(text));
}

export function clearPendingSelection(): void {
  pendingSelection = '';
  selectionSuppressed = false;
}

// User clicked the X on the selected-text bubble. Unlike the clipboard we
// can't restore the OS selection, so we just mark it suppressed for this
// session and hide the chip. The next trigger re-captures fresh.
export function dismissCurrentSelection(): void {
  selectionSuppressed = true;
  broadcastSelectionContext({ preview: null, length: 0 });
}

export function broadcastSelectionContext(payload: { preview: string | null; length: number }): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.SelectionContext, payload);
  }
}

// Last app-context logged, so the watcher's 2s ticks don't spam the console
// with an unchanged window/tab. Only real changes get a log line.
let lastLoggedAppContext = '';

function updateAppContext(ctx: AppContext | null): void {
  const prev = lastAppContext;
  lastAppContext = ctx;
  const logKey = ctx
    ? `${ctx.process}|${ctx.title}|${ctx.url ?? ''}|${ctx.activeTab ?? ''}`
    : '';
  if (logKey !== lastLoggedAppContext) {
    lastLoggedAppContext = logKey;
    if (ctx) {
      // console.log(`[app-context] ${appContextTextFrom(ctx).replace(/\n/g, ' | ')}`);
    }
  }
  const preview = ctx ? previewFromAppContext(ctx) : null;
  if (preview === lastBroadcastAppPreview) return;
  lastBroadcastAppPreview = preview;
  broadcastAppContext(preview);
  // The user switched app/window/tab while the box is open: regenerate the
  // suggestion chips for the new context (re-OCRs the region — cheap, and only
  // when nothing is streaming).
  void regenerateChipsOnAppChange(prev, ctx);
}

// Foreground-app snapshot. Two callers:
//  - AI-mode start (main.ts onStart): fired BEFORE the overlay takes focus,
//    so the read sees the app the user was in when they pressed the trigger.
//    This is now FAST: only the ~50ms identity read is awaited (box opens
//    instantly); the ~1s UIA URL walk continues in the background and, when
//    it lands, feeds the chip through onEnriched.
//  - Submit (check-on-send): the event-driven watcher is active, so instead
//    of returning the cached context we do a FRESH topmost read — the user
//    may have switched apps/tabs since the last sample. captureTopmostAppContext
//    reads the window BENEATH the full-screen overlay (the app the user is
//    actually looking at), so it can't return "Spirit". The context is
//    enriched only for browser windows (that's where a tab/URL matters);
//    on failure the last known context is kept.
// If the watcher is somehow not running (shouldn't happen while the box is
// open), fall back to a fresh capture — self-skipped so it can never overwrite
// a real context with "Spirit".
export async function snapshotAppContext(cursor?: { x: number; y: number }): Promise<AppContext | null> {
  if (isAppContextWatcherRunning()) {
    let fresh: AppContext | null = null;
    try {
      fresh = await captureTopmostAppContext();
    } catch (err) {
      console.error('[handlers] topmost app-context capture failed:', err);
    }
    if (fresh && !isSelfContext(fresh)) {
      if (isBrowserContext(fresh.process, fresh.url ?? '')) {
        await enrichContextByHandle(fresh);
      }
      setExternalForeground(fresh);
      updateAppContext(fresh);
      return fresh;
    }
    // The fresh read failed or returned Spirit itself: fall back to the last
    // known context, but relabel it as a cached/approximate capture so the
    // LLM never mistakes it for a live observation of the current screen.
    return lastAppContext ? staleCopyOf(lastAppContext) : null;
  }
  let ctx: AppContext | null = null;
  try {
    ctx = await captureForegroundApp({
      // Prefer the window under the trigger cursor: it's the content the user
      // is pointing at, and GetForegroundWindow can be a transient shell flyout
      // (Quick settings) that poisons the context and the agent's target.
      cursor,
      // The trigger-time URL walk lands AFTER the box opens (it's not gated).
      // Feed the enriched context to the chip instead of losing it.
      onEnriched: (enriched) => {
        if (enriched && !isSelfContext(enriched)) updateAppContext(enriched);
      },
    });
  } catch (err) {
    console.error('[handlers] foreground app capture failed:', err);
    ctx = null;
  }
  if (ctx && isSelfContext(ctx)) {
    console.log('[handlers] skip self app-context:', JSON.stringify(ctx));
    ctx = null;
  }
  updateAppContext(ctx);
  return ctx;
}

// Feed a watcher sample into the shared app-context state. Self-captures are
// already filtered out by the watcher; the dedupe in updateAppContext stops
// the chip from re-broadcasting an unchanged app on every tick.
export function applyAppContextFromWatcher(ctx: AppContext): void {
  updateAppContext(ctx);
}

// The watcher runs ONLY while the box is open. main.ts calls these from
// onStart/onEnd so the 1s poll starts when the box opens and stops when it
// closes — no background tracking while Spirit is idle.
export function startAppContextTracking(): void {
  startAppContextWatcher(applyAppContextFromWatcher);
}

export function stopAppContextTracking(): void {
  stopAppContextWatcher();
}

export function clearPendingAppContext(): void {
  lastAppContext = null;
  lastBroadcastAppPreview = null;
  lastTurnAppContextKey = '';
  broadcastAppContext(null);
}

function broadcastAppContext(preview: string | null): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.AppContext, preview);
  }
}

// The cursor shape the custom-cursor overlay should draw. Main's shape probe
// (electron/input/cursor-shape.ts) learns which standard Windows cursor sits
// under the physical mouse — even while the overlay's `cursor: none` hides
// it — and stores it here. Every CursorPosition payload carries it so the
// renderer's SpiritCursor can switch shapes without any extra IPC.
let currentCursorShape = 'pointer';

// Companion to the shape: when the pointer sits on a classic non-client
// scrollbar, whether that bar is vertical or horizontal (from the probe's
// WM_NCHITTEST). The renderer hides the custom cursor over vertical bars.
let currentScrollbar: 'vert' | 'horz' | null = null;

export function setCurrentCursorShape(shape: string): void {
  currentCursorShape = shape;
}

export function setCurrentScrollbar(scrollbar: 'vert' | 'horz' | null): void {
  currentScrollbar = scrollbar;
}

export function getCurrentCursorShape(): string {
  return currentCursorShape;
}

function buildPayload(): CursorPosition {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return {
    x: cursor.x - display.workArea.x,
    y: cursor.y - display.workArea.y,
    displayId: display.id,
    shape: currentCursorShape,
    scrollbar: currentScrollbar,
    t: Date.now(),
  };
}

export function registerIpcHandlers(): void {
  // Preload bundled skills so the very first query sees the enabled block.
  initSkillsRuntime();

  ipcMain.handle(CHANNELS.PermissionsGet, () => getPermissions());

  ipcMain.handle(CHANNELS.PermissionsOpen, (_e, kind: 'accessibility' | 'screen-recording') => {
    resetScreenRecordingCache();
    return openSystemSettings(kind);
  });

  ipcMain.handle(CHANNELS.AIModeCancel, (_e, opts?: { cancelStream?: boolean; keepOpen?: boolean }) => {
    // Idle guard: a cancel that lands while AI mode is already closed (the
    // observed 30× idle dismiss storm) is a no-op — there is nothing to end,
    // and firing endAIMode would broadcast a spurious AIModeEnd to every
    // overlay. Only a live session actually dismisses.
    if (getAIModeState() === 'idle') {
      if (opts?.cancelStream) cancelCurrentStream();
      return;
    }
    // ESC and the ✕ button are explicit "stop it" gestures — they genuinely
    // cancel the in-flight answer. Every other dismissal (backdrop click,
    // idle timer, busy-elsewhere) only hides the box: an in-flight answer
    // keeps running in the background and shows on the next trigger.
    // `keepOpen` (the ✕ while the AI is answering) cancels the stream but
    // leaves the box + partial answer on screen: the abort ends the run as
    // "done" in the router so the reader keeps exactly what was streamed.
    console.log(
      `[chips/ai] overlay dismiss requested, cancelStream=${opts?.cancelStream ?? false} keepOpen=${opts?.keepOpen ?? false}`,
    );
    if (opts?.cancelStream) cancelCurrentStream();
    if (opts?.keepOpen) return;
    endAIMode('renderer-cancel');
  });

  ipcMain.handle(CHANNELS.ClipboardDismiss, () => {
    dismissCurrentClipboard();
  });

  // Explicit user tap on a generated-UI "copy" control — never automatic.
  ipcMain.handle(CHANNELS.ClipboardWrite, (_e, text: string) => {
    try {
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'Nothing to copy' };
      }
      clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Copy failed',
      };
    }
  });

  // Mermaid "Copy as PNG": renderer sends a PNG data URL; main puts the image
  // on the system clipboard. Explicit user tap only.
  ipcMain.handle(CHANNELS.ClipboardWriteImage, (_e, dataUrl: string) => {
    try {
      if (typeof dataUrl !== 'string' || !/^data:image\/png/i.test(dataUrl)) {
        return { ok: false, error: 'Invalid image' };
      }
      const img = nativeImage.createFromDataURL(dataUrl);
      if (img.isEmpty()) return { ok: false, error: 'Failed to decode image' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Copy failed',
      };
    }
  });

  // [DIAGRAM] "Copy as PNG": rasterize the LIVE pixels of the widget's
  // viewport rect (DIP, relative to this overlay's webContents). capturePage
  // paints exactly what the user sees — boxes, arrows and borders come from the
  // composited page, not a style-inlined DOM clone, so a foreignObject/font/
  // pseudo-element rendering quirk can no longer drop the structure. Explicit
  // user tap only.
  ipcMain.handle(CHANNELS.CopyRegionToClipboard, async (e, rect: { x: number; y: number; width: number; height: number } | null) => {
    try {
      if (!rect || typeof rect !== 'object') return { ok: false, error: 'No element rect' };
      const { x, y, width, height } = rect;
      if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return { ok: false, error: 'Invalid element rect' };
      }
      if (width <= 0 || height <= 0) return { ok: false, error: 'Element not rendered' };
      const bounds = { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(width), height: Math.ceil(height) };
      const img = await e.sender.capturePage(bounds);
      if (img.isEmpty()) return { ok: false, error: 'Capture returned empty' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Copy failed',
      };
    }
  });

  ipcMain.handle(CHANNELS.SelectionDismiss, () => {
    dismissCurrentSelection();
  });

  // Dropped-file attach: renderer posts absolute paths from a drag-drop;
  // main resolves + reads them (text inline, images as vision blocks) and
  // broadcasts summaries for the chip row. Never throws — bad drops come
  // back as skipped notes.
  ipcMain.handle(CHANNELS.FilesAttach, async (_e, paths: unknown) => {
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
    pendingAttached = readAttachedFiles(list);
    const summary = pendingAttached.map((it) => ({
      path: it.path,
      name: it.path ? basename(it.path) : '',
      kind: it.kind,
      note: it.note ?? (it.kind === 'text' ? 'ready' : it.kind === 'image' ? 'image ready' : undefined),
    }));
    broadcastToOverlays(CHANNELS.FilesAttached, summary);
    return summary;
  });

  ipcMain.handle(CHANNELS.FilesDismiss, () => {
    clearPendingAttached();
    broadcastToOverlays(CHANNELS.FilesAttached, []);
  });

  // Append/Replace button: release overlay focus and type the text into
  // the user's focused app at the caret. Routes through the engine (not raw
  // actions) so long/emoji text pastes intact and focus drift re-focuses.
  ipcMain.handle(CHANNELS.InsertText, async (_e, text: string) => {
    try {
      await performType(String(text ?? ''));
      return { ok: true } as const;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to insert text',
      } as const;
    }
  });

  ipcMain.on(CHANNELS.OverlaySetInteractive, (e, interactive: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    for (const [displayId, overlay] of getOverlayEntries()) {
      if (overlay === win) {
        setOverlayInteractive(displayId, interactive);
        return;
      }
    }
  });

  // Cursor-tracking demand: the renderer registers (true) while it needs the
  // pointer position and unregisters (false) when it doesn't. Prune the id
  // when its renderer dies so a crashed/reloaded overlay can't pin tracking on
  // forever.
  ipcMain.on(CHANNELS.CursorTrackingNeeded, (e, needed: boolean) => {
    if (needed) {
      setCursorTrackingNeeded(e.sender.id, true);
      e.sender.once('destroyed', () => setCursorTrackingNeeded(e.sender.id, false));
    } else {
      setCursorTrackingNeeded(e.sender.id, false);
    }
  });

  // SettingsGet must NEVER trigger a keychain prompt. The light variant
  // skips decryption — provider apiKey fields come back as empty strings
  // but `enabled` flags and "do we have a key" info are preserved. If the
  // renderer needs to display an existing plaintext key (Show button), it
  // issues an explicit RevealProviderKey IPC, which is the user-active
  // moment where the keychain prompt is expected to fire.
  ipcMain.handle(CHANNELS.SettingsGet, () => getSettingsLight());
  ipcMain.handle(CHANNELS.SettingsSet, (_e, patch: Partial<Settings>) => {
    // Validate provider keys server-side. Catches the placeholder /
    // typo case ("sr-..." instead of "sk-...") that previously made it
    // through Save and into the encrypted store. Throwing rejects the
    // IPC; renderer catches and surfaces the message.
    if (patch.providers) {
      for (const id of Object.keys(patch.providers) as ProviderId[]) {
        const p = patch.providers[id];
        if (p?.apiKey && p.apiKey.length > 0) {
          const check = validateProviderKey(id, p.apiKey);
          if (!check.ok) {
            throw new Error(`${id}: ${check.error}`);
          }
        }
      }
    }
    setSettings(patch);
    if (typeof patch.ghostMode === 'boolean' || typeof patch.ghostHideTaskbar === 'boolean') {
      const ghost = getGhostMode();
      const hideTaskbar = getGhostHideTaskbar();
      setContentProtectionEnabled(ghost);
      setOverlaysSkipTaskbar(ghost && hideTaskbar);
      if (process.platform === 'darwin' && app.dock) {
        if (ghost && hideTaskbar) app.dock.hide();
        else app.dock.show();
      }
      if (typeof patch.ghostMode === 'boolean') app.emit('spirit:ghost-mode', ghost);
    }
    // Broadcast a health-changed event so the ProviderHealthBanner can
    // refresh immediately instead of waiting for its 30s poll. Without
    // this push the banner lingered for up to half a minute after the
    // user fixed the broken key — exactly the moment the diagnostic
    // should disappear.
    if (patch.providers) {
      for (const win of getAllOverlays()) {
        if (!win.isDestroyed()) {
          win.webContents.send(CHANNELS.ProvidersHealthChanged);
        }
      }
    }
    return getSettingsLight();
  });
  ipcMain.handle(CHANNELS.HasProviderKey, (_e, provider: ProviderId) => hasProviderKey(provider));

  // Vision bridge config read/write. The plain fields (toggle/url/model) live
  // on the localai settings (they ride the normal save path); the API key —
  // which may belong to a different service than the local server — lives in
  // its own encrypted slot (visionBridgeSecure), written only through this
  // dedicated IPC so a generic settings save can never wipe or decrypt it.
  ipcMain.handle(CHANNELS.GetVisionBridge, () => {
    const c = getLocalAiConfig();
    return {
      useBridge: c.useVisionBridge === true,
      url: c.visionBridgeUrl ?? '',
      model: c.visionBridgeModel ?? '',
      hasKey: hasVisionBridgeKey(),
    };
  });
  ipcMain.handle(
    CHANNELS.SetVisionBridge,
    (_e, payload: { useBridge: boolean; url: string; model: string; key?: string; clearKey?: boolean }) => {
      const c = getLocalAiConfig();
      writeLocalAiConfig({
        ...c,
        useVisionBridge: !!payload.useBridge,
        visionBridgeUrl: typeof payload.url === 'string' ? payload.url : c.visionBridgeUrl,
        visionBridgeModel:
          typeof payload.model === 'string' ? payload.model : c.visionBridgeModel,
      });
      if (payload.clearKey) {
        setVisionBridgeKey('');
      } else if (typeof payload.key === 'string' && payload.key.length > 0) {
        setVisionBridgeKey(payload.key);
      }
      return true;
    },
  );
  // `hasAnyProviderKey` memo was sometimes returning false even when
  // OpenRouter was working (suspected state-sync race). This main-side
  // check reads the live store directly and is the single source of truth.
  // Local AI is "configured" by its base URL, not by a stored key.
  ipcMain.handle(CHANNELS.HasAnyConfiguredProvider, () => {
    const s = getSettingsLight();
    return PROVIDER_IDS.some((id) => {
      const cfg = s.providers[id];
      if (!cfg || !cfg.enabled) return false;
      // Keyless local servers count by base URL, not by key: localai AND
      // opencode need no API key by design.
      if (id === 'localai') return hasLocalAiServer();
      if (id === 'opencode') return hasOpencodeServer();
      return hasProviderKey(id);
    });
  });
  ipcMain.handle(CHANNELS.ProvidersHealth, () => getProvidersHealth());
  ipcMain.handle(CHANNELS.RevealProviderKey, (_e, provider: ProviderId) => {
    // Explicit user action ("Show key"). This DOES trigger safeStorage
    // and will prompt the keychain on macOS the first time per session.
    return getDecryptedProviderKey(provider);
  });
  ipcMain.handle(CHANNELS.RevealChipsProviderKey, (_e, provider: ProviderId) => {
    // Same explicit-user-action reveal, but for the chips-only provider map
    // (the separate provider configured just for "Suggest actions" chips).
    return getDecryptedChipsProviderKey(provider);
  });

  ipcMain.handle(CHANNELS.AutostartGet, () => getAutostart());
  ipcMain.handle(CHANNELS.AutostartSet, (_e, state: { openAtLogin: boolean; openAsHidden: boolean }) =>
    setAutostart(state),
  );

  ipcMain.handle(CHANNELS.LaunchApp, async (_e, appId: string) => launchApp(appId));
  ipcMain.handle(CHANNELS.ListLaunchableApps, async () => listLaunchableApps());
  ipcMain.handle(CHANNELS.ExternalOpen, async (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) return;
    await shell.openExternal(url);
  });

  // The display the submitting overlay window lives on. The submit-time full
  // screen shot must target THIS display, not wherever the mouse happens to be
  // — the user is interacting with the app where the box is, so a cursor that
  // moved to another monitor must not make the model "see" the wrong screen.
  const overlayDisplayIdForSender = (sender: Electron.WebContents): number | undefined => {
    try {
      const win = BrowserWindow.fromWebContents(sender);
      if (!win || win.isDestroyed()) return undefined;
      return screen.getDisplayMatching(win.getBounds()).id;
    } catch {
      return undefined;
    }
  };

  // Display POINT-coordinate geometry resolves against: the overlay's display
  // when known (matches which display captureScreenForSubmit targeted),
  // otherwise the display under the cursor, else primary.
  const pointGeoDisplay = (sender: Electron.WebContents) => {
    const overlayId = overlayDisplayIdForSender(sender);
    const all = screen.getAllDisplays();
    const byOverlay = overlayId !== undefined ? all.find((d) => d.id === overlayId) : undefined;
    return (
      byOverlay ||
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    );
  };

  // Build the image→screen geometry for a FULL-DISPLAY submit shot (the JPEG
  // is the whole display, so the image maps 1:1 onto display.size at the
  // display-bounds origin). Best effort — returns null on any decode failure,
  // in which case POINT tags for this turn are skipped.
  const pointGeoForFullDisplayB64 = (
    b64: string,
    sender: Electron.WebContents,
  ): PointGeo | null => {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      const d = pointGeoDisplay(sender);
      return {
        imgW: width,
        imgH: height,
        absLeft: d.bounds.x,
        absTop: d.bounds.y,
        winW: d.size.width,
        winH: d.size.height,
        // Scene elements are native physical px on Windows; the overlay is DIP.
        agentUnitsPerDip: agentUnitsPerDip(d),
      };
    } catch {
      return null;
    }
  };

  // Build the image→screen geometry for a user-dragged selection-rect capture:
  // the image is a crop of the display at the rect's (work-area-local) position,
  // so tags written in its pixels map like a region of the canonical display
  // shot. Absent rect metadata (or on decode failure) returns null — callers
  // keep the previous behavior (geo NONE → tags dropped).
  const pointGeoForRectB64 = (shot: NonNullable<typeof pendingScreenshot>): PointGeo | null => {
    if (!shot.rect || typeof shot.displayId !== 'number') return null;
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(shot.b64, 'base64'));
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      const all = screen.getAllDisplays();
      const disp = all.find((d) => d.id === shot.displayId) ?? screen.getPrimaryDisplay();
      const primary = screen.getPrimaryDisplay();
      const sf = disp.scaleFactor || 1;
      // The rect is work-area-local DIP; place it in the display's native pixel
      // grid (canonical px). cropSize = the rect's physical extent — if the
      // model image was downscaled from it, region.w/h (decoded) differ and the
      // ratio un-resizes tags; if not, it's 1:1.
      const regionX = Math.round((disp.bounds.x + (disp.workArea.x - disp.bounds.x) + shot.rect.x - primary.bounds.x) * sf);
      const regionY = Math.round((disp.bounds.y + (disp.workArea.y - disp.bounds.y) + shot.rect.y - primary.bounds.y) * sf);
      return {
        imgW: Math.round(disp.size.width * sf),
        imgH: Math.round(disp.size.height * sf),
        absLeft: disp.bounds.x,
        absTop: disp.bounds.y,
        winW: disp.size.width,
        winH: disp.size.height,
        region: { x: regionX, y: regionY, w: width, h: height },
        cropSize: {
          w: Math.round(shot.rect.width * sf),
          h: Math.round(shot.rect.height * sf),
        },
        agentUnitsPerDip: sf,
      };
    } catch {
      return null;
    }
  };

  // Convert absolute screen-DIP annotations into the receiving overlay's LOCAL
  // space (absolute minus the overlay window's workArea origin — per-display
  // overlays sit at display.workArea.x/y). Phase 4 broadcast raw absolute
  // coords, which landed wrong on non-primary monitors; this fixes placement
  // on every display.
  const broadcastAnnotations = (
    sender: Electron.WebContents,
    annotations: ScreenAnnotation[],
  ) => {
    if (sender.isDestroyed()) return;
    const win = BrowserWindow.fromWebContents(sender);
    let ox = 0;
    let oy = 0;
    if (win && !win.isDestroyed()) {
      const b = win.getBounds();
      ox = b.x;
      oy = b.y;
    }
    const local = annotations.map((a) => {
      if (a.kind === 'point') return { ...a, x: a.x - ox, y: a.y - oy };
      if (a.kind === 'box') return { ...a, x: a.x - ox, y: a.y - oy };
      return { ...a, x1: a.x1 - ox, y1: a.y1 - oy, x2: a.x2 - ox, y2: a.y2 - oy };
    });
    sender.send(CHANNELS.AnnotationStream, { annotations: local });
  };

  const runQuery = async (
    e: Electron.IpcMainInvokeEvent,
    prompt: string,
    options: {
      web?: boolean;
      templateId?: TemplateId;
      includeClipboard?: boolean;
      fromChip?: boolean;
      runId?: string;
    },
  ) => {
    const runId = options.runId || randomUUID();
    cancelCurrentStream();
    cancelPendingChips();
    cancelPendingNextChips();
    cancelPendingWebImages();
    // Any [IMAGE] subject search results broadcast while this run is active
    // are shown.
    webImagesArmed = true;
    const sender = e.sender;
    // Run lifecycle: every event this run emits carries its id, a terminal
    // goes out exactly once, and late events from a superseded run are
    // dropped by the cancelled flag instead of polluting the fresh UI.
    const run: StreamRun = {
      id: runId,
      stream: null,
      cancelled: false,
      terminalSent: false,
      sendDone: () => {},
      sendError: () => {},
      sendInterrupted: () => {},
    };
    run.sendDone = () => {
      if (run.terminalSent) return;
      run.terminalSent = true;
      if (currentStreamRun === run) currentStreamRun = null;
      if (run.stream && currentStream === run.stream) currentStream = null;
      broadcastToOverlays(CHANNELS.LLMDone, { runId: run.id });
    };
    run.sendError = (message, code) => {
      if (run.terminalSent) return;
      run.terminalSent = true;
      if (currentStreamRun === run) currentStreamRun = null;
      if (run.stream && currentStream === run.stream) currentStream = null;
      broadcastToOverlays(CHANNELS.LLMError, {
        runId: run.id,
        message,
        code: code ?? 'unknown',
      });
    };
    run.sendInterrupted = (message, code, partialText) => {
      if (run.terminalSent) return;
      run.terminalSent = true;
      if (currentStreamRun === run) currentStreamRun = null;
      if (run.stream && currentStream === run.stream) currentStream = null;
      broadcastToOverlays(CHANNELS.LLMInterrupted, {
        runId: run.id,
        message,
        code: code ?? 'unknown',
        text: partialText ?? '',
      });
    };
    currentStreamRun = run;

    // Context-isolation rule: a NEW box-open (fresh trigger since the last
    // submit) starts a brand-new session — new goal, fresh history — so an old
    // task like a "Suggest a reply" draft can never leak into a question the user
    // asks on another screen. Two carve-outs resume the previous session:
    // (a) a short continuation fragment ("ok", "windows", "the second one")
    // typed into the STILL-OPEN box, and (b) that same fragment when the user
    // RE-OPENS the box but is still in the SAME app/window/tab the last turn
    // saw — a fresh trigger in a DIFFERENT app is always a new task, so the
    // "what's this button" asked after switching apps can never silently
    // resume the old app's conversation AND its old screenshot. Tapped
    // suggestion chips always continue the ongoing conversation — never a new
    // one.
    // Kick the foreground-app snapshot FIRST so the isolation decision below
    // can compare it against the last committed turn's context. It stays in
    // flight and is reused by the app block later — the capture and the
    // snapshot still run in parallel.
    const appCtxPromise = snapshotAppContext().catch(() => null);
    if (
      activeSession &&
      activeSession.turnCount > 0 &&
      triggerOpenedSinceSubmit &&
      !options.fromChip
    ) {
      const isContinuationFragment = prompt.trim().split(/\s+/).filter(Boolean).length <= 8;
      const ctxNow = await appCtxPromise;
      const contextKeyNow = ctxNow ? appContextKey(ctxNow) : '';
      const appChanged =
        !!lastTurnAppContextKey && !!contextKeyNow && contextKeyNow !== lastTurnAppContextKey;
      if (!isContinuationFragment || appChanged) {
        console.log(
          `[session] new trigger + ${appChanged ? 'app/window/tab switch' : 'non-fragment prompt'} -> fresh session (was turn ${activeSession.turnCount})`,
        );
        await endActiveSession();
      }
    }
    triggerOpenedSinceSubmit = false;

    // First turn of a new session: needs the screenshot from the trigger.
    // Subsequent turns reuse the same screenshot (the actual screen is now
    // partially covered by Spirit itself, so recapturing would be wrong).
    // Vision context is the product's core differentiator — always capture
    // unless the trigger pre-captured already.
    // Will the first resolvable model read the screenshot directly? The
    // cloud defaults are all vision-capable, so the common path skips the
    // full-screen OCR wall that used to block every first token — OCR is
    // only awaited as the text-only-model fallback.
    const visionModel = wouldUseVisionModel();
    // Accessibility walk of the USER's window, kicked now so it lands while the
    // model streams: named UIA/AX elements give icon-only tollbars a real
    // frame to snap annotation labels to.
    // Text comes from the OCR grounding instead, so noText avoids a second
    // full-window OCR pass. Linux has no tree to walk — skip.
    const annotUiaPromise =
      process.platform === 'win32' || process.platform === 'darwin'
        ? buildScene({ noText: true })
            .then((s) => (s.elements.length > 0 ? s.elements : null))
            .catch(() => null)
        : null;
    if (!activeSession) {
      let imageB64 = '';
      // OCR readback of the image actually used this turn. Null until one of
      // the capture paths below has decided the image; set when the fresh
      // submit-time shot is used so its (possibly empty) OCR never gets
      // replaced by the trigger crop's stale OCR.
      let freshOcr: string | null = null;
      let freshImageUsed = false;
      if (pendingScreenshotManual && pendingScreenshot) {
        // The user deliberately dragged a selection rectangle: keep exactly
        // that scoping, never override it with an auto-capture. The rect has a
        // known screen position — map its image onto the display so annotation
        // tags land exactly instead of being dropped (geo NONE).
        imageB64 = pendingScreenshot.b64;
        beginAnnotationRuler(pointGeoForRectB64(pendingScreenshot));
      } else {
        // Fresh capture AT SUBMIT TIME: the model sees the screen the moment
        // the user enters their prompt — the app they are in NOW — instead of
        // the trigger-time crop around the cursor (which can be stale or have
        // caught the wrong window, e.g. a terminal next to the email they are
        // reading). Overlays are content-protected, so Spirit's box is
        // excluded. OCR the fresh shot as the text-only-model fallback.
        try {
          const fresh = await captureScreenForSubmit(overlayDisplayIdForSender(sender));
          if (fresh) {
            imageB64 = fresh;
            freshImageUsed = true;
            beginAnnotationRuler(pointGeoForFullDisplayB64(fresh, sender));
            if (!visionModel) {
              freshOcr = await Promise.race([
                ocrImageB64Text(fresh)
                  .then((t) => capOcrText(t))
                  .catch(() => null),
                new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 2500)),
              ]);
            }
          }
        } catch {
          freshOcr = null;
        }
      }
      if (!imageB64) {
        if (pendingScreenshotError) {
          broadcastToOverlays(CHANNELS.LLMError, { message: pendingScreenshotError });
          return;
        } else if (pendingScreenshotPromise) {
          // The lazy trigger capture is still in flight (the box opened before
          // it landed). Wait for it — with a cap — so an instant submit doesn't
          // silently lose the screenshot. On timeout, proceed without one.
          try {
            await Promise.race([
              pendingScreenshotPromise,
              new Promise<void>((resolve) => setTimeout(resolve, 1500)),
            ]);
          } catch {
            /* capturePromise never rejects, but be defensive */
          }
          // Straight-line flow has narrowed `pendingScreenshot` to null here,
          // but the awaited capture REASSIGNS the module variable — re-read the
          // live value with the full type.
          const shot = pendingScreenshot as { b64: string; ts: number } | null;
          if (shot) {
            imageB64 = shot.b64;
            beginAnnotationRuler(null);
          } else if (pendingScreenshotError) {
            broadcastToOverlays(CHANNELS.LLMError, { message: pendingScreenshotError });
            return;
          }
        } else {
          // No pending capture and the fresh submit-time shot failed/no-op'd:
          // capture around the cursor as the last-resort fallback.
          try {
            const cursor = screen.getCursorScreenPoint();
            imageB64 = await captureAroundCursor(cursor);
            beginAnnotationRuler(null);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Screenshot failed';
            broadcastToOverlays(CHANNELS.LLMError, { message });
            return;
          }
        }
      }
      // If the screenshot was set by a drag-rectangle capture, the user
      // deliberately scoped the visual context — don't pollute it with
      // clipboard text on this first turn.
      const initialClip = pendingSuppressClipboard ? '' : pendingClipboard;
      // OCR for the image actually used this turn. When the fresh submit-time
      // shot won, its OCR is authoritative (possibly empty on a slow read) —
      // the trigger crop's OCR describes a different, stale image and must
      // never leak in. Otherwise await the trigger capture's OCR. On a vision
      // model that OCR is never needed, so don't block the first token on a
      // pending trigger-crop read — keep whatever already landed.
      let ocrForTurn: string;
      if (freshImageUsed) {
        ocrForTurn = freshOcr ?? '';
      } else if (visionModel) {
        ocrForTurn = pendingScreenshotOcr ?? '';
      } else {
        if (pendingScreenshotOcrPromise) {
          await Promise.race([
            pendingScreenshotOcrPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 2000)),
          ]);
        }
        ocrForTurn = pendingScreenshotOcr ?? '';
      }
      startNewSession(imageB64, initialClip, ocrForTurn);
      if (pendingSuppressClipboard && activeSession) {
        (activeSession as ActiveSession).suppressClipboardOnce = true;
        pendingSuppressClipboard = false;
      }
    }

    if (!activeSession) return;

    // Follow-up turns: the session screenshot was taken at the FIRST submit
    // (e.g. a terminal the user was in). If they've since switched apps
    // (terminal → browser) and submit a follow-up like "summarise this", the
    // stale shot keeps describing the old screen and the model answers about
    // the wrong thing. Recapture the CURRENT full screen + OCR at EVERY submit
    // and update the session, so the image and OCR blocks below always reflect
    // what's on screen right now. Spirit's overlays are content-protected, so
    // the box never appears in the shot. Best-effort: on any failure the
    // previous screenshot/OCR stay in place for this turn.
    // The capture itself is unavoidable (only the pixels know if the screen
    // moved), but when the fresh frame is byte-identical to the session's —
    // the common case for rapid follow-ups in one app — the reassign, ruler
    // remap and 2.5s OCR wall are all skipped: identical pixels OCR to
    // identical text, and the OCR cache would return the same string anyway.
    if (activeSession.messages.length > 0) {
      try {
        const fresh = await captureScreenForSubmit(overlayDisplayIdForSender(sender));
        if (fresh && frameHash(fresh) !== frameHash(activeSession.imageB64)) {
          activeSession.imageB64 = fresh;
          beginAnnotationRuler(pointGeoForFullDisplayB64(fresh, sender));
          // Re-OCR only for a text-only model: a vision model reads the fresh
          // shot directly, so the 2.5s OCR wall never blocks a follow-up.
          if (!visionModel) {
            activeSession.screenshotOcr =
              (await Promise.race([
                ocrImageB64Text(fresh)
                  .then((t) => capOcrText(t))
                  .catch(() => null),
                new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 2500)),
              ])) ?? '';
          }
        }
      } catch {
        // keep the previous screenshot/OCR for this turn
      }
    }

    // Continuity logging: tells us whether a submit is a fresh session or a
    // resumed follow-up (a re-ask loop after the user answered usually means
    // the session was dropped between triggers).
    console.log(
      `[session] ${
        activeSession.turnCount === 0 ? 'new session' : `resume turn ${activeSession.turnCount + 1}`
      }`,
    );

    // Check-on-send app context: snapshot the foreground app at the moment
    // of THIS submit (first or follow-up turn), so the LLM always sees the
    // app + active tab the user is in right now. One short subprocess call
    // per submit — zero background polling. Started in parallel with the
    // capture above; by now it has usually already resolved.
    const appCtx = await appCtxPromise;
    let appForTurn = appCtx ? appContextTextFrom(appCtx) : '';
    // Conflicting-observation self-invalidation: a fresh snapshot that differs
    // from the context of the last COMMITTED turn invalidates that older
    // observation. Tell the model the CURRENT app/tab/URL is authoritative and
    // to ignore whatever app/tab earlier turns in this conversation showed —
    // otherwise the fresh context sits next to a stale one in history and the
    // model can't tell which screen state is real. The note stays at the very
    // end of the app block (the last, most-volatile part of the user message).
    const freshContextKey = appCtx ? appContextKey(appCtx) : '';
    if (freshContextKey && lastTurnAppContextKey && freshContextKey !== lastTurnAppContextKey) {
      appForTurn +=
        '\n[NOTE: you switched app, window, or tab since the previous turn — the CURRENT ' +
        'app/tab/URL above is authoritative. Ignore any app or tab shown earlier in this conversation.]';
    }

    const sendActivity = (activity: ToolActivity) => {
      if (run.cancelled) return;
      broadcastToOverlays(CHANNELS.ToolActivity, activity);
    };

    // Hybrid approval: a single YES on the first card of a RUN authorizes
    // every later NON-DESTRUCTIVE action in that run without another card —
    // one grant per task, not per step. High-impact tools re-ask every time
    // even after a grant. The hard walls stay regardless of the grant:
    // DANGEROUS_RE in run-command.ts always refuses destructive shell, and
    // untrusted web content never auto-executes. A denied card still stops
    // the run cold.
    let runApprovedOnce = false;

    const requestToolApproval = (
      id: string,
      name: string,
      args: Record<string, unknown>,
    ) =>
      new Promise<boolean>((resolve) => {
        // Per-tool permission rules win over everything (even auto-approve):
        // an explicit deny blocks without a card, an explicit allow skips it.
        // Absent rule = default flow below.
        try {
          const rule = getPermissionRules()[name];
          if (rule === 'deny') {
            resolve(false);
            return;
          }
          if (rule === 'allow') {
            resolve(true);
            return;
          }
        } catch {
          /* rule read is best-effort */
        }
        // Auto-approve mode: accept every tool action without showing the
        // green ✓ / red ✗ card. Activity rows still stream so the user can
        // watch each step of a hands-off task run.
        if (getSettingsLight().autoApproveTools) {
          resolve(true);
          return;
        }
        // Later NON-DESTRUCTIVE action in a run the user already green-lit:
        // no more cards. High-impact tools re-ask every time. DANGEROUS_RE
        // stays the wall that never moves.
        if (runApprovedOnce && !isHighImpactTool(name)) {
          resolve(true);
          return;
        }
        // Box is hidden (dismissed mid-task — the stream keeps running in the
        // background). The user can't approve here, so deny the tool so the
        // run continues with a text answer instead of hanging on the card.
        if (getAIModeState() !== 'active') {
          resolve(false);
          return;
        }
        const req: ToolApprovalRequest = {
          id,
          name,
          label: describeToolForUI(name, args),
          args,
        };
        // Wrapped resolver: a YES flips the run grant (visible to the hybrid
        // check above via the shared closure binding).
        pendingApprovals.set(id, (value: boolean) => {
          if (value) runApprovedOnce = true;
          resolve(value);
        });
        approvalTimeouts.set(
          id,
          setTimeout(() => {
            if (!pendingApprovals.has(id)) return;
            const r = pendingApprovals.get(id);
            pendingApprovals.delete(id);
            approvalTimeouts.delete(id);
            r?.(false); // auto-deny: the user never answered the card
          }, APPROVAL_TIMEOUT_MS),
        );
        if (!sender.isDestroyed()) sender.send(CHANNELS.ToolApprovalRequest, req);
        // The card needs a click: make sure the overlay is on top when it
        // appears (a newly launched app may have taken the foreground).
        console.log(`[approval] card shown: ${req.label}`);
        for (const win of getAllOverlays()) {
          if (win.isDestroyed()) continue;
          try {
            win.setAlwaysOnTop(true, 'screen-saver');
            win.moveTop();
          } catch {
            /* best effort */
          }
        }
      });

    // Build the messages array for this turn:
    //  - first turn: [system, user(screenshot + clip + prompt)]
    //  - later turns: existing messages + new user(text only)
    // Re-read the clipboard on each submit so that copying text (Cmd+C)
    // while the box is open is picked up — the user can highlight text in
    // another app and ask Spirit about it without restarting the session.
    // BUT: if the user clicked the X on the chip and the clipboard hasn't
    // changed since, treat it as empty for this turn. Otherwise dismissing
    // would only hide the chip visually while still leaking the text to the
    // LLM, which is the opposite of what the user asked for.
    // suppressClipboardOnce: a drag-rectangle was just drawn for this
    // turn — force-empty the clipboard so the LLM sees ONLY what the
    // user framed visually. Cleared after consumption so follow-up
    // turns get the normal clipboard flow back.
    const suppressClip = activeSession.suppressClipboardOnce === true;
    if (suppressClip) activeSession.suppressClipboardOnce = false;
    // Renderer's clipboard chip is opt-in: if the user didn't toggle it
    // on for this turn, includeClipboard is false and we skip the
    // clipboard read entirely. This replaces the v1.0/1.1 always-on
    // polling behavior where any copied text auto-leaked into the next
    // prompt and surprised users.
    const explicitClipboardOptIn = options.includeClipboard === true;
    const liveClipboardRaw =
      suppressClip || !explicitClipboardOptIn ? '' : readClipboardText();
    const liveClipboard =
      dismissedClipboard !== null && liveClipboardRaw === dismissedClipboard
        ? ''
        : liveClipboardRaw;
    if (liveClipboard !== activeSession.clipboard) {
      activeSession.clipboard = liveClipboard;
      const preview = liveClipboard.replace(/\s+/g, ' ').trim();
      const previewCap = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
      for (const win of getAllOverlays()) {
        if (!win.isDestroyed()) {
          win.webContents.send(CHANNELS.ClipboardContext, {
            preview: liveClipboard ? previewCap : null,
            length: liveClipboard.length,
          });
        }
      }
    }

    // Screenshot for this turn — always the latest captured image.
    const screenshotForTurn = activeSession.imageB64;

    // Vision readback for TEXT-ONLY models via the vision bridge: when the
    // answering model cannot take image input (a local build without mmproj,
    // or a vision-off model), a separate configured vision endpoint describes
    // the turn's screenshot so the model gets the visual content OCR cannot
    // read (icons, images, charts, canvas state). Best-effort, run in
    // parallel with everything else — on any failure the turn proceeds
    // OCR-only exactly as before. Only for text-only answering models (a
    // vision model reads the attached image directly; a bridge description
    // would be redundant cost).
    let visionReadbackForTurn: string | null = null;
    if (screenshotForTurn && !visionModel && isVisionBridgeEnabled()) {
      visionReadbackForTurn = await Promise.race([
        describeScreenshot(screenshotForTurn, prompt).catch(() => null),
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), SUBMIT_TIMEOUT_MS)),
      ]);
      if (visionReadbackForTurn) {
        console.log(
          `[vision-bridge] text-only model: attached vision readback (${visionReadbackForTurn.length} chars) for "${
            appForTurn ? `app ${appForTurn.split('\n')[0]}` : `prompt ${frameHash(prompt)}`
          }"`,
        );
      }
    }

    // Selected-text context: captured at trigger time, auto-attached unless
    // the user dismissed the selected-text bubble. Follows the spirit
    // behavior — "The user also selected this text on their screen" — so the
    // LLM sees what the user highlighted.
    let selectionForTurn = selectionSuppressed ? '' : pendingSelection;
    // Selection submit retry: the trigger-time read races against the box
    // taking focus, and a slow Chromium control can stall it past the cap.
    // If it came back empty but the user did select text, re-read once here.
    // The retry is time-capped and targets the window the agent acts on (the
    // last real foreground window under the pointer) rather than OS focus —
    // when the box holds focus we'd otherwise read our own (empty) input.
    if (!selectionForTurn && !selectionSuppressed) {
      const retried = await captureSelectedText({
        hwnd: resolveAgentTargetHwnd(),
        retry: true,
      });
      if (retried) {
        selectionForTurn = retried;
        pendingSelection = retried;
        broadcastSelectionContext(selectionPreview(retried));
      }
    }

    let messages: Message[];
    // Paint-to-select texts: regions the user dragged a box over while the
    // box was open, OCR'd at capture time. Attached alongside the screenshot /
    // selection context so the LLM sees what the user painted. Consumed for
    // THIS turn, then cleared — the UI is hidden on submit, so follow-up
    // turns shouldn't silently re-attach selections the user already sent.
    const paintTextsForTurn = pendingPaintSelections.map((p) => p.text).filter(Boolean);
    clearPendingPaintSelections();

    // Dropped-file attach: text content joins the context blocks below;
    // images join the user message as vision blocks (vision models only).
    // Persists across turns until dismissed — like an explicit selection.
    const attachedTextForTurn = attachedTextBlock(pendingAttached);
    const attachedImagesForTurn = attachedImages(pendingAttached);

    // Screen context for THIS turn (assembled once, reused by the relevance
    // gate, buildMessages, and the per-turn RAG recall below).
    const screenContext = [
      activeSession.screenshotOcr ? `OCR:\n${activeSession.screenshotOcr}` : null,
      visionReadbackForTurn ? `Vision readback (from the vision bridge):\n${visionReadbackForTurn}` : null,
      activeSession.clipboard ? `Clipboard:\n${activeSession.clipboard}` : null,
      selectionForTurn ? `Selection:\n${selectionForTurn}` : null,
      paintTextsForTurn.length ? `Paint regions:\n${paintTextsForTurn.join('\n')}` : null,
      appForTurn ? `App: ${appForTurn}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    const turnSources = [
      activeSession.screenshotOcr ? 'ocr' : null,
      visionReadbackForTurn ? 'ocr' : null,
      activeSession.clipboard ? 'clipboard' : null,
      selectionForTurn ? 'selection' : null,
      paintTextsForTurn.length ? 'paint' : null,
      attachedTextForTurn || attachedImagesForTurn.length > 0 ? 'files' : null,
      appForTurn ? 'app' : null,
    ]
      .filter(Boolean)
      .map((s) => s as string);
    let screenRelevance = classifyScreenRelevance(prompt, screenContext);
    // A region the user deliberately SELECTED or PAINTED is always screen-
    // relevant — the pointer is on something they pointed at, no matter how
    // the question reads. And any phrasing that explicitly asks for on-screen
    // pointer/box/arrow annotation names the screen as the subject. Without
    // this override the gate could classify "explain how this reaction takes
    // place" as unrelated, DROP the screenshot, and leave the model blind —
    // the exact state that produced hallucinated annotations ("system tray
    // icon") in the debug session.
    const hasScreenRegion = Boolean(selectionForTurn || paintTextsForTurn.length);
    if (
      screenRelevance === 'unrelated' &&
      (hasScreenRegion || SCREEN_ANNOTATION_ASK_RE.test(prompt))
    ) {
      screenRelevance = 'related';
    }
    const relevanceNote =
      screenRelevance === 'unrelated' ? SCREEN_UNRELATED_NOTE : '';

    // OCR grounding for this turn's screenshot: real word boxes as pixel
    // anchors for the model, so named tags snap to exact text frames instead
    // of estimated blobs. Best-effort — a slow/empty read just degrades to
    // the old estimate behavior. Gated to screen-related turns with a usable
    // full-display geometry. Elements land in the scene stash (re-registered
    // after the per-run clear below) so emitAnnotations SNAPS label matches.
    let ocrGroundNote = '';
    let ocrGroundElements: SceneElement[] | null = null;
    if (screenshotForTurn && screenRelevance !== 'unrelated' && getCurrentPointGeo()) {
      const grounding = await Promise.race([
        ocrGroundFromScreenshotB64(screenshotForTurn, getCurrentPointGeo()).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (grounding) {
        ocrGroundNote = grounding.note;
        ocrGroundElements = grounding.elements;
        console.log(
          `[annotate] ocr-ground: ${ocrGroundElements.length} phrase(s) anchored from the attached screenshot`,
        );
      }
    }

    // Topic pivot: did THIS follow-up question change topic away from the
    // session's opening subject? First-turn questions can't pivot (the session
    // history is empty then, so there is no prior topic to compare against).
    // Deictic questions ("this", "the cows again", "back to that page") are
    // never pivots — they deliberately point at the prior context.
    const topicPivot = (() => {
      if (activeSession.messages.length === 0) return 'uncertain' as const;
      let firstText = '';
      for (const m of activeSession.messages) {
        if (m.role !== 'user') continue;
        if (typeof m.content === 'string') firstText = m.content;
        else if (Array.isArray(m.content)) {
          firstText = m.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
        }
        break;
      }
      const firstTopic = firstText.split(/\n\s*\n/)[0]?.trim();
      if (!firstTopic) return 'uncertain' as const;
      return classifyTopicPivot(prompt, firstTopic);
    })();

    if (activeSession.messages.length === 0) {
      const initial = buildMessages(
        prompt,
        screenshotForTurn,
        activeSession.clipboard,
        selectionForTurn,
        screenRelevance === 'unrelated' ? '' : appForTurn,
        paintTextsForTurn,
        promptWithSkills(SYSTEM_PROMPT, { prompt, appText: appForTurn }),
        undefined,
        // Text-only models read the screen as text: the OCR readback plus,
        // when a vision bridge is configured, a description of the screenshot
        // a vision model wrote (icons/images OCR can't read).
        screenRelevance === 'unrelated'
          ? ''
          : [activeSession.screenshotOcr, visionReadbackForTurn].filter(Boolean).join('\n\n'),
        relevanceNote,
        // Image-geometry caption kills the double-scaled annotation class:
        // the model learns the screenshot's pixel bounds at the source. The
        // OCR anchor-word LIST is VISION models only: handing word boxes to a
        // vision model with "reuse its exact coordinates, never estimate it"
        // railroads it into annotating ONLY the listed text (the OCR-only
        // point regression). A vision model reads labels from the image
        // itself; the OCR/UIA elements still register for post-hoc snapping.
        [
          annotationImageNote(getCurrentPointGeo()),
          visionModel ? null : ocrGroundNote,
        ]
          .filter(Boolean)
          .join('\n\n'),
        // Attach the screenshot IMAGE block only for models that can read it.
        // Text-only models get the same info as OCR text above; a rejected
        // image block would hard-fail the whole round (llama.cpp: "image
        // input is not supported ... provide the mmproj").
        visionModel,
        attachedTextForTurn,
      );
      // Dropped-file images ride as vision blocks on the first turn (text
      // went in via attachedFilesText above). Vision models only — same
      // mmproj rule as the screenshot.
      if (visionModel && attachedImagesForTurn.length > 0) {
        const firstUser = initial.find((m) => m.role === 'user');
        if (firstUser && Array.isArray(firstUser.content)) {
          for (const img of attachedImagesForTurn) {
            if (!img.imageB64) continue;
            firstUser.content.push({
              type: 'image_url',
              image_url: { url: `data:${mimeForExt(img.path)};base64,${img.imageB64}` },
            });
          }
        }
      }
      messages = initial;
      activeSession.firstPrompt = prompt;
      activeSession.selection = selectionForTurn;
      activeSession.templateId = options.templateId ?? null;
      activeSession.web = !!options.web;
    } else {
      // For follow-up turns include the latest clipboard + selection inline so
      // the model sees the user's freshly copied snippet alongside the new prompt.
      // The screenshot OCR is the text of the CURRENT screen (refreshed at this
      // submit) — text-only models read it instead of the image.
      const contextBlocks = [
        activeSession.clipboard
          ? `Selected text from clipboard:\n${activeSession.clipboard}`
          : null,
        screenRelevance === 'unrelated'
          ? null
          : selectionForTurn
            ? `Selected text from screen:\n${selectionForTurn}`
            : null,
        // Dropped files are explicit user intent — always attached,
        // regardless of screen relevance.
        attachedTextForTurn ? attachedTextForTurn : null,
        screenRelevance === 'unrelated'
          ? null
          : paintTextsForTurn.length
            ? `Selected regions from screen:\n${paintTextsForTurn.join('\n\n')}`
            : null,
        screenRelevance === 'unrelated'
          ? null
          : activeSession.screenshotOcr || visionReadbackForTurn
            ? `Text visible on screen (from screenshot):\n${[
                activeSession.screenshotOcr,
                visionReadbackForTurn,
              ]
                .filter(Boolean)
                .join('\n\n')}`
            : null,
        screenRelevance === 'unrelated'
          ? null
          : appForTurn
            ? `Current app:\n${appForTurn}`
            : null,
      ].filter(Boolean) as string[];
      let turnText = contextBlocks.length
        ? `${prompt}\n\n${contextBlocks.join('\n\n')}`
        : prompt;
      // Attach the CURRENT screen capture (refreshed at this submit) to the
      // follow-up message too — vision models see what's on screen NOW, not
      // just the first-turn shot buried in the history. Text-only models get
      // the same info via the OCR block added above. Add a nudge so weak
      // models treat the fresh screen + this question as authoritative over
      // earlier turns' screen state. Skipped when the question is unrelated
      // to the screen — the SCREEN_UNRELATED_NOTE already told the model to
      // ignore it, and contradicting that here would re-trigger the bug.
      if (screenshotForTurn || activeSession.screenshotOcr) {
        const attached = screenshotForTurn && visionModel;
        const currentScreen = attached
          ? 'The screenshot attached to THIS message is the user\'s CURRENT screen (recaptured at submit).'
          : 'The OCR block above is the user\'s CURRENT screen text (recaptured at submit).';
        turnText += `\n\n[${currentScreen} Base your answer on that and the user's question — earlier turns show OLDER screen state.]`;
        const capNote = annotationImageNote(getCurrentPointGeo());
        if (screenshotForTurn && capNote) turnText += ` ${capNote}`;
        // OCR anchor list is text-only-model food; a vision model reads the
        // screenshot and must stay free to annotate ANY target (the list as a
        // directive collapses it onto OCR words — see ocr-ground.ts).
        if (screenshotForTurn && !visionModel && ocrGroundNote) turnText += `\n\n${ocrGroundNote}`;
      }
      // Active-task grounding (topic drift fix): when this follow-up changed
      // topic or isn't about the screen at all, PIN the current question at the
      // END of the message (recency bias is the one reliable lever on 4B local
      // models) and declare it wins over the earlier turns — whose stale first-
      // turn OCR is already masked above when it was a pivot. Never applies to
      // deictic "this/that/it" questions (they need the prior context).
      if (topicPivot === 'pivot' || screenRelevance === 'unrelated') {
        const activeTask = prompt.trim().slice(0, 500);
        turnText += `\n\n[ACTIVE TASK — answer ONLY this question; it overrides earlier screen text and prior answers unless the question refers back: "${activeTask}"]`;
      }
      const userParts: ContentBlock[] = [{ type: 'text', text: turnText }];
      if (screenshotForTurn && visionModel) {
        userParts.push({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${screenshotForTurn}` },
        });
      }
      if (visionModel) {
        for (const img of attachedImagesForTurn) {
          if (!img.imageB64) continue;
          userParts.push({
            type: 'image_url',
            image_url: { url: `data:${mimeForExt(img.path)};base64,${img.imageB64}` },
          });
        }
      }
      // Follow-up turns replay the whole history, so strip OLD screenshot parts
      // from earlier user messages — only THIS turn may carry an image (the
      // fresh capture above, itself gated by screen relevance). A stale
      // first-turn screenshot otherwise rides along in every later request
      // (1500 tokens each) and weak models answer about a screen that's long
      // gone (observed: "what are cows" answered about a feedback webpage).
      const history: Message[] = activeSession.messages.map((m): Message => {
        if (m.role === 'user' && Array.isArray(m.content)) {
          const onlyText = m.content.filter((p) => p.type !== 'image_url');
          return {
            ...m,
            content:
              onlyText.length > 0
                ? onlyText
                : [{ type: 'text', text: '(a screenshot was attached here in an earlier turn)' }],
          } as Message;
        }
        return m;
      });
      messages = [...history, { role: 'user', content: userParts }];
      // De-anchor the stale first turn BEFORE truncation: frees budget for the
      // real recent turns and removes the strongest topic anchor at once, so the
      // window is no longer dominated by the opening topic's OCR text.
      if (topicPivot === 'pivot') {
        messages = maskTurnOneOnPivot(messages);
      }
    }
    messages = truncateForBudget(messages, getMaxContextTokens());

    // Long-term context memory: per-turn RAG recall. Recalls what was learned
    // in earlier chats using ONLY the user's current prompt (screen context is
    // deliberately excluded — it is this-moment evidence, and querying with it
    // made unrelated memories surface) and injects the memories as a
    // stripped/re-injected block in the system msg.
    messages = await withMemoryBlock(messages, prompt);
    // About-the-user line (Settings profile + self-learned name/role):
    // refreshed every turn like the memory block so newly learned facts
    // apply immediately. Gated on personalizePrompts — profile data stays
    // out of prompts unless the user opted in. Covers the LLM answer AND
    // every CUA agent tool call (same system message drives the loop).
    // Same gate + refresh for the behavior-only Preferences line (hour/app
    // counters — never text); one counter bump per submit.
    {
      const prof = getSettingsLight();
      if (prof.personalizePrompts) {
        noteSubmit(appCtx ? appCtx.process || appCtx.title : '');
        messages = withUserProfileLine(
          messages,
          [buildUserProfileLine(prof.userProfile), preferencesLine()]
            .filter(Boolean)
            .join('\n'),
        );
      } else {
        messages = withUserProfileLine(messages, '');
      }
    }
    // Per-app lessons (Phase F): give the model the quirks recorded about the
    // CURRENT foreground app (false-failing GUI launchers, focus that missed,
    // typing that landed elsewhere) as compact hints in the system message —
    // only when the app has any. Mirrors the memory block's inject/replace.
    {
      const appKey = appCtx ? appCtx.process || appCtx.title : '';
      if (appKey) {
        const lessonsBlock = appLessonsBlockFor(appKey, appForTurn.split('\n').find((l) => l.startsWith('Current app: '))?.slice('Current app: '.length));
        if (lessonsBlock) {
          messages = messages.map((m) => ({ ...m }));
          const sys = messages[0];
          if (sys && sys.role === 'system' && typeof sys.content === 'string') {
            sys.content = `${stripAppLessonsBlock(sys.content)}\n\n${lessonsBlock}`;
          }
          // Reuse signal: this injection is a "hit" for the app's lessons —
          // orders future recall (useful first) and protects them from GC.
          touchAppLessons(appKey);
        }
      }
    }

    // Continuity soften on topic pivot: the global SYSTEM_PROMPT tells the model
    // "don't restate context, assume 'this'/'it' mean the most recent subject" —
    // right for continuations, harmful right after a topic change. Inject a
    // volatile-last override AFTER the memory block so the global prompt and the
    // memory block stay byte-identical for prefix caching.
    if (topicPivot === 'pivot' && messages.length > 0 && typeof messages[0].content === 'string') {
      messages[0] = {
        ...messages[0],
        content:
          (messages[0].content as string) +
          '\n\n[This turn changed topic. Prior screen text and earlier answers are background only — answer the NEW question.]',
      };
    }

    // Hard guard AFTER the memory block lands: the first truncation pass (above)
    // ran before withMemoryBlock re-injected the recalled block into the system
    // message, so this pass is the only thing keeping the ASSEMBLED request
    // under the provider window (a real session logged ≈19312 est. vs a 6000
    // budget before this existed). A 0.9 reserve covers the tokenizer's
    // underestimate vs. estimateTokens, and truncateForBudgetKeepLast guarantees
    // the user's just-typed question survives even if history above it is cut.
    messages = truncateForBudgetKeepLast(
      messages,
      Math.floor(getMaxContextTokens() * 0.9),
    );

    // Input observability: print what ACTUALLY shipped to the model this turn
    // (message count + image parts + token estimate + the exact sources that
    // passed the relevance gate, and the last user message verbatim) so the
    // session log pairs every [agentic] output with its real input. Best-effort
    // observability only — never fail a query over the logging.
    try {
      const firstTurn = activeSession.messages.length === 0;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastUserText =
        lastUser && typeof lastUser.content === 'string'
          ? lastUser.content
          : lastUser && Array.isArray(lastUser.content)
            ? lastUser.content
                .filter((p) => p.type === 'text')
                .map((p) => (p as { type: 'text'; text: string }).text)
                .join('\n')
            : '';
      const imageParts = messages.reduce(
        (s, m) =>
          s +
          (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0),
        0,
      );
      const est = messages.reduce((s, m) => s + estimateTokens(m), 0);
      // Fingerprint, never the text: the dev session log is a plain file on
      // disk and user prompts/context blocks must not land in it raw.
      console.log(
        `[run] turn=${activeSession.turnCount + 1} first=${firstTurn} relevance=${screenRelevance} ` +
          `msgs=${messages.length} imgParts=${imageParts} estTokens=${est} budget=${getMaxContextTokens()} ` +
          `sources=[${turnSources.join(',')}] screenshot=${screenshotForTurn ? 'yes' : 'no'}\n` +
          `[run] user-text ${frameHash(lastUserText)}`,
      );
    } catch (err) {
      console.warn('[run] input logging failed:', err instanceof Error ? err.message : String(err));
    }

    // Every submit resets the idle TTL so the conversation stays alive while
    // the user keeps working on the same task.
    extendSessionWindow();

    // Track this turn's assistant text so we can append a clean assistant
    // message to the session when streaming completes. Key takeaways parsed
    // out of the SAME response are held here until onDone commits history.
    let turnAssistantText = '';
    let turnTakeaways: ExtractedMemory[] = [];
    activeSession.turnCount += 1;

    // Annotation protocol (Phase 7) state, reset per submit: incremental tag
    // detection over freshly-streamed text ([POINT]/[BOX]/[ARROW] in story
    // order), a stable run-wide sequence counter for chip numbers, a cleared
    // scene stash (so [BOX:el#] never resolves stale elements from an earlier
    // task), and a clear of the previous answer's overlay + tour.
    const annotationScanner = createAnnotationScanner();
    let annotationSeq = 0;
    // Authoritative annotation set of the finished run (display-local screen
    // coords) — attached to the final answer so past turns can replay it.
    // Reset per run alongside allRunTags.
    let lastFinalAnnotations: ScreenAnnotation[] = [];
    // Annotation coordinate-space auto-heal (per run): a model asked to
    // annotate a downscaled image sometimes writes coordinates for the REAL
    // screen instead (e.g. 1920x1080 numbers into a 1280x720 image). A batch
    // streams live as it completes (so boxes/arrows animate while the model
    // narrates), but every tag is ALSO accumulated run-wide. When the answer
    // becomes authoritative the FULL set is re-decided by the same heuristic
    // and re-broadcast as one unit — so a screen-space latch found anywhere in
    // the run rescales EVERY tag uniformly, and the corrected set stays on
    // screen while the user reads.
    // Tags carry the geometry that was current when each one completed, so a
    // mid-run image swap (a see_screen window shot, a dragged rect) never
    // re-maps a tag against the WRONG image's ruler — the root cause of
    // annotations landing "somewhere else" when the model referenced several
    // screenshots in one run. geo null ⇒ no usable geometry; the tag is dropped
    // at emit (the original geo-NONE behavior).
    type AnnotEntry = {
      tag: AnnotationTag;
      geo: PointGeo | null;
      // When the final-pass resolver (correctAnnotGroup) already decided where
      // this tag lands, the geometry is authoritative: `screen-*` results are
      // real element bounds used verbatim (no geo map, no DX/DY nudge);
      // `image-*` results are mapped through the geo and get the manual nudge
      // but are never re-snapped (the resolver already applied its near-only
      // snap and group shift). Undefined ⇒ the legacy emit path (live batches)
      // snap/map as before.
      resolved?: ResolvedGeom | null;
    };
    let pendingAnnotTags: AnnotEntry[] = [];
    let allRunTags: AnnotEntry[] = [];
    let annotFlushTimer: NodeJS.Timeout | null = null;
    let annotationsFinalized = false;
    clearSceneElements();
    // Re-register this turn's grounding so label-matched annotation tags snap
    // to exact frames: the OCR text boxes first (never overwritten by a later
    // see_screen run, which registers its own richer scene), and the window's
    // UIA/AX elements when the parallel accessibility walk lands — merged with
    // UIA preferred (it beats an OCR phrase for the same control).
    if (ocrGroundElements) rememberSceneElements(ocrGroundElements);
    if (annotUiaPromise) {
      annotUiaPromise
        .then((uiaElements) => {
          if (!uiaElements || annotationsFinalized) return;
          rememberSceneElements(mergeSceneLayers([uiaElements, getSceneElements() ?? []]));
        })
        .catch(() => {});
    }
    broadcastAnnotations(sender, []);
    // Inline [THOUGHT]/[THINKING]/[THINK] blocks get routed to the
    // Chain-of-Thought panel (same channel as provider reasoning_content) and
    // stripped out of the live text, final answer, history and TTS. Stateful
    // across stream deltas so tags split mid-token still resolve.
    const thoughtExtractor = new ThoughtTagExtractor();
    let thoughtReasoningBroadcast = false;

    // Short pause after the last tag before flushing, so tags arriving in
    // tight succession are decided (and rescaled) together in one live batch.
    const ANNOT_FLUSH_SETTLE_MS = 220;
    const scheduleAnnotFlush = (): void => {
      if (annotFlushTimer) clearTimeout(annotFlushTimer);
      annotFlushTimer = setTimeout(() => {
        annotFlushTimer = null;
        flushPendingAnnotations();
      }, ANNOT_FLUSH_SETTLE_MS);
    };

    // Flush one live batch straight through the image→screen mapping. The
    // coordinate-space decision is NOT made here: a live batch rarely has
    // enough tags for a trustworthy call, and flipping mid-run on weak
    // evidence produced the live-wrong/final-different jitter. Live tags stay
    // in the caption-true IMAGE space; the authoritative final pass (below)
    // re-decides the WHOLE run with a consensus and re-broadcasts corrected
    // coordinates once. Each completed tag also joins allRunTags so that pass
    // sees everything.
    const flushPendingAnnotations = (): void => {
      if (annotFlushTimer) {
        clearTimeout(annotFlushTimer);
        annotFlushTimer = null;
      }
      if (pendingAnnotTags.length === 0) return;
      const batch = pendingAnnotTags;
      pendingAnnotTags = [];
      allRunTags.push(...batch);
      // Accumulate the live set for per-turn replay: when the final pass is
      // OFF this is the only annotation set the run produces.
      lastFinalAnnotations.push(...emitAnnotations(batch));
    };

    // Authoritative pass for the finished run. The space decision is made over
    // EVERY tag the run produced — and only flips to screen-space on required
    // consensus — then the complete corrected set is re-broadcast as one unit,
    // wiping the live-streamed set first (fresh seq from 1) so fixed
    // coordinates replace the live ones and the boxes/arrows STAY on screen
    // while the user reads the answer instead of being cleared the instant the
    // answer lands.
    const finalizeAnnotations = async (): Promise<void> => {
      annotationsFinalized = true;
      if (pendingAnnotTags.length > 0) {
        allRunTags.push(...pendingAnnotTags);
        pendingAnnotTags = [];
      }
      if (allRunTags.length === 0) return;
      // Each tag maps against the geo it was born under (its own screenshot's
      // ruler); only geo-less tags fall back to whatever is current now.
      const fallbackGeo = getCurrentPointGeo();
      const waited = allRunTags.map((entry) => ({
        tag: entry.tag,
        geo: entry.geo ?? fallbackGeo,
      }));
      const scale = fallbackGeo ? imageScale(fallbackGeo) : 1;
      const evidenceTags = waited.filter(({ tag, geo }) =>
        geo ? isScreenSpaceEvidence(tag, geo) : false,
      );
      const consensus = screenSpaceConsensus(evidenceTags.length, waited.length);
      // The PHYSICAL-grid class (scale factor sf): tags past both the image AND
      // the DIP window that only fit the display's native px — e.g. `y=886` on
      // an 819-tall image / 864-tall window / 1080-tall physical grid. Whole-run
      // flip on consensus, otherwise the unambiguous tags are still rescued
      // individually (nothing else explains them).
      const physEvidenceTags = waited.filter(({ tag, geo }) =>
        geo ? isPhysicalSpaceEvidence(tag, geo) : false,
      );
      const physConsensus = physicalSpaceConsensus(physEvidenceTags.length, waited.length);
      if (physConsensus) {
        // The physical scale factor: read from the first piece of physical
        // evidence's own geo (fallbackGeo may be null even when per-tag geos
        // carried the evidence).
        const physScale =
          physEvidenceTags.length > 0 && physEvidenceTags[0].geo
            ? physicalImageScale(physEvidenceTags[0].geo)
            : fallbackGeo
              ? physicalImageScale(fallbackGeo)
              : 1;
        console.log(
          `[annotate] FINAL SPACE=physical scale=${physScale.toFixed(3)} ` +
            `evidence=${physEvidenceTags.length}/${waited.length} — whole run rescaled from physical pixels`,
        );
      } else if (consensus) {
        console.log(
          `[annotate] FINAL SPACE=screen scale(win/img)=${scale} evidence=${evidenceTags.length}/${waited.length} — ` +
            `rescaled across the whole run`,
        );
      } else if (evidenceTags.length > 0 || physEvidenceTags.length > 0) {
        console.log(
          `[annotate] FINAL space=image (no consensus: evidence=${evidenceTags.length}/${waited.length}, ` +
            `physical=${physEvidenceTags.length}/${waited.length}) — ` +
            `tags kept in caption-true image space`,
        );
      }
      const normalized = waited.map(({ tag, geo }) => {
        if (!geo) return tag;
        if (physConsensus || isPhysicalSpaceEvidence(tag, geo)) return rescalePhysicalTagToImage(tag, geo);
        if (consensus) return rescaleTagToImage(tag, geo);
        return tag;
      });
      // Grounded Annotation Resolver (pass-2): glue label-matched tags to real
      // scene/OCR frames (near only), then correct the WHOLE group's
      // systematic shift (provider resize → "right shape, wrong spot"). Tags
      // are grouped by the geometry they were born under: each group resolves
      // against the source image its geo can serve. Lives inside the
      // authoritative pass so corrected coordinates replace the live guesses
      // exactly once.
      let cursor = 0;
      const refinedOut = new Array<AnnotationTag>(waited.length);
      const resolvedOut = new Array<ResolvedGeom | null>(waited.length).fill(null);
      const byGeo = new Map<string, AnnotEntry[]>();
      for (const e of waited) {
        const g = e.geo ?? fallbackGeo;
        const key = g
          ? `${g.imgW}x${g.imgH}@${g.absLeft},${g.absTop}:${g.winW}x${g.winH}` +
            (g.region ? `:r${g.region.x},${g.region.y},${g.region.w},${g.region.h}` : '')
          : 'none';
        const list = byGeo.get(key);
        if (list) list.push(e);
        else byGeo.set(key, [e]);
      }
      for (const group of byGeo.values()) {
        const sub = group.map((e) => e.tag);
        let out: AnnotationTag[] = sub;
        let resolved: (ResolvedGeom | null)[] = new Array<ResolvedGeom | null>(sub.length).fill(null);
        const rg = group[0].geo ?? fallbackGeo;
        if (rg && sub.length > 0) {
          // Grounded Annotation Resolver: snap label-matched tags to real
          // element frames (near only), then measure the provider's whole-group
          // shift and move the still-unplaced tags by it — see
          // annotation-resolver.ts.
          const g = await correctAnnotGroup(
            sub,
            screenshotForTurn && visionModel ? screenshotForTurn : null,
            rg,
            getSceneElements(),
            {
              refine: {},
              nativeSource: getLastNativeScreenshot(),
              ground: (b64, geo) => groundedElementsFor(b64, geo),
            },
          );
          for (const line of g.logs) console.log(`[annotate] ${line}`);
          out = g.tags;
          resolved = g.resolved;
        }
        for (let i = 0; i < group.length; i += 1) {
          refinedOut[cursor + i] = out[i] ?? group[i].tag;
          resolvedOut[cursor + i] = resolved[i] ?? null;
        }
        cursor += group.length;
      }
      // Wipe the live streamed annotations, then deliver the authoritative set
      // numbered from 1 again so chips read "1 · …" for the first tag.
      // Snapshot it for per-turn replay (attached to the final answer).
      const entries = waited.map((entry, i) => ({
        tag: refinedOut[i] ?? entry.tag,
        geo: entry.geo,
        resolved: resolvedOut[i] ?? null,
      }));
      annotationSeq = 0;
      broadcastAnnotations(sender, []);
      lastFinalAnnotations = emitAnnotations(entries);
      allRunTags = [];
    };

    // Map a set of image-space tags to screen DIP, log each one, and broadcast.
    // seq is assigned per tag so chip numbers track story order (a skipped
    // number just means one tag couldn't map). Returns the emitted set so
    // the authoritative final pass can snapshot it for per-turn replay.
    const emitAnnotations = (entries: AnnotEntry[]): ScreenAnnotation[] => {
      const sceneEls = getSceneElements();
      const light = getSettingsLight();
      // Manual calibration nudge for GUESSED coords (raw img->screen mapped
      // points/boxes/arrows). Element-snapped and box-el frames are REAL
      // bounds and must NOT be pushed around by this.
      const DX = light.annotOffsetX ?? 0;
      const DY = light.annotOffsetY ?? 0;
      const out: ScreenAnnotation[] = [];
      // Display labels are shown in chips/boxes/arrow tags on the overlay —
      // model-written LaTeX (\beta_1, \frac{a}{b}, \text{C=O}) has no math
      // engine there, so render it down to readable Unicode before it leaves
      // main. The near-snap label MATCHING above already ran on the raw label.
      const tagLabel = (label: string): string => latexToUnicodeText(label);
      // Near-radius guard (same as resolver): a label match only snaps when
      // the element is near the guess (≤320px). Far captions never hijack.
      const NEAR_RADIUS = 320;
      // Each tag maps against the geometry it was captured under (a per-tag
      // snapshot from scan time); only geo-less tags fall back to current.
      const fallbackGeo = getCurrentPointGeo();
      for (const entry of entries) {
        const t = entry.tag;
        const geo = entry.geo ?? fallbackGeo;
        annotationSeq += 1;
        const seq = annotationSeq;
        // One-line `[annotate]` diagnostic per tag: input coordinate (already
        // rescaled to image pixels when the run was screen-space; the ORIGINAL
        // screen numbers appear in the SPACE=screen line above), the geo used
        // to map it, and where it ended up in screen DIP — or WHY it was
        // dropped. Copy the line from DevTools when a pointer lands off-target
        // so the mapping can be traced.
        const geoInfo = geo
          ? `geo(img ${geo.imgW}x${geo.imgH} @ ${geo.absLeft},${geo.absTop} win ${geo.winW}x${geo.winH}${geo.region ? ` reg ${geo.region.x},${geo.region.y} ${geo.region.w}x${geo.region.h}` : ''})`
          : 'geo NONE';
        // Final-pass resolver geometry (see correctAnnotGroup): the screenshot
        // the model saw is NOT what it thinks — the group of guesses is
        // systematically shifted, so the resolver glues label-matched tags to
        // real frames and shifts the leftovers by the measured group offset.
        // `screen-*` results are real bounds (no map, no nudge, no re-snap);
        // `image-*` results map through the geo with the manual nudge but skip
        // the re-snap the resolver already decided against.
        const resolvedGeom = entry.resolved ?? null;
        if (resolvedGeom) {
          if (resolvedGeom.kind === 'screen-point') {
            console.log(
              `[annotate] #${seq} point GLUED "${t.label}" -> real center(${resolvedGeom.x},${resolvedGeom.y}) ${geoInfo}`,
            );
            out.push({ kind: 'point', x: resolvedGeom.x, y: resolvedGeom.y, label: tagLabel(t.label), seq });
          } else if (resolvedGeom.kind === 'screen-box') {
            const { x, y, w, h } = resolvedGeom;
            if (geo && coversNearlyWholeFrame({ x, y, w, h }, geo.winW, geo.winH)) {
              console.log(
                `[WARN] [annotate] #${seq} box WHOLE-SCREEN "${t.label}" (${x},${y},${w}x${h}) over ${geo.winW}x${geo.winH} — dropped (box a specific region, never the whole screen) ${geoInfo}`,
              );
            } else {
              console.log(
                `[annotate] #${seq} box GLUED "${t.label}" -> real bounds(${x},${y},${w}x${h}) ${geoInfo}`,
              );
              out.push({ kind: 'box', x, y, w, h, label: tagLabel(t.label), seq });
            }
          } else if (resolvedGeom.kind === 'screen-arrow') {
            const { x1, y1, x2, y2 } = resolvedGeom;
            console.log(
              `[annotate] #${seq} arrow GLUED "${t.label}" -> real(${x1},${y1}->${x2},${y2}) ${geoInfo}`,
            );
            out.push({ kind: 'arrow', x1, y1, x2, y2, label: tagLabel(t.label), seq });
          } else if (resolvedGeom.kind === 'image-point') {
            if (!geo) {
              console.log(`[annotate] #${seq} point DROPPED (${geoInfo})`);
            } else if (isOutOfImageBounds({ x: resolvedGeom.x, y: resolvedGeom.y }, geo)) {
              console.log(
                `[annotate] #${seq} point OOB img(${resolvedGeom.x},${resolvedGeom.y}) over ${geo.imgW}x${geo.imgH} label="${t.label}" ${geoInfo}`,
              );
            } else {
              const p = mapPointToScreen(
                { x: resolvedGeom.x, y: resolvedGeom.y, label: tagLabel(t.label), screen: 0 },
                geo,
              );
              if (p) {
                console.log(
                  `[annotate] #${seq} point img(${resolvedGeom.x},${resolvedGeom.y}) -> screen(${p.x},${p.y}) ${geoInfo} label="${t.label}"`,
                );
                out.push({ kind: 'point', x: p.x + DX, y: p.y + DY, label: tagLabel(t.label), seq });
              } else {
                console.log(`[annotate] #${seq} point UNMAPPED (${geoInfo})`);
              }
            }
          } else if (resolvedGeom.kind === 'image-box') {
            if (!geo) {
              console.log(`[annotate] #${seq} box DROPPED (${geoInfo})`);
            } else if (coversNearlyWholeFrame(resolvedGeom, geo.imgW, geo.imgH)) {
              console.log(
                `[WARN] [annotate] #${seq} box WHOLE-SCREEN "${t.label}" (${resolvedGeom.x},${resolvedGeom.y},${resolvedGeom.w}x${resolvedGeom.h}) over ${geo.imgW}x${geo.imgH} — dropped (box a specific region, never the whole screen) ${geoInfo}`,
              );
            } else if (isBoxOutOfImageBounds(resolvedGeom, geo)) {
              console.log(
                `[annotate] #${seq} box OOB img(${resolvedGeom.x},${resolvedGeom.y},${resolvedGeom.w}x${resolvedGeom.h}) over ${geo.imgW}x${geo.imgH} label="${t.label}" ${geoInfo}`,
              );
            } else {
              const b = mapBoxToScreen(resolvedGeom, geo);
              if (b) {
                console.log(
                  `[annotate] #${seq} box img(${resolvedGeom.x},${resolvedGeom.y},${resolvedGeom.w}x${resolvedGeom.h}) -> screen(${b.x},${b.y},${b.w}x${b.h}) ${geoInfo} label="${t.label}"`,
                );
                out.push({ kind: 'box', x: b.x + DX, y: b.y + DY, w: b.w, h: b.h, label: tagLabel(t.label), seq });
              } else {
                console.log(`[annotate] #${seq} box UNMAPPED (${geoInfo})`);
              }
            }
          } else if (resolvedGeom.kind === 'image-arrow') {
            if (!geo) {
              console.log(`[annotate] #${seq} arrow DROPPED (${geoInfo})`);
            } else if (
              isArrowOutOfImageBounds(
                { x1: resolvedGeom.x1, y1: resolvedGeom.y1, x2: resolvedGeom.x2, y2: resolvedGeom.y2 },
                geo,
              )
            ) {
              console.log(
                `[annotate] #${seq} arrow OOB img(${resolvedGeom.x1},${resolvedGeom.y1}->${resolvedGeom.x2},${resolvedGeom.y2}) over ${geo.imgW}x${geo.imgH} label="${t.label}" ${geoInfo}`,
              );
            } else {
              const a = mapArrowToScreen(
                { x1: resolvedGeom.x1, y1: resolvedGeom.y1, x2: resolvedGeom.x2, y2: resolvedGeom.y2, screen: 0 },
                geo,
              );
              if (a) {
                console.log(
                  `[annotate] #${seq} arrow img(${resolvedGeom.x1},${resolvedGeom.y1}->${resolvedGeom.x2},${resolvedGeom.y2}) -> screen(${a.x1},${a.y1}->${a.x2},${a.y2}) ${geoInfo} label="${t.label}"`,
                );
                out.push({
                  kind: 'arrow',
                  x1: a.x1 + DX,
                  y1: a.y1 + DY,
                  x2: a.x2 + DX,
                  y2: a.y2 + DY,
                  label: tagLabel(t.label),
                  seq,
                });
              } else {
                console.log(`[annotate] #${seq} arrow UNMAPPED (${geoInfo})`);
              }
            }
          }
          continue;
        }
        if (t.kind === 'point') {
          if (!geo) {
            console.log(`[annotate] #${seq} point DROPPED (${geoInfo})`);
            continue;
          }
          const el = sceneEls ? matchElementByLabel(t.label, sceneEls, t.x, t.y) : null;
          if (el) {
            const hintScreen = mapPointToScreen({ x: t.x, y: t.y, label: '', screen: 0 }, geo!);
            if (hintScreen) {
              // el.bounds/center are AGENT units; the near-guard and the emit
              // both live in screen DIP.
              const ecx = agentToDip(geo!, typeof el.center?.[0] === 'number' ? el.center[0] : (el.bounds[0] + el.bounds[2]) / 2);
              const ecy = agentToDip(geo!, typeof el.center?.[1] === 'number' ? el.center[1] : (el.bounds[1] + el.bounds[3]) / 2);
              const dx = ecx - hintScreen.x;
              const dy = ecy - hintScreen.y;
              if (dx * dx + dy * dy <= NEAR_RADIUS * NEAR_RADIUS) {
                console.log(
                  `[annotate] #${seq} point SNAPPED "${t.label}" -> el ${el.id} center(${el.center.join(',')}) (was img ${t.x},${t.y})`,
                );
                out.push({ kind: 'point', x: ecx, y: ecy, label: tagLabel(t.label), seq });
                continue;
              }
            }
          }
          if (isOutOfImageBounds({ x: t.x, y: t.y }, geo)) {
            console.log(
              `[annotate] #${seq} point OOB img(${t.x},${t.y}) over ${geo.imgW}x${geo.imgH} label="${t.label}" ${geoInfo}`,
            );
            continue;
          }
          const p = mapPointToScreen(t, geo);
          if (p) {
            console.log(
              `[annotate] #${seq} point img(${t.x},${t.y}) -> screen(${p.x},${p.y}) ${geoInfo} label="${t.label}"`,
            );
            out.push({ kind: 'point', x: p.x + DX, y: p.y + DY, label: tagLabel(t.label), seq });
          } else {
            console.log(`[annotate] #${seq} point UNMAPPED (${geoInfo})`);
          }
        } else if (t.kind === 'box') {
          if (!geo) {
            console.log(`[annotate] #${seq} box DROPPED (${geoInfo})`);
            continue;
          }
          if (coversNearlyWholeFrame(t, geo.imgW, geo.imgH)) {
            console.log(
              `[WARN] [annotate] #${seq} box WHOLE-SCREEN "${t.label}" (${t.x},${t.y},${t.w}x${t.h}) over ${geo.imgW}x${geo.imgH} — dropped (box a specific region, never the whole screen) ${geoInfo}`,
            );
            continue;
          }
          const el = sceneEls
            ? matchElementByLabel(t.label, sceneEls, t.x + t.w / 2, t.y + t.h / 2, {
                x: t.x,
                y: t.y,
                w: t.w,
                h: t.h,
              })
            : null;
          if (el) {
            const boxCenterScreen = mapBoxToScreen({ x: t.x + t.w / 2, y: t.y + t.h / 2, w: 0, h: 0 }, geo!);
            if (boxCenterScreen) {
              // el.bounds/center are AGENT units; the near-guard and the emit
              // both live in screen DIP.
              const ecx = agentToDip(geo!, (el.bounds[0] + el.bounds[2]) / 2);
              const ecy = agentToDip(geo!, (el.bounds[1] + el.bounds[3]) / 2);
              const dx = ecx - boxCenterScreen.x;
              const dy = ecy - boxCenterScreen.y;
              if (dx * dx + dy * dy <= NEAR_RADIUS * NEAR_RADIUS) {
                const b = el.bounds;
                console.log(
                  `[annotate] #${seq} box SNAPPED "${t.label}" -> el ${el.id} bounds(${b.join(',')}) (was img ${t.x},${t.y},${t.w}x${t.h})`,
                );
                const bx = agentToDip(geo!, b[0]);
                const by = agentToDip(geo!, b[1]);
                const bx2 = agentToDip(geo!, b[2]);
                const by2 = agentToDip(geo!, b[3]);
                out.push({
                  kind: 'box',
                  x: bx,
                  y: by,
                  w: bx2 - bx,
                  h: by2 - by,
                  label: tagLabel(t.label),
                  seq,
                });
                continue;
              }
            }
          }
          if (isBoxOutOfImageBounds(t, geo)) {
            console.log(
              `[annotate] #${seq} box OOB img(${t.x},${t.y},${t.w}x${t.h}) over ${geo.imgW}x${geo.imgH} label="${t.label}" ${geoInfo}`,
            );
            continue;
          }
          const b = mapBoxToScreen(t, geo);
          if (b) {
            console.log(
              `[annotate] #${seq} box img(${t.x},${t.y},${t.w}x${t.h}) -> screen(${b.x},${b.y},${b.w}x${b.h}) ${geoInfo} label="${t.label}"`,
            );
            out.push({ kind: 'box', x: b.x + DX, y: b.y + DY, w: b.w, h: b.h, label: tagLabel(t.label), seq });
          } else {
            console.log(`[annotate] #${seq} box UNMAPPED (${geoInfo})`);
          }
        } else if (t.kind === 'box-el') {
          const frame = resolveSceneElementFrame(t.id);
          if (frame) {
            // frames come back in AGENT units (native physical px on Windows,
            // DIP on macOS); the overlay is absolute screen DIP, so divide.
            const bx = agentToDip(geo!, frame.bounds[0]);
            const by = agentToDip(geo!, frame.bounds[1]);
            const bx2 = agentToDip(geo!, frame.bounds[2]);
            const by2 = agentToDip(geo!, frame.bounds[3]);
            console.log(
              `[annotate] #${seq} box-el ${t.id} -> bounds(${frame.bounds.join(',')}) label="${t.label}"`,
            );
            out.push({
              kind: 'box',
              x: bx,
              y: by,
              w: bx2 - bx,
              h: by2 - by,
              label: tagLabel(t.label),
              seq,
            });
          } else {
            console.log(`[annotate] #${seq} box-el ${t.id} UNRESOLVED label="${t.label}"`);
          }
        } else if (geo) {
          if (isArrowOutOfImageBounds(t, geo)) {
            console.log(
              `[annotate] #${seq} arrow OOB img(${t.x1},${t.y1}->${t.x2},${t.y2}) over ${geo.imgW}x${geo.imgH} label="${t.label}" ${geoInfo}`,
            );
            continue;
          }
          const a = mapArrowToScreen(t, geo);
          if (a) {
            console.log(
              `[annotate] #${seq} arrow img(${t.x1},${t.y1}->${t.x2},${t.y2}) -> screen(${a.x1},${a.y1}->${a.x2},${a.y2}) ${geoInfo} label="${t.label}"`,
            );
            out.push({
              kind: 'arrow',
              x1: a.x1 + DX,
              y1: a.y1 + DY,
              x2: a.x2 + DX,
              y2: a.y2 + DY,
              label: tagLabel(t.label),
              seq,
            });
          } else {
            console.log(`[annotate] #${seq} arrow UNMAPPED (${geoInfo})`);
          }
        } else if (t.kind === 'arrow') {
          console.log(`[annotate] #${seq} arrow DROPPED (${geoInfo})`);
        }
      }
      if (out.length > 0) broadcastAnnotations(sender, out);
      return out;
    };

    // Commit the turn's answer (+ Key takeaways) to the running session. Both
    // the normal end-of-run and the interrupted path use this, so a partial
    // answer is remembered exactly like a complete one — Continue then resumes
    // from real history instead of asking the model to re-derive it.
    const commitTurn = async (): Promise<void> => {
      if (!activeSession) return;
      // Fallback for streams that never emit onFinalAnswer: still strip the
      // Key takeaways section so it never leaks into history.
      if (turnTakeaways.length === 0) {
        const split = splitRememberSection(turnAssistantText);
        if (split.cleaned !== turnAssistantText) turnAssistantText = split.cleaned;
        turnTakeaways = split.takeaways;
      }
      const sess = activeSession;
      if (sess.messages.length === 0) {
        // First turn: pull system + user that were just sent. The RAG memory
        // block is stripped before commit so it never pollutes session history
        // — it is re-injected fresh each turn.
        sess.messages = messages.map((m, i) =>
          i === 0 && m.role === 'system' && typeof m.content === 'string'
            ? { ...m, content: stripMemoryBlock(m.content) }
            : m,
        );
      } else {
        sess.messages.push({ role: 'user', content: prompt });
      }
      sess.messages.push({ role: 'assistant', content: turnAssistantText });
      // Long-term context memory: remember the Key takeaways the model
      // appended in the SAME response — no extra LLM call.
      if (isContextMemoryEnabled() && turnTakeaways.length > 0) {
        const rememberResult = await rememberTakeaways(turnTakeaways, turnSources).catch(() => null);
        if (rememberResult && rememberResult.added > 0) {
          const first = (rememberResult.addedTexts[0] ?? '').trim();
          const brief = first.length > 70 ? first.slice(0, 70).trimEnd() + '…' : first;
          const more = rememberResult.added > 1 ? ` (+${rememberResult.added - 1} more)` : '';
          broadcastToOverlays(CHANNELS.LearnedHint, {
            text: `Memory updated${brief ? ` · ${brief}` : ''}${more}`,
            kind: 'memory',
          });
        }
        // Self-learned profile (Hermes USER.md-style): a takeaway like
        // "User's name is Ana" fills the EMPTY Settings profile field.
        try {
          const learned = extractProfileUpdates(turnTakeaways);
          if (learned.name || learned.role || learned.preferredLanguage) {
            const filled = applyLearnedProfile(learned);
            if (filled.length > 0) {
              broadcastToOverlays(CHANNELS.LearnedHint, {
                text: `Noted your ${filled.join(' + ')}`,
                kind: 'profile',
              });
            }
          }
        } catch {
          /* profile learning is best-effort */
        }
      }
      // This turn is now committed history — remember the app context it
      // carried so the next submit can detect a switch.
      lastTurnAppContextKey = freshContextKey;
    };

    currentStream = streamCompletion(
      prompt,
      screenshotForTurn,
      activeSession.clipboard,
      {
        onChunk: (text) => {
          if (run.cancelled) return;
          // Split [THOUGHT]…[/THOUGHT] reasoning OUT of the answer stream: only
          // the non-tag text is appended/published, the reasoning rides the
          // LLMReasoning channel the CoT panel already renders.
          const thought = thoughtExtractor.push(text);
          if (thought.reasoning) {
            thoughtReasoningBroadcast = true;
            broadcastToOverlays(CHANNELS.LLMReasoning, { runId: run.id, delta: thought.reasoning });
          }
          if (!thought.answer) return;
          turnAssistantText += thought.answer;
          const freshTags = annotationScanner.scan(thought.answer);
          if (freshTags.length > 0) {
            // Live: hold for the settle window, then flush the batch so the
            // boxes/arrows animate while the model narrates. The authoritative
            // final pass re-decides the WHOLE run and re-broadcasts it. Each
            // tag snapshots the geometry current at this instant — a later
            // see_screen/drag-rect image swap must not re-aim it at another
            // image's ruler. Grid rescue: the see_screen swap CHANGED the live
            // ruler mid-answer, but the model keeps writing numbers in the
            // submit grid it was told first (it anchors to first numbers it
            // reads). A tag that doesn't fit the current ruler but DOES fit
            // the run-baseline grid (beginAnnotationRuler) was written in that
            // grid — map it with the baseline geometry so it lands on screen
            // correctly instead of being dropped by the OOB guard below.
            const geoLive = getCurrentPointGeo();
            const geoBaseline = getLaunchPointGeo();
            pendingAnnotTags.push(
              ...freshTags.map((tag) => ({
                tag,
                // box-el tags resolve to a scene element's REAL frame — no
                // pixel coords to rescue against a different grid.
                geo:
                  tag.kind === 'box-el'
                    ? geoLive
                    : fitGeoForTag(tag, geoLive, geoBaseline) ?? geoLive,
              })),
            );
            scheduleAnnotFlush();
          }
          // BroadCAST (all overlays) so the answer box that follows the mouse
          // shows the LIVE stream on whatever display the cursor is on. Raw
          // [UI]/[QUESTIONS]/[MERMAID] JSON is masked out of the visible text
          // and replaced by a live placeholder state (uiLive) the renderer
          // turns into a titled tile; the authoritative segments arrive with
          // the final answer.
          const live = liveUiFrom(turnAssistantText);
          broadcastToOverlays(CHANNELS.LLMChunk, {
            runId: run.id,
            // Annotation tags are data for the on-screen annotations, never
            // answer text: hide them from the live stream too (the final
            // answer strips them again via stripAnnotations).
            text: maskAnnotationTags(live.maskedText),
            uiLive: live.live,
          });
        },
        onToolStart: (id, label, name, args) => {
          sendActivity({ kind: 'start', id, name, label, args });
        },
        onToolEnd: (id, name, ok, summary) => {
          if (!sender.isDestroyed()) sender.send(CHANNELS.ToolApprovalCleared, id);
          sendActivity({ kind: 'end', id, name, ok, summary });
        },
        onReasoning: (delta) => {
          if (run.cancelled) return;
          broadcastToOverlays(CHANNELS.LLMReasoning, { runId: run.id, delta });
        },
        onFinalAnswer: async (text) => {
          // The stream is done — flush any tags still held in the settle
          // buffer so the answer's last annotations still surface.
          flushPendingAnnotations();
          // Great parse target: split inline [THOUGHT]/[THINKING]/[THINK]
          // reasoning out of the assembled final text so it never reaches the
          // display answer, history or TTS. When the live chunks ALREADY
          // carried it (streaming flag set in onChunk) we only strip here; when
          // a provider emits only the final text we broadcast it too.
          const fin = splitThoughtTags(text);
          if (fin.reasoning && !thoughtReasoningBroadcast) {
            thoughtReasoningBroadcast = true;
            if (!run.cancelled) {
              broadcastToOverlays(CHANNELS.LLMReasoning, { runId: run.id, delta: fin.reasoning });
            }
          }
          // Authoritative final answer. [UI] / [QUESTIONS] / [MERMAID] blocks
          // are extracted FIRST — their private-use markers then ride through
          // every later strip (web images, next chips, [REPLY], Key
          // takeaways) at their exact inline positions, and resolveUiMarkers
          // turns them back into inline UI segments at the end. The plain
          // marker-free text is committed to history and spoken by TTS.
          const uiExtract = extractUiBlocks(fin.answer);
          let clean = uiExtract.text;
          clean = await stripWebImagesFromAnswer(clean);
          clean = publishNextChipsFromAnswer(clean);
          // [REPLY] contract: only the text between the tags is the display
          // answer; reasoning/narration before or after is discarded. No tags
          // present → unchanged (never guess). Runs after the NEXT_ACTIONS
          // strip so the block is parsed even if the model nested it inside.
          clean = stripReplyPayload(clean);
          const split = splitRememberSection(clean);
          clean = split.cleaned;
          turnTakeaways = split.takeaways;
          // [POINT]/[BOX]/[ARROW] tags are data for the on-screen annotations, not
          // answer text — they never reach the displayed answer, TTS, or session
          // history.
          clean = stripAnnotations(clean);
          // Surface tags the parser couldn't turn into anything drawable — the
          // model's garbage tags get stripped silently and would otherwise leave
          // a "I asked for annotations but nothing appeared" turn unexplained.
          for (const dead of findUnparseableAnnotationTokens(fin.answer)) {
            console.log(`[WARN] [annotate] unparseable tag dropped without drawing: ${dead}`);
          }
          const resolved = resolveUiMarkers(clean, uiExtract.blocks);
          turnAssistantText = resolved.plainText;          // Annotations turn to HISTORY when the answer is authoritative — but
          // not by vanishing: the whole run's tags are re-decided by the
          // coordinate-space auto-heal and re-broadcast as one unit, so the
          // boxes/arrows STAY on screen while the user reads the answer (the
          // renderer auto-fades them after ~8s). This replaces the old hard
          // clear, which raced the run-end flush into invisibility. Gated by
          // the "Annotation final pass" setting (default off): when off, the
          // live boxes are the run's only annotations — no second step.
          if (getSettingsLight().annotFinalPass === true) await finalizeAnnotations();
          if (run.cancelled) return;
          broadcastToOverlays(CHANNELS.LLMFinal, {
            runId: run.id,
            text: turnAssistantText,
            ui: resolved.segments.length > 0 ? resolved.segments : undefined,
            annotations: lastFinalAnnotations.length > 0 ? lastFinalAnnotations : undefined,
          });
        },
        onDone: async () => {
          currentStream = null;
          // Run over — surface any tags still sitting in the settle buffer
          // (providers that stream only onFinalAnswer or skip it entirely).
          flushPendingAnnotations();
          // If onFinalAnswer never fired (truncated/error-free stream), the
          // run's annotations still get the authoritative re-broadcast here so
          // they persist for the user instead of never presenting. Skipped
          // when the final pass is off (default) — live boxes already stand.
          if (getSettingsLight().annotFinalPass === true && !annotationsFinalized) {
            await finalizeAnnotations();
          }
          // Fallback: if a stream neither chunked reasoning nor finalized
          // (error-free but truncated), surface any unclosed trailing thought.
          const leftover = thoughtExtractor.flush();
          if (leftover.reasoning && !thoughtReasoningBroadcast) {
            if (!run.cancelled) {
              broadcastToOverlays(CHANNELS.LLMReasoning, { runId: run.id, delta: leftover.reasoning });
            }
          }
          // Run is over — no more tool broadcasts; the images already shown
          // stay on screen until the next submit clears them.
          webImagesArmed = false;
          await commitTurn();
          run.sendDone();
        },
        onInterrupted: async (message, code, partialText) => {
          currentStream = null;
          webImagesArmed = false;
          if (annotFlushTimer) {
            clearTimeout(annotFlushTimer);
            annotFlushTimer = null;
          }
          console.warn(`[run] interrupted [${code ?? 'unknown'}]: ${message}`);
          broadcastAnnotations(sender, []);
          // Keep whatever already streamed. Annotation tags and reasoning are
          // data, not answer text — strip them so the kept partial reads clean.
          const streamed = turnAssistantText.trim();
          const fallback = stripAnnotations(splitThoughtTags(partialText ?? '').answer).trim();
          const kept = streamed || fallback;
          if (!kept) {
            // Nothing to preserve — behave like a normal error.
            run.sendError(message, code);
            return;
          }
          turnAssistantText = kept;
          await commitTurn();
          run.sendInterrupted(message, code, kept);
        },
        onError: (message, code) => {
          currentStream = null;
          webImagesArmed = false;
          if (annotFlushTimer) {
            clearTimeout(annotFlushTimer);
            annotFlushTimer = null;
          }
          // Errors were NEVER logged here before, which is exactly why every
          // failed run looked like a silent self-cancel (the one visible trace
          // was a one-line message in the UI box). Log the classified code +
          // message so failures show up in logs/ like every other event.
          console.error(`[run] error [${code ?? 'unknown'}]: ${message}`);
          broadcastAnnotations(sender, []);
          run.sendError(message, code);
        },
      },
      {
        web: options.web,
        templateId: options.templateId,
        requestToolApproval,
        existingMessages: messages,
      },
    );
    run.stream = currentStream;
  };

  ipcMain.handle(CHANNELS.LLMQuery, async (e, prompt: string) => {
    await runQuery(e, prompt, {});
  });

  ipcMain.handle(
    CHANNELS.LLMQueryOptions,
    async (
      e,
      prompt: string,
      options: { web?: boolean; templateId?: TemplateId; fromChip?: boolean; runId?: string },
    ) => {
      await runQuery(e, prompt, options ?? {});
    },
  );

  ipcMain.handle(CHANNELS.FetchLinkMeta, async (_e, url: string) => {
    if (typeof url !== 'string') return null;
    return await fetchLinkMeta(url);
  });

  ipcMain.on(CHANNELS.Quit, () => {
    app.quit();
  });

  ipcMain.on(CHANNELS.OpenSettings, () => {
    broadcastSettingsOpen();
  });

  ipcMain.handle(
    CHANNELS.SaveResponse,
    async (
      _e,
      payload: { prompt: string; markdown: string; web: boolean; images?: import('../types').WebImage[] },
    ) => {
      return await saveResponse(payload);
    },
  );

  ipcMain.handle(CHANNELS.PickWorkspaceFolder, async () => {
    const result = await withOverlaysLowered(() =>
      dialog.showOpenDialog({
        title: 'Choose Spirit workspace folder',
        defaultPath: getSettings().workspaceFolder,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Choose folder',
      }),
    );
    if (result.canceled || result.filePaths.length === 0) return null;
    const folder = result.filePaths[0];
    setSettings({ workspaceFolder: folder });
    return folder;
  });

  ipcMain.handle(CHANNELS.AppVersion, () => app.getVersion());

  // Test a provider API key. The handler is intentionally stateless — it does
  // NOT persist anything; the renderer decides what to do with the result. We
  // also explicitly don't read the key from getSettings(); the renderer hands
  // it in so an unsaved typing-in-progress can be validated without forcing
  // the user to save first.
  ipcMain.handle(
    CHANNELS.TestProviderKey,
    async (_e, payload: { provider: ProviderId; apiKey: string }) => {
      return await testProviderKey(payload.provider, payload.apiKey);
    },
  );

  // Local AI server probe + model auto-detect. Stateless like the
  // key test: the renderer hands in the current form's base URL and optional
  // key so an unsaved edit can be validated without saving first.
  ipcMain.handle(
    CHANNELS.DetectLocalModels,
    async (_e, payload: { baseUrl: string; apiKey: string }) => {
      return await detectLocalModels(payload.baseUrl, payload.apiKey);
    },
  );

  // Lightweight Local AI connection test. Separate from Detect so
  // the user can check reachability without triggering a model re-scan.
  ipcMain.handle(
    CHANNELS.TestLocalAi,
    async (_e, payload: { baseUrl: string; apiKey: string }) => {
      return await testLocalAiServer(payload.baseUrl, payload.apiKey);
    },
  );

  // Opencode server connection test + live model discovery. Both are
  // stateless: the renderer hands in the current base URL so an unsaved edit
  // can be validated and model list refreshed without saving first.
  ipcMain.handle(
    CHANNELS.TestOpencode,
    async (_e, payload: { baseUrl: string }) => {
      return await testOpencodeServer(payload.baseUrl);
    },
  );

  ipcMain.handle(
    CHANNELS.DetectOpencodeModels,
    async (_e, payload: { baseUrl: string }) => {
      return await detectOpencodeModels(payload.baseUrl);
    },
  );

  ipcMain.handle(CHANNELS.ListSessions, () => listSessions());
  ipcMain.handle(CHANNELS.LoadLatestSession, () => loadLatestSessionMarkdown());
  ipcMain.handle(CHANNELS.RevealSession, async (_e, rel: string) => {
    // Renderer passes a relative path (relative to the workspace folder).
    // The main process resolves it and enforces workspace containment so a
    // crafted relative input cannot reveal arbitrary filesystem locations.
    const resolved = resolveSessionRelativePath(rel);
    if (!resolved) return;
    shell.showItemInFolder(resolved);
  });
  ipcMain.handle(CHANNELS.ClearSessions, () => clearAllSessions());
  ipcMain.handle(CHANNELS.SessionClear, async (e) => {
    await resetCurrentSession();
    // /clear also dismisses any on-screen annotations/tour on this overlay.
    broadcastToOverlays(CHANNELS.AnnotationStream, { annotations: [] });
    // /clear starts a NEW session — retake the screen NOW (right around the
    // cursor, like a fresh overlay open) so the fresh session's "Screenshot
    // attached" chip + suggestion chips describe the CURRENT app, never the
    // previous one. Otherwise the first submit finds a null pendingScreenshot
    // and has to wait for the submit-time capture anyway.
    try {
      await runLaunchCapture(screen.getCursorScreenPoint());
    } catch (err) {
      console.error('[handlers] /clear launch capture failed:', err);
    }
  });

  // /memory manager UI. list returns the full store when memory is enabled
  // (the manager shows an empty state otherwise); delete/update/clear mutate
  // the store by id. These run only on explicit user taps in the overlay.
  ipcMain.handle(CHANNELS.MemoryList, async () =>
    isContextMemoryEnabled() ? getAllMemories() : [],
  );
  ipcMain.handle(CHANNELS.MemoryDelete, async (_e, id: string) => deleteMemory(id));
  ipcMain.handle(CHANNELS.MemoryUpdate, async (_e, id: string, text: string) =>
    updateMemory(id, text),
  );
  ipcMain.handle(CHANNELS.MemoryClear, async () => {
    await clearMemories();
    return true;
  });

  // Skills (Phase 5). Catalog list also triggers first load (initSkillsRuntime
  // is idempotent); setEnabled persists and returns the re-resolved catalog.
  ipcMain.handle(CHANNELS.SkillsList, () => {
    initSkillsRuntime();
    return getSkillsCatalog();
  });
  ipcMain.handle(CHANNELS.SkillsSetEnabled, (_e, id: string, enabled: boolean) => {
    setSkillEnabled(typeof id === 'string' ? id : '', enabled === true);
    return getSkillsCatalog();
  });

  ipcMain.handle(CHANNELS.SynthesizeSpeech, async (_e, text: string) => {
    try {
      const result = await synthesizeSpeech(text);
      console.log(`[tts] IPC voice:synthesize OK: audio=${result.audioBase64.length} base64 chars`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'TTS failed';
      console.error(`[tts] IPC voice:synthesize ERROR: ${msg}`);
      return { error: msg };
    }
  });

  ipcMain.on(CHANNELS.ToolApprovalRespond, (_e, id: string, approved: boolean) => {
    const resolve = pendingApprovals.get(id);
    if (!resolve) return;
    console.log(`[approval] answered ${approved ? 'YES' : 'NO'}: ${id}`);
    pendingApprovals.delete(id);
    const timer = approvalTimeouts.get(id);
    if (timer) clearTimeout(timer);
    approvalTimeouts.delete(id);
    resolve(!!approved);
  });

  // Renderer crash/hang reports land in the session log. Rate-limited:
  // a crash loop must not flood the log file.
  let lastRendererErrorAt = 0;
  ipcMain.on(CHANNELS.RendererError, (_e, message: string) => {
    const now = Date.now();
    if (now - lastRendererErrorAt < 2000) return;
    lastRendererErrorAt = now;
    console.error(`[renderer] ${String(message ?? '')}`);
  });
  ipcMain.on(CHANNELS.TriggerAIMode, () => {
    triggerAIModeFromMenu();
  });

  // Renderer pushes the box's current bounds (in display-local coords) so the
  // main process can detect clicks that land outside the box even when the
  // overlay is click-through. Sending null clears the bounds (box hidden or
  // settings panel covering it).
  ipcMain.on(CHANNELS.BoxBounds, (_e, payload: { left: number; top: number; right: number; bottom: number; displayId: number } | null) => {
    setActiveBoxBounds(payload);
  });

  // Custom-cursor capture mode. While AI mode is active on a display, the
  // renderer marks that display as "capturing" so main skips its own
  // uiohook outside-click dismissal (the DOM owns it once the overlay is
  // interactive) and ignores the synthetic events it posts while forwarding.
  ipcMain.on(CHANNELS.OverlayCaptureMode, (_e, payload: { displayId: number; on: boolean }) => {
    setCaptureMode(payload.displayId, payload.on);
  });

  // Forward an outside click to the app under the cursor. Payload coords are
  // display-local (clientX/clientY of the overlay window); convert to screen
  // coords so SetCursorPos + mouse_event hit the right spot. Electron's
  // workArea/clientX are DIP but SetCursorPos uses physical pixels, so the
  // scaleFactor conversion is required on any display above 100% scaling.
  //
  // The DIP origin is taken from the overlay window's OWN bounds when it
  // exists (it is created at the display's workArea origin, minus the 2px
  // taskbar gap) rather than assuming workArea — a window-manager that moved
  // or resized an overlay would otherwise make every forwarded click drift by
  // exactly that delta. The full chain is logged so a wrong-landing click can
  // be bisected from DevTools/main output alone.
  ipcMain.on(CHANNELS.ForwardClick, (_e, payload: { x: number; y: number; displayId: number; button?: 'left' | 'right' }) => {
    const display = screen.getAllDisplays().find((d) => d.id === payload.displayId);
    if (!display) {
      console.warn(
        `[forward-click] display=${payload.displayId} NOT FOUND (stale overlay / display removed)`,
      );
      return;
    }
    const overlay = getOverlayForDisplay(payload.displayId);
    let origin = { x: display.workArea.x, y: display.workArea.y };
    let originSource = 'workArea';
    if (overlay && !overlay.isDestroyed()) {
      const b = overlay.getBounds();
      origin = { x: b.x, y: b.y };
      originSource = 'window';
    }
    const sf = display.scaleFactor || 1;
    const physX = Math.round((origin.x + payload.x) * sf);
    const physY = Math.round((origin.y + payload.y) * sf);
    console.log(
      `[forward-click] display=${payload.displayId} sf=${sf} ${originSource}Origin=(${origin.x},${origin.y}) ` +
        `local=(${payload.x},${payload.y}) -> physical=(${physX},${physY}) button=${payload.button}`,
    );
    void forwardClickAt(physX, physY, { button: payload.button });
  });

  // Forward a scroll gesture (in wheel notches) to the app under the cursor.
  ipcMain.on(CHANNELS.ForwardScroll, (_e, payload: { delta: number; displayId: number }) => {
    if (Math.round(payload.delta) === 0) return;
    // console.log(`[forward-scroll] display=${payload.displayId} delta=${payload.delta}`);
    void forwardScroll(payload.delta);
  });

  // While the Settings panel is open, lower every overlay's alwaysOnTop level
  // so the user can Cmd+Tab to their browser (e.g. to copy an OpenRouter API
  // key) without our screen-saver-level overlays blocking the way.
  ipcMain.on(CHANNELS.OverlaySettingsMode, (_e, opening: boolean) => {
    setAllOverlaysAlwaysOnTop(!opening);
  });

  // User dragged a custom selection rectangle on top of the underlying app.
  // We re-capture exactly that region and substitute it for the default
  // cursor-centered 1024x768 crop. Works either:
  //  - BEFORE the first submit → replaces pendingScreenshot, the next submit
  //    picks it up automatically
  //  - DURING an active session → replaces activeSession.imageB64 AND clears
  //    the message history so the new image becomes the basis of the
  //    follow-up conversation (otherwise the LLM would still be reasoning
  //    about the old picture in its earlier turns).
  ipcMain.handle(
    CHANNELS.SelectionCapture,
    async (
      e,
      payload: { rect: { x: number; y: number; width: number; height: number }; displayId: number },
    ) => {
      try {
        const b64 = await captureRectFromDisplay(payload.rect, payload.displayId);
        pendingScreenshot = {
          b64,
          ts: Date.now(),
          rect: { ...payload.rect },
          displayId: payload.displayId,
        };
        pendingScreenshotError = null;
        pendingScreenshotManual = true;
        const captureId = ++pendingScreenshotCaptureId;
        const ocrRun = kickPendingScreenshotOcr(b64, captureId);
        void ocrRun.then(() => {
          const { x, y, width, height } = payload.rect;
          console.log(
            `[ocr] drag-selection rect ${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)} ->`,
            JSON.stringify((pendingScreenshotOcr ?? '').slice(0, 300)),
          );
        });
        // Re-scope the suggestion chips to the freshly-dragged region and
        // regenerate them (text-only, cached by content — cheap).
        lastChipsRect = { rect: payload.rect, displayId: payload.displayId };
        void regenerateChipsFromRegion();
        if (activeSession) {
          activeSession.imageB64 = b64;
          activeSession.messages = [];
          activeSession.turnCount = 0;
          activeSession.suppressClipboardOnce = true;
          // The fresh rect image is now the run's reference frame: tag the
          // next turn's annotations against its own (region-mapped) geometry.
          beginAnnotationRuler(pointGeoForRectB64(pendingScreenshot));
          // Fresh visual context → fresh OCR for the next first-turn prompt.
          void ocrRun.then(() => {
            if (captureId === pendingScreenshotCaptureId && activeSession) {
              activeSession.screenshotOcr = pendingScreenshotOcr ?? '';
            }
          });
        } else {
          pendingSuppressClipboard = true;
        }
        if (!e.sender.isDestroyed()) {
          e.sender.send(CHANNELS.SelectionDone, { ok: true });
        }
        return { ok: true } as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Selection capture failed';
        console.error('[handlers] selection capture failed:', message);
        if (!e.sender.isDestroyed()) {
          e.sender.send(CHANNELS.SelectionDone, { ok: false, error: message });
        }
        return { ok: false, error: message } as const;
      }
    },
  );

  ipcMain.handle(
    CHANNELS.PaintCapture,
    async (
      _e,
      payload: { rect: { x: number; y: number; width: number; height: number }; displayId: number },
    ) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        const { text, error } = await ocrRegionText(payload.rect, payload.displayId);
        const { x, y, width, height } = payload.rect;
        console.log(
          `[ocr] paint region ${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)} ->`,
          JSON.stringify((text ?? '').slice(0, 300)),
          error ? `error: ${error}` : '',
        );
        // Keep every committed region (even OCR-empty) so the bubble shows the
        // outcome; empty text is filtered out of the prompt context later.
        pendingPaintSelections.push({ id, text, rect: payload.rect });
        return { ok: true, id, text, error: text ? undefined : error ?? 'No text found in that region' } as const;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Region OCR failed';
        console.error('[handlers] paint capture failed:', message);
        return { ok: false, id, text: '', error: message } as const;
      }
    },
  );

  // User clicked the X on a paint-selection bubble — drop that region's text
  // so it stops feeding the prompt context.
  ipcMain.on(CHANNELS.PaintRemove, (_e, id: string) => {
    removePendingPaintSelection(id);
  });

  ipcMain.handle(
    CHANNELS.TranscribeAudio,
    async (_e, audioBase64: string, mimeType: string, opts?: TranscribeOptions) => {
      try {
        return await transcribeAudio(audioBase64, mimeType, opts);
      } catch (err) {
        // Same shape as success so the renderer never type-crashes on error;
        // the __error__ text prefix is the established error signal.
        return {
          text: err instanceof Error ? `__error__:${err.message}` : '__error__:unknown',
          language: null,
          quiet: false,
        };
      }
    },
  );

  ipcMain.handle(CHANNELS.SttStatus, () => getSttStatus());

  // Speech-model manager: the Settings → Voice list reads this (download
  // state, disk use, spec recommendation, active model).
  ipcMain.handle(CHANNELS.SttModels, () => ({ ...listSttModels(), active: getActiveSttModel() }));
  // Switch + persist: missing weights download on sidecar load with the
  // existing "STT setup %" progress (renderer keeps polling SttStatus).
  ipcMain.handle(CHANNELS.SttSwitchModel, async (_e, id: string) => {
    const ok = await switchSttModel(String(id ?? ''));
    if (ok) {
      try {
        const { setSettings } = await import('../store/settings');
        setSettings({ sttModel: String(id ?? '') });
      } catch {
        /* persist best-effort; the switch itself already applied */
      }
    }
    return { ok, active: getActiveSttModel() };
  });
  ipcMain.handle(CHANNELS.SttDeleteModel, (_e, id: string) => deleteSttModel(String(id ?? '')));

  // Phase 7: kick the sidecar + model load off as soon as the mic arms, so the
  // first live chunk lands on a warm model instead of paying the cold start on
  // the hot path. Best-effort: startLocalStt already returns false when the
  // wheel is missing, and transcription falls back to local-when-ready / cloud.
  ipcMain.handle(CHANNELS.SttWarm, async () => {
    console.log('[voice] warm STT requested');
    await startLocalStt();
    return getSttStatus();
  });

  // Renderer pulls AI mode state on mount — catches missed push events from
  // broadcastAIModeStart when the renderer hadn't mounted yet (common in dev
  // mode where Vite HMR can delay React mounting past the trigger).
  ipcMain.handle(CHANNELS.AIModeSync, () => {
    const s = getAIModeState();
    return { active: s !== 'idle' };
  });
}

// A window can pass isDestroyed() while its render frame is already gone
// (display unplugged, frame disposed) — sending then throws "Render frame
// was disposed" from a timer. Check the frame too on timer-driven paths.
function canSend(win: { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } }): boolean {
  try {
    return !win.isDestroyed() && !win.webContents.isDestroyed();
  } catch {
    return false;
  }
}

// Send an IPC message to EVERY overlay window (not only the one the user
// submitted from). Stream content is broadcast so the answer box follows the
// mouse onto whatever display the cursor is on — the overlay box only renders
// when the cursor is over its own display, so each display needs the data.
function broadcastToOverlays(channel: string, payload?: unknown): void {
  for (const win of getAllOverlays()) {
    if (canSend(win)) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        /* frame died mid-send */
      }
    }
  }
}

export function broadcastAIModeStart(): void {
  const payload = buildPayload();
  console.log(`[spirit] ai-mode start (display ${payload.displayId}, shape pointer)`);
  aiModeGeneration++;
  noteAIActivity();
  armAIModeWatchdog();
  // Re-assert top-level z-order on every trigger. The overlay is constructed
// with `alwaysOnTop: 'screen-saver'`, but macOS can demote it back to a
  // regular level after a number of innocuous events (Cmd+Tab to another
  // app, DevTools open/close, Settings panel lowering the overlay, system
  // sleep/wake). When that happens the trigger still fires but the box
  // renders BEHIND whatever is currently focused — looks broken to the
  // user. Bumping the level + moveTop() here guarantees the box is visible
  // immediately and on every retrigger, not just the first one after launch.
  //
  // We also explicitly focus the overlay on the display the cursor is on.
  // Without that the window can be visually frontmost but NOT macOS's "key
  // window" — DOM `input.focus()` calls from the renderer then silently fail
  // and the user lands in the open box with no caret, having to click the
  // input before they can type. Only the overlay for the active display
  // gets focused; secondary overlays stay focusable but unfocused.
  for (const win of getAllOverlays()) {
    if (win.isDestroyed()) continue;
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    } catch {
      /* ignore — best effort */
    }
    if (canSend(win)) {
      try {
        win.webContents.send(CHANNELS.AIModeStart, payload);
      } catch {
        /* frame died mid-send */
      }
    }
  }
  const activeWin = getOverlayForDisplay(payload.displayId);
  if (activeWin && !activeWin.isDestroyed()) {
    // Focus uses AttachThreadInput on Windows to bypass SetForegroundWindow
    // restrictions. The overlay is WS_EX_TRANSPARENT at first; once the
    // renderer sends setInteractive(true), WS_EX_TRANSPARENT is removed and
    // the AttachThreadInput call can succeed. We retry at staggered delays to
    // cover the handoff window.
    for (const delay of [0, 150, 350]) {
      setTimeout(() => {
        if (activeWin.isDestroyed()) return;
        void focusOverlayWindow(activeWin);
      }, delay);
    }
  }
}

export function broadcastAIModeEnd(reason = 'unknown'): void {
  console.log(`[spirit] ai-mode end: ${reason}`);
  disarmAIModeWatchdog();
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.AIModeEnd);
  }
  // End sweep: the renderer normally drops capture itself on AIModeEnd, but
  // a frozen/blank renderer never sends setInteractive(false) — leaving a
  // fullscreen invisible input-eater until force-quit (seen live). Recheck
  // once after 4s; a live renderer heals a wrong release on next hover.
  // Generation-guarded: a NEW ai-mode started since is untouched.
  const gen = aiModeGeneration;
  setTimeout(() => {
    if (gen !== aiModeGeneration) return;
    for (const [displayId, overlay] of getOverlayEntries()) {
      if (overlay.isDestroyed()) continue;
      if (isOverlayInteractive(displayId)) {
        console.warn(`[watchdog] overlay ${displayId} still capturing after ai-mode end — forcing click-through`);
        try {
          setOverlayInteractive(displayId, false);
        } catch {
          /* best effort */
        }
      }
    }
  }, 4000);
}

// Dead-man's switch for the fullscreen mouse capture. AI mode makes the
// overlay interactive over the whole screen by design — if the run wedges
// (no attempt, tool, or chunk for minutes) the screen would stay untouchable
// until a tray force-quit (seen live). One-shot timer, re-armed while fresh
// activity keeps arriving; on stall it cancels the stream, drops every
// overlay back to click-through, and ends the mode. Never fires during real
// progress: attempts, tools, and streamed chunks all touch the clock.
//
// Sleep-vs-stall: a laptop nap freezes ALL timers, so on wake the idle gap
// reads huge. A gap past 2x the watchdog means sleep, not a wedge — restore
// the overlays and keep the run instead of killing it.
const AIMODE_WATCHDOG_MS = 6 * 60_000;
let aiModeWatchdog: NodeJS.Timeout | null = null;
// Bumped on every ai-mode start; the end sweep only acts for its own run.
let aiModeGeneration = 0;

function armAIModeWatchdog(): void {
  disarmAIModeWatchdog();
  aiModeWatchdog = setTimeout(checkAIModeWatchdog, AIMODE_WATCHDOG_MS);
}

function disarmAIModeWatchdog(): void {
  if (aiModeWatchdog) {
    clearTimeout(aiModeWatchdog);
    aiModeWatchdog = null;
  }
}

function checkAIModeWatchdog(): void {
  aiModeWatchdog = null;
  const idleMs = Date.now() - lastAIActivityAt();
  if (idleMs < AIMODE_WATCHDOG_MS) {
    aiModeWatchdog = setTimeout(checkAIModeWatchdog, AIMODE_WATCHDOG_MS - idleMs);
    return;
  }
  if (idleMs > AIMODE_WATCHDOG_MS * 2) {
    // Machine slept through the watchdog window: every timer (round fuse,
    // retries, this check) expired at once on wake. Don't murder a run
    // that merely napped — restore the overlays and re-arm.
    console.warn(
      `[watchdog] ${(Math.round(idleMs / 1000))}s gap looks like sleep — restoring overlays, keeping the run`,
    );
    try {
      restoreOverlaysAfterWake();
    } catch {
      /* best effort */
    }
    aiModeWatchdog = setTimeout(checkAIModeWatchdog, AIMODE_WATCHDOG_MS);
    return;
  }
  console.error(
    `[watchdog] AI mode stalled ${Math.round(idleMs / 1000)}s with no activity — ` +
      'cancelling stream and releasing mouse capture',
  );
  try {
    cancelCurrentStream();
  } catch {
    /* best effort */
  }
  for (const [displayId, overlay] of getOverlayEntries()) {
    if (!overlay.isDestroyed()) {
      try {
        setOverlayInteractive(displayId, false);
      } catch {
        /* best effort */
      }
    }
  }
  broadcastAIModeEnd('watchdog-stall');
}

export function broadcastCursorPosition(): void {
  const payload = buildPayload();
  for (const win of getAllOverlays()) {
    if (!canSend(win)) continue;
    try {
      win.webContents.send(CHANNELS.CursorPosition, payload);
    } catch {
      /* frame died mid-send (unplugged display) */
    }
  }
}

export function broadcastSettingsOpen(): void {
  let focused = false;
  for (const win of getAllOverlays()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(CHANNELS.SettingsOpen);
    if (!focused) {
      try { win.focus(); } catch { /* ignore */ }
      focused = true;
    }
  }
}

export function broadcastSelectionArm(armed: boolean): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.SelectionArm, armed);
  }
}

// Fired from trigger.ts when the user types a printable, non-trigger key
// while Spirit is idle. The renderer interprets this as "user is busy
// in another app's textfield" and reacts (prompt-box auto-dismiss).
export function broadcastExternalTyping(kind: 'key' | 'click'): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.ExternalTyping, { kind });
  }
}

// Capture mode: main detected physical outside clicks that the overlay's DOM
// missed because they landed inside the temporary click-through window while
// a click-forward was being synthesized (the second click of a fast
// double-click). The renderer adds `count` to its dismiss accumulator so the
// double-click still closes the box.
export function broadcastForwardedClickEaten(count: number): void {
  for (const win of getAllOverlays()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.ForwardedClickEaten, count);
  }
}
