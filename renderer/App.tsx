import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAIMode } from './hooks/useAIMode';
import { useCursorDisplayId } from './hooks/useCursorPosition';
import { getCursorPos, subscribeCursor } from './lib/cursorStore';
import { useAnnotations } from './hooks/useAnnotations';
import { useSettings } from './hooks/useSettings';
import { useLLMQuery } from './hooks/useLLMQuery';
import { useClipboardContext } from './hooks/useClipboardContext';
import { useChips } from './hooks/useChips';
import { useWebImages } from './hooks/useWebImages';
import { useSelectionContext } from './hooks/useSelectionContext';
import { useAppContext } from './hooks/useAppContext';
import { useToolApprovals } from './hooks/useToolApprovals';
import { CursorLayer } from './components/CursorLayer';
import { PointCursor } from './components/PointCursor';
import { ScreenAnnotations } from './components/ScreenAnnotations';
import { PermissionsBanner } from './components/PermissionsBanner';
import { SettingsPanel } from './components/SettingsPanel';
import { NotificationToast } from './components/NotificationToast';
import { PromptInput, type ConversationTurn } from './components/PromptInput';
import { SelectionRectangle } from './components/SelectionRectangle';
import { ProviderHealthBanner } from './components/ProviderHealthBanner';
import { HELP_TEXT, type CommandId } from './lib/commands';
import { SEED_TESTS, buildSeedTurns } from './lib/testSeeds';
import { computeAnchor } from './lib/positioning';
import { formatHistoryMarkdown } from './hooks/useHistory';
import { ipc } from './lib/ipc';
import type { PermissionsStatus, TemplateId, ProviderId, ProviderSettings, PaintSelection, UiSegment, SuggestionChip, ScreenAnnotation } from '../electron/types';

// Chip labels that read as web-search intents ("search for…", "show
// the picture of…", "find…", "look up…") should OPEN the browser with a
// DuckDuckGo search — that is what the user means by tapping the chip. If we
// just submit the label to the LLM the user gets another text answer and the
// browser never opens. Non-search labels still submit to the LLM as before.
function looksLikeWebSearch(label: string): boolean {
  const t = label.toLowerCase().trim();
  if (!t) return false;
  return (
    t.includes('search') ||
    t.includes('picture of') ||
    t.includes('image of') ||
    t.includes('photo of') ||
    t.includes('photos of') ||
    /^(find |look up |look for |google |search for )/.test(t) ||
    /^(who is |what is |when was |when did |where is )/.test(t)
  );
}

// DOMRect equality with a 1px tolerance. `getBoundingClientRect` returns a
// fresh object every call, so without this the box-bounds RAF loop fires a
// state update 60× per second even when nothing moved — which made the box
// flicker on hover and flooded the IPC bridge.
function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 1 &&
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.right - b.right) < 1 &&
    Math.abs(a.bottom - b.bottom) < 1
  );
}

export function App() {
  const [displayId, setDisplayId] = useState<number | null>(null);
  const [isPrimary, setIsPrimary] = useState(false);
  const [platform, setPlatform] = useState<string>('?');
  const [perms, setPerms] = useState<PermissionsStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsOpenTab, setSettingsOpenTab] = useState<'memory' | null>(null);
  const [autoShowChecked, setAutoShowChecked] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [screenSize, setScreenSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [overrideResponse, setOverrideResponse] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string>('');
  const [lastWasWeb, setLastWasWeb] = useState<boolean>(false);
  // Banner sits in the click-through overlay; without hit-testing its
  // bounds the "Open Settings" button is unreachable. Track bounds + hover
  // and feed them into the interactivity rule below.
  const [bannerBounds, setBannerBounds] = useState<DOMRect | null>(null);
  const [bannerHovered, setBannerHovered] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [boxBounds, setBoxBounds] = useState<DOMRect | null>(null);
  const [boxHovered, setBoxHovered] = useState(false);
  // Drag-screenshot state. Tracks an in-progress rectangle the user is
  // drawing on top of the underlying app. When the drag passes a minimum
  // threshold the rectangle visibly mounts; if the drag stays below that
  // threshold the gesture is treated as a regular backdrop click (dismiss).
  // `selectionFeedback` shows a brief confirmation toast after capture.
  const [selection, setSelection] = useState<
    | { startX: number; startY: number; currX: number; currY: number; pointerId: number; armed: boolean }
    | null
  >(null);
  const [selectionFeedback, setSelectionFeedback] = useState<
    | { kind: 'ok'; rect: { width: number; height: number } }
    | { kind: 'error'; message: string }
    | null
  >(null);
  // True while user is holding the trigger key on top of an already-open
  // box — switches the overlay into "drag a rectangle to screenshot" mode.
  const [selectionMode, setSelectionMode] = useState(false);
  // Paint-to-select state. A plain left-drag on the backdrop while the box is
  // open paints an accent-tinted region which is OCR'd into text (vs the
  // trigger-held `selectionMode` which screenshots the region). `paint` tracks
  // an in-progress drag; `paintSelections` holds committed regions that show
  // as accent highlights + top-of-screen bubbles, mirroring main's
  // pendingPaintSelections which feeds the prompt on submit.
  const [paint, setPaint] = useState<
    | { startX: number; startY: number; currX: number; currY: number; pointerId: number; armed: boolean }
    | null
  >(null);
  const [paintSelections, setPaintSelections] = useState<PaintSelection[]>([]);
  // Screenshot opt-out (default on). Reset every time AI mode opens so a
  // fresh trigger always starts with screenshot attached. User dismisses
  // via the X on the screenshot chip → next submit goes vision-free.
  const [screenshotIncluded, setScreenshotIncluded] = useState(true);
  // Clipboard opt-in (default off). User toggles via the chip button left
  // of the mic in PromptInput. When on, the chip shows the current
  // clipboard preview and the next submit attaches it.
  const [clipboardIncluded, setClipboardIncluded] = useState(false);
  const dismissTimer = useRef<number | null>(null);
  const [ttsActive, setTtsActive] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const backdropClickTimer = useRef<number | null>(null);
  const backdropClickCount = useRef<number>(0);
  // Latest countDismissClick / aiActiveHere, so the mount-once eaten-click
  // subscription below can call the current closures without re-subscribing.
  const countDismissClickRef = useRef<() => void>(() => {});
  const aiActiveHereRef = useRef(false);
  // Last result shown before the box hid. Restored on a re-trigger within the
  // session window (~2 min, matching main's session TTL) so hiding the box
  // never loses the answer; after that the box opens fresh.
  const lastResultRef = useRef<{
    text: string;
    ui: UiSegment[];
    nextChips: SuggestionChip[];
    turns: ConversationTurn[];
    ts: number;
  } | null>(null);
  const selectionFeedbackTimer = useRef<number | null>(null);
  // Throttle wheel forwarding: while the overlay owns the mouse, every scroll
  // gesture would otherwise spawn a PowerShell process per event.
  const lastWheelForwardRef = useRef(0);
  const wheelAccumRef = useRef(0);

  const { active } = useAIMode();

  const cursorDisplayId = useCursorDisplayId();
  const pointStream = useAnnotations();
  const { settings, loading: settingsLoading, save: saveSettings } = useSettings();
  const {
    state: llmState,
    response,
    uiSegments,
    completion,
    uiLive,
    error: llmError,
    interrupted,
    activities,
    reasoning,
    elapsedSecs,
    submit,
    continueLast,
    retryLast,
    reset,
    restore: restoreLastResponse,
    consumeCompletion,
    streamActiveRef,
    lastAnswerAtRef,
  } = useLLMQuery();
  const { ctx: clipboardCtx, dismiss: dismissClipboard } = useClipboardContext();
  const { chips: suggestionChips, nextChips, pending: chipsPending, restoreNext } = useChips();
  const { images: webImages } = useWebImages();
  const { ctx: selectionCtx, dismiss: dismissSelection } = useSelectionContext();
  const appPreview = useAppContext();
  const { requests: approvals, decide: decideApproval, clearAll: clearApprovals } =
    useToolApprovals();

  // Conversation transcript: every committed Q+A turn stays rendered in the
  // box (not just the latest answer). Turns commit when a run completes;
  // committedTurnId hides the in-flight turn to avoid showing it twice.
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([]);
  // Monotonic turn counter for stable Q-numbers (never restarts mid-session).
  const turnSeq = useRef(0);
  // Seeded fake turns from /test. Local-only, never saved or sent —
  // exercises the transcript rail + snap without an LLM.
  const [seedTurns, setSeedTurns] = useState<ConversationTurn[]>([]);
  // Seed a catalogued UI test straight into the transcript.
  const handlePickSeedTest = useCallback((id: string) => {
    const test = SEED_TESTS.find((t) => t.id === id);
    if (!test) return;
    setSeedTurns(
      buildSeedTurns(test).map((t) => {
        turnSeq.current += 1;
        return { ...t, n: turnSeq.current };
      }),
    );
  }, []);
  const handleClearSeedTurns = useCallback(() => {
    setSeedTurns([]);
  }, []);
  const completedTurn = useMemo(
    () =>
      completion && (completion.response.length > 0 || completion.uiSegments.length > 0)
        ? {
            id: completion.runId,
            // Real number assigned at commit; 0 = not yet committed.
            n: 0,
            prompt: completion.prompt,
            wasWeb: completion.wasWeb,
            response: completion.response,
            uiSegments: completion.uiSegments,
            // Snapshot this run's media so the past turn replays it fully.
            images: webImages.length > 0 ? [...webImages] : undefined,
            annotations: completion.annotations,
          }
        : null,
    [completion, webImages],
  );
  const visibleConversationTurns = useMemo(() => {
    if (!completedTurn || conversationTurns.some((turn) => turn.id === completedTurn.id)) {
      return conversationTurns;
    }
    return [...conversationTurns, completedTurn];
  }, [completedTurn, conversationTurns]);

  useEffect(() => {
    if (!completedTurn) return;
    setConversationTurns((turns) => {
      const i = turns.findIndex((turn) => turn.id === completedTurn.id);
      // Upsert: late media (images row, replay tags) lands after the text.
      // The committed Q-number is sacred — never overwrite it.
      if (i >= 0) {
        const next = [...turns];
        const kept = next[i].n;
        next[i] = { ...completedTurn, n: kept };
        return next;
      }
      turnSeq.current += 1;
      return [...turns, { ...completedTurn, n: turnSeq.current }];
    });
    // Consume so the newest turn stops hiding behind committedTurnId and
    // immediately gets its rail tick.
    consumeCompletion();
  }, [completedTurn, consumeCompletion]);

  // USER-ATTENTION-ELSEWHERE DETECTION
  // Main process emits a single channel for both kinds of "user is doing
  // something else" signals: a non-trigger printable keystroke OR a click
  // outside our overlay bounds. The renderer is the smart gate: it
  // decides what to do with the signal based on (a) whether Spirit
  // is active, and (b) whether our own input has focus.
  //
  // Behavior (AI active): count signals + start a 4s engagement timer;
  // when either threshold trips, auto-dismiss the prompt box (handleCancel)
  // so it doesn't camp on the screen.
  //
  // Why we don't gate on `state` in main: the user expects the prompt box
  // to react. Gating in main meant only one state path got events. Renderer
  // now decides; main just reports raw signals.
  const elsewhereClicksRef = useRef<{ ts: number }[]>([]);
  // Timestamp of the most recent DOM keydown that landed on an element
  // inside the box. Ground truth for "the user is typing into US": a
  // keystroke that reaches our box's input always fires a DOM keydown on a
  // descendant of the box, while a keystroke in another app never does.
  // This is platform-independent — unlike document.hasFocus(), which is
  // unreliable on Windows for this transparent always-on-top overlay (the
  // window can be frontmost and receiving input while hasFocus() still
  // reports false), and unlike document.activeElement, which stays pinned
  // to the input even after OS focus has moved to another app.
  const lastBoxKeydownAtRef = useRef(0);
  // This overlay's display id, mirrored to a ref so the once-mounted
  // external-typing listener can compare it against the cursor's display
  // (state is null inside the []-closure). The box only renders on the
  // display where the cursor is, so signals received by secondary overlays
  // must be ignored — otherwise the invisible overlay on the other monitor
  // counts the user's own typing into the box as "busy elsewhere" and
  // dismisses the capsule mid-typing.
  const displayIdRef = useRef<number | null>(null);

  // We need handleCancel inside the effect below but it's declared later
  // in the file. Stash it in a ref so the effect always sees the latest.
  const handleCancelRef = useRef<() => void>(() => {});
  // Cursor position has to be available inside the once-mounted listener
  // closure. Read it from the module store instead of mirroring React state
  // (pos is no longer state — see lib/cursorStore).
  // Mirror llmState so the external-typing listener can decide whether
  // the user is mid-loading (auto-dismiss makes sense — the box would
  // otherwise camp on the screen) vs reading a finished answer (user
  // is using the result to do something else, MUST keep the box open
  // so they can ask a follow-up without losing session + screenshot).
  const llmStateRef = useRef(llmState);
  useEffect(() => { llmStateRef.current = llmState; });

  // Agent/tool-turn tracking. While the model runs tools the user is
  // (correctly) busy looking at the tool's effect — Notepad, a browser, an
  // app under them. The "busy elsewhere" and idle auto-dismiss logic would
  // otherwise mistake that for the user having wandered off and kill the
  // in-flight task. Once ANY tool activity lands this turn, we hold off
  // auto-dismiss until the turn ends (done/error). The flag starts on the
  // first activity so it also covers the final composition round, where no
  // activity row is visibly "running" yet the model is still working.
  const [toolsUsedThisTurn, setToolsUsedThisTurn] = useState(false);
  useEffect(() => {
    if (activities.length > 0) setToolsUsedThisTurn(true);
  }, [activities.length > 0]);
  useEffect(() => {
    if (llmState === 'loading' || llmState === 'idle') setToolsUsedThisTurn(false);
  }, [llmState]);
  const agentBusy = toolsUsedThisTurn && (llmState === 'loading' || llmState === 'streaming');
  const agentBusyRef = useRef(agentBusy);
  useEffect(() => { agentBusyRef.current = agentBusy; });
  // Chip generation is active background work (the box just opened and is
  // fetching its action suggestions). Same holdoff reasoning as agentBusy:
  // clicks in the app underneath while chips are still loading are not the
  // user abandoning the box — they'd kill an in-flight generation round.
  const chipsPendingRef = useRef(chipsPending);
  useEffect(() => { chipsPendingRef.current = chipsPending; });

  useEffect(() => {
    // Own-keystroke detection: the uiohook keyboard hook in main fires for
    // EVERY keystroke anywhere, including the ones the user types into our
    // own box. The DOM is the arbiter — if a keydown targeted an element
    // inside the box, that keystroke was destined for us regardless of
    // what document.hasFocus() reports (see note at lastBoxKeydownAtRef).
    const onDomKeydown = (e: KeyboardEvent) => {
      const boxEl = boxRef.current;
      const target = e.target instanceof Node ? e.target : null;
      if (boxEl && boxEl.offsetParent !== null && target && boxEl.contains(target)) {
        lastBoxKeydownAtRef.current = Date.now();
      }
    };
    document.addEventListener('keydown', onDomKeydown, true);

    const offExternal = window.spirit.onExternalTyping((kind) => {
      // DISPLAY GATE: this overlay only renders the prompt box on the
      // display where the cursor is (pos.displayId). Main broadcasts every
      // external-typing signal to ALL overlays, so secondary overlays on
      // other monitors receive the user's own typing into our box and —
      // having no DOM to see those keydowns — count them as "busy
      // elsewhere" and dismiss the capsule mid-typing. Only the overlay
      // whose displayId matches the cursor's display may accumulate
      // signals; everyone else ignores them entirely.
      const p0 = getCursorPos();
      if (!p0 || p0.displayId !== displayIdRef.current) {
        return;
      }

      // OWN-KEYSTROKE GATE: if the user just typed into our own box, the DOM
      // keydown for that stroke fired <500ms ago (uiohook throttles bursts
      // to 350ms, so every external-typing signal trails the DOM event of
      // the keystroke it mirrors). Treat it as noise, not as "user is busy
      // elsewhere". This replaces the old document.hasFocus() gate which
      // failed on Windows where the overlay keeps receiving input while
      // hasFocus() reports false — that let the box dismiss itself
      // mid-typing.
      if (kind === 'key' && Date.now() - lastBoxKeydownAtRef.current < 500) {
        return;
      }

      // ENGAGEMENT GATE: if the cursor is currently inside our big-pill
      // bounds, treat this signal as noise — the user is at our box.
      // We deliberately don't use document.activeElement here for this
      // check: our <input> keeps DOM focus even after the OS has handed
      // focus to another app (Chrome, Claude, etc), which made the
      // earlier gate swallow every legitimate elsewhere signal while
      // the prompt input had been touched once. Geometric proximity is
      // the ground truth for "the user is engaging with us".
      const boxEl = boxRef.current;
      // offsetParent is null for detached elements (unmounted from DOM)
      // and for display:none. Guarding here means a stale ref left over
      // from a previous AI session can't report a phantom rect that
      // mistakenly absorbs an elsewhere signal.
      const boxAttached = boxEl && boxEl.offsetParent !== null;
      const box = boxAttached ? boxEl.getBoundingClientRect() : null;
      const p = getCursorPos();
      if (box && p && box.width > 0) {
        const HALO = 24; // matches OUTSIDE_HALO_PX in trigger.ts
        const inside =
          p.x >= box.left - HALO && p.x <= box.right + HALO &&
          p.y >= box.top - HALO && p.y <= box.bottom + HALO;
        if (inside) {
          return;
        }
      }

      // OWN-INPUT GUARD (key signals only): a keystroke is destined for us
      // when BOTH (a) the OS focus is on our window and (b) the focused
      // DOM element is inside the box. Either alone is not enough —
      // Electron DOM focus is window-scoped, so the input keeps
      // activeElement even after the OS hands focus elsewhere; hasFocus()
      // alone wouldn't tell us whether focus is on the prompt input vs.
      // some other in-window control. Click signals always pass through
      // (an outside click is by definition not "user typing into us").
      if (kind === 'key' && boxAttached) {
        const active = document.activeElement;
        const ownInputFocused = !!(boxEl && active && boxEl.contains(active));
        if (document.hasFocus() && ownInputFocused) {
          return;
        }
      }

      // Engagement-based auto-dismiss applies only while the LLM is
      // still working (loading / streaming). Once the response is
      // 'done' (or 'error'), the user is reading + USING the answer —
      // typically by switching to another app to apply it — and the
      // prompt box MUST stay open so the follow-up message lands in the
      // same session against the same screenshot. Dismiss in that
      // state can be done explicitly with ESC or an outside click
      // (the registerDismissClick / uiohook path is unchanged).
      if (llmStateRef.current === 'done' || llmStateRef.current === 'error') {
        return;
      }

      // Agent-turn gate: while the model is running tools, clicks/keys in
      // other apps are the tool executing (Notepad, browser, ...), not the
      // user abandoning the box. Dismissing here would abort the task mid-
      // flight. Hold dismissal until the turn ends (see toolsUsedThisTurn).
      if (agentBusyRef.current || chipsPendingRef.current) {
        return;
      }

      // Count this signal toward the prompt-box auto-dismiss while the
      // model is still working. Trim entries older than 5s out of the
      // rolling window first.
      const now = Date.now();
      elsewhereClicksRef.current = elsewhereClicksRef.current
        .filter((c) => now - c.ts < 5000)
        .concat({ ts: now });

      // 3+ signals in 5s → dismiss (the user is clearly busy elsewhere).
      // A single elsewhere signal must NOT arm a countdown: free / slow
      // models often take well over 4s to answer, and the user may still
      // be waiting at the box while scrolling the app the AI is reading.
      if (elsewhereClicksRef.current.length >= 3) {
        handleCancelRef.current();
        elsewhereClicksRef.current = [];
        return;
      }
    });

    return () => {
      document.removeEventListener('keydown', onDomKeydown, true);
      offExternal();
    };
  }, []);

  // Eaten outside clicks: while a click-forward is being synthesized the
  // overlay is briefly click-through, so the second click of a fast
  // double-click can pass through without ever hitting this DOM. Main
  // catches it on its uiohook hook and tells us to count it here, so the
  // double-click still dismisses the box.
  useEffect(() => {
    const offEaten = window.spirit?.onForwardedClickEaten?.((count) => {
      // Only the overlay actually in capture mode on the cursor's display
      // owns backdrop dismissal (registerDismissClick runs there). Secondary
      // overlays have no DOM to count clicks, so they must not count eaten
      // ones either — otherwise the box could dismiss from a click aimed at
      // a different monitor.
      if (!aiActiveHereRef.current) return;
      for (let i = 0; i < count; i++) countDismissClickRef.current();
    });
    return () => offEaten?.();
  }, []);

  // Engagement reset. When AI is active and the cursor is INSIDE the
  // prompt-box bounds, wipe the elsewhere-click counter (used by the
  // 3-signals auto-dismiss). Subscribes to the cursor store so it does not
  // re-render App on every pointer move.
  useEffect(() => {
    if (!active) return;
    return subscribeCursor((p) => {
      if (!p) return;
      const boxEl = boxRef.current;
      const boxAttached = boxEl && boxEl.offsetParent !== null;
      const box = boxAttached ? boxEl.getBoundingClientRect() : null;
      if (box && box.width > 0) {
        const HALO = 24;
        const inside =
          p.x >= box.left - HALO && p.x <= box.right + HALO &&
          p.y >= box.top - HALO && p.y <= box.bottom + HALO;
        if (inside) {
          elsewhereClicksRef.current = [];
        }
      }
    });
  }, [active]);

  // When a tool/agent turn starts, wipe any auto-dismiss state that was
  // already armed (the elsewhere-click count) — otherwise a signal from
  // before the turn could fire mid-task and abort it.
  useEffect(() => {
    if (!agentBusy) return;
    elsewhereClicksRef.current = [];
  }, [agentBusy]);

  // AI mode start/end: clear pending prompt-box auto-dismiss state so a
  // fresh session never inherits stale elsewhere-click counters from the
  // previous one.
  useEffect(() => {
    elsewhereClicksRef.current = [];
  }, [active]);

  useEffect(() => {
    // Initial-paint theme: apply the system color scheme ONCE so the very
    // first paint doesn't flash the wrong theme. After settings load, the
    // themePreference effect below owns the html.dark class entirely —
    // including the 'system' branch which subscribes to the media query
    // on its own. Keeping a separate persistent media-query listener here
    // would race with the user preference and overwrite a manually picked
    // light/dark theme whenever the macOS appearance changed.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    document.documentElement.classList.toggle('dark', mq.matches);

    const params = new URLSearchParams(window.location.search);
    const idStr = params.get('displayId');
    const parsedId = idStr ? parseInt(idStr, 10) : null;
    setDisplayId(parsedId);
    displayIdRef.current = parsedId;
    setIsPrimary(params.get('primary') === '1');
    setPlatform(window.spirit?.platform ?? '?');

    const onResize = () => setScreenSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    // Poll permission state: every 2s while the user still needs to grant
    // something (macOS prompts are awaited, so a fresh check matters), but
    // back off to 10s once everything is granted — a 2s forever-poll wastes
    // IPC + a screen-capture probe for no benefit after setup is complete.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<boolean> => {
      try {
        const next = await ipc.getPermissions();
        setPerms(next);
        return next.accessibility && next.screenRecording;
      } catch {
        return false; /* preload not ready */
      }
    };
    const tick = async () => {
      const granted = await poll();
      timer = setTimeout(tick, granted ? 10000 : 2000);
    };
    void tick();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  // User-controlled theme override. settings.themePreference =
  //   'system' → follow prefers-color-scheme (default, matches initial paint)
  //   'light'  → force html.dark ON (this codebase inverts: html.dark =
  //              white pill = light UI; see useEffect above)
  //   'dark'   → force html.dark OFF
  // The 'system' branch re-subscribes to the media query; 'light'/'dark'
  // ignore it. Re-runs whenever the user picks a new theme in Settings.
  useEffect(() => {
    if (!settings) return;
    const pref = settings.themePreference ?? 'system';
    if (pref === 'light') {
      document.documentElement.classList.add('dark');
      return;
    }
    if (pref === 'dark') {
      document.documentElement.classList.remove('dark');
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings?.themePreference]);

  // Two-tier check:
  // 1. Renderer-side memo from `settings.providers` (fast, available
  //    synchronously on every render).
  // 2. Backend authoritative truth via `hasAnyConfiguredProvider` IPC,
  //    refreshed whenever settings change. The renderer's hasKey flag
  //    sometimes diverged from the actual store state — e.g. after a
  //    Child-Mode activation that had stale settings in flight. The backend
  //    check resolves the disagreement: if main says "yes, you have a
  //    usable key", trust it.
  const hasAnyProviderKeyRenderer = useMemo(() => {
    if (!settings) return false;
    return (Object.entries(settings.providers) as [ProviderId, ProviderSettings][]).some(
      ([id, p]) =>
        p.enabled &&
        (id === 'localai' || id === 'opencode'
          ? (p.baseUrl ?? '').trim().length > 0
          : p.hasKey || p.apiKey.trim().length > 0),
    );
  }, [settings]);
  // null = backend check still in flight. The auto-open effect waits for it:
  // opening on the renderer memo alone raced the backend answer and popped
  // Settings on every start for keyless (opencode/local) setups.
  const [hasAnyProviderKeyBackend, setHasAnyProviderKeyBackend] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await window.spirit.hasAnyConfiguredProvider();
        if (!cancelled) setHasAnyProviderKeyBackend(v);
      } catch {
        /* ignore — fall back to renderer memo */
      }
    })();
    return () => { cancelled = true; };
  }, [settings]);
  const hasAnyProviderKey = hasAnyProviderKeyBackend ?? hasAnyProviderKeyRenderer;

  const requestSettingsOpen = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (!isPrimary || settingsLoading || autoShowChecked) return;
    // Don't auto-open settings before we actually have a settings
    // snapshot in hand — otherwise `hasAnyProviderKey` is false purely
    // because settings is null on first paint.
    if (!settings) return;
    setAutoShowChecked(true);
    if (!hasAnyProviderKey) requestSettingsOpen();
  }, [isPrimary, settingsLoading, hasAnyProviderKey, autoShowChecked, settings, requestSettingsOpen]);

  useEffect(() => {
    const off = ipc.onSettingsOpen(() => {
      console.log('[settings] open IPC received, isPrimary=', isPrimary);
      // Always open on whatever overlay receives this — earlier we restricted
      // it to isPrimary, but if the user is working on a non-primary monitor
      // the panel would silently open on the primary display they can't see
      // and feel like "settings won't open". Settings is global state anyway,
      // the IPC handler in main only fires it on the explicit request paths
      // (tray menu, /settings command), so it's safe to always honor it on
      // whichever overlay's renderer process picked it up first.
      requestSettingsOpen();
    });
    return off;
  }, [isPrimary, requestSettingsOpen]);

  useEffect(() => {
    return window.spirit.onSelectionArm((armed) => setSelectionMode(armed));
  }, []);

  // Self-knowledge line: quiet one-liner the box shows at its bottom edge
  // when the agent learns something durable. No popup. Clears on events
  // only — next submit or next hint replaces it. No timers.
  const [learnedLine, setLearnedLine] = useState<{ text: string; kind?: string } | null>(null);
  useEffect(() => {
    return window.spirit.onLearnedHint((hint) => {
      if (!hint?.text) return;
      setLearnedLine({ text: hint.text, kind: hint.kind });
    });
  }, []);

  // Which display owns the cursor: from the rare React state (changes only
  // when the pointer crosses monitors), not the per-move cursor position.
  const onThisDisplay = cursorDisplayId !== null && cursorDisplayId === displayId;
  const aiActiveHere = active && onThisDisplay;
  // "Capture mode": AI is active on this display AND Settings isn't covering
  // the screen. This is when the overlay owns the mouse full-time — the OS
  // cursor is hidden, the SpiritCursor arrow shows, and outside clicks/scrolls
  // get forwarded to the app underneath. With Settings open the overlay is
  // interactive too, and the branded cursor + DOM-driven Bibata shapes take
  // over the modal (hand over buttons/selects, I-beam over inputs) while
  // click forwarding is disabled so the modal stays usable.
  const captureActive = aiActiveHere && !settingsOpen;
  // The branded-cursor takeover (OS arrow hidden + SpiritCursor drawn) must
  // ONLY engage on the display that actually has BOTH the cursor and a reason
  // to own it: capture mode under AI, or the Settings modal on the PRIMARY
  // display. Settings broadcasts `settingsOpen` to every overlay renderer
  // (the modal itself renders only on isPrimary), so without the onThisDisplay
  // + isPrimary gates every monitor hid the OS arrow and drew a mirrored
  // phantom SpiritCursor wherever the pointer happened to be.
  //
  // The custom Bibata cursor (SpiritCursor) always renders ABOVE the overlay
  // (z-10001): box, annotations, toasts all sit below the pointer.
  const cursorTakeover =
    onThisDisplay &&
    !selectionMode &&
    (captureActive || (settingsOpen && isPrimary));

  // OPEN: lock the box anchor when AI-mode opens on this display. Waits for
  // the first cursor position (arrives via the cursor store, not React state)
  // so this no longer depends on the per-move `pos` and cannot re-render App.
  useEffect(() => {
    if (!aiActiveHere || anchor !== null) return;
    let done = false;
    const open = (p: { x: number; y: number }) => {
      if (done) return;
      done = true;
      setAnchor({ x: p.x, y: p.y });
      // Re-trigger inside the session window:
      //  - a background stream is still live (streaming/loading) → keep it;
      //    it will finish into the box.
      //  - an answer completed in the background within the last ~2 min →
      //    keep showing it.
      //  - otherwise idle with a stash → restore the stashed last result.
      //  - anything else (stale stash, error/cancelled) → fresh box (main has
      //    already ended the session).
      const stash = lastResultRef.current;
      const stale = !stash || Date.now() - stash.ts >= 120_000;
      if (stale) {
        lastResultRef.current = null;
        restoreNext([]);
        // Broadcasts reach every overlay, so the DISPLAY that just took the
        // box has been accumulating the live stream (or the finished answer)
        // all along — even though it never submitted. Judge by this
        // renderer's own state, not streamActiveRef (which is only set by
        // the overlay that called submit): otherwise switching monitors
        // mid-answer wipes the current response here and leaves an empty box.
        const liveHere =
          llmStateRef.current === 'loading' || llmStateRef.current === 'streaming';
        const recentDoneHere =
          llmStateRef.current === 'done' &&
          lastAnswerAtRef.current !== null &&
          Date.now() - lastAnswerAtRef.current < 120_000;
        if (!liveHere && !recentDoneHere) {
          setConversationTurns([]);
          reset();
        }
      } else if (llmStateRef.current === 'idle') {
        restoreLastResponse(stash.text, stash.ui);
        restoreNext(stash.nextChips);
        setConversationTurns(stash.turns);
      }
      // Re-stamp the screenshot default here so a
      // fresh box opens with the correct chip state from the very
      // first trigger (otherwise the initial useState(true) would
      // win on launch).
      setScreenshotIncluded(true);
      setClipboardIncluded(false);
    };
    const cur = getCursorPos();
    if (cur) {
      open(cur);
      return;
    }
    return subscribeCursor((p) => {
      if (p) open(p);
    });
  }, [aiActiveHere, anchor, reset, restoreLastResponse, restoreNext, clearApprovals, streamActiveRef, lastAnswerAtRef, visibleConversationTurns]);

  // CLOSE: tear down the anchor when AI-mode deactivates.
  useEffect(() => {
    if (active || anchor === null) return;
    setAnchor(null);
    if (streamActiveRef.current) {
      // The AI is still answering in the background — hiding the box must
      // NOT truncate it. Keep the live response/state so it finishes and is
      // shown on the next trigger. Only drop command-override text.
      setOverrideResponse(null);
    } else {
      // No stream in flight: stash what was last shown so a quick re-trigger
      // restores it. The 2-min window matches main's session TTL — past that
      // a fresh session (and empty box) is expected.
      lastResultRef.current = {
        text: overrideResponse ?? response,
        ui: uiSegments,
        nextChips,
        turns: visibleConversationTurns,
        ts: Date.now(),
      };
      setConversationTurns([]);
      reset();
      setOverrideResponse(null);
    }
    clearApprovals();
    // Reset per-session chip state so the next trigger starts fresh.
    setScreenshotIncluded(true);
    setClipboardIncluded(false);
  }, [active, anchor, reset, clearApprovals, overrideResponse, response, uiSegments, nextChips, visibleConversationTurns]);

  // Provider-health banner: track its bounds on a slow 1s tick (plus on window
  // resize), NOT a 60 fps RAF loop. The banner is a static element that only
  // exists when a provider is broken; the old always-on RAF kept the renderer
  // from ever idling (a measured hotspot). A 1s cadence is plenty for a 12px
  // hover pad and is ~60× cheaper.
  useEffect(() => {
    if (!isPrimary) return;
    const measure = () => {
      const el = bannerRef.current;
      if (el && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        setBannerBounds((prev) => sameRect(prev, r) ? prev : r);
      } else if (bannerBounds !== null) {
        setBannerBounds(null);
      }
    };
    measure();
    const iv = window.setInterval(measure, 1000);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('resize', measure);
    };
  }, [isPrimary, bannerBounds]);

  // Hover hit-test for banner. Subscribes to the cursor store (no App
  // re-render on pointer move).
  useEffect(() => {
    const test = (px?: number, py?: number) => {
      if (!bannerBounds) {
        if (bannerHovered) setBannerHovered(false);
        return;
      }
      const p = px !== undefined && py !== undefined ? { x: px, y: py } : getCursorPos();
      if (!p) {
        if (bannerHovered) setBannerHovered(false);
        return;
      }
      const pad = 12;
      const inside =
        p.x >= bannerBounds.left - pad &&
        p.x <= bannerBounds.right + pad &&
        p.y >= bannerBounds.top - pad &&
        p.y <= bannerBounds.bottom + pad;
      if (inside !== bannerHovered) setBannerHovered(inside);
    };
    test();
    return subscribeCursor((p) => {
      if (p) test(p.x, p.y);
    });
  }, [bannerBounds, bannerHovered]);

  // While AI mode is active, watch the box bounds so we know when the cursor
  // is over it. Cursor-over-box = interactive overlay (DOM events reach the
  // input/buttons). Cursor outside = click-through so the user can interact
  // with whatever's underneath (highlight text, copy with Cmd+C, etc.).
  //
  // The measurement loop is ADAPTIVE instead of a flat 60fps forever: it
  // measures while the box is actually moving — the cursor-follow spring, a
  // drag, response growth — and parks itself once the rect has sat unchanged
  // for ~1.5s. Event sources (cursor movement via `pos`, a ResizeObserver on
  // the box, window resizes) re-kick it on demand, so a parked box stops
  // driving renderer frame callbacks entirely. Without the sameRect dedupe,
  // every frame produced a fresh DOMRect and re-fired every downstream effect —
  // that caused the box to flicker on hover and spammed 60Hz IPC to main.
  //
  // The loop is additionally HELD OFF for the entrance animation (~350ms):
  // while the box springs in, its rect legitimately changes every frame, so
  // measuring then re-renders the whole prompt tree and floods sendBoxBounds
  // IPC for the entire pop, which read as the box "jittering" as it appeared.
  // Hit-testing during that window uses the seeded boxHovered (the box anchors
  // at the cursor, so it's interactive from frame 1) instead of live bounds.
  const kickBoundsRef = useRef<() => void>(() => {});
  const prevRectRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    if (!aiActiveHere) {
      setBoxBounds(null);
      return;
    }
    let raf = 0;
    let running = false;
    let settled = false;
    let stillFrames = 0;
    prevRectRef.current = null;

    const measure = () => {
      if (!boxRef.current) return;
      const r = boxRef.current.getBoundingClientRect();
      stillFrames = sameRect(prevRectRef.current, r) ? stillFrames + 1 : 0;
      prevRectRef.current = r;
      setBoxBounds((prev) => (sameRect(prev, r) ? prev : r));
    };

    const loop = () => {
      running = false;
      measure();
      // Keep measuring while anything moves (~1.5s of stillness → stop).
      if (stillFrames < 90) {
        running = true;
        raf = window.requestAnimationFrame(loop);
      }
    };

    const kick = () => {
      if (!settled || !boxRef.current) return;
      stillFrames = 0;
      if (!running) {
        running = true;
        raf = window.requestAnimationFrame(loop);
      }
    };
    kickBoundsRef.current = kick;

    // Kick off measurement after the entrance spring settles.
    const settleTimer = window.setTimeout(() => {
      settled = true;
      kick();
    }, 350);

    // Re-measure on layout changes (response growth, chips, tool rows, …) and
    // display/OS resizes.
    const ro = boxRef.current ? new ResizeObserver(kick) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    const onResize = kick;
    window.addEventListener('resize', onResize);

    return () => {
      window.clearTimeout(settleTimer);
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      kickBoundsRef.current = () => {};
    };
  }, [aiActiveHere]);

  // Cursor movement moves the box (cursor-follow spring / drag), so each fresh
  // position re-kicks the bounds loop while the box is open. Subscribes to the
  // cursor store so App itself never re-renders on pointer move.
  useEffect(() => {
    if (!aiActiveHere) return;
    return subscribeCursor((p) => {
      if (p) kickBoundsRef.current();
    });
  }, [aiActiveHere]);

  // The box always anchors at the cursor when it opens, so the cursor is
  // inside its bounds from the very first frame. Seed boxHovered=true on
  // mount so the overlay is interactive immediately — otherwise the false→true
  // flip (and the setIgnoreMouseEvents toggle that comes with it) would land
  // mid-entrance-animation. The measurement loop corrects it after the
  // entrance settles.
  useEffect(() => {
    if (aiActiveHere) setBoxHovered(true);
  }, [aiActiveHere]);

  useEffect(() => {
    if (!aiActiveHere) {
      if (boxHovered) setBoxHovered(false);
      return;
    }
    const test = (px: number, py: number) => {
      if (!boxBounds) return;
      // Hysteresis: 14px halo to ENTER hover, 80px halo to LEAVE it. Without
      // hysteresis the cursor wobbling 1px back and forth at the edge made
      // `boxHovered` flip every frame, which toggled setIgnoreMouseEvents on
      // and off — macOS repaints the window frame on focus/blur, and the user
      // saw that as the box "flickering" on hover and drag. The wide leave
      // halo also tolerates the natural lag between cursor position (33ms IPC)
      // and box position during a fast drag.
      const pad = boxHovered ? 80 : 14;
      const inside =
        px >= boxBounds.left - pad &&
        px <= boxBounds.right + pad &&
        py >= boxBounds.top - pad &&
        py <= boxBounds.bottom + pad;
      if (inside !== boxHovered) {
        if (import.meta.env.DEV) {
          console.log(
            `[flicker] boxHovered flip → ${inside} cursor=(${px},${py}) box=(${Math.round(boxBounds.left)},${Math.round(boxBounds.top)})-(${Math.round(boxBounds.right)},${Math.round(boxBounds.bottom)}) pad=${pad}`,
          );
        }
        setBoxHovered(inside);
      }
    };
    const cur = getCursorPos();
    if (cur) test(cur.x, cur.y);
    return subscribeCursor((p) => {
      if (p) test(p.x, p.y);
    });
  }, [boxBounds, boxHovered, aiActiveHere]);

  const lastInteractive = useRef<boolean | null>(null);
  useEffect(() => {
    // Interactivity rule:
    //  - settings modal open → always interactive (whole screen)
    //  - AI mode active → interactive the WHOLE TIME (custom-cursor "capture
    //    mode"). The overlay owns the mouse so `cursor: none` hides the OS
    //    arrow everywhere; outside clicks/scrolls are forwarded to the app
    //    underneath via forwardClick / forwardScroll. Previously this was
    //    gated on boxHovered/selectionMode so the overlay stayed click-through
    //    outside the box — but a click-through window can't hide the cursor.
    //  - banner hovered → interactive (so its buttons are reachable)
    // NOTE: no stale-pos release here. An earlier version dropped capture
    // when pos went 3s without a beat — but main-thread bursts (app launch,
    // screen reads) stall the heartbeat and the guard fired mid-task,
    // unlocking the screen under a live run. A wrong release is worse than
    // none: the 4s end-sweep and the 6min watchdog own recovery instead.
    const interactiveDuringAI = aiActiveHere;
    const next = interactiveDuringAI || settingsOpen || bannerHovered;
    if (lastInteractive.current !== next) {
      console.log(
        `[flicker] setInteractive ${lastInteractive.current ?? 'init'} → ${next} aiActive=${aiActiveHere} settingsOpen=${settingsOpen} bannerHovered=${bannerHovered}`,
      );
      lastInteractive.current = next;
    }
    ipc.setInteractive(next);
  }, [aiActiveHere, settingsOpen, bannerHovered]);

  // Demand signal for main's cursor tracking. While this overlay has anything
  // that needs the pointer position (AI mode, Settings/Memory modal) we ask
  // main to keep polling it; when the last overlay drops its need, main stops
  // the poll loop entirely — a fully idle Spirit costs no timer wakeups. The
  // cleanup also fires on unmount so a closed overlay can't pin tracking on.
  useEffect(() => {
    ipc.setCursorTrackingNeeded(active || settingsOpen);
    return () => ipc.setCursorTrackingNeeded(false);
  }, [active, settingsOpen]);

  // Custom-cursor capture mode. While AI is active on this display, tell main
  // to treat it as "capturing" — it then skips its own uiohook outside-click
  // dismissal (the DOM owns it once the overlay is interactive) and ignores
  // the synthetic events it posts while forwarding clicks/scrolls. The flag
  // is per-display because only the overlay where the box lives is in
  // capture mode; the others stay click-through.
  useEffect(() => {
    if (displayId === null) return;
    window.spirit?.setOverlayCaptureMode?.(displayId, captureActive);
    return () => window.spirit?.setOverlayCaptureMode?.(displayId, false);
  }, [captureActive, displayId]);

  // Tell the main process when Settings / Memory open. While they're up the
  // overlay lowers its alwaysOnTop level so the user can Cmd+Tab to a
  // browser (e.g. to copy their OpenRouter API key) without our
  // screen-saver-level window blocking it.
  useEffect(() => {
    window.spirit?.setOverlaySettingsMode?.(settingsOpen);
  }, [settingsOpen]);

  // Push the box's display-local bounds to main whenever they change so the
  // global uiohook can detect a click that lands outside the box (the overlay
  // is click-through, so the renderer never sees those clicks itself). Sending
  // null clears the bounds (box hidden, or Settings covering it).
  useEffect(() => {
    if (!aiActiveHere || !boxBounds || displayId === null || settingsOpen) {
      window.spirit?.sendBoxBounds?.(null);
      return;
    }
    window.spirit?.sendBoxBounds?.({
      left: Math.round(boxBounds.left),
      top: Math.round(boxBounds.top),
      right: Math.round(boxBounds.right),
      bottom: Math.round(boxBounds.bottom),
      displayId,
    });
  }, [aiActiveHere, boxBounds, displayId, settingsOpen]);

  // 30s idle auto-dismiss. Starts when the Big Pill opens, restarts on
  // any sign of engagement (typing into our input, mouse movement inside
  // the box bounds, mousedown inside the box, llm turn finishing). Mouse
  // movement OUTSIDE the box does NOT count — only true interaction with
  // us. Clears when the pill closes. Replaces the old llmState==='done'
  // — that variant never fired if the user opened the pill but never
  // submitted, which is the most common idle case.
  const bumpIdleTimerRef = useRef<(ms?: number) => void>(() => {});
  useEffect(() => {
    if (!aiActiveHere) {
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      bumpIdleTimerRef.current = () => {};
      return;
    }

    // While the LLM is actively working, don't auto-dismiss on idle — the
    // user is watching the model load or the answer stream in, not ignoring
    // the box. This covers BOTH agent tool turns (`agentBusy`) and plain
    // text loading/streaming (a long answer takes >30s and the old code
    // hid the box mid-stream). Resume the normal idle cadence once the
    // turn ends. ESC always still works.
    const llmWorking = llmState === 'loading' || llmState === 'streaming';
    if (agentBusy || llmWorking || chipsPending || ttsActive) {
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      bumpIdleTimerRef.current = () => {};
      return;
    }

    const bump = (ms = 30_000) => {
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
      dismissTimer.current = window.setTimeout(() => {
        dismissTimer.current = null;
        handleCancelRef.current();
      }, ms);
    };
    bumpIdleTimerRef.current = bump;
    bump();

    const isInsideBox = (clientX: number, clientY: number): boolean => {
      const boxEl = boxRef.current;
      if (!boxEl || boxEl.offsetParent === null) return false;
      const box = boxEl.getBoundingClientRect();
      if (box.width === 0) return false;
      return (
        clientX >= box.left && clientX <= box.right &&
        clientY >= box.top && clientY <= box.bottom
      );
    };

    const onKey = (): void => {
      // Keystroke counts as engagement only when destined for us:
      // OS focus is on our window AND the focused element is inside the box.
      const boxEl = boxRef.current;
      const active = document.activeElement;
      if (document.hasFocus() && boxEl && active && boxEl.contains(active)) {
        bump();
      }
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (isInsideBox(e.clientX, e.clientY)) bump();
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (isInsideBox(e.clientX, e.clientY)) bump();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('mousedown', onMouseDown, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      bumpIdleTimerRef.current = () => {};
    };
  }, [aiActiveHere, agentBusy, llmState, ttsActive]);

  // Restart the idle timer whenever the LLM turn settles. Use a LONGER
  // window (2 min) post-done because the typical workflow at this point
  // is: read the answer → switch to another app to apply it → come back
  // and ask a follow-up against the same screenshot + session. A short
  // (30 s) timer dismissed the box during that switch and the user lost
  // their context. Pre-done turns keep the default 30 s.
  useEffect(() => {
    if (llmState === 'done') bumpIdleTimerRef.current(120_000);
  }, [llmState]);

  const layout = useMemo(() => {
    if (!anchor) return null;
    return computeAnchor(anchor.x, anchor.y, screenSize.w, screenSize.h);
  }, [anchor, screenSize]);

  const needsAccessibility = perms !== null && !perms.accessibility && platform === 'darwin';
  const needsScreenRecording = perms !== null && !perms.screenRecording && platform === 'darwin';
  // Mount the halo a beat AFTER the prompt box pops. Both animate on open,
  // and the halo is a full-screen blurred SVG (three blur filters) while the
  // box is a springing pill — rendering both from the first frame stutters
  // the box entrance on the compositor. Let the box have the first clean
  // frames; the halo fades in once it has settled.
  const [haloVisible, setHaloVisible] = useState(false);
  // Replay counter for the annotation tour: bumped by the overlay's ↻ button,
  // passed to PointCursor so it re-flies the whole current set from seq 1.
  const [annotationsReplay, setAnnotationsReplay] = useState(0);
  // Past-turn annotation replay: re-show a committed turn's boxes/arrows.
  // Replay wins while active (releases after ~8s); live is the fallback.
  const [replayedAnnotations, setReplayedAnnotations] = useState<ScreenAnnotation[] | null>(null);
  const replayClearTimer = useRef<number | null>(null);
  const replayTurnAnnotations = useCallback((turn: ConversationTurn) => {
    const tags = turn.annotations;
    if (!tags || tags.length === 0) return;
    if (replayClearTimer.current) window.clearTimeout(replayClearTimer.current);
    setReplayedAnnotations([...tags]);
    setAnnotationsReplay((s) => s + 1);
    replayClearTimer.current = window.setTimeout(() => {
      replayClearTimer.current = null;
      setReplayedAnnotations(null);
    }, 8000);
  }, []);
  const liveAnnotations = pointStream.annotations;
  const shownAnnotations = replayedAnnotations ?? (liveAnnotations.length > 0 ? liveAnnotations : []);
  useEffect(() => {
    if (active) {
      const t = window.setTimeout(() => setHaloVisible(true), 220);
      return () => window.clearTimeout(t);
    }
    setHaloVisible(false);
  }, [active]);
  const showHalo = haloVisible && cursorDisplayId === displayId;
  const webOnDefault = !!settings?.webSearch;

  const handleSubmit = (
    prompt: string,
    options?: {
      web?: boolean;
      templateId?: TemplateId;
      displayPrompt?: string;
      fromChip?: boolean;
    },
  ) => {
    setOverrideResponse(null);
    // A new turn invalidates the previous answer's follow-up row.
    restoreNext([]);
    // A new turn also retires the self-knowledge line — it described the
    // turn that just finished.
    setLearnedLine(null);
    // `displayPrompt` is the short label the user actually tapped; the long
    // hidden chip prompt is what gets sent to the LLM.
    setLastPrompt(options?.displayPrompt ?? prompt);
    setLastWasWeb(!!options?.web);
    // Paint-to-select UI is submit-scoped: once the user sends, hide the
    // in-progress drag + committed highlights/bubbles (main consumes the
    // texts for this turn and clears its own list).
    setPaint(null);
    setPaintSelections([]);
    // Stamp the per-turn chip state onto the submit so the main
    // process knows whether to attach clipboard.
    void submit(prompt, {
      ...options,
      includeClipboard: clipboardIncluded,
    });
  };

  // Chip tap routing: web-search labels open the browser (DuckDuckGo),
  // everything else submits to the LLM as a normal follow-up. A chip's hidden
  // inner `prompt` (when present) is what actually gets submitted; the label
  // stays as the short display name. Offline search chips (web: true) submit
  // with web search FORCED on so the model actually searches the internet
  // instead of answering from memory.
  const handleChipRun = (chip: SuggestionChip) => {
    const { label, prompt, web } = chip;
    if (looksLikeWebSearch(label)) {
      console.log(`[chip] web-search intent: "${label}" -> opening DuckDuckGo`);
      void ipc.openExternal('https://duckduckgo.com/?q=' + encodeURIComponent(label));
      return;
    }
    const inner = prompt && prompt.trim() ? prompt : label;
    handleSubmit(inner, { displayPrompt: label, fromChip: true, web: web || undefined });
  };

  // Generated-UI button actions. 'send' submits the interpolated prompt as a
  // follow-up that continues the current session (same as a reply chip);
  // 'copy' writes visible text to the clipboard — explicit user tap only.
  const handleUiSubmit = (prompt: string) => {
    handleSubmit(prompt, { fromChip: true });
  };
  const handleUiCopy = (text: string) => {
    void ipc.writeClipboard(text);
  };

  const handleCommand = (id: CommandId, _args: string) => {
    void _args;
    switch (id) {
      case 'settings':
        void requestSettingsOpen();
        break;
      case 'memory':
        setSettingsOpenTab('memory');
        void requestSettingsOpen();
        break;
      case 'help':
        reset();
        restoreNext([]);
        setOverrideResponse(HELP_TEXT);
        break;
      case 'history':
        reset();
        restoreNext([]);
        setOverrideResponse('## Loading sessions…');
        void (async () => {
          try {
            const list = await ipc.listSessions();
            setOverrideResponse(formatHistoryMarkdown(list));
          } catch (e) {
            setOverrideResponse(
              `## History\n\nCould not load sessions: ${e instanceof Error ? e.message : 'unknown error'}.`,
            );
          }
        })();
        break;
      case 'lastsession':
        // Restore the most recent saved session into the response area
        // so the user can re-read what was just there. Useful when they
        // closed the box by accident mid-thought. Requires
        // memorySaveEnabled (off by default) — without saved sessions
        // there is nothing to restore.
        reset();
        setOverrideResponse('## Loading last session…');
        void (async () => {
          try {
            const md = await window.spirit.loadLatestSession();
            if (md && md.length > 0) {
              setOverrideResponse(md);
            } else {
              setOverrideResponse(
                `## No saved sessions found\n\nEnable **Settings → Memory → "Save session transcripts"** so Spirit keeps a copy of each conversation. /lastsession can only restore conversations that were saved to your workspace.`,
              );
            }
          } catch (e) {
            setOverrideResponse(
              `## Last session\n\nCould not load: ${e instanceof Error ? e.message : 'unknown error'}.`,
            );
          }
        })();
        break;
      case 'clear':
        reset();
        setOverrideResponse(null);
        restoreNext([]);
        // True session reset in the main process: drops session history,
        // pending context, in-flight stream and the recalled context memory.
        window.spirit?.clearActiveSession?.();
        break;
      case 'test': {
        // /test lists UI seed scenarios; /test <id> seeds one directly.
        // Fake transcript turns only — no LLM call, nothing saved or sent.
        const name = (_args ?? '').trim().toLowerCase();
        const hit = SEED_TESTS.find((t) => t.id === name);
        if (hit) {
          handlePickSeedTest(hit.id);
        }
        // Bare /test is handled by the input dropdown — nothing to do here.
        break;
      }
      case 'quit':
        window.spirit?.quit?.();
        break;
      case 'web':
      case 'summary':
      case 'brief':
      case 'translate':
      case 'explain':
      case 'code':
      case 'improve':
      case 'define':
      case 'solve':
      case 'reply':
      case 'identify':
        // Handled inline in PromptInput before reaching here.
        break;
    }
  };

  const handleCancel = (opts?: { cancelStream?: boolean }) => {
    // Explicit "stop it" gestures (ESC, the ✕ button) pass cancelStream: true
    // and genuinely abort the in-flight answer. Everything else — backdrop
    // click, idle timer, busy-elsewhere — just hides the box: the AI keeps
    // answering in the background and the result shows on the next trigger.
    void ipc.cancelAIMode(opts);
  };
  // Keep the ref in sync so the elsewhere-detection effect can call the
  // latest handleCancel without re-running on every render.
  useEffect(() => {
    handleCancelRef.current = handleCancel;
  });

  useEffect(() => {
    aiActiveHereRef.current = aiActiveHere;
  });
  useEffect(() => {
    countDismissClickRef.current = countDismissClick;
  });

  // AI-mode end clears any in-progress drag and every committed paint bubble
  // + highlight (main clears its own pendingPaintSelections in onEnd).
  useEffect(() => {
    if (!active) {
      setPaint(null);
      setPaintSelections([]);
    }
  }, [active]);

  // One counted outside click toward the double-click-to-dismiss threshold.
  // Shared by the DOM backdrop clicks AND the eaten-click signals main sends
  // when a click got swallowed by the forward's temporary click-through
  // window (see onForwardedClickEaten below).
  const countDismissClick = () => {
    backdropClickCount.current += 1;
    if (backdropClickCount.current >= 2) {
      backdropClickCount.current = 0;
      if (backdropClickTimer.current !== null) {
        window.clearTimeout(backdropClickTimer.current);
        backdropClickTimer.current = null;
      }
      handleCancelRef.current();
      return;
    }
    if (backdropClickTimer.current !== null) {
      window.clearTimeout(backdropClickTimer.current);
    }
    backdropClickTimer.current = window.setTimeout(() => {
      backdropClickCount.current = 0;
      backdropClickTimer.current = null;
    }, 800);
  };

  const registerDismissClick = () => {
    // The user can hide the box at any time; hiding never blocks. The last
    // result stays available for the session window (~2 min) and is restored
    // on the next trigger (see lastResultRef), so dismissing mid-task just
    // puts the box away — the work is not lost.
    // Default behaviour: require a double-click to dismiss, so a single
    // click into the empty area doesn't tear down the box. The user can
    // switch to single-click in Settings → Behaviour.
    const requireDouble = settings?.dismissOnDoubleClick ?? true;
    if (!requireDouble) {
      handleCancel();
      return;
    }
    countDismissClick();
  };

  // Drag-screenshot / paint-select gesture handlers. Two drag kinds share the
  // backdrop pointer handlers, disambiguated by whether selectionMode is
  // armed (trigger key held):
  //   - selectionMode  → ad-hoc rect SCREENSHOT (legacy behavior)
  //   - plain drag     → PAINT-TO-SELECT: accent region, OCR'd into a bubble
  //
  // Per pointerdown the plain-drag path defers its outcome until release:
  //   - released within 6px of start → treated as a backdrop click (dismiss
  //     counter + click forwarded to the app underneath)
  //   - drag of ≥6px released         → paint the region, OCR it, add a bubble
  //   - ESC while dragging            → cancel the paint cleanly
  //
  // We use pointerCapture so a fast drag that overshoots the overlay window
  // (e.g. flicks to the screen edge) keeps firing pointermove/up at us
  // instead of vanishing into the underlying app halfway through.
  const SELECTION_THRESHOLD_PX = 6;

  const handleBackdropPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !aiActiveHere) return;
    // Right-click outside the box: forward the context-menu click to the app
    // underneath (capture mode swallows it otherwise) but don't count it
    // toward dismissal.
    if (e.button === 2 && !selectionMode) {
      forwardOutsideClick(e, 'right');
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!selectionMode) {
      // Plain left-drag = paint-to-select. Defer the click-forward/dismiss
      // until the gesture resolves: a drag that passes the threshold is a
      // paint; a drag that never moves is a forwarded click.
      setPaint({
        startX: e.clientX,
        startY: e.clientY,
        currX: e.clientX,
        currY: e.clientY,
        pointerId: e.pointerId,
        armed: false,
      });
      return;
    }
    setSelection({
      startX: e.clientX,
      startY: e.clientY,
      currX: e.clientX,
      currY: e.clientY,
      pointerId: e.pointerId,
      armed: false,
    });
  };

  // Capture mode swallowed the user's physical click (the overlay owns the
  // mouse so `cursor: none` works). Replay it into the app under the cursor
  // so "click lands in the app" keeps working. Coordinates are display-local
  // (clientX/Y relative to this overlay window); main converts to screen
  // coords before clicking.
  const forwardClickAt = (x: number, y: number, button: 'left' | 'right') => {
    if (displayId === null) return;
    const px = Math.round(x);
    const py = Math.round(y);
    console.log(`[forward-click] renderer sending x=${px} y=${py} display=${displayId} button=${button}`);
    window.spirit?.forwardClick?.(px, py, displayId, { button });
  };
  const forwardOutsideClick = (e: React.PointerEvent<HTMLDivElement>, button: 'left' | 'right') => {
    forwardClickAt(e.clientX, e.clientY, button);
  };

  // Capture mode also swallows scroll gestures. Forward them to the app under
  // the cursor — accumulate trackpad micro-deltas into whole notches, then
  // throttle the forwarding so we don't spawn a PowerShell process per wheel
  // event.
  const handleBackdropWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!aiActiveHere || displayId === null) return;
    const target = e.target instanceof Node ? e.target : null;
    const boxEl = boxRef.current;
    if (boxEl && boxEl.offsetParent !== null && target && boxEl.contains(target)) return;
    wheelAccumRef.current += e.deltaY;
    const now = Date.now();
    if (now - lastWheelForwardRef.current < 90) return;
    const notches = Math.round(wheelAccumRef.current / 100);
    if (notches === 0) {
      wheelAccumRef.current = 0;
      return;
    }
    lastWheelForwardRef.current = now;
    // Drain the WHOLE accumulated count on every forward. (The old code
    // computed `notches` BEFORE the throttle check and skipped the drain when
    // throttled, so a fast continuous scroll grew the accumulator unboundedly
    // — a single forward eventually carried dozens of notches, which not only
    // jumped the page but also overflowed WM_MOUSEWHEEL's 16-bit delta once
    // wheel posts went direct-to-window.)
    wheelAccumRef.current -= notches * 100;
    // DOM deltaY is positive when scrolling DOWN; the main-process scrollLines
    // API uses "positive = scroll up" (pyautogui convention). Negate so a
    // wheel-down gesture reaches the app as a scroll-down and wheel-up as
    // scroll-up.
    window.spirit?.forwardScroll?.(-notches, displayId);
  };

  const handleBackdropPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (selection && e.pointerId === selection.pointerId) {
      const dx = e.clientX - selection.startX;
      const dy = e.clientY - selection.startY;
      const armed = selection.armed || Math.abs(dx) >= SELECTION_THRESHOLD_PX || Math.abs(dy) >= SELECTION_THRESHOLD_PX;
      setSelection({
        ...selection,
        currX: e.clientX,
        currY: e.clientY,
        armed,
      });
      return;
    }
    if (paint && e.pointerId === paint.pointerId) {
      const dx = e.clientX - paint.startX;
      const dy = e.clientY - paint.startY;
      const armed = paint.armed || Math.abs(dx) >= SELECTION_THRESHOLD_PX || Math.abs(dy) >= SELECTION_THRESHOLD_PX;
      setPaint({
        ...paint,
        currX: e.clientX,
        currY: e.clientY,
        armed,
      });
    }
  };

  const handleBackdropPointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (paint && e.pointerId === paint.pointerId) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer may already be released if cancelled */
      }
      const wasArmed = paint.armed;
      const startX = paint.startX;
      const startY = paint.startY;
      const rect = {
        x: Math.min(startX, paint.currX),
        y: Math.min(startY, paint.currY),
        width: Math.abs(paint.currX - startX),
        height: Math.abs(paint.currY - startY),
      };
      setPaint(null);
      if (!wasArmed) {
        // Plain click (no drag): the pointerdown deferred the click-forward
        // until we knew the gesture wasn't a paint. Replay it + count toward
        // the dismiss threshold now.
        forwardClickAt(startX, startY, 'left');
        registerDismissClick();
        return;
      }
      if (displayId === null || rect.width < 4 || rect.height < 4) return;
      const id = `paint-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPaintSelections((prev) => [...prev, { id, rect, text: '', status: 'reading' }]);
      const result = await window.spirit.capturePaint(rect, displayId);
      setPaintSelections((prev) =>
        prev.map((p) =>
          p.id === id
            ? result.ok
              ? { ...p, text: result.text, status: 'done' }
              : { ...p, status: 'error', error: result.error }
            : p,
        ),
      );
      return;
    }
    if (!selection || e.pointerId !== selection.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released if cancelled */
    }
    const wasArmed = selection.armed;
    const rect = {
      x: Math.min(selection.startX, selection.currX),
      y: Math.min(selection.startY, selection.currY),
      width: Math.abs(selection.currX - selection.startX),
      height: Math.abs(selection.currY - selection.startY),
    };
    setSelection(null);
    if (!wasArmed || displayId === null || rect.width < 4 || rect.height < 4) {
      return;
    }
    const result = await window.spirit.captureSelection(rect, displayId);
    if (result.ok) {
      setSelectionFeedback({ kind: 'ok', rect: { width: rect.width, height: rect.height } });
    } else {
      setSelectionFeedback({ kind: 'error', message: result.error });
    }
  };

  // Remove one committed paint selection (bubble X): drop its highlight here
  // and tell main to drop its text from the prompt context.
  const removePaintSelection = (id: string) => {
    window.spirit?.removePaint?.(id);
    setPaintSelections((prev) => prev.filter((p) => p.id !== id));
  };

  // Toast auto-dismiss after 2s. Clears any pending timer first so back-to-
  // back captures don't stack timers.
  useEffect(() => {
    if (!selectionFeedback) return;
    if (selectionFeedbackTimer.current !== null) {
      window.clearTimeout(selectionFeedbackTimer.current);
    }
    selectionFeedbackTimer.current = window.setTimeout(() => {
      setSelectionFeedback(null);
      selectionFeedbackTimer.current = null;
    }, 2000);
  }, [selectionFeedback]);

  // ESC during a selection/paint cancels the in-progress rect without
  // dismissing AI mode (ESC outside a selection still dismisses the box via
  // the uiohook handler in main).
  useEffect(() => {
    if (!selection && !paint) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null);
        setPaint(null);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [selection, paint]);

  const displayResponse = overrideResponse ?? response;  const displayLoading = overrideResponse ? false : llmState === 'loading';
  const displayStreaming = overrideResponse ? false : llmState === 'streaming';
  const displayError = overrideResponse ? null : llmError;

  const selRect = selection
    ? {
        x: Math.min(selection.startX, selection.currX),
        y: Math.min(selection.startY, selection.currY),
        width: Math.abs(selection.currX - selection.startX),
        height: Math.abs(selection.currY - selection.startY),
      }
    : null;

  const paintRect = paint
    ? {
        x: Math.min(paint.startX, paint.currX),
        y: Math.min(paint.startY, paint.currY),
        width: Math.abs(paint.currX - paint.startX),
        height: Math.abs(paint.currY - paint.startY),
      }
    : null;

  return (
    <div
      className={[
        'fixed inset-0',
        // Force cursor:none across the ENTIRE overlay DOM while the custom
        // Bibata cursor is active — element-level cursor rules (cursor-grab on
        // the box drag handle, label cursor-pointer, the UA textarea I-beam,
        // …) would otherwise leak the OS cursor through. Off during selection
        // mode so the OS crosshair shows.
        cursorTakeover ? 'spirit-cursor-hidden' : '',
      ].join(' ')}
      style={{
        // Capture mode / Settings: hide the OS arrow (the accent SpiritCursor
        // replaces it). During selection mode show the OS crosshair for
        // precision. Settings is a full-screen interactive overlay too, so the
        // branded cursor takes over there as well. All of this is display-gated
        // via cursorTakeover — other monitors keep their real OS arrow.
        cursor: cursorTakeover
          ? 'none'
          : selectionMode && aiActiveHere
            ? 'crosshair'
            : undefined,
      }}
      onPointerDown={captureActive ? handleBackdropPointerDown : undefined}
      onPointerMove={aiActiveHere && (selection || paint) ? handleBackdropPointerMove : undefined}
      onPointerUp={aiActiveHere && (selection || paint) ? handleBackdropPointerUp : undefined}
      onPointerCancel={aiActiveHere && (selection || paint) ? handleBackdropPointerUp : undefined}
      onWheel={captureActive ? handleBackdropWheel : undefined}
    >
      <AnimatePresence>
        {aiActiveHere && selectionMode && !selection && (
          <motion.div
            key="selection-hint"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full px-3 py-1.5 text-[12px] font-medium shadow-glass backdrop-blur-md"
            style={{
              background: 'rgba(20,22,18,0.78)',
              color: 'rgba(var(--spirit-accent-rgb), 0.95)',
              border: '1px solid rgba(var(--spirit-accent-rgb), 0.35)',
            }}
          >
            Drag to capture a region
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cursor-tracking visuals live in an isolated subtree so the 30 Hz
          pointer stream re-renders ONLY these leaves, never App/PromptInput. */}
      <CursorLayer
        showHalo={showHalo}
        cursorTakeover={cursorTakeover}
        captureActive={captureActive}
        paintArmed={paint?.armed ?? false}
      />

      {/* Annotation protocol (Phase 7): persistent annotation boxes,
          arrows and numbered chips for the answer's [POINT]/[BOX]/[ARROW]
          tags, plus the touring branded cursor that flies each anchor in story
          order. Independent of the OS mouse — the real cursor never moves.
          Mounted unconditionally; clears itself on run end. The replay bump
          makes the toolbar's ↻ button re-fly the whole tour from seq 1. */}
      <ScreenAnnotations annotations={shownAnnotations} />
      <PointCursor
        annotations={shownAnnotations}
        replaySignal={annotationsReplay}
      />

      {selRect && selection?.armed && (
        <SelectionRectangle
          x={selRect.x}
          y={selRect.y}
          width={selRect.width}
          height={selRect.height}
        />
      )}

      {paintRect && paint?.armed && (
        <SelectionRectangle
          tone="accent"
          x={paintRect.x}
          y={paintRect.y}
          width={paintRect.width}
          height={paintRect.height}
        />
      )}

      {/* Committed paint selections: persistent accent highlights + the bubble
          row at the top of the screen. Highlights are pointer-events-none so
          they never block the app underneath; bubbles are interactive for the
          remove (✕) button. */}
      {paintSelections.map((p) => (
        <div
          key={p.id}
          className="pointer-events-none absolute z-10 rounded-[2px]"
          style={{
            left: p.rect.x,
            top: p.rect.y,
            width: p.rect.width,
            height: p.rect.height,
            background: 'rgb(var(--spirit-accent-rgb) / 0.14)',
            border: '1.5px solid rgb(var(--spirit-accent-rgb) / 0.85)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.18)',
          }}
        />
      ))}

      {paintSelections.length > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-50 flex max-w-[80vw] -translate-x-1/2 flex-wrap items-center justify-center gap-2">
          {paintSelections.map((p) => {
            const preview =
              p.status === 'reading'
                ? 'Reading…'
                : p.status === 'error'
                  ? p.error ?? 'No text'
                  : p.text.length > 56
                    ? p.text.slice(0, 56).replace(/\s+/g, ' ').trimEnd() + '…'
                    : p.text || 'No text';
            return (
              <motion.div
                key={p.id}
                layout
                initial={{ opacity: 0, y: -8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.95 }}
                transition={{ duration: 0.16 }}
                className="pointer-events-auto flex max-w-[320px] items-center gap-2 rounded-full px-2.5 py-1.5 shadow-glass backdrop-blur-md"
                style={{
                  background: 'rgba(20,22,18,0.85)',
                  border: '1px solid rgb(var(--spirit-accent-rgb) / 0.45)',
                }}
                title={p.status === 'done' ? p.text : preview}
              >
                <span
                  className="truncate text-[12px] font-medium"
                  style={{ color: 'rgb(var(--spirit-accent-rgb) / 0.95)' }}
                >
                  {preview}
                </span>
                <span
                  className="shrink-0 rounded px-1 text-[10px] font-medium leading-tight"
                  style={{ color: 'rgba(255,255,255,0.6)' }}
                >
                  {Math.round(p.rect.width)}×{Math.round(p.rect.height)}
                </span>
                <button
                  aria-label="Remove selection"
                  className="shrink-0 cursor-pointer rounded-full px-1.5 text-[12px] leading-none transition-colors hover:bg-white/10"
                  style={{ color: 'rgba(255,255,255,0.75)' }}
                  onClick={() => removePaintSelection(p.id)}
                >
                  ✕
                </button>
              </motion.div>
            );
          })}
        </div>
      )}

      <AnimatePresence>
        {selectionFeedback && (
          <motion.div
            key="selection-feedback"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full px-3 py-1.5 text-[12px] font-medium shadow-glass backdrop-blur-md"
            style={
              selectionFeedback.kind === 'ok'
                ? {
                    background: 'rgba(20,22,18,0.78)',
                    color: 'rgb(var(--spirit-accent-rgb) / 0.95)',
                    border: '1px solid rgb(var(--spirit-accent-rgb) / 0.35)',
                  }
                : {
                    background: 'rgba(40,16,16,0.85)',
                    color: 'rgba(255,180,180,0.95)',
                    border: '1px solid rgba(255,120,120,0.4)',
                  }
            }
          >
            {selectionFeedback.kind === 'ok'
              ? `Selection captured · ${Math.round(selectionFeedback.rect.width)}×${Math.round(selectionFeedback.rect.height)} px`
              : `Selection failed · ${selectionFeedback.message}`}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {/* PromptInput must wait for settings: audioMode read off a null
            settings snapshot is `false`, so the very first wiggle would open
            as a type-box instead of the Listening capsule. */}
        {aiActiveHere && layout && !settingsOpen && !settingsLoading && (
          <PromptInput
            key="prompt"
            ref={boxRef}
            x={layout.x}
            y={layout.y}
            loading={displayLoading}
            streaming={displayStreaming}
                response={displayResponse}
                error={displayError}
                interrupted={overrideResponse ? null : interrupted}
                onContinue={() => void continueLast()}
                onRetry={() => void retryLast()}
            conversationTurns={[...visibleConversationTurns, ...seedTurns]}
            committedTurnId={completion?.runId ?? null}
            webOnDefault={webOnDefault}
            audioMode={!!settings?.audioMode}
            selectionMode={selectionMode}
            lastPrompt={overrideResponse ? 'Spirit · help' : lastPrompt}
            lastWasWeb={lastWasWeb}
            activities={overrideResponse ? [] : activities}
            reasoning={overrideResponse ? '' : reasoning}
            elapsedSecs={overrideResponse ? null : elapsedSecs}
            approvals={overrideResponse ? [] : approvals}
            clipboardPreview={clipboardCtx.preview}
            clipboardLength={clipboardCtx.length}
            selectionPreview={selectionCtx.preview}
            selectionLength={selectionCtx.length}
            onDismissSelection={() => void dismissSelection()}
            appPreview={appPreview}
            screenshotIncluded={screenshotIncluded}
            onDismissScreenshot={() => setScreenshotIncluded(false)}
            onToggleScreenshot={() => setScreenshotIncluded((v) => !v)}
            clipboardIncluded={clipboardIncluded}
            onToggleClipboard={() => setClipboardIncluded((v) => !v)}
            onApprove={decideApproval}
            onDismissClipboard={() => {
              void dismissClipboard();
              setClipboardIncluded(false);
            }}
            onSubmit={handleSubmit}
            onCommand={handleCommand}
            onCancel={() => handleCancel({ cancelStream: true })}
            onStopStream={() => ipc.cancelAIMode({ cancelStream: true, keepOpen: true })}
            hasAnnotations={shownAnnotations.length > 0}
            onReplayAnnotations={() => setAnnotationsReplay((s) => s + 1)}
            onReplayTurnAnnotations={replayTurnAnnotations}
            onPickSeedTest={handlePickSeedTest}
            onClearSeedTurns={handleClearSeedTurns}
            chipVisibility={settings?.chipVisibility ?? 'both'}
            suggestionChips={suggestionChips}
            onRunSuggestion={handleChipRun}
            chipsPending={chipsPending}
            learnedLine={learnedLine}
            nextChips={nextChips}
            onRunNextChip={handleChipRun}
            webImages={webImages}
            uiSegments={overrideResponse ? [] : uiSegments}
            uiLive={overrideResponse ? null : uiLive}
            onUiSubmit={handleUiSubmit}
            onUiCopy={handleUiCopy}
            onTtsActiveChange={setTtsActive}
          />
        )}
      </AnimatePresence>

      {isPrimary && (
        <ProviderHealthBanner ref={bannerRef} onOpenSettings={() => void requestSettingsOpen()} />
      )}

      {needsAccessibility && (
        <PermissionsBanner
          message="Accessibility permission required"
          hint="System Settings was opened. Grant access, then quit Spirit and relaunch."
        />
      )}
      {!needsAccessibility && needsScreenRecording && (
        <PermissionsBanner
          message="Screen Recording permission required"
          hint="System Settings was opened. Grant access, then quit Spirit and relaunch."
        />
      )}

      <AnimatePresence>
        {settingsOpen && (
          <div
            key="settings-backdrop"
            className="fixed inset-0 z-[9998]"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                forwardClickAt(e.clientX, e.clientY, 'left');
                setSettingsOpen(false);
              }
            }}
          >
              <SettingsPanel
                initial={settings}
                onClose={() => { setSettingsOpen(false); setSettingsOpenTab(null); }}
                onSaved={(s) => saveSettings(s)}
                openTab={settingsOpenTab}
              />
          </div>
        )}
      </AnimatePresence>

      <NotificationToast enabled={settings?.notificationsEnabled ?? true} />
    </div>
  );
}
