import { forwardRef, lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useDragControls, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion';
import { Brain } from 'lucide-react';
import { IconChevronRight, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  COMMANDS,
  HELP_TEXT,
  isTemplateCommand,
  matchCommands,
  parseCommand,
  type Command,
  type CommandId,
} from '../lib/commands';
import { LinkCard } from './LinkCard';
// The markdown pipeline (react-markdown + remark/rehype + katex) is the heaviest
// chunk in the renderer bundle. Loading it lazily keeps it out of every overlay's
// boot bundle — it only loads the first time an answer actually contains
// markdown, then stays cached for the rest of the session.
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));
import { ToolApproval } from './ToolApproval';
import { SuggestionChips } from './SuggestionChips';
import { ChipsLoadingLine } from './ChipsLoadingLine';
import { NextActionChips } from './NextActionChips';
import { WebImagesRow } from './WebImagesRow';
import { ScrollArrows } from './ScrollArrows';
import { CustomUi } from './CustomUi';
import { OpenUiBlock } from './OpenUiBlock';
import { QuestionWizard } from './QuestionWizard';
import { MermaidDiagram } from './MermaidDiagram';
import { DiagramWidget } from './DiagramWidget';
import { ChainPanel } from './ChainPanel';
import { AgentStatus } from './AgentStatus';
import { WordHighlight } from './WordHighlight';
import { BorderBeam } from 'border-beam';
import { useLinkMetas } from '../hooks/useLinkMetas';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useTTS } from '../hooks/useTTS';
import type { ToolActivityRow } from '../hooks/useLLMQuery';
import type {
  TemplateId,
  ToolApprovalRequest,
  ChipVisibility,
  SuggestionChip,
  WebImage,
  UiSegment,
  UiLiveBlock,
  AttachedFile,
  ScreenAnnotation,
} from '../../electron/types';
import { ipc } from '../lib/ipc';
import { getCursorPos, subscribeCursor } from '../lib/cursorStore';
import { TurnScrubber, type TurnChapter } from './TurnScrubber';
import { SEED_TESTS } from '../lib/testSeeds';
import { shouldShowChips, type ChipPhase } from '../lib/chipsMode';
import { streamDisplayText } from '../lib/streamDisplay';
import { matchVoiceCommand, effectiveVoiceLang, isStopUtterance } from '../lib/voiceCommands';
import { speakAcknowledge, cancelVoiceFeedback, primeVoiceFeedback } from '../lib/voiceGreeting';

const BOX_WIDTH = 380;
// Voice-first (audioMode) narrow-capsule width. With "start with listening"
// on, the box opens as this small pill and widens as live transcript text
// types into the input, capped at BOX_WIDTH.
const PILL_WIDTH = 132;
// Minimum width the full input row needs to render without cramping (dot +
// textarea + tools + send). Used as the floor once live text starts landing.
const ROW_MIN_WIDTH = 320;
// When a result is showing, the action "context" chips (the live suggestion
// chips that normally sit under the box) move to a fixed-width vertical rail
// on the RIGHT edge, top-aligned, so they stay reachable while the user reads
// the answer. This is the horizontal space reserved for that rail (192px rail
// + 6px gap) — the box itself keeps its full BOX_WIDTH.
const CONTEXT_RAIL_W = 192;
const RAIL_RESERVE = CONTEXT_RAIL_W + 6;
const DROPDOWN_MAX_VISIBLE = 4;

// A user-placed box stays where it was left. When PromptInput unmounts on
// hide (AnimatePresence) its position state would normally vanish and the
// next open would re-anchor to the cursor — the "offset" the user sees after
// dragging the handle, hiding, and reopening. This module-level store survives
// remounts within the display window (each display runs its own overlay
// window/bundle), so a pinned box reopens exactly where it was placed. The
// follow-the-cursor mode stays the default for fresh, never-placed opens.
const lastPlaced = { x: 0, y: 0, has: false, pinned: false };

// In-session prompt history for ArrowUp/ArrowDown navigation (newest first).
// Module-level so it survives remounts of the box within this display window
// (each display runs its own overlay bundle), mirroring `lastPlaced`.
const MAX_PROMPT_HISTORY = 200;
const promptHistoryStore: string[] = [];

export type ConversationTurn = {
  id: string;
  // Monotonic session number (Q1, Q2, …) assigned at commit. Never
  // restarts or shifts when turns filter in/out — the rail label is stable.
  n?: number;
  prompt: string;
  wasWeb: boolean;
  response: string;
  uiSegments: UiSegment[];
  // Snapshots so past turns replay their full media, not just text.
  images?: WebImage[];
  annotations?: ScreenAnnotation[];
};

// Plain-text snippet of an answer for the rail preview card: strip
// markdown/tags, collapse whitespace, cap length.
function snippetText(md: string): string {
  const plain = md
    .replace(/\[.+?\]/g, ' ')
    .replace(/[#*`_~>|\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 160 ? plain.slice(0, 160).trimEnd() + '…' : plain;
}

type Props = {
  x: number;
  y: number;
  loading: boolean;
  streaming: boolean;
  response: string;
  // Committed Q+A turns of this session, oldest first. Rendered above the
  // live answer so previous questions stay visible in the box.
  conversationTurns?: ConversationTurn[];
  // Id of the turn currently streaming (already shown live) — hidden from
  // the committed list to avoid showing it twice.
  committedTurnId?: string | null;
  error: string | null;
  // Set when the run failed after streaming: the partial answer is kept and
  // the action row offers Continue (resume from history) + Retry (from scratch).
  interrupted?: string | null;
  onContinue?: () => void;
  onRetry?: () => void;
  webOnDefault: boolean;
  // When true, the box auto-starts the microphone on mount, auto-submits the
  // transcript, reads the answer back via TTS, and re-opens the mic for a
  // follow-up. Hands-free voice loop. ESC always breaks out.
  audioMode: boolean;
  lastPrompt: string;
  lastWasWeb: boolean;
  activities: ToolActivityRow[];
  // Live chain-of-thought (reasoning_content) streamed from the main process
  // while a reasoning-capable model thinks. Shown in the ChainPanel at the top
  // of the answer area; kept after the answer lands so it can be re-opened.
  reasoning: string;
  // Frozen round-trip seconds for the "thought for Xs" line (null while busy).
  elapsedSecs?: number | null;
  approvals: ToolApprovalRequest[];
  clipboardPreview: string | null;
  clipboardLength: number;
  // Captured on-screen text selection chip (emerald): auto-shown when the
  // box opens and the main process found selected text. Auto-attached to
  // the prompt; X dismisses it for the session.
  selectionPreview: string | null;
  selectionLength: number;
  onDismissSelection: () => void;
  // Always-on "current app" context chip (violet): shows which app + tab
  // the AI was sent along with this turn. No dismiss — unlike clipboard /
  // selection the app context has no privacy opt-out; it's read at trigger
  // and re-read on every send.
  appPreview: string | null;
  // Screenshot chip (lila): shown by default; user dismisses it to send
  // the next submit without vision context. Reset per AI-mode session.
  screenshotIncluded?: boolean;
  onDismissScreenshot?: () => void;
  onToggleScreenshot?: () => void;
  // Clipboard chip (accent): opt-in via toggle button left of the mic.
  // Replaces the always-on polling with explicit user intent so unrelated
  // queries don't leak whatever happens to be in the clipboard.
  clipboardIncluded?: boolean;
  onToggleClipboard?: () => void;
  // Dynamic-pill inertia: live cursor position in display-local px.
  // The box drifts gently toward the cursor with a spring (max ±18px from
  // its anchor), so it "looks at" the user without leaving its open
  // location. Cursor-following lives here, on the OPEN response pill. The
  // cursor position is read directly from the cursor store — no props, so
  // pointer moves never re-render App (which re-renders this whole subtree).
  // True when the user is holding the trigger key to draw a screenshot
  // rectangle. The pill collapses to a small pulsing indicator next to
  // the cursor — desktopCapturer would otherwise include the entire pill
  // in the resulting screenshot. When selectionMode flips back to false
  // the pill unfolds again at its current position.
  selectionMode?: boolean;
  onApprove: (id: string, approved: boolean) => void;
  onDismissClipboard: () => void;
  onSubmit: (text: string, options?: { web?: boolean; templateId?: TemplateId }) => void;
  onCommand: (id: CommandId, args: string) => void;
  onCancel: () => void;
  // ✕ while the AI is answering: stop the stream but leave the box open with
  // the partial answer (contrast with onCancel, which also hides the box).
  onStopStream?: () => void;
  // Replay annotations: re-fly the on-screen annotation tour from the start.
  // Moved out of the overlay's bottom bar into the answer's action row.
  hasAnnotations?: boolean;
  onReplayAnnotations?: () => void;
  // Replay one PAST turn's boxes/arrows onto the screen.
  onReplayTurnAnnotations?: (turn: ConversationTurn) => void;
  // /test seed picker: seed a fake-transcript UI test straight from the
  // /-style dropdown (no LLM call, nothing saved or sent).
  onPickSeedTest?: (id: string) => void;
  onClearSeedTurns?: () => void;
  // Action suggestion chips: generated TEXT-ONLY
  // by main from the OCR'd region + on-screen selection + foreground app/tab.
  // Tapping one submits its label immediately — or its hidden `prompt` when
  // the chip carries one. `suggestionsPending` shows the shimmer while main
  // generates the first result. `chipVisibility` filters the display by the
  // box's current phase (voice capsule vs typing row) — the user's setting.
  chipVisibility?: ChipVisibility;
  suggestionChips?: SuggestionChip[];
  onRunSuggestion?: (chip: SuggestionChip) => void;
  // Self-knowledge line (Hermes-style memory notice): quiet one-liner at the
  // box bottom when the agent learns something durable ("Saved 2 memories",
  // "Noted your name"). Parent auto-clears it after a few seconds.
  learnedLine?: { text: string; kind?: string } | null;
  // True while main is generating the box-open chips: drives the accent
  // underline sweep at the box's bottom edge.
  chipsPending?: boolean;
  // Post-response "next action" chips (same provider that answered), shown as
  // a horizontal scrollable row at the end of the box.
  nextChips?: SuggestionChip[];
  onRunNextChip?: (chip: SuggestionChip) => void;
  // Post-response web images ([IMAGE] subject lines fetched by main), shown as
  // a scrollable row at the top of the answer.
  webImages?: WebImage[];
  // Inline AI-generated UI ([UI]/[QUESTIONS]/[MERMAID] blocks) interleaved at
  // their exact positions in the final answer. Empty = plain markdown answer.
  uiSegments?: UiSegment[];
  // Live placeholder state while a [UI]/[QUESTIONS]/[MERMAID] block streams
  // (its raw JSON is masked out of `response` on the main side). Shown as a
  // titled tile until the authoritative final answer replaces the stream.
  uiLive?: UiLiveBlock | null;
  // Generated-UI button actions: 'send' submits the (interpolated) prompt as a
  // follow-up continuing the session; 'copy' writes visible text to the
  // clipboard — explicit user tap only.
  onUiSubmit?: (prompt: string) => void;
  onUiCopy?: (text: string) => void;
  onTtsActiveChange?: (active: boolean) => void;
};

export const PromptInput = forwardRef<HTMLDivElement, Props>(function PromptInput(
  {
    x,
    y,
    loading,
    streaming,
    response,
    error,
    interrupted = null,
    onContinue,
    onRetry,
    webOnDefault,
    audioMode,
    lastPrompt,
    lastWasWeb,
    activities,
    approvals,
    reasoning,
    elapsedSecs = null,
    clipboardPreview,
    clipboardLength,
    selectionPreview,
    selectionLength,
    onDismissSelection,
    appPreview,
    selectionMode = false,
    screenshotIncluded = true,
    onDismissScreenshot,
    onToggleScreenshot,
    clipboardIncluded = false,
    onToggleClipboard,
    onApprove,
    onDismissClipboard,
    onSubmit,
    onCommand,
onCancel,
    onStopStream,
    conversationTurns = [],
    committedTurnId = null,
    hasAnnotations = false,
    onReplayAnnotations,
    onReplayTurnAnnotations,
    onPickSeedTest,
    onClearSeedTurns,
    chipVisibility = 'both',
    suggestionChips = [],
    onRunSuggestion,
    chipsPending = false,
    learnedLine = null,
    nextChips = [],
    onRunNextChip,
    webImages = [],
    uiSegments = [],
    uiLive = null,
    onUiSubmit,
    onUiCopy,
    onTtsActiveChange,
  },
  forwardedRef,
) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { t } = useTranslation();
  // Unique id for the loader's SVG mask (a hardcoded #clipping id would
  // collide across overlay windows; a per-instance id keeps them from
  // resolving the same mask).
  const loaderMaskId = `spirit-loader-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [value, setValue] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  // Dropped-file attach: files dragged onto the box, read by main. Mirrors
  // main's pendingAttached via files:attached broadcasts; cleared on dismiss
  // or session end (main clears too).
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  useEffect(() => {
    return window.spirit.onAttachedFiles((files) => setAttachedFiles(files ?? []));
  }, []);
  const [inserted, setInserted] = useState(false);
  // Voice-first shrink-to-tiny: in audio mode the capsule collapses to the
  // phase pill unless the user is recording (live text) or expands it by
  // clicking the pill — textOpen is that expansion.
  const [textOpen, setTextOpen] = useState(false);
  // '+' tools popover (Clipboard opt-in currently lives there).
  const [toolsOpen, setToolsOpen] = useState(false);
// Expanded input editor: the textarea grows to a tall fixed box (capped at
// INPUT_MAX_EXPANDED) with a dedicated scrollbar; the below suggestion chips
// move to the right rail like in result mode.
const [inputExpanded, setInputExpanded] = useState(false);
// True once the prompt content fills the auto-grow ceiling (~4-5 lines) so
// the textarea actually scrolls. The expand button only appears then (the
// input always starts small and grows as the user types).
const [atTwoLines, setAtTwoLines] = useState(false);
const [atInputMax, setAtInputMax] = useState(false);
  // The '+' menu shows whenever there's an opt-in tool behind it: the
  // Clipboard toggle and, once moved in there, the per-query Screenshot
  // re-attach (visible while the screenshot chip is dismissed).
  const toolsAvailable = !!onToggleClipboard || !!onToggleScreenshot;
  // The action row below Send appears once the prompt reaches ~2-3 lines
  // (the '+' drops out of the main row so the textarea keeps the width);
  // the expand icon only joins it once the auto-grow cap is actually hit
  // (scrollbar appears, ~4-5 lines). Never shown while the prompt is empty.
  const showSecondRow =
    value.trim() !== '' && (atTwoLines || atInputMax || inputExpanded);
  const toolsRef = useRef<HTMLDivElement>(null);
  const voice = useVoiceInput();
  const tts = useTTS();
  const ttsActiveRef = useRef(tts.state === 'playing' || tts.state === 'paused' || tts.state === 'loading');
  useEffect(() => {
    const active = tts.state === 'playing' || tts.state === 'paused' || tts.state === 'loading';
    if (active !== ttsActiveRef.current) {
      ttsActiveRef.current = active;
      onTtsActiveChange?.(active);
    }
  }, [tts.state, onTtsActiveChange]);
  const dragControls = useDragControls();

  // Conversation loop state. Tracks where we are in the audio-mode cycle so
  // we don't double-arm the mic or speak twice. A single ref also lets us
  // gate the "voice transcript arrives → auto-submit" callback on whether
  // we still want it (the user can ESC out mid-cycle).
  const audioActiveRef = useRef(audioMode);
  useEffect(() => {
    audioActiveRef.current = audioMode;
  }, [audioMode]);
  // Snapshot of streaming so we can detect the streaming=true → streaming=false
  // transition (= LLM finished this turn).
  const prevStreamingRef = useRef(false);
  // Once we've spoken a given response we mark it consumed so re-renders don't
  // restart TTS for the same text.
  const spokenResponseRef = useRef<string>('');
  // Once we've spoken THIS turn we want to re-arm the mic exactly once after
  // playback ends; this ref tracks that promise so we don't loop on idle.
  const armNextRef = useRef(false);

  // On macOS the overlay window can be visually on top but not the system
  // "key window" yet at the moment React mounts the input — a single
  // setTimeout focus call then silently fails and the user lands in the box
  // with no caret. We retry at staggered intervals so AT LEAST ONE of them
  // lands after the window has become the key window. Cancelled if the user
  // clicks somewhere else before focus actually takes (focus() on an already
  // focused input is a no-op). window.focus() is included so the whole box is
  // pulled to the foreground for typing on Windows, where a transparent
  // always-on-top overlay sometimes needs a nudge before DOM focus sticks.
  useEffect(() => {
    const timers: number[] = [];
    const tryFocus = () => {
      window.focus();
      inputRef.current?.focus();
    };
    for (const delay of [30, 100, 220, 400, 700]) {
      timers.push(window.setTimeout(tryFocus, delay));
    }
    // Also focus when the window itself gains focus — covers the case where
    // macOS hands us key-window status later than 700ms (slow display wake).
    const onWindowFocus = () => tryFocus();
    window.addEventListener('focus', onWindowFocus);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  // Auto-grow the textarea to fit its content (live voice transcript,
  // Shift+Enter line breaks). Native `field-sizing: content` (Chromium)
  // resolves the intrinsic height at every layout — including during the box's
  // unfold animation — clamped by min/max-height, so the input always starts
  // small (single line) and only grows as the user types, then scrolls once
  // the cap is hit. `atInputMax` tracks when the cap is actually reached so
  // the expand button only appears once the ~4-5 lines are filled.
  //
  // Hysteresis: once a stage is reached it latches until the content is
  // clearly below its threshold again (a line of slack), so appearing the
  // second row (which widens the textarea as the '+' leaves the main row)
  // can't flip the stage back off and start a resize/flicker loop.
  // `atTwoLines` ≈ 2-3 lines typed (the '+' drops below Send); `atInputMax`
  // is strict — true ONLY while the scrollbar is actually present (content
  // exceeds the auto-grow cap, ~4-5 lines). The expand icon shows only then;
  // deleting back under the cap hides it again (unless the editor is already
  // expanded).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const update = () => {
      const s = el.scrollHeight;
      const h = el.clientHeight;
      setAtTwoLines((prev) => (h > 46 ? true : prev ? h >= 30 : false));
      setAtInputMax(s > h + 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, inputExpanded]);

  // Never linger in the tall expanded editor once the text is gone — the
  // action row below Send and the 320px editor must not stay over an empty
  // prompt. Back to the minimal single-row state.
  useEffect(() => {
    if (!value.trim() && inputExpanded) setInputExpanded(false);
  }, [value, inputExpanded]);

  // Focus the textarea when the voice-first pill expands to the full row.
  useEffect(() => {
    if (textOpen) inputRef.current?.focus();
  }, [textOpen]);

  // Close the '+' tools popover on any outside click. (A plain fixed
  // backdrop can't be used: the pill lives inside a transformed element,
  // which would confine a fixed child to the box instead of the viewport.)
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = toolsRef.current;
      if (el && !el.contains(e.target as Node)) setToolsOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [toolsOpen]);

  // A successful drag-rectangle screenshot has just been written into the
  // pending-screenshot slot. The user's mouse was busy drawing the rect, so
  // the input lost focus. Pull it back so the next keystroke immediately
  // lands in the prompt and they don't have to mouse over to it.
  useEffect(() => {
    return window.spirit.onSelectionDone((result) => {
      if (result.ok) {
        // A small delay lets the toast / feedback render first, then we steal
        // focus back. Without the delay the focus call sometimes lands before
        // the pointer-capture release in App.tsx, and macOS ignores it.
        window.setTimeout(() => inputRef.current?.focus(), 40);
      }
    });
  }, []);

  const completions = useMemo(() => matchCommands(value), [value]);

  // /test seed picker: behaves exactly like the / command list — live
  // dropdown while typing, arrows + Enter/click to seed instantly.
  // NOTE: showTestList reads `busy`, declared further below — the derived
  // consts live next to showExpanded for that reason.
  const testArgs = useMemo(() => {
    const m = /^\/test(?:\s+(.*))?$/i.exec(value.trim());
    return m ? (m[1] ?? '').trim().toLowerCase() : null;
  }, [value]);
  const [testHighlight, setTestHighlight] = useState(0);

  // Suppressed while the test list owns the input (declared below with
  // `busy`); the test dropdown renders in place of command completions.
  const suppressCompletions = testArgs !== null;

  useEffect(() => {
    if (highlight >= completions.length) setHighlight(0);
  }, [completions, highlight]);

  const showCompletions = completions.length > 0 && !suppressCompletions;

  // Keep the highlighted item scrolled into view inside the dropdown.
  const listRef = useRef<HTMLUListElement>(null);
  const testListRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[highlight] as HTMLElement | undefined;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  useEffect(() => {
    const list = testListRef.current;
    if (!list) return;
    const item = list.children[testHighlight] as HTMLElement | undefined;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [testHighlight]);

  // A pure-UI answer (only a [UI]/[QUESTIONS]/[MERMAID] block, no markdown)
  // has empty `response` but still counts as a finished answer to render.
  // Committed earlier turns count too — the box shows the conversation.
  const hasCurrentResponse = response.length > 0 || uiSegments.length > 0;
  const previousTurns = committedTurnId
    ? conversationTurns.filter((turn) => turn.id !== committedTurnId)
    : conversationTurns;
  const hasResponse = hasCurrentResponse || conversationTurns.length > 0;

  // Past-question rail: always on when turns exist, ticks on the left
  // boundary, answers seamless in flow below.
  const turnRefs = useRef(new Map<string, HTMLElement>());
  // Selected past question: ONLY its answer shows. Rail clicks select +
  // scroll to it. A new submit folds back to thinking (busy hides past).
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(null);
  const prefersReducedMotion = useReducedMotion();

  // Answer auto-scroll pinning refs (effects live below, after `busy` —
  // they read it and consts must precede use).
  const answerScrollWrapperRef = useRef<HTMLDivElement>(null);
  const answerViewportRef = useRef<HTMLElement | null>(null);
  const answerContentRef = useRef<HTMLDivElement>(null);
  const stickToAnswerBottomRef = useRef(true);
  // The right-side chip rail is shown in result mode AND while the input is
  // expanded (chips shift to the right rail like the result one). Drives the
  // box width, the row/column layout and the rail wrapper.
  const railLayout = hasResponse || inputExpanded;
  const busy = loading || streaming;
  // Past visible only when idle: a new prompt collapses the overlay into
  // thinking (rail + old answers hide until the run settles).
  const showPast = !busy && previousTurns.length > 0;
  // Grown mode: chevron expanded the box + question list menu.
  const [pastGrown, setPastGrown] = useState(false);
  // Rail overflow: ticks don't fit the answer height → chevron instead.
  const [railOverflow, setRailOverflow] = useState(false);
  useEffect(() => {
    if (!showPast) {
      setRailOverflow(false);
      return;
    }
    // Measure the rail's real parent (the top-0 bottom-0 wrapper), not the
    // scroll viewport whose cap/maxHeight can read stale. Row math matches
    // TurnScrubber list chrome: 12px rows + 8px vertical padding.
    const wrapper = answerScrollWrapperRef.current;
    const viewport = answerViewportRef.current;
    const check = () => {
      const needed = previousTurns.length * 12 + 8;
      const avail = wrapper?.clientHeight ?? viewport?.clientHeight ?? 0;
      setRailOverflow(avail > 0 && needed > avail);
    };
    check();
    const ro = new ResizeObserver(check);
    if (wrapper) ro.observe(wrapper);
    if (viewport) ro.observe(viewport);
    return () => ro.disconnect();
  }, [showPast, previousTurns.length, pastGrown]);
  const showTestList = !busy && testArgs !== null;
  const testOptions = useMemo(() => {
    if (!showTestList) return [];
    if (!testArgs) return SEED_TESTS;
    return SEED_TESTS.filter(
      (t) =>
        t.id.includes(testArgs) ||
        t.label.toLowerCase().includes(testArgs),
    );
  }, [showTestList, testArgs]);

  useEffect(() => {
    if (testHighlight >= testOptions.length) setTestHighlight(0);
  }, [testOptions, testHighlight]);

  const showExpanded =
    busy ||
    hasResponse ||
    error !== null ||
    activities.length > 0 ||
    approvals.length > 0 ||
    showTestList;
  const showAnswerScroll = busy || error !== null || hasResponse;

  // Answer auto-scroll pinning: new turns/streaming content pin the scroll
  // to the bottom unless the user scrolled up (64px stickiness), so
  // follow-ups don't yank the reading position.
  useEffect(() => {
    if (!showAnswerScroll) {
      answerViewportRef.current = null;
      stickToAnswerBottomRef.current = true;
      return;
    }
    const viewport = answerScrollWrapperRef.current?.querySelector<HTMLElement>('.overflow-y-auto');
    const content = answerContentRef.current;
    if (!(viewport instanceof HTMLElement) || !content) return;
    answerViewportRef.current = viewport;
    const pinToBottom = () => {
      if (!stickToAnswerBottomRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    };
    const observer = new ResizeObserver(pinToBottom);
    const updateStickiness = () => {
      stickToAnswerBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 64;
      if (stickToAnswerBottomRef.current) observer.observe(content);
      else observer.disconnect();
    };
    viewport.addEventListener('scroll', updateStickiness, { passive: true });
    updateStickiness();
    pinToBottom();
    return () => {
      viewport.removeEventListener('scroll', updateStickiness);
      observer.disconnect();
      if (answerViewportRef.current === viewport) answerViewportRef.current = null;
    };
  }, [showAnswerScroll, hasResponse, error]);

  useEffect(() => {
    if (!stickToAnswerBottomRef.current) return;
    const viewport = answerViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [conversationTurns, committedTurnId, response, uiSegments, uiLive, streaming, loading, webImages.length]);

  // New submit folds every past answer back to thinking.
  const wasBusyRef = useRef(busy);
  useEffect(() => {
    if (busy && !wasBusyRef.current) {
      setExpandedTurnId(null);
      setPastGrown(false);
    }
    wasBusyRef.current = busy;
  }, [busy]);

  const chapters: TurnChapter[] = [...previousTurns]
    .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    .map((turn) => ({
      id: turn.id,
      title: turn.prompt.length > 60 ? turn.prompt.slice(0, 60).trimEnd() + '…' : turn.prompt,
      description: snippetText(turn.response),
      meta: `Q${turn.n ?? 0}`,
    }));
  // Grown menu + rail share one Q-ordered list: newest always lands below.
  const orderedTurns = useMemo(
    () => [...previousTurns].sort((a, b) => (a.n ?? 0) - (b.n ?? 0)),
    [previousTurns],
  );

  const jumpToTurn = useCallback((chapter: TurnChapter) => {
    // Clicking the selected tick again goes back to the current answer.
    if (chapter.id === expandedTurnId) {
      setExpandedTurnId(null);
      return;
    }
    setExpandedTurnId(chapter.id);
    // The section mounts on this render — scroll after paint, then the
    // snap point catches the glide (smooth-as-snappy).
    window.setTimeout(() => {
      const viewport = answerViewportRef.current;
      const el = turnRefs.current.get(chapter.id);
      if (viewport && el) {
        viewport.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
      }
    }, 60);
  }, [expandedTurnId]);

  // Refocus the textarea the moment a turn settles (busy → false). The box can
  // reopen while a background answer is still streaming — the input is
  // disabled for the whole busy window, so the mount-time focus retries miss it
  // and the user has to click the input before typing the follow-up. The moment
  // the answer lands the caret must return on its own. A short delay lets the
  // busy→enabled DOM flip (and any window-activation settling) land first.
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (wasBusy && !busy) {
      const t = window.setTimeout(() => {
        window.focus();
        inputRef.current?.focus();
      }, 40);
      return () => window.clearTimeout(t);
    }
  }, [busy]);

  // A new LLM turn makes any in-flight Read/audio-mode playback stale — the
  // answer it is reading was just replaced (new submit, chip tap, follow-up).
  // Stop the moment busy goes false→true, which covers typed submits, voice
  // submits, and chip taps alike. Guarded to the transition so the settled
  // autofocus effect above is unaffected.
  const turnStartBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = turnStartBusyRef.current;
    turnStartBusyRef.current = busy;
    if (
      !wasBusy && busy &&
      (tts.state === 'playing' || tts.state === 'loading' || tts.state === 'paused')
    ) {
      console.log('[tts] new turn started; stopping stale playback');
      tts.stop();
    }
  }, [busy, tts]);

  // First-run local STT setup: faster-whisper downloads its model weights
  // (~460MB) on the very first voice use. While that's happening (phase
  // 'downloading' / 'installing') the capsule shows a tiny progress bar so
  // the user knows it's working instead of a frozen "Transcribing…".
  const sttSetup =
    voice.sttStatus && (voice.sttStatus.phase === 'downloading' || voice.sttStatus.phase === 'installing')
      ? voice.sttStatus
      : null;

  const { metas, reset: resetMetas } = useLinkMetas(response, !busy && !error && hasResponse);
  useEffect(() => {
    if (!hasResponse) resetMetas();
  }, [hasResponse, resetMetas]);

  const linkList = useMemo(() => Object.values(metas), [metas]);

  // While the response is being read aloud, swap the markdown answer for a
  // word-by-word reading view that highlights the currently-spoken word and
  // Convert :icon-name: shortcodes to emoji equivalents for clean clipboard paste.
  const ICON_TO_EMOJI: Record<string, string> = {
    check: '\u2705', x: '\u274c', 'circle-check': '\u2705', 'x-circle': '\u274c',
    search: '\uD83D\uDD0D', sparkles: '\u2728', star: '\u2B50', stars: '\u2728',
    bulb: '\uD83D\uDCA1', 'alert-triangle': '\u26A0\uFE0F', 'info-circle': '\u2139\uFE0F',
    mail: '\u2709\uFE0F', code: '\uD83D\uDCBB', terminal: '\uD83D\uDCBB',
    table: '\uD83D\uDCCA', link: '\uD83D\uDD17', calendar: '\uD83D\uDCC5',
    download: '\u2B07\uFE0F', upload: '\u2B06\uFE0F', export: '\u2B07\uFE0F',
    import: '\uD83D\uDCE5', share: '\uD83D\uDCE4', refresh: '\uD83D\uDD04',
    bookmark: '\uD83D\uDD16', edit: '\u270F\uFE0F', trash: '\uD83D\uDDD1\uFE0F',
    eye: '\uD83D\uDC41', clock: '\u23F0', settings: '\u2699\uFE0F',
    zap: '\u26A1', bolt: '\u26A1', power: '\u26A1', fast: '\u26A1',
    fire: '\uD83D\uDD25', flame: '\uD83D\uDD25', hot: '\uD83D\uDD25',
    heart: '\u2764\uFE0F', love: '\u2764\uFE0F', like: '\u2764\uFE0F',
    sun: '\u2600\uFE0F', moon: '\uD83C\uDF19', snowflake: '\u2744\uFE0F',
    cold: '\u2744\uFE0F', wind: '\uD83C\uDF2C\uFE0F', cloud: '\u2601\uFE0F',
    rain: '\uD83C\uDF27\uFE0F', snow: '\u2744\uFE0F', storm: '\u26C8\uFE0F',
    water: '\uD83D\uDCA7', drop: '\uD83D\uDCA7', rainbow: '\uD83C\uDF08',
    sunset: '\uD83C\uDF07', sunrise: '\uD83C\uDF05', light: '\u2600\uFE0F',
    dark: '\uD83C\uDF19', bell: '\uD83D\uDD14', notification: '\uD83D\uDD14',
    info: '\u2139\uFE0F', note: '\uD83D\uDCDD', tip: '\uD83D\uDCA1',
    warn: '\u26A0\uFE0F', warning: '\u26A0\uFE0F', danger: '\uD83D\uDEA8',
    error: '\u274C', success: '\u2705', done: '\u2705', complete: '\u2705',
    fail: '\u274C', failed: '\u274C', missing: '\u274C', found: '\u2705',
    create: '\uD83D\uDCDD', build: '\uD83D\uDD27', make: '\uD83D\uDD27',
    fix: '\uD83D\uDD27', repair: '\uD83D\uDD27', solve: '\u2705',
    explain: '\uD83D\uDCD6', teach: '\uD83C\uDF93', learn: '\uD83D\uDCDA',
    study: '\uD83D\uDCD6', research: '\uD83D\uDD0D', explore: '\uD83C\uDF0D',
    discover: '\uD83C\uDF0D', design: '\uD83C\uDFA8', draw: '\u270F\uFE0F',
    write: '\u270F\uFE0F', read: '\uD83D\uDCD6', listen: '\uD83C\uDFB5',
    watch: '\uD83D\uDCFA', think: '\uD83E\uDDE0', consider: '\uD83E\uDDE0',
    remember: '\uD83D\uDD16', forget: '\u274C', understand: '\uD83D\uDCA1',
    know: '\u2705', believe: '\u2705', doubt: '\u2753', wonder: '\u2753',
    plan: '\uD83D\uDCCB', organize: '\uD83D\uDCCB', manage: '\u2699\uFE0F',
    sort: '\uD83D\uDD03', filter: '\uD83D\uDD0E',
    compare: '\uD83D\uDCCA', analyze: '\uD83D\uDCCA', chart: '\uD83D\uDCCA',
    graph: '\uD83D\uDCCA', data: '\uD83D\uDCCA', track: '\uD83D\uDCC2',
    monitor: '\uD83D\uDCFA', observe: '\uD83D\uDC41', measure: '\uD83D\uDCCF',
    test: '\uD83E\uDDEA', verify: '\u2705', validate: '\u2705',
    approve: '\u2705', reject: '\u274C', accept: '\u2705',
    confirm: '\u2705', deny: '\u274C', yes: '\u2705', no: '\u274C',
    maybe: '\u2753', true: '\u2705', false: '\u274C', correct: '\u2705',
    wrong: '\u274C', right: '\u2705', good: '\u2705', bad: '\u274C',
    great: '\u2B50', excellent: '\u2B50', perfect: '\u2728',
    amazing: '\u2728', awesome: '\u2728', nice: '\u2705',
    important: '\u2B50', critical: '\u26A0\uFE0F', urgent: '\uD83D\uDEA8',
    priority: '\u2B50', best: '\u2B50', top: '\u2B50',
    slow: '\u23F3', quick: '\u26A1', instant: '\u26A1', speed: '\u26A1',
    strength: '\uD83D\uDCAA', weak: '\uD83D\uDC94', strong: '\uD83D\uDCAA',
    easy: '\u2705', simple: '\u2705', complex: '\uD83E\uDDE9',
    difficult: '\uD83E\uDDE9', hard: '\uD83E\uDDE9',
    save: '\uD83D\uDCBE', load: '\uD83D\uDCC2', backup: '\uD83D\uDCBE',
    restore: '\uD83D\uDD04', sync: '\uD83D\uDD04', update: '\uD83D\uDD04',
    upgrade: '\u2B06\uFE0F', downgrade: '\u2B07\uFE0F',
    install: '\uD83D\uDCE6', uninstall: '\uD83D\uDDD1\uFE0F',
    start: '\u25B6\uFE0F', stop: '\u23F9\uFE0F', pause: '\u23F8\uFE0F',
    resume: '\u25B6\uFE0F', restart: '\uD83D\uDD04', reset: '\uD83D\uDD04',
    undo: '\u21A9\uFE0F', redo: '\u21AA\uFE0F',
    copy: '\uD83D\uDCCB', paste: '\uD83D\uDCCB', cut: '\u2702\uFE0F',
    delete: '\uD83D\uDDD1\uFE0F', remove: '\u274C', clear: '\uD83E\uDDF9',
    clean: '\uD83E\uDDF9', dry: '\u2600\uFE0F', wet: '\uD83D\uDCA7',
    warm: '\u2600\uFE0F', cool: '\u2744\uFE0F',
    book: '\uD83D\uDCD5', page: '\uD83D\uDCC4', file: '\uD83D\uDCC4',
    folder: '\uD83D\uDCC1', document: '\uD83D\uDCC4', text: '\uD83D\uDCDD',
    image: '\uD83D\uDDBC\uFE0F', photo: '\uD83D\uDCF7', video: '\uD83D\uDCF9',
    audio: '\uD83C\uDFB5', music: '\uD83C\uDFB5', song: '\uD83C\uDFB5',
    memo: '\uD83D\uDCDD', report: '\uD83D\uDCCA',
    url: '\uD83D\uDD17', website: '\uD83C\uDF10', web: '\uD83C\uDF10',
    globe: '\uD83C\uDF0D', world: '\uD83C\uDF0D', internet: '\uD83C\uDF10',
    email: '\u2709\uFE0F', message: '\uD83D\uDCE8', chat: '\uD83D\uDCAC',
    call: '\uD83D\uDCDE', phone: '\uD83D\uDCDE', contact: '\uD83D\uDC64',
    user: '\uD83D\uDC64', person: '\uD83D\uDC64', people: '\uD83D\uDC65',
    team: '\uD83D\uDC65', group: '\uD83D\uDC65', friend: '\uD83D\uDC6B',
    home: '\uD83C\uDFE0', house: '\uD83C\uDFE0', building: '\uD83C\uDFE2',
    office: '\uD83C\uDFE2', school: '\uD83C\uDFEB', hospital: '\uD83C\uDFE5',
    bank: '\uD83C\uDFE6', store: '\uD83C\uDFEA', shop: '\uD83C\uDFEA',
    restaurant: '\uD83C\uDF7D\uFE0F', food: '\uD83C\uDF5D', drink: '\uD83C\uDF75',
    coffee: '\u2615', tea: '\uD83C\uDF75', cake: '\uD83C\uDF82',
    cookie: '\uD83C\uDF6A', candy: '\uD83C\uDF6D', pizza: '\uD83C\uDF55',
    burger: '\uD83C\uDF54', car: '\uD83D\uDE97', bus: '\uD83D\uDE8C',
    train: '\uD83D\uDE86', plane: '\u2708\uFE0F', boat: '\u26F5',
    bike: '\uD83D\uDEB2', walk: '\uD83D\uDEB6', run: '\uD83C\uDFC3',
    swim: '\uD83C\uDFCA', fly: '\uD83D\uDE82', drive: '\uD83D\uDE97',
    travel: '\u2708\uFE0F', trip: '\uD83C\uDFD4\uFE0F', vacation: '\uD83C\uDF34',
    beach: '\uD83C\uDFD6\uFE0F', mountain: '\u26F0\uFE0F', forest: '\uD83C\uDF32',
    tree: '\uD83C\uDF33', flower: '\uD83C\uDF3B', plant: '\uD83C\uDF31',
    garden: '\uD83C\uDF3B', park: '\uD83C\uDFDE\uFE0F',
    animal: '\uD83D\uDC3E', dog: '\uD83D\uDC36', cat: '\uD83D\uDC31',
    bird: '\uD83D\uDC26', fish: '\uD83D\uDC1F', horse: '\uD83D\uDC34',
    bug: '\uD83D\uDC1B', shield: '\uD83D\uDEE1\uFE0F',
    'shield-check': '\uD83D\uDEE1\uFE0F', lock: '\uD83D\uDD12',
    'lock-open': '\uD83D\uDD13', key: '\uD83D\uDD11', secure: '\uD83D\uDD12',
    'arrow-right': '\u27A1\uFE0F', 'arrow-left': '\u2B05\uFE0F',
    play: '\u25B6\uFE0F', server: '\uD83D\uDDA5\uFE0F',
    map: '\uD83D\uDDFA\uFE0F', compass: '\uD83E\uDDED',
    rocket: '\uD83D\uDE80', gem: '\uD83D\uDC8E', trophy: '\uD83C\uDFC6',
    medal: '\uD83C\uDFC5', crown: '\uD83D\uDC51', flag: '\uD83D\uDEA9',
    tag: '\uD83C\uDFF7\uFE0F', scissors: '\u2702\uFE0F',
    printer: '\uD83D\uDDA8\uFE0F', clipboard: '\uD83D\uDCCB',
    anchor: '\u2693', gift: '\uD83C\uDF81', party: '\uD83C\uDF89',
  };
  const clipboardText = (t: string) =>
    t.replace(/:([a-z][a-z0-9_-]*):/g, (_m, name: string) => ICON_TO_EMOJI[name] ?? `:${name}:`);

  const copy = async () => {
    if (!response) return;
    try {
      await navigator.clipboard.writeText(clipboardText(response));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const save = async () => {
    if (!response || saving) return;
    setSaving(true);
    setSavedPath(null);
    try {
      const result = await ipc.saveResponse({
        prompt: lastPrompt || 'Spirit response',
        markdown: response,
        web: lastWasWeb,
        images: webImages,
      });
      if (result.ok) {
        setSavedPath(result.path);
        window.setTimeout(() => setSavedPath(null), 2500);
      }
    } finally {
      setSaving(false);
    }
  };

  const insertCompletion = (cmd: Command) => {
    setValue(cmd.name + (cmd.argsHint ? ' ' : ''));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const executeCommandImmediate = (cmd: Command) => {
    if (cmd.argsHint) {
      insertCompletion(cmd);
      return;
    }
    onCommand(cmd.id, '');
    setValue('');
    setTextOpen(false);
  };

  // Seed a UI test straight into the transcript: closes the list, clears
  // the input, answers appear with rail + snap ready.
  const seedTest = (id: string) => {
    onPickSeedTest?.(id);
    setValue('');
    setTextOpen(false);
    setTestHighlight(0);
  };

  // PROMPT HISTORY (ArrowUp / ArrowDown)
  // indexRef -1 = not navigating (shows the live draft); 0 = newest prompt;
  // higher = older prompts. The draft (what was typed before starting to
  // browse) is kept so ArrowDown returns to it instead of overwriting.
  const promptHistoryIdxRef = useRef(-1);
  const promptHistoryDraftRef = useRef('');

  const pushPromptHistory = (text: string) => {
    const t = text.trim();
    if (!t) return;
    if (promptHistoryStore[0] === t) return; // skip consecutive duplicates
    promptHistoryStore.unshift(t);
    if (promptHistoryStore.length > MAX_PROMPT_HISTORY) {
      promptHistoryStore.length = MAX_PROMPT_HISTORY;
    }
    promptHistoryIdxRef.current = -1;
  };

  const stepPromptHistory = (dir: 1 | -1) => {
    const len = promptHistoryStore.length;
    if (len === 0) return;
    const current = promptHistoryIdxRef.current;
    // ArrowUp walks backward into older prompts; ArrowDown returns toward the
    // newest and finally back to the live draft — it must CLAMP at -1 (the
    // draft), never go below, or promptHistoryStore[-2] reads undefined and
    // feeding setValue(undefined) into the controlled textarea crashes the
    // overlay.
    const next =
      dir === -1
        ? current === -1
          ? 0
          : Math.min(current + 1, len - 1)
        : Math.max(-1, current - 1);
    if (next === current) return;
    if (current === -1) promptHistoryDraftRef.current = value;
    const recall = next === -1 ? promptHistoryDraftRef.current : promptHistoryStore[next];
    if (typeof recall !== 'string') return;
    promptHistoryIdxRef.current = next;
    setValue(recall);
    // Put the caret at the end of the recalled prompt.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
    });
  };

  const handleEnter = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    pushPromptHistory(trimmed);
    // Voice-first: a typed submit ends the expanded input row so the
    // capsule collapses back to its small pill height for the next turn
    // instead of staying stuck at the tall expanded size.
    setTextOpen(false);
    const parsed = parseCommand(trimmed);
    if (parsed) {
      const { command, args } = parsed;
      if (command.id === 'web') {
        const q = args.trim();
        if (!q) {
          setValue(command.name + ' ');
          return;
        }
        setValue('');
        onSubmit(q, { web: true });
        return;
      }
      if (isTemplateCommand(command.id)) {
        const q = args.trim();
        if (!q) {
          setValue(command.name + ' ');
          return;
        }
        setValue('');
        onSubmit(q, { templateId: command.id });
        return;
      }
      onCommand(command.id, args);
      setValue('');
      return;
    }
    setValue('');
    if (audioActiveRef.current) {
      cancelVoiceFeedback();
      void speakAcknowledge();
    }
    onSubmit(trimmed, { web: webOnDefault });
  };

  // Use a ref so the auto-start effect doesn't have to depend on `value`,
  // `webOnDefault`, etc. — otherwise it would re-fire on every keystroke.
  const submitRef = useRef(onSubmit);
  useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);
  const webOnDefaultRef = useRef(webOnDefault);
  useEffect(() => {
    webOnDefaultRef.current = webOnDefault;
  }, [webOnDefault]);

  // Manual voice toggle (microphone icon in the prompt). In audio mode the
  // transcript is submitted automatically; in keyboard mode it fills the
  // input for review — the user decides when to press Enter.
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      const text = transcript.trim();
      if (!text) return;
      const lang = effectiveVoiceLang(undefined);
      // Stop-word interrupt: when the user is in audio-mode and
      // says "stop" / "halt" / "be quiet" / etc., halt the loop instead
      // of treating it as a query. Without this gate the transcript
      // would auto-submit, the LLM would answer "stop", TTS would speak,
      // and the loop would re-arm — trapping the user.
      if (audioActiveRef.current && isStopUtterance(text, lang)) {
        if (tts.state === 'playing' || tts.state === 'loading') tts.stop();
        voice.stop();
        armNextRef.current = false;
        setValue('');
        return;
      }
      // Pre-LLM slash-command routing for short phrases ("settings",
      // "search the web for cats", etc).
      const hit = matchVoiceCommand(text, lang);
      if (hit) {
        onCommand(hit.commandId, hit.args);
        return;
      }
      // Keyboard mode: drop the final transcript into the box, put the
      // caret at the end, and wait for Enter. The live partial already
      // occupies `value`, so replace (not append) it with the final pass.
      if (!audioActiveRef.current) {
        setValue(text);
        setTextOpen(true);
        window.setTimeout(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          const end = el.value.length;
          try {
            el.setSelectionRange(end, end);
          } catch {
            /* some browsers reject selection on hidden inputs */
          }
        }, 0);
        return;
      }
      // Voice-first loop keeps auto-submit; the TTS-then-re-arm cycle is
      // driven by the audioMode flag in the phase-3 effect.
      setValue('');
      setTextOpen(false);
      pushPromptHistory(text);
      cancelVoiceFeedback();
      void speakAcknowledge();
      submitRef.current(text, { web: webOnDefaultRef.current });
    },
    [onCommand, tts, voice],
  );

  // Live pseudo-transcription: while the user is still talking, slice-by-
  // slice transcript text lands here and fills the input field so they can
  // watch their words appear. The authoritative, full-length transcription
  // replaces it at stop via handleVoiceTranscript.
  const handleVoiceLive = useCallback((text: string) => {
    setValue(text);
  }, []);

  // Helper: arm the mic, but first stop any TTS that's currently playing or
  // loading. Without this guard, if the user pressed the mic button while
  // Spirit was speaking, the TTS would keep playing on top of the new
  // recording (and any in-flight TTS IPC would resume playback after the
  // user thought they stopped it — fixed in useTTS via speakId token).
  const armVoice = useCallback(() => {
    if (tts.state === 'playing' || tts.state === 'loading') {
      tts.stop();
    }
    // If we're in the audio-mode loop, a manual mic press must reset the
    // "speak next response" arming so we don't auto-speak the prior turn.
    armNextRef.current = false;
    void voice.start(handleVoiceTranscript, handleVoiceLive);
  }, [tts, voice, handleVoiceTranscript, handleVoiceLive]);

  const toggleVoice = () => {
    if (voice.state === 'recording') {
      voice.stop();
    } else if (voice.state === 'idle' || voice.state === 'error') {
      armVoice();
    }
  };

  // AUDIO-MODE CONVERSATION LOOP
  // Phase 1: on mount, if audio mode is on, start the mic so the user can
  // speak immediately.
  useEffect(() => {
    if (!audioMode) return;
    primeVoiceFeedback();
    armVoice();
    return () => {
      voice.stop();
      tts.stop();
      armNextRef.current = false;
    };
    // We only want this to run once per box-mount. Future re-arms come from
    // the TTS-finish effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 2: when the LLM finishes streaming an answer, speak it aloud
  // (audio mode only). One TTS per response — guarded by spokenResponseRef.
  useEffect(() => {
    if (error) {
      cancelVoiceFeedback();
      return;
    }
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    if (!audioMode) return;
    if (!wasStreaming || streaming) return;
    if (!response || response === spokenResponseRef.current) return;
    spokenResponseRef.current = response;
    armNextRef.current = true;
    void tts.speak(response);
  }, [streaming, response, error, audioMode, tts]);

  // Phase 3: when TTS playback finishes, re-open the mic for the user's next
  // turn. Only re-arm once per response (armNextRef), and only if the box is
  // still open and we're still in audio mode.
  //
  // CRITICAL: the prev-state must be updated BEFORE the gate check, not
  // after — otherwise a re-render that doesn't change tts.state still
  // resets the ref and a future state change is missed. The voice-state
  // check is also tightened: only re-arm if voice is fully idle, never
  // mid-transition (recording or transcribing). Earlier code allowed
  // re-arm during 'error' which races with the prior recorder cleanup.
  const ttsPrevStateRef = useRef(tts.state);
  useEffect(() => {
    const prev = ttsPrevStateRef.current;
    ttsPrevStateRef.current = tts.state;
    if (!audioMode) return;
    if (!armNextRef.current) return;
    if (prev !== 'idle' && tts.state === 'idle') {
      armNextRef.current = false;
      // Only arm when the voice hook is fully settled. An 'error' state
      // is technically not 'recording' but the underlying MediaRecorder
      // and AudioContext may not be cleaned up yet — re-arming here
      // races against the cleanup in useVoiceInput and can produce
      // ghost-recorder state. Also don't re-arm while the user expanded
      // the capsule to type (textOpen) — they're typing, not talking.
      if (voice.state === 'idle' && !textOpen) {
        armVoice();
      }
    }
  }, [tts.state, audioMode, voice, armVoice, textOpen]);

  // DYNAMIC PILL: cursor-following + unfold-from-cursor entry
  //
  // The pill stays softly anchored next to the cursor with a slow spring.
  // Earlier iterations stored a static offset = (anchor - cursor) at
  // mount and added it to live cursor every frame. That worked when the
  // user triggered Spirit near the middle of the screen, but triggering
  // near the bottom edge opens the box with the cursor near bottom-center,
  // which makes computeAnchor force the box upward to fit in the screen.
  // The captured offset was then huge-negative-Y, and as the cursor
  // later moved up the box flew off the top.
  //
  // The new approach: recompute the "near-cursor" target every cursor
  // tick. Logic mirrors computeAnchor — pill goes to the RIGHT of cursor
  // unless that overflows the right edge (then left), and pill-Y is
  // cursor-Y clamped inside the screen with padding for the pill's own
  // height. This keeps the pill consistently 28px next to the cursor
  // regardless of where the cursor opens or moves to.
  //
  // Drag handling: framer-motion's <motion.div drag> applies its own
  // x/y offsets on the inner element. To prevent the cursor-follow
  // from yanking the box back while the user is mid-drag, we PAUSE
  // updates to the spring target during drag. After drag end we resume
  // with the user's dragged position as the new natural resting point.
  // Earlier (without the pause) the user perceived the box "running
  // away" — they'd try to grab it and it would tug toward the cursor
  // path, making drag feel like chasing a fly.
  const [introDone, setIntroDone] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setIntroDone(true), 320);
    return () => window.clearTimeout(t);
  }, []);

  // Drag state: when true, the cursor-follow effect short-circuits and
  // doesn't update the spring target — the user owns the position.
  const isDraggingRef = useRef(false);
  const [, forceDragRender] = useState(0);
  // After drag ends we additionally suppress follow for ~600ms so the
  // spring doesn't immediately snap the box back to "next to cursor".
  // Gives the user time to release without the pill recoiling.
  const dragSuppressUntilRef = useRef(0);

  // PINNED (locked) mode. Dragging the handle to place the box pins it in
  // place: cursor-follow is switched off and the position survives hide/show
  // (see lastPlaced above), so reopening shows the box exactly where it was
  // left instead of snapping to the cursor. Clicking the handle toggles back
  // to follow mode. The handle turns blue while pinned.
  const [pinned, setPinned] = useState(() => lastPlaced.has && lastPlaced.pinned);
  // True only for a genuine drag (pointer moved), so a plain click on the
  // handle can toggle pinning without onDragEnd immediately re-pinning.
  const dragMovedRef = useRef(false);

  // When an LLM turn starts the box has just shrunk (chips unmount on a chip
  // tap, or Enter was pressed with the cursor near the input). Freeze the
  // cursor-follow for a brief settle window so the box doesn't yank toward
  // the cursor the instant the query begins; after that it resumes tracking
  // the cursor WHILE the answer streams in. Reset when the turn settles.
  const busySuppressUntilRef = useRef(0);
  useEffect(() => {
    if (busy) {
      if (busySuppressUntilRef.current === 0) {
        busySuppressUntilRef.current = Date.now() + 600;
      }
    } else {
      busySuppressUntilRef.current = 0;
    }
  }, [busy]);

  // Live-recompute the "near cursor" target instead of using a static
  // offset. CURSOR_GAP is the spec value from positioning.ts; we hard-
  // code it here (28) to avoid importing — saves a circular concern.
  // PILL_W is BOX_WIDTH; PILL_H is approximated by 80 (a tight upper
  // bound for the empty-state pill; the real height grows when content
  // streams in, but using 80 keeps the resting target predictable).
  const CURSOR_GAP = 28;
  // Mic-listening offset: just a few px under the cursor (see comment above).
  const RECORD_GAP = 8;
  const PILL_H_APPROX = 80;
  function computeFollowTarget(cx: number, cy: number, belowCursor: boolean): { x: number; y: number } {
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const PAD = 12;
    // Prefer right of cursor; flip to left if no room.
    const wouldOverflowRight = cx + CURSOR_GAP + BOX_WIDTH > screenW - PAD;
    const x = wouldOverflowRight
      ? Math.max(PAD, cx - CURSOR_GAP - BOX_WIDTH)
      : Math.min(screenW - BOX_WIDTH - PAD, cx + CURSOR_GAP);
    // Vertical. Mic-listening (recording) anchors the capsule just a few px
    // BELOW the cursor — low enough that it reads as "under the point" but
    // not pushed so far down that it crowds the thing the user is pointing
    // at. Every other state centers on the cursor (top at cy - half-height),
    // clamped inside the screen.
    const idealY = belowCursor ? cy + RECORD_GAP : cy - PILL_H_APPROX / 2;
    const y = Math.max(PAD, Math.min(screenH - PILL_H_APPROX - PAD, idealY));
    return { x, y };
  }

  // Start where the box was last pinned (if it was), otherwise at the fresh
  // cursor anchor `x`/`y` — that anchor is what made a reopened box snap to
  // the cursor and feel "offset" from where it was dragged to.
  const targetXMV = useMotionValue(pinned ? lastPlaced.x : x);
  const targetYMV = useMotionValue(pinned ? lastPlaced.y : y);
  // Drag transform of the INNER (draggable) element. The outer anchor stays at
  // followX/followY; framer writes the drag delta into these so that on drag
  // end we can fold the delta into the outer target and clear it here — else
  // the box lands at double-offset and "drifts" after release.
  const dragXMV = useMotionValue(0);
  const dragYMV = useMotionValue(0);
  // Calmer spring than the original tuning: damping 38 /
  // stiffness 70 / mass 1.0 gives a calm, perceptible lag — the pill
  // glides toward the cursor instead of darting. Earlier (stiffness 130)
  // it felt too eager AND made drag hard because the pill was always
  // moving while the user tried to grab it. Slower = more grabbable.
  const followX = useSpring(targetXMV, { damping: 38, stiffness: 70, mass: 1.0 });
  const followY = useSpring(targetYMV, { damping: 38, stiffness: 70, mass: 1.0 });
  const finalX = useTransform(followX, (v) => v);
  const finalY = useTransform(followY, (v) => v);

  // FREEZE-ON-HOVER: cursor-follow ONLY pauses when the cursor is
  // actually inside the box's bounds (plus a small halo). The earlier
  // distance-based zone (160px) was overly broad and made the box feel
  // "skittish" — user reported they couldn't click buttons inside the
  // pill because it kept gliding away while they reached for it.
  //
  // With bounds-based freeze:
  //   - Cursor anywhere outside the pill → box follows cursor softly.
  //   - Cursor enters the pill rect (with a small halo so the edge isn't
  //     a hair-trigger) → box freezes IMMEDIATELY → drag handle works,
  //     buttons (mic, copy, X, clipboard chip) all clickable.
  //   - Cursor leaves → box resumes follow with the soft spring.
  // Halo gives a generous "I'm clearly heading for the box" zone without
  // re-introducing the skittish chase the user disliked.
  const HOVER_HALO_PX = 8;
  // LIVE BOX HEIGHT for freeze bounds. PILL_H_APPROX is the COLLAPSED
  // height (~80px). After an LLM answer, the box can be 400-800px tall.
  // If we keep using the constant, the freeze check thinks the cursor
  // is "below" the box when it's actually on the answer area, so the
  // box keeps following the mouse and the user can't scroll/click.
  // ResizeObserver tracks the real height; fallback is PILL_H_APPROX
  // until the first measurement lands.
  const liveBoxHeightRef = useRef<number>(PILL_H_APPROX);
  const boxMeasureRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = boxMeasureRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) liveBoxHeightRef.current = h;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!introDone) return;
    // Pinned: the box is locked where the user placed it — never follow the
    // cursor, so it also stays put across hide/show.
    if (pinned) return;
    // Subscribe to the cursor store so pointer moves never re-render App.
    const follow = (cursorX: number, cursorY: number) => {
      if (isDraggingRef.current) return;
      if (Date.now() < dragSuppressUntilRef.current) return;
      // While the LLM is working the box follows the cursor, but only AFTER a
      // short settle window (see busySuppressUntilRef). On a chip tap the chips
      // unmount (busy), the box shrinks, and the cursor ends up just below the
      // new bounds — following the instant the query starts would yank the box
      // toward the cursor, which reads as lag/jitter. Once the box has settled
      // (~600ms) it resumes tracking the cursor while the answer streams in.
      if (busy && Date.now() < busySuppressUntilRef.current) return;
      const liveH = liveBoxHeightRef.current || PILL_H_APPROX;
      const left = followX.get() - HOVER_HALO_PX;
      const top = followY.get() - HOVER_HALO_PX;
      const right =
        followX.get() + BOX_WIDTH + (railLayout ? RAIL_RESERVE : 0) + HOVER_HALO_PX;
      const bottom = followY.get() + liveH + HOVER_HALO_PX;
      const insideBox =
        cursorX >= left && cursorX <= right &&
        cursorY >= top && cursorY <= bottom;
      if (insideBox) return; // cursor is over the box — freeze so user can interact
      const t = computeFollowTarget(cursorX, cursorY, voice.state === 'recording');
      targetXMV.set(t.x);
      targetYMV.set(t.y);
    };
    // Prime with the current position (the old effect ran once on mount).
    const cur = getCursorPos();
    if (cur) follow(cur.x, cur.y);
    return subscribeCursor((p) => {
      if (p) follow(p.x, p.y);
    });
  }, [introDone, pinned, railLayout, busy, hasResponse, targetXMV, targetYMV, followX, followY, voice.state]);

  // VOICE-FIRST CAPSULE WIDTH
  //
  // With audioMode ("start with listening") on, the box opens as a small
  // pill and grows as live transcript text types in. `tinyPill` hides the
  // input row behind the phase pill whenever there's no live text to show —
  // idle, transcribing, thinking/speaking — AND the very start of recording
  // before words land. The moment live text arrives the row unfolds and the
  // box widens with the text (floor ROW_MIN_WIDTH, capped at BOX_WIDTH);
  // height follows via the autosize textarea when lines exceed.
  const recording = voice.state === 'recording';
  const liveLen = value.trim().length;
  const ttsActive = tts.state === 'playing' || tts.state === 'paused' || tts.state === 'loading';
  // "AI is working": transcribing the utterance, the model thinking/streaming,
  // speaking the answer, or an answer already on screen. During these legs the
  // box uses the NORMAL width — the narrow capsule is reserved for the very
  // start (mic just armed, no words yet) and the idle listen pill.
  const aiWorking = voice.state === 'transcribing' || busy || ttsActive || hasResponse;
  const tinyPill = audioMode && !textOpen && !aiWorking && (!recording || liveLen === 0);
  let capsuleW = BOX_WIDTH;
  if (audioMode && !textOpen) {
    capsuleW = tinyPill
      ? PILL_WIDTH
      : recording && liveLen > 0
        ? Math.min(BOX_WIDTH, Math.max(ROW_MIN_WIDTH, PILL_WIDTH + liveLen * 7.2))
        : BOX_WIDTH;
  }

  // SUGGESTION CHIPS PHASE GATE
  // "Setting rules everything": chip visibility is a pure function of the
  // user's chipVisibility preference + which phase the box is in right now
  // (voice mic/speech capsule vs the typing row). No mic-first special-casing.
  const chipPhase: ChipPhase =
    recording || ttsActive || (audioMode && !textOpen) ? 'voice' : 'type';
  const chipsOn = shouldShowChips(chipVisibility, chipPhase);
  const visibleChips = chipsOn ? suggestionChips : [];
  const visibleNextChips = chipsOn ? nextChips : [];
  const visibleChipsPending = chipsOn && chipsPending;

  return (
    <motion.div
      // Entry: pre-position invisibly at the anchor (cursor location),
      // then fade in while the WIDTH unfolds left-to-right from 0 → full.
      // This mirrors the expand-into-label animation and
      // eliminates the "box flies in then tugs toward the cursor" jump:
      // when the user first SEES the box, it's already at the cursor and
      // simply unfurls outward. Drift toward live cursor only engages
      // after introDone (320ms timer).
      //
      // SELECTION MODE: when the user holds the trigger key to draw a
      // screenshot rectangle, the same width/opacity animation runs in
      // REVERSE — the pill folds in (width → 0) and fades out so it's
      // NOT included in the screenshot (desktopCapturer captures every
      // visible window including our overlay). When the user releases
      // selection mode, the pill unfolds again automatically.
      initial={{ opacity: 0, width: 0 }}
      animate={{
        opacity: selectionMode ? 0 : 1,
        width: selectionMode ? 0 : BOX_WIDTH,
      }}
      // FADE TIMING: fade-in 280ms / fade-out 220ms with smooth cubic
      // easing. The framer-motion default split: exit transition overrides
      // animate transition when AnimatePresence runs the exit phase, so we
      // give exit its own opacity duration. easeInOut for entry feels
      // organic; easeOut for exit feels crisp without being abrupt.
      exit={{
        opacity: 0,
        width: 0,
        transition: {
          opacity: { duration: 0.22, ease: [0.4, 0, 0.2, 1] },
          width: { duration: 0.22, ease: [0.4, 0, 0.2, 1] },
        },
      }}
      transition={{
        width: { type: 'spring', damping: 28, stiffness: 320, mass: 0.7 },
        opacity: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
      }}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        x: finalX,
        y: finalY,
        transformOrigin: '0% 50%',
        // CRITICAL: overflow MUST be hidden during the intro (so the
        // rounded chrome doesn't draw past the unfolding-from-left edge)
        // BUT must be visible afterwards — otherwise the user's drag
        // moves the inner element outside the outer's bounding box and
        // it gets CLIPPED INVISIBLE. That's exactly what the user saw:
        // "ich ziehe sie aus ihren wrapper und sie verschwindet". The
        // moment introDone flips true, we let the inner draw anywhere.
        overflow: introDone ? 'visible' : 'hidden',
        // Selection mode: collapse the pill out of the screenshot area.
        // The pill's content is hidden via opacity/scale; the outer is
        // still mounted so the unfold-on-return animation has a parent
        // to re-grow inside.
        ...(selectionMode ? {
          pointerEvents: 'none' as const,
        } : {}),
        // Keep height auto-sized to content; only WIDTH is animated.
      }}
      className="pointer-events-auto z-[9999] rounded-3xl"
      data-spirit-ui
      onDragOver={(e) => {
        // Allow file drops onto the box (Electron file paths ride along).
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = files.map((f) => (f as File & { path?: string }).path).filter((p): p is string => !!p);
        if (paths.length === 0) return;
        void window.spirit
          .attachFiles(paths)
          .then((attached) => setAttachedFiles(attached ?? []))
          .catch(() => undefined);
      }}
    >
      <motion.div
        // forwardedRef goes on the INNER (draggable) motion.div, not the
        // outer (anchor) one. After the user drags, only the inner element
        // gets a CSS transform — the outer stays at the entry-anchor
        // position. Hit-testing in App.tsx uses getBoundingClientRect() to
        // decide whether the cursor is over the box; if the ref pointed to
        // the outer, the bounds would still report the original anchor
        // position after every drag, hover would test false, the overlay
        // would flip to click-through, and the user couldn't click the
        // input or initiate a second drag. Putting the ref on the inner
        // (transformed) element makes the bounds follow the visible box.
        ref={(el: HTMLDivElement | null) => {
          boxMeasureRef.current = el;
          if (typeof forwardedRef === 'function') forwardedRef(el);
          else if (forwardedRef && 'current' in forwardedRef) {
            (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          }
        }}
        // `layout="position"`: only POSITION changes animate. Size changes
        // (growing the input box, the expand/plus row appearing, expand/
        // collapse) snap instantly so the send button, textarea, and buttons
        // never get scaled/squished by a full-box morph. Width is animated
        // separately on the outer motion.div; height follows content.
        // (Plain `layout` used to cause a vertical "pumping" — every time the
        // clipboard chip mounted/unmounted, the response area grew, or a
        // tool activity appeared, the whole box squashed and expanded. The
        // state flips that drove that loop (e.g. atInputMax) are latched
        // now, but a full-box morph still scales the contents.)
        layout="position"
        drag
        dragListener={false}
        dragControls={dragControls}
        dragMomentum={false}
        dragElastic={0}
        // Framer writes the drag delta into dragXMV/dragYMV (instead of its
        // own private values) so onDragEnd can fold the delta into the outer
        // anchor and clear it — otherwise the inner transform lingers and the
        // box drifts by a full drag-offset after release.
        style={{ x: dragXMV, y: dragYMV, minWidth: introDone ? undefined : BOX_WIDTH }}
        // Pause the cursor-follow spring while the user is dragging.
        // Without this, the outer's spring target keeps moving toward
        // the live cursor (which IS where the user's finger is during
        // drag, but Framer also applies a drag-offset on top, so the
        // box visually fights the user). After drag end we suppress
        // follow for 600ms so the box settles where the user dropped
        // it before resuming the gentle near-cursor target.
        onDragStart={() => {
          isDraggingRef.current = true;
          dragMovedRef.current = false;
          forceDragRender((n) => (n + 1) % 1024);
        }}
        onDragEnd={(_event, info) => {
          isDraggingRef.current = false;
          const moved =
            Math.abs(info.offset.x) + Math.abs(info.offset.y) > 4;
          dragMovedRef.current = moved;
          // Generous post-drag suppression: 3 seconds before cursor-
          // follow kicks back in. Gives the user time to release, click
          // in the input, type a few characters, etc, without the box
          // immediately trying to drift toward wherever the cursor
          // happened to end up. After the window expires the soft
          // spring eases the box back toward the cursor — never a snap.
          dragSuppressUntilRef.current = Date.now() + 3000;
          if (moved) {
            // The user placed the box — remember where and pin it so it
            // stays put (no drift back to the cursor) and reopens in the
            // same spot next time. At release the visible box = outer
            // (followX/followY) + inner drag delta (dragXMV/dragYMV). The
            // rect already includes both. Fold that into the outer target
            // and clear the inner delta, or the box would land at
            // double-offset and "drift" right after letting go.
            const r = boxMeasureRef.current?.getBoundingClientRect();
            if (r) {
              lastPlaced.x = r.left;
              lastPlaced.y = r.top;
              lastPlaced.has = true;
              lastPlaced.pinned = true;
              // Snap the outer to the true final position (no glide back to
              // the pre-drag anchor) and zero the inner drag transform.
              dragXMV.set(0);
              dragYMV.set(0);
              targetXMV.set(r.left);
              targetYMV.set(r.top);
              followX.jump(r.left);
              followY.jump(r.top);
              setPinned(true);
            }
          }
          forceDragRender((n) => (n + 1) % 1024);
        }}
        // Free drag anywhere within the overlay window. Very large bounds so
        // the user can pull the box across the whole screen without snapping.
        // Multi-monitor: each display has its own overlay window, dragging
        // beyond a screen edge is clamped by the OS window bounds.
        dragConstraints={{ left: -window.innerWidth, right: window.innerWidth, top: -window.innerHeight, bottom: window.innerHeight }}
        transition={{
          layout: { type: 'spring', damping: 52, stiffness: 220, mass: 1 },
          width: { type: 'spring', damping: 52, stiffness: 220, mass: 1 },
        }}
        // Inner pill keeps its own width regardless of the outer's intro-
        // clipping, so the visible chrome never reflows as the outer
        // unfolds. In audioMode the width starts at PILL_WIDTH and grows
        // with the live transcript (capped at BOX_WIDTH); otherwise it's
        // the full BOX_WIDTH as before.
        //
        // RESULT MODE (hasResponse): the layout flips from a column to a
        // ROW so the action context chips (SuggestionChips) can sit in a
        // fixed-width vertical rail on the right edge, top-aligned (easy
        // access while reading the answer). The width grows by RAIL_RESERVE
        // so the box itself keeps its full BOX_WIDTH. The floating chip
        // bubbles keep their own full-width line on top via `basis-full`.
        animate={{ width: railLayout ? capsuleW + RAIL_RESERVE : capsuleW }}
        className={[
          railLayout
            ? 'flex flex-row flex-wrap items-start gap-1.5'
            : 'flex flex-col items-stretch gap-1.5',
        ].join(' ')}
      >
        <div className={railLayout ? 'basis-full' : undefined}>
          {/* In voice mode the floating context chips are hidden while the mic
              is actively recording or a transcription is in flight — they're
              noise next to the live listening/transcribing feedback. */}
          {voice.state === 'idle' || voice.state === 'error' ? (
            <FloatingChips
            screenshotIncluded={screenshotIncluded}
            clipboardIncluded={clipboardIncluded}
            clipboardPreview={clipboardPreview}
            clipboardLength={clipboardLength}
            selectionPreview={selectionPreview}
            selectionLength={selectionLength}
            appPreview={appPreview}
            busy={busy}
            onDismissScreenshot={onDismissScreenshot}
            onDismissClipboard={onDismissClipboard}
            onDismissSelection={onDismissSelection}
          />
          ) : null}
        </div>

        {/* Dropped-file chips: files dragged onto the box, read by main.
            Persist until dismissed (✕) or the session ends. */}
        {attachedFiles.length > 0 && (
          <div className={['flex flex-wrap items-center gap-1.5', railLayout ? 'basis-full' : undefined].join(' ')}>
            {attachedFiles.map((f, i) => (
              <span
                key={`${f.path || f.note}-${i}`}
                title={f.path || f.note}
                className="inline-flex max-w-[240px] items-center gap-1 rounded-full border border-white/[0.06] px-2 py-0.5 text-[10.5px] text-white/70 dark:border-neutral-900/20 dark:text-neutral-900/70 spirit-glass-chip"
              >
                <span className="truncate">{f.name || 'file'}{f.kind === 'skipped' ? ` (${f.note ?? 'skipped'})` : ''}</span>
              </span>
            ))}
            <button
              type="button"
              onClick={() => void window.spirit.dismissAttachedFiles().then(() => setAttachedFiles([])).catch(() => undefined)}
              aria-label="Remove attached files"
              className="flex h-4 w-4 items-center justify-center rounded-full text-white/50 transition hover:bg-white/15 hover:text-white dark:text-neutral-800/60 dark:hover:bg-neutral-300"
            >
              <svg viewBox="0 0 10 10" fill="none" className="h-2.5 w-2.5">
                <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        <BorderBeam
          size="pulse-outside"
          colorVariant="mono"
          active={!tinyPill}
          borderRadius={24}
          strength={busy ? 0.9 : 0.5}
          theme={document.documentElement.classList.contains('dark') ? 'light' : 'dark'}
          className={`shadow-glass${railLayout ? ' order-0 min-w-0 flex-1' : ''}`}
        >
          <BorderBeam
            size={busy ? 'pulse-inner' : 'line'}
            colorVariant="mono"
            active={!tinyPill}
            borderRadius={24}
            strength={busy ? 0.9 : 0.45}
            theme={document.documentElement.classList.contains('dark') ? 'light' : 'dark'}
          >
        <div
          className={[
            'rounded-3xl border relative spirit-border-beam',
            // z-[1] lifts the box into its own stacking context so the
            // accent underglow (.spirit-accent-glow, anchored at top:100%)
            // stays visually BELOW the overlay and never over its content.
            'z-[1]',
            // Glass panel surface — alpha/blur driven by the Appearance →
            // Window slider via CSS vars (renderer/lib/glass.ts).
            'border-white/[0.06]',
            'dark:border-white/8',
            'spirit-glass-panel',
          ].join(' ')}
        >
        {/* Drag handle — grip indicator at the top edge. Click+drag here (or
            any other empty area of the box) repositions the panel so the user
            can pull it out of a screen corner. The handle turns BLUE when the
            box is pinned; clicking it toggles pin/unpin — pinned locks the box
            where it is (survives hide/show, no cursor-follow), unpinned makes
            it follow the cursor again. Hidden in the tiny voice pill — there
            the whole pill itself is draggable instead. */}
        {!tinyPill && (
        <div
          onPointerDown={(e) => {
            // A fresh pointer interaction — clear the stale "moved" flag from
            // a previous drag so a plain click here toggles pin/unpin. A real
            // drag sets it again in onDragEnd.
            dragMovedRef.current = false;
            dragControls.start(e);
          }}
          onClick={() => {
            // A genuine drag pins via onDragEnd; a click (no movement)
            // toggles between pinned and follow mode.
            if (dragMovedRef.current) return;
            setPinned((v) => {
              const next = !v;
              lastPlaced.pinned = next;
              if (next) {
                // Lock at the current spot so the follow spring has the
                // right base when the user later unlocks.
                const r = boxMeasureRef.current?.getBoundingClientRect();
                if (r) {
                  lastPlaced.x = r.left;
                  lastPlaced.y = r.top;
                  lastPlaced.has = true;
                  targetXMV.set(r.left);
                  targetYMV.set(r.top);
                }
              }
              return next;
            });
          }}
          className={[
            'group relative flex cursor-grab justify-center active:cursor-grabbing',
            tinyPill ? 'pt-[5px]' : 'pt-1.5',
          ].join(' ')}
          title={
            pinned
              ? 'Pinned — click to follow cursor'
              : 'Drag to move · click to pin in place'
          }
        >
          {/* INVISIBLE expanded hit zone: a generous strip around the thin
              3px bar so pin/unpin (and drag) don't need pixel-pointing at the
              bar itself. Covers the whole top width of the box and a few px
              above/below the bar; clicks and drags bubble to the handle div's
              handlers. */}
          <span aria-hidden className="absolute -inset-y-2 inset-x-0 cursor-grab active:cursor-grabbing" />
          <span
            className={[
              'block h-[3px] w-9 rounded-full transition-colors',
              pinned
                ? 'bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.7)]'
                : 'bg-white/15 group-hover:bg-white/30 dark:bg-neutral-900/15 dark:group-hover:bg-neutral-900/30',
            ].join(' ')}
          />
        </div>
        )}

        <motion.div
          className={[
            'relative flex items-start gap-2.5 px-3.5',
            tinyPill ? 'items-center justify-center py-1.5' : 'py-2.5',
          ].join(' ')}
          onPointerDown={(e) => {
            // Allow drag-init unless the user pressed on an actual interactive
            // child (input / textarea / button / kbd). This keeps the box
            // "drag from anywhere empty" while preserving normal focus.
            const target = e.target as HTMLElement;
            if (!target.closest('input, textarea, button, a, kbd, [data-no-drag]')) {
              dragControls.start(e);
            }
          }}
        >
          {tinyPill ? (
            // Voice-first shrink-to-pill: with "start with listening" on,
            // the capsule is just the phase pill whenever there's no live
            // text to show — including the start of a recording before the
            // first words land. While listening it shows the equalizer, bars
            // + "Listening…" label, centered — no top drag handle (the whole
            // pill is draggable instead). Other phases keep the labeled pill.
            // Clicking it opens the full input row.
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                // A real drag suppresses the click that follows the release,
                // so the capsule only expands on a plain click.
                if (dragMovedRef.current) return;
                setTextOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setTextOpen(true);
                }
              }}
              className="flex w-full cursor-pointer items-center justify-center px-1 py-0.5 outline-none"
              title="Click to type instead"
            >
              {voice.state === 'recording' ? (
                <span className="flex items-center justify-center gap-2">
                  <VoiceLevelBars level={voice.level} />
                  <span className="text-[10.5px] font-medium uppercase tracking-wider text-white/55 dark:text-neutral-900/60">
                    Listening…
                  </span>
                </span>
              ) : (
                <ConversationPhasePill
                  voiceState={voice.state}
                  voiceLevel={voice.level}
                  busy={busy}
                  ttsState={tts.state}
                  hasResponse={hasResponse}
                />
              )}
            </div>
          ) : (
            <>
            <div className="flex w-full min-w-0 flex-col gap-1.5">
              <div className="flex items-start gap-2.5">
          {busy ? (
            <span
              className="spirit-loader shrink-0"
              style={{ '--size': 0.24 } as React.CSSProperties}
              aria-hidden="true"
            >
              <svg width="100" height="100" viewBox="0 0 100 100">
                <defs>
                  <mask id={loaderMaskId} className="spirit-loader-mask">
                    <polygon points="0,0 100,0 100,100 0,100" fill="black" />
                    {/* Goo triangles scaled 0.85 around (50,50) so the bubble
                        sits a little smaller inside the boundary ring. */}
                    <polygon points="28.75,28.75 71.25,28.75 50,71.25" fill="white" />
                    <polygon points="50,28.75 71.25,71.25 28.75,71.25" fill="white" />
                    <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
                    <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
                    <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
                    <polygon points="37.25,37.25 62.75,37.25 50,62.75" fill="white" />
                  </mask>
                </defs>
              </svg>
              <div className="spirit-loader-orb">
                <div
                  className="spirit-loader-box"
                  style={{
                    maskImage: `url(#${loaderMaskId})`,
                    WebkitMaskImage: `url(#${loaderMaskId})`,
                  }}
                />
              </div>
            </span>
          ) : (
            // The status dot IS the mic toggle: click to start recording,
            // click again to stop. Recording turns it into the three-bar
            // pulse with a rose ring that follows the live mic level.
            <button
              type="button"
              onClick={toggleVoice}
              disabled={voice.state === 'transcribing'}
              aria-label={voice.state === 'recording' ? 'Stop recording' : 'Voice input'}
              title={voice.state === 'recording' ? 'Stop recording' : 'Voice input'}
              data-no-drag
              className={[
                'relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full transition',
                'hover:bg-white/8 dark:hover:bg-neutral-900/8',
              ].join(' ')}
            >
              {voice.state === 'recording' && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-rose-400/60 transition-opacity"
                  style={{ opacity: 0.25 + voice.level * 0.75 }}
                />
              )}
              {voice.state === 'transcribing' ? (
                <span className="block h-3 w-3 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
              ) : voice.state === 'recording' ? (
                <VoiceLevelBars level={voice.level} />
              ) : (
                <span className="spirit-loader-idle transition-all duration-200" />
              )}
            </button>
          )}
          <textarea
            ref={inputRef}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={1}
            placeholder={
              voice.state === 'recording'
                ? 'Listening…'
                : voice.state === 'transcribing'
                  ? 'Transcribing…'
                  : busy
                    ? t('interrupt.redirectHint')
                    : webOnDefault
                      ? 'Ask anything · web on · / for commands'
                      : 'Ask about what you see · / for commands'
            }
            spellCheck={false}
            onKeyDown={(e) => {
              if (showTestList) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setTestHighlight((h) => (testOptions.length > 0 ? (h + 1) % testOptions.length : 0));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setTestHighlight((h) =>
                    testOptions.length > 0 ? (h - 1 + testOptions.length) % testOptions.length : 0,
                  );
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  const pick = testOptions[testHighlight] ?? testOptions[0];
                  if (pick) {
                    e.preventDefault();
                    seedTest(pick.id);
                    return;
                  }
                }
                if (e.key === 'Escape' && testOptions.length > 0) {
                  e.preventDefault();
                  setValue('');
                  return;
                }
              }
              if (showCompletions) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % completions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + completions.length) % completions.length);
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  insertCompletion(completions[highlight]);
                  return;
                }
              }
              if (!showCompletions && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                stepPromptHistory(e.key === 'ArrowUp' ? -1 : 1);
                return;
              }
              if (e.key === 'Enter') {
                // Shift+Enter inserts a line break (auto-grow), plain Enter
                // submits the prompt.
                if (e.shiftKey) return;
                e.preventDefault();
                const exact = parseCommand(value.trim());
                if (exact) {
                  handleEnter();
                  return;
                }
                if (showCompletions && completions.length > 0 && /^\/\w*$/.test(value)) {
                  executeCommandImmediate(completions[highlight]);
                  return;
                }
                handleEnter();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              }
            }}
            className={[
              'min-h-[22px] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-[4px] text-[13px] leading-snug outline-none disabled:opacity-60',
              '[field-sizing:content]',
              inputExpanded
                ? 'max-h-[320px] rounded-lg bg-white/5 px-2 dark:bg-neutral-900/5'
                : 'max-h-[100px]',
              'text-white placeholder:text-[12px] placeholder:text-white/42',
              'dark:text-neutral-900 dark:placeholder:text-neutral-900/45',
            ].join(' ')}
          />
          {/* Right-side action column: Send sits on the top row; once the
              expand icon appears (tall editor) the expand + '+' buttons
              show directly BELOW Send — anchored to the send button, not
              pushed to the bottom of the tall editor. Clipboard opt-in and
              the per-query Screenshot re-attach live behind the "+". The
              tools menu renders as an in-flow strip below the box (not an
              absolute popover — the box chrome is overflow-hidden, which
              would crop anything outside it). */}
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex items-center gap-2.5">
              {!showSecondRow && toolsAvailable && (
                <button
                  type="button"
                  onClick={() => setToolsOpen((v) => !v)}
                  disabled={busy}
                  aria-label="More tools"
                  aria-expanded={toolsOpen}
                  title="More tools"
                  className={[
                    'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition',
                toolsOpen
                  ? 'bg-white/10 text-white dark:bg-neutral-900/10 dark:text-neutral-900'
                  : 'text-white/55 hover:bg-white/8 hover:text-white dark:text-neutral-900/55 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900',
                  ].join(' ')}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z" />
                  </svg>
                </button>
              )}
              {busy ? (
                <>
                  {value.trim() && (
                    <motion.button
                      type="button"
                      onClick={handleEnter}
                      aria-label="Interrupt"
                      title="Interrupt — send this into the ongoing task"
                      data-no-drag
                      className="flex h-7 shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full bg-accent pl-2 pr-2.5 text-white shadow-md transition hover:brightness-110 dark:text-neutral-900"
                    >
                      <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                        <path
                          d="M3 3l8 8M11 3l-8 8"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                      <span className="text-[11px] font-semibold leading-none">{t('interrupt.button')}</span>
                    </motion.button>
                  )}
                  {/* ✕ is ALWAYS Stop while a run is active — even with text
                      typed. Typed text has its own Interrupt button above; ✕
                      never submits or silently collapses the box. It stops the
                      response but keeps the overlay (keepOpen), per spec. */}
                  <button
                    type="button"
                    onClick={onStopStream ?? onCancel}
                    aria-label={onStopStream ? 'Stop (keep answer)' : 'Stop'}
                    title={onStopStream ? 'Stop (keeps partial answer)' : 'Stop (Esc)'}
                    data-no-drag
                    className="group relative inline-flex h-7 shrink-0 items-center justify-center rounded-full border border-white/16 bg-white/10 px-2.5 text-white/60 transition hover:bg-white/20 hover:text-white dark:border-neutral-900/20 dark:bg-neutral-900/10 dark:text-neutral-900/60 dark:hover:bg-neutral-900/20 dark:hover:text-neutral-900"
                  >
                    <span
                      aria-hidden
                      className="absolute -inset-[1px] rounded-full ring-1 ring-white/12 opacity-60 transition-opacity group-hover:opacity-100 dark:ring-neutral-900/15"
                    />
                    <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                      <path
                        d="M3 3l8 8M11 3l-8 8"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </>
              ) : (
                <motion.button
                  type="button"
                  onClick={handleEnter}
                  disabled={!value.trim() || voice.state === 'recording'}
                  aria-label="Send"
                  title="Send (Enter)"
                  data-no-drag
                  className={[
                    'flex h-7 shrink-0 items-center justify-center overflow-hidden rounded-full transition',
                    value.trim()
                      ? 'bg-accent pl-2.5 pr-3 text-white shadow-md hover:brightness-110 dark:text-neutral-900'
                      : 'px-1.5 text-white/35 hover:bg-white/8 hover:text-white/75 dark:text-neutral-900/35 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900/75',
                  ].join(' ')}
                >
                  {/* Telegram-style paper plane, pointing right. */}
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
                    <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2 .01 7Z" />
                  </svg>
                  <AnimatePresence initial={false}>
                    {value.trim() && (
                      <motion.span
                        key="send-label"
                        initial={{ opacity: 0, width: 0, marginLeft: 0 }}
                        animate={{ opacity: 1, width: 'auto', marginLeft: 6 }}
                        exit={{ opacity: 0, width: 0, marginLeft: 0 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className="overflow-hidden whitespace-nowrap text-[11px] font-semibold leading-none"
                      >
                        Send
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.button>
              )}
            </div>
            {showSecondRow && (
              <div className="flex items-center gap-2.5">
                {(inputExpanded || atInputMax) && (
                  <button
                    type="button"
                    onClick={() => setInputExpanded((v) => !v)}
                    disabled={busy}
                    aria-label={inputExpanded ? 'Minimize input' : 'Expand input'}
                    aria-expanded={inputExpanded}
                    title={inputExpanded ? 'Minimize input' : 'Expand input'}
                    className={[
                      'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition',
                      inputExpanded
                        ? 'bg-white/10 text-white dark:bg-neutral-900/10 dark:text-neutral-900'
                        : 'text-white/45 hover:bg-white/8 hover:text-white dark:text-neutral-900/45 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900',
                    ].join(' ')}
                  >
                    {inputExpanded ? (
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(-45deg)' }}>
                        <path d="M8 9l-4 4 4 4M16 9l4 4-4 4" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(-45deg)' }}>
                        <path d="M8 7l-4 5 4 5M16 7l4 5-4 5" />
                      </svg>
                    )}
                  </button>
                )}
                {toolsAvailable && (
                  <button
                    type="button"
                    onClick={() => setToolsOpen((v) => !v)}
                    disabled={busy}
                    aria-label="More tools"
                    aria-expanded={toolsOpen}
                    title="More tools"
                    className={[
                      'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition',
                      toolsOpen
                        ? 'bg-white/10 text-white dark:bg-neutral-900/10 dark:text-neutral-900'
                        : 'text-white/55 hover:bg-white/8 hover:text-white dark:text-neutral-900/55 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900',
                    ].join(' ')}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
                      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
              </div>
            </div>
            </>
          )}
        </motion.div>

        {/* Post-response "next action" chips — a horizontal row
            between the text field and the result. Kept out of the bottom of
            the box so a finished answer doesn't grow the overlay further.
            Generated by the same provider that just answered. */}
        <NextActionChips
          chips={visibleNextChips}
          busy={busy}
          onRun={(chip) => onRunNextChip?.(chip)}
        />

        <AnimatePresence initial={false}>
          {toolsOpen && toolsAvailable && (
            <motion.div
              key="tools-menu"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { type: 'spring', damping: 30, stiffness: 380 }, opacity: { duration: 0.12 } }}
              className="overflow-hidden"
            >
              <div ref={toolsRef} className="flex flex-wrap items-center justify-end gap-1.5 px-3.5 pb-2" data-no-drag>
                {onToggleScreenshot && (
                  <button
                    type="button"
                    onClick={() => {
                      onToggleScreenshot();
                      setToolsOpen(false);
                    }}
                    className={[
                      'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition',
                      screenshotIncluded
                        ? 'bg-spirit-accent/18 text-sky-200 dark:text-sky-800'
                        : 'bg-white/8 text-white/80 hover:bg-white/14 hover:text-white dark:bg-neutral-900/8 dark:text-neutral-900/80 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900',
                    ].join(' ')}
                  >
                    <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3">
                      <rect x="1.5" y="3.5" width="11" height="7.5" rx="1.1" stroke="currentColor" strokeWidth="1.3" />
                      <circle cx="7" cy="7.25" r="1.8" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M5 3.5l.6-1.2h2.8L9 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    </svg>
                    <span>Screenshot</span>
                    <span className="text-[10px] opacity-60">{screenshotIncluded ? 'On' : 'Off'}</span>
                  </button>
                )}
                {onToggleClipboard && (
                  <button
                    type="button"
                    onClick={() => {
                      onToggleClipboard();
                      setToolsOpen(false);
                    }}
                    className={[
                      'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition',
                      clipboardIncluded
                        ? 'bg-[#0a84ff]/18 text-sky-200 dark:text-sky-800'
                        : 'bg-white/8 text-white/80 hover:bg-white/14 hover:text-white dark:bg-neutral-900/8 dark:text-neutral-900/80 dark:hover:bg-neutral-900/14 dark:hover:text-neutral-900',
                    ].join(' ')}
                  >
                    <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.3">
                      <rect x="3" y="2.5" width="7" height="9" rx="1.2" />
                      <path d="M5.5 1.5h3a1 1 0 0 1 1 1v.5h-5v-.5a1 1 0 0 1 1-1Z" />
                      <path d="M5.5 6h3M5.5 8h2" strokeLinecap="round" />
                    </svg>
                    <span>Clipboard</span>
                    <span className="text-[10px] opacity-60">{clipboardIncluded ? 'On' : 'Off'}</span>
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {sttSetup && (
          <div className="flex items-center gap-2 px-3.5 pb-2.5" data-no-drag>
            {sttSetup.phase === 'downloading' ? (
              <>
                <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/10 dark:bg-neutral-900/15">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                    style={{ width: `${sttSetup.progress ?? 0}%` }}
                  />
                </div>
                <span className="shrink-0 text-[10px] font-medium tabular-nums text-white/55 dark:text-neutral-900/60">
                  STT {Math.round(sttSetup.progress ?? 0)}%
                </span>
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
                <span className="text-[10px] font-medium text-white/55 dark:text-neutral-900/60">
                  Installing local STT…
                </span>
              </div>
            )}
          </div>
        )}

        <AnimatePresence initial={false}>
        <AnimatePresence initial={false}>
          {showTestList && !busy && (
            <motion.div
              key="testlist"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { type: 'spring', damping: 30, stiffness: 380 }, opacity: { duration: 0.12 } }}
              className="overflow-hidden"
            >
              <ScrollArrows
                className="overflow-y-auto"
                style={{ maxHeight: `${DROPDOWN_MAX_VISIBLE * 32 + 8}px` }}
              >
                <ul
                  ref={testListRef}
                  className={[
                    'border-t px-1 py-1',
                    'border-white/8',
                    'dark:border-neutral-900/10',
                  ].join(' ')}
                >
                {testOptions.map((t, i) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setTestHighlight(i)}
                      onClick={() => seedTest(t.id)}
                      className={[
                        'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[12.5px] transition',
                        i === testHighlight
                          ? 'bg-accent/15 text-accent shadow-sm dark:bg-accent/20 dark:text-accent'
                          : 'text-white/82 hover:bg-white/8 dark:text-neutral-900/82 dark:hover:bg-neutral-900/8',
                      ].join(' ')}
                    >
                      <span className="flex min-w-0 items-center gap-2 truncate">
                        <span className="flex w-4 shrink-0 items-center justify-center">
                          {i === testHighlight && (
                            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
                              <path
                                d="M3 8.5l3.2 3L13 4.5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                        <span
                          className={[
                            'truncate font-medium',
                            i === testHighlight
                              ? 'text-accent dark:text-accent'
                              : 'text-white/95 dark:text-neutral-900/90',
                          ].join(' ')}
                        >
                          {t.label}
                        </span>
                        <span
                          className={[
                            'truncate',
                            i === testHighlight
                              ? 'text-accent/75 dark:text-accent/75'
                              : 'text-white/45 dark:text-neutral-900/55',
                          ].join(' ')}
                        >
                          {t.hint}
                        </span>
                      </span>
                      <span
                        className={[
                          'shrink-0 truncate text-[11px] tabular-nums',
                          i === testHighlight
                            ? 'text-accent/80 dark:text-accent/80'
                            : 'text-white/55 dark:text-neutral-900/55',
                        ].join(' ')}
                      >
                        {t.questions.length} turn{t.questions.length === 1 ? '' : 's'}
                      </span>
                    </button>
                  </li>
                ))}
                {testOptions.length === 0 && (
                  <li className="px-3 py-2 text-[12px] text-white/45 dark:text-neutral-900/55">
                    No test matches — Enter runs /test as-is.
                  </li>
                )}
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      onClearSeedTurns?.();
                      setValue('');
                      setTextOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[12.5px] text-white/60 transition hover:bg-white/8 dark:text-neutral-900/65 dark:hover:bg-neutral-900/8"
                  >
                    Clear seeded turns
                  </button>
                </li>
                </ul>
              </ScrollArrows>
            </motion.div>
          )}
        </AnimatePresence>

        {showCompletions && !busy && (
            <motion.div
              key="completions"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { type: 'spring', damping: 30, stiffness: 380 }, opacity: { duration: 0.12 } }}
              className="overflow-hidden"
            >
              <ScrollArrows
                className="overflow-y-auto"
                style={{ maxHeight: `${DROPDOWN_MAX_VISIBLE * 32 + 8}px` }}
              >
                <ul
                  ref={listRef}
                  className={[
                    'border-t px-1 py-1',
                    'border-white/8',
                    'dark:border-neutral-900/10',
                  ].join(' ')}
                >
                {completions.map((c, i) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => executeCommandImmediate(c)}
                      className={[
                        'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-[12.5px] transition',
                        i === highlight
                          ? 'bg-accent/15 text-accent shadow-sm dark:bg-accent/20 dark:text-accent'
                          : 'text-white/82 hover:bg-white/8 dark:text-neutral-900/82 dark:hover:bg-neutral-900/8',
                      ].join(' ')}
                    >
                      <span className="flex min-w-0 items-center gap-2 truncate">
                        <span className="flex w-4 shrink-0 items-center justify-center">
                          {i === highlight && (
                            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
                              <path
                                d="M3 8.5l3.2 3L13 4.5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                        <span
                          className={[
                            'truncate font-medium',
                            i === highlight
                              ? 'text-accent dark:text-accent'
                              : 'text-white/95 dark:text-neutral-900/90',
                          ].join(' ')}
                        >
                          {c.name}
                        </span>
                        {c.argsHint && (
                          <span
                            className={[
                              'truncate',
                              i === highlight
                                ? 'text-accent/75 dark:text-accent/75'
                                : 'text-white/45 dark:text-neutral-900/55',
                            ].join(' ')}
                          >
                            {c.argsHint}
                          </span>
                        )}
                      </span>
                      <span
                        className={[
                          'truncate text-[11px]',
                          i === highlight
                            ? 'text-accent/80 dark:text-accent/80'
                            : 'text-white/55 dark:text-neutral-900/55',
                        ].join(' ')}
                      >
                        {c.description}
                      </span>
                    </button>
                  </li>
                ))}
                </ul>
              </ScrollArrows>
            </motion.div>
          )}
        </AnimatePresence>

        {showCompletions && !busy && (
          <div
            className={[
              'flex items-center justify-center gap-5 border-t px-3 py-1.5 text-[10.5px] leading-none',
              'border-white/8 text-white/45',
              'dark:border-neutral-900/10 dark:text-neutral-900/50',
            ].join(' ')}
          >
            <span className="inline-flex items-center gap-1.5">
              <kbd
                className={[
                  'inline-flex h-[15px] min-w-[15px] items-center justify-center rounded border px-1 text-[9px] leading-none',
                  'border-white/25 bg-white/8',
                  'dark:border-neutral-900/30 dark:bg-neutral-900/10',
                ].join(' ')}
              >
                ↑↓
              </kbd>
              navigate
            </span>
            <span className="inline-flex items-center gap-1.5">
              <kbd
                className={[
                  'inline-flex h-[15px] min-w-[15px] items-center justify-center rounded border px-1 text-[9px] leading-none',
                  'border-white/25 bg-white/8',
                  'dark:border-neutral-900/30 dark:bg-neutral-900/10',
                ].join(' ')}
              >
                ↵
              </kbd>
              confirm highlighted
            </span>
            <span className="inline-flex items-center gap-1.5">
              <kbd
                className={[
                  'inline-flex h-[15px] min-w-[15px] items-center justify-center rounded border px-1 text-[9px] leading-none',
                  'border-white/25 bg-white/8',
                  'dark:border-neutral-900/30 dark:bg-neutral-900/10',
                ].join(' ')}
              >
                Esc
              </kbd>
              close
            </span>
          </div>
        )}

        <AnimatePresence initial={false}>
          {showExpanded && !showCompletions && (
            <motion.section
              key="expanded"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{
                height: { type: 'spring', damping: 30, stiffness: 320, mass: 0.7 },
                opacity: { duration: 0.18 },
              }}
              className="overflow-hidden"
            >
              <div
                className={[
                  'border-t px-4 py-3',
                  'border-white/8',
                  'dark:border-neutral-900/10',
                ].join(' ')}
              >
                <AnimatePresence initial={false}>
                  {approvals.map((req) => (
                    <ToolApproval key={req.id} request={req} onDecide={onApprove} />
                  ))}
                </AnimatePresence>

                <ChainPanel activities={activities} reasoning={reasoning} busy={busy} hasResponse={hasResponse} elapsedSecs={elapsedSecs} />

                {error ? (
                  <p className="text-sm leading-relaxed text-rose-300 dark:text-rose-700">{error}</p>
                ) : hasResponse ? (
                  <div className="relative" ref={answerScrollWrapperRef}>
                    {showPast && !railOverflow && (
                      <div className="pointer-events-none absolute bottom-0 -left-4 top-0 z-10 flex">
                        <div
                          className="pointer-events-auto"
                          onWheel={(e) => {
                            // Wheel over the rail scrolls the answers beneath.
                            const viewport = answerViewportRef.current;
                            if (viewport) viewport.scrollTop += e.deltaY;
                          }}
                        >
                          <TurnScrubber chapters={chapters} side="right" onSelect={jumpToTurn} />
                        </div>
                      </div>
                    )}
                    {showPast && railOverflow && !pastGrown && (
                      <button
                        type="button"
                        onClick={() => setPastGrown(true)}
                        aria-label="Show past questions"
                        title="Past questions"
                        className="absolute -left-5 top-1.5 z-10 flex h-6 w-9 items-center justify-start pl-1 text-white/60 transition hover:text-white dark:text-neutral-900/55 dark:hover:text-neutral-900"
                      >
                        <IconChevronRight size={15} stroke={2.2} className="drop-shadow-[0_0_3px_rgba(0,0,0,0.9)] dark:drop-shadow-[0_0_3px_rgba(255,255,255,0.9)]" />
                      </button>
                    )}
                    <ScrollArrows
                      className="overflow-y-auto pr-1 snap-y snap-proximity"
                      style={{ maxHeight: pastGrown ? 520 : 360 }}
                    >
                      <div ref={answerContentRef}>
                      {showPast && pastGrown && (
                        <div className="spirit-glass-panel spirit-thin-scroll mb-2 max-h-[192px] snap-start overflow-y-auto rounded-2xl [scroll-padding-top:44px]">
                          <div className="sticky top-0 z-20 flex items-center justify-between border-b border-white/8 bg-black/85 px-3 py-2 backdrop-blur-xl dark:border-neutral-900/10 dark:bg-white/95">
                            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/40 dark:text-neutral-900/50">
                              Past questions · {previousTurns.length}
                            </span>
                            <button
                              type="button"
                              onClick={() => setPastGrown(false)}
                              aria-label="Hide past questions"
                              className="rounded-md p-1 text-white/40 transition hover:bg-white/10 hover:text-white/80 dark:text-neutral-900/50 dark:hover:bg-neutral-900/10"
                            >
                              <IconX size={12} stroke={2} />
                            </button>
                          </div>
                          <div className="px-1.5 py-1.5">
                          {orderedTurns.map((turn) => (
                            <button
                              key={turn.id}
                              type="button"
                              onClick={() => {
                                jumpToTurn({ id: turn.id, title: turn.prompt });
                                setPastGrown(false);
                              }}
                              title={turn.prompt}
                              className="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all hover:translate-x-0.5 hover:bg-white/5 dark:hover:bg-neutral-900/5"
                            >
                              <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/30 transition group-hover:text-[rgb(var(--spirit-accent-rgb))] dark:text-neutral-900/30">
                                {String(turn.n ?? 0).padStart(2, '0')}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-xs text-white/65 transition group-hover:text-white dark:text-neutral-900/65 dark:group-hover:text-neutral-900">
                                {turn.prompt}
                              </span>
                              <IconChevronRight size={13} stroke={2} className="shrink-0 text-white/0 transition group-hover:text-white/50 dark:group-hover:text-neutral-900/50" />
                            </button>
                          ))}
                          </div>
                        </div>
                      )}
                      {showPast && (
                      <AnimatePresence mode="wait" initial={false}>
                      {orderedTurns.map((turn) => {
                        // Single-answer view: only the rail-selected turn
                        // shows its answer. No question lines below — the
                        // rail hover preview identifies each tick.
                        if (expandedTurnId !== turn.id) return null;
                        return (
                        <motion.section
                          key={turn.id}
                          initial={prefersReducedMotion ? false : { opacity: 0, filter: 'blur(6px)', y: 8 }}
                          animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
                          exit={prefersReducedMotion ? undefined : { opacity: 0, filter: 'blur(6px)', y: -6, transition: { duration: 0.12, ease: 'easeIn' } }}
                          transition={{ duration: 0.18, ease: 'easeOut' }}
                          ref={(el) => {
                            if (el) turnRefs.current.set(turn.id, el);
                            else turnRefs.current.delete(turn.id);
                          }}
                          className="snap-start"
                        >
                          {turn.images && turn.images.length > 0 && (
                            <WebImagesRow images={turn.images} />
                          )}
                          <AnswerBody
                            text={turn.response}
                            segments={turn.uiSegments}
                            audioMode={audioMode}
                            onSubmit={onUiSubmit}
                            onCopy={onUiCopy}
                          />
                          {turn.annotations && turn.annotations.length > 0 && onReplayTurnAnnotations && (
                            <button
                              type="button"
                              onClick={() => onReplayTurnAnnotations(turn)}
                              className="mb-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] text-white/45 transition hover:bg-white/5 hover:text-white/80 dark:text-neutral-900/50 dark:hover:bg-neutral-900/5 dark:hover:text-neutral-900/85"
                            >
                              <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                                <path d="M12 7A5 5 0 1 1 7 2c1.9 0 3.4.9 4.3 2.3M11.5 1.5v3h-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              show on screen
                            </button>
                          )}
                        </motion.section>
                        );
                      })}
                      </AnimatePresence>
                      )}
                      {(hasCurrentResponse || streaming) && !expandedTurnId && (
                      <section
                        className={[
                          showPast && expandedTurnId
                            ? 'border-t border-white/8 pt-5 dark:border-neutral-900/10'
                            : '',
                          'snap-start relative',
                        ].join(' ')}
                      >
                      <div className="relative">
                      <WebImagesRow images={webImages} />
                      {uiLive && streaming && (
                        <UiLiveTile live={uiLive} onSubmit={onUiSubmit} onCopy={onUiCopy} />
                      )}
                      <AnswerBody
                        text={streaming ? streamDisplayText(response) : response}
                        segments={uiSegments}
                        audioMode={audioMode}
                        onSubmit={onUiSubmit}
                        onCopy={onUiCopy}
                      />
                      {streaming && (
                        <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] bg-accent align-middle motion-safe:animate-pulse" />
                      )}

                      {linkList.length > 0 && (
                        <div className="mt-3 flex flex-col gap-1.5">
                          {linkList.map((m, i) => (
                            <LinkCard key={m.url} meta={m} index={i} />
                          ))}
                        </div>
                      )}
                      <WordHighlight words={tts.words} activeWord={tts.activeWord} seekToWord={tts.seekToWord} />
                      </div>
                      </section>
                      )}
                      </div>
                    </ScrollArrows>
                  </div>
                ) : (
                  !busy && <AgentStatus />
                )}
              </div>
              {hasResponse && !busy && !error && (
                <div
                  className={[
                    'flex items-center justify-end gap-1 border-t px-2 pt-1.5 pb-2',
                    'border-white/6 dark:border-neutral-900/8',
                  ].join(' ')}
                >
                  {interrupted && (
                    <>
                      <ActionButton
                        label="Continue"
                        ok
                        onClick={() => onContinue?.()}
                        icon={
                          <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                            <path
                              d="M2 7h9M7.5 3.5L11 7l-3.5 3.5"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        }
                      />
                      <ActionButton
                        label="Retry"
                        onClick={() => onRetry?.()}
                        icon={
                          <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                            <path
                              d="M11.5 7a4.5 4.5 0 1 1-1.4-3.2M11.5 2v2.6H9"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        }
                      />
                      <span
                        className="mr-auto truncate pl-1 text-[10px] text-amber-500"
                        title={interrupted}
                      >
                        stopped early — answer kept
                      </span>
                    </>
                  )}
                  <ActionButton
                    label={
                      tts.state === 'loading'
                        ? 'Loading…'
                        : tts.state === 'playing'
                          ? 'Pause'
                          : tts.state === 'paused'
                            ? 'Resume'
                            : 'Read'
                    }
                    ok={tts.state === 'playing' || tts.state === 'paused'}
                    disabled={tts.state === 'loading'}
                    shimmer={tts.state === 'loading'}
                    onClick={() => {
                      if (tts.state === 'playing') tts.pause();
                      else if (tts.state === 'paused') tts.resume();
                      else void tts.speak(response);
                    }}
                    icon={
                      tts.state === 'playing' ? (
                        // Pause icon (two bars) — playback can be paused here.
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="currentColor">
                          <rect x="3.5" y="3" width="2.2" height="8" rx="0.9" />
                          <rect x="8.3" y="3" width="2.2" height="8" rx="0.9" />
                        </svg>
                      ) : tts.state === 'loading' ? (
                        <span className="block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
                      ) : (
                        // Play icon (speaker) — idle / paused / done.
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                          <path
                            d="M2 5.5h2.5l3-2.5v8l-3-2.5H2v-3Z"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M9.5 4.5c.9.7 1.5 1.6 1.5 2.5s-.6 1.8-1.5 2.5"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                          />
                        </svg>
                      )
                    }
                  />
                  <ActionButton
                    label={saving ? 'Saving…' : savedPath ? 'Saved' : 'Save'}
                    ok={!!savedPath}
                    disabled={saving}
                    shimmer={saving}
                    onClick={() => void save()}
                    icon={
                      savedPath ? (
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                          <path
                            d="M2.5 7.2l3 3 6.2-6.4"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                          <path
                            d="M7 1.5v8M3.6 6.1L7 9.5l3.4-3.4M2 12.5h10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )
                    }
                  />
                  <ActionButton
                    label={copied ? 'Copied' : 'Copy'}
                    onClick={copy}
                    icon={
                      copied ? (
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                          <path
                            d="M2.5 7.2l3 3 6.2-6.4"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                          <rect
                            x="3.5"
                            y="2.5"
                            width="7"
                            height="9"
                            rx="1.2"
                            stroke="currentColor"
                            strokeWidth="1.3"
                          />
                          <path
                            d="M6 1.5h3.5a1.5 1.5 0 0 1 1.5 1.5"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                          />
                        </svg>
                      )
                    }
                  />
                  {/* Replay — re-fly the annotation tour from the start.
                      Only meaningful when the run drew something on screen. */}
                  {hasAnnotations && onReplayAnnotations && (
                    <ActionButton
                      label="Replay"
                      onClick={onReplayAnnotations}
                      icon={
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
                            fill="currentColor"
                          />
                        </svg>
                      }
                    />
                  )}
                  {/* Append/Replace — types the AI response into the focused
                      app at the caret. "Replace" when there's a captured
                      selection (it replaces the highlighted text), "Append"
                      otherwise (inserts at the cursor). Like Python spirit. */}
                  <ActionButton
                    label={inserted ? 'Typed!' : selectionPreview ? 'Replace' : 'Append'}
                    ok={inserted}
                    onClick={() => {
                      if (!response || inserted) return;
                      void (async () => {
                        await ipc.insertText(response);
                        setInserted(true);
                        window.setTimeout(() => setInserted(false), 1500);
                      })();
                    }}
                    icon={
                      inserted ? (
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                          <path
                            d="M2.5 7.2l3 3 6.2-6.4"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : selectionPreview ? (
                        // Replace: swap the selected text for the response.
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none">
                          <path
                            d="M1.5 5h8l-2-2M12.5 9h-8l2 2"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        // Append: insert at the cursor.
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="currentColor">
                          <path d="M3 12V2.5L11 7l-8 5Z" />
                        </svg>
                      )
                    }
                  />
                </div>
              )}
            </motion.section>
          )}
        </AnimatePresence>

        {/* Accent underline sweep while the action chips are being
            generated. Attached to the BOX's bottom edge (centered, narrowed),
            not the overlay window's bottom — it follows the drag. */}
        <ChipsLoadingLine
          visible={visibleChipsPending}
          className="pointer-events-none absolute left-1/2 -bottom-[3px] z-30 w-40 -translate-x-1/2"
        />

        {/* Self-knowledge line: quiet memory notice at the box bottom edge.
            Brain icon for memory updates, plain text otherwise. No popup,
            no toast — one muted line. Hidden while streaming/busy. */}
        <AnimatePresence>
          {learnedLine && !busy && (
            <motion.div
              key="learned-line"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="pointer-events-none absolute left-1/2 -bottom-5 z-30 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap text-[10px] text-white/40 dark:text-neutral-900/40"
            >
              {learnedLine.kind === 'memory' && <Brain className="size-3 shrink-0 text-[rgb(var(--spirit-accent-rgb))]/70" />}
              <span>{learnedLine.text}</span>
            </motion.div>
          )}
        </AnimatePresence>

        </div>
          </BorderBeam>

          {/* Blue accent underglow — kept OUTSIDE the inner (overflow:hidden)
              beam wrapper so it still paints below the box while streaming. */}
        <div className={['spirit-accent-glow', busy ? 'visible' : ''].join(' ')} />
        </BorderBeam>

        {/* Action suggestion (context) chips. Below the chrome wrapper
            but still inside the draggable parent so they follow the box when
            dragged. Hidden automatically while the LLM is working. RESULT
            MODE: the wrapper becomes the fixed-width right rail (`shrink-0
            w-48` matches CONTEXT_RAIL_W) on the same flex row as the box,
            top-aligned, so the context stays reachable while reading.
            `relative z-20` keeps the chips above the box's frosted blur
            (backdrop-filter stacks below later positioned siblings), so the
            pills never render dimmed behind the glass. */}
        <div className={['relative z-20', railLayout ? 'shrink-0 w-48' : ''].join(' ')}>
          <SuggestionChips
            chips={visibleChips}
            busy={busy}
            rail={railLayout}
            onRun={(chip) => onRunSuggestion?.(chip)}
          />
        </div>
      </motion.div>
    </motion.div>
  );
});

// Floating context chips — elongated muted pills above the prompt box.
// Collapsed: icon + short label. Hover: expands to show full text + dismiss.
function FloatingChips({
  screenshotIncluded,
  clipboardIncluded,
  clipboardPreview,
  clipboardLength,
  selectionPreview,
  selectionLength,
  appPreview,
  busy,
  onDismissScreenshot,
  onDismissClipboard,
  onDismissSelection,
}: {
  screenshotIncluded: boolean;
  clipboardIncluded: boolean;
  clipboardPreview: string | null;
  clipboardLength: number;
  selectionPreview: string | null;
  selectionLength: number;
  appPreview: string | null;
  busy: boolean;
  onDismissScreenshot?: () => void;
  onDismissClipboard: () => void;
  onDismissSelection: () => void;
}) {
  const [hovered, setHovered] = useState<'screenshot' | 'clipboard' | 'selection' | 'app' | null>(null);

  type ChipDef = {
    id: 'screenshot' | 'clipboard' | 'selection' | 'app';
    show: boolean;
    label: string;
    shortLabel: string;
    meta?: string;
    onDismiss?: () => void;
    icon: React.ReactNode;
  };

  const chips: ChipDef[] = [
    {
      id: 'screenshot',
      show: screenshotIncluded && !busy,
      label: 'Screenshot attached',
      shortLabel: 'Shot',
      onDismiss: onDismissScreenshot,
      icon: (
        <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3 shrink-0">
          <rect x="1.5" y="3.5" width="11" height="7.5" rx="1.1" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="7" cy="7.25" r="1.8" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 3.5l.6-1.2h2.8L9 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'selection',
      show: !!selectionPreview && !busy,
      label: selectionPreview ?? 'Selection',
      shortLabel: 'Select',
      meta: formatLen(selectionLength),
      onDismiss: onDismissSelection,
      icon: (
        <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3 shrink-0">
          <path d="M3 4h8M3 7h8M3 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'clipboard',
      show: clipboardIncluded && !!clipboardPreview && !busy,
      label: clipboardPreview ?? 'Clipboard',
      shortLabel: 'Clip',
      meta: formatLen(clipboardLength),
      onDismiss: onDismissClipboard,
      icon: (
        <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3 shrink-0">
          <rect x="3" y="2.5" width="8" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5.5 2V1h3v1M5.5 6h3M5.5 8.5h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'app',
      show: !!appPreview && !busy,
      label: appPreview ?? 'App',
      shortLabel: 'App',
      icon: (
        <svg viewBox="0 0 14 14" fill="none" className="h-3 w-3 shrink-0">
          <rect x="1.5" y="2.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1.5 5.5h11M4.5 9.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      ),
    },
  ].filter((c) => c.show) as ChipDef[];

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-row items-center gap-2 px-4">
      <AnimatePresence initial={false}>
        {chips.map((c) => {
          const isHovered = hovered === c.id;
          return (
            <motion.div
              key={c.id}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{
                layout: { type: 'spring', damping: 28, stiffness: 380, mass: 0.6 },
                default: { type: 'spring', damping: 26, stiffness: 360, mass: 0.6 },
              }}
              onMouseEnter={() => setHovered(c.id)}
              onMouseLeave={() => setHovered((h) => (h === c.id ? null : h))}
              className={[
                'flex items-center rounded-full',
                'border border-white/[0.06]',
                'dark:border-neutral-900/20',
                'spirit-glass-chip',
                'text-[11px] font-medium text-white/70',
                'dark:text-neutral-900/70',
                'shadow-glass',
                'max-w-[240px] overflow-hidden',
                'transition-all duration-200',
                isHovered
                  ? 'gap-1.5 pl-2 pr-2 py-1 border-white/[0.1] text-white/90 dark:border-neutral-900/30 dark:text-neutral-900/90'
                  : 'gap-1.5 px-2.5 py-1',
              ].join(' ')}
              aria-expanded={isHovered}
            >
              {isHovered && c.onDismiss ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    c.onDismiss?.();
                  }}
                  aria-label="Remove"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white/75 transition hover:bg-white/15 hover:text-white dark:text-neutral-800/70 dark:hover:bg-neutral-300 dark:hover:text-neutral-900"
                >
                  <svg viewBox="0 0 10 10" fill="none" className="h-2.5 w-2.5">
                    <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              ) : (
                c.icon
              )}
              <span className="min-w-0 truncate whitespace-nowrap">
                {isHovered ? c.label : c.shortLabel}
              </span>
              {isHovered && c.meta && (
                <span className="shrink-0 opacity-40 text-[10px]">{c.meta}</span>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled,
  ok,
  shimmer,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ok?: boolean;
  shimmer?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={[
        // Minimal ghost button: no boxes or borders in idle — icon + 10px
        // label in muted tone, faint wash on hover. Accent reserved for the
        // active (ok) state only.
        'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 py-1',
        'text-[10px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50',
        'disabled:pointer-events-none disabled:opacity-40',
        shimmer ? 'spirit-shimmer' : '',
        ok
          ? 'text-accent hover:bg-accent/10'
          : 'text-white/45 hover:bg-white/8 hover:text-white/85 dark:text-neutral-900/45 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900/85',
      ].join(' ')}
    >
      <span className="relative z-[1] inline-flex items-center justify-center gap-1">
        <span className="flex h-3 w-3 items-center justify-center">{icon}</span>
        <span>{label}</span>
      </span>
    </button>
  );
}

function formatLen(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// Inline phase indicator rendered just below the drag handle while voice-
// first mode is active. Tells the user at a glance which leg of the loop
// they're in (listening → thinking → speaking → back to listening) without
// them having to look at the input placeholder or guess from the streaming
// text. The dot pulses with the live mic level while listening, and a
// live oscilloscope draws the last 14 RMS
// samples as a rolling waveform — gives recording a tangible sense of
// "I hear you" instead of a single pulsing dot.
function ConversationPhasePill({
  voiceState,
  voiceLevel,
  busy,
  ttsState,
  hasResponse,
}: {
  voiceState: 'idle' | 'recording' | 'transcribing' | 'error';
  voiceLevel: number;
  busy: boolean;
  ttsState: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  hasResponse: boolean;
}) {
  // No swallowed "Ready" default — a leg should be active, otherwise the
  // capsule falls back to a quiet "tap to type" affordance (never blank).
  // The leading dot is the SAME premium accent dot as normal type mode
  // (spirit-loader-idle: accent glow + slow gradient sheen, no pulsing) —
  // no bumpy scaling or animate-pulse here.
  let label = '';
  if (voiceState === 'recording') {
    label = 'Listening…';
  } else if (voiceState === 'transcribing') {
    label = 'Transcribing…';
  } else if (voiceState === 'error') {
    label = 'Mic error · tap to retry';
  } else if (busy) {
    label = 'Thinking…';
  } else if (ttsState === 'loading' || ttsState === 'playing') {
    label = 'Speaking…';
  } else if (ttsState === 'paused') {
    label = 'Paused';
  } else if (hasResponse) {
    label = 'Done · say a follow-up';
  } else {
    label = 'Tap to type';
  }
  return (
    <div className="flex items-center justify-center gap-2 px-3 pt-1 pb-0.5">
      <span aria-hidden className="spirit-loader-idle" />
      {voiceState === 'recording' && (
        <VoiceWaveform level={voiceLevel} />
      )}
      <span className="text-[10.5px] font-medium uppercase tracking-wider text-white/55 dark:text-neutral-900/60">
        {label}
      </span>
    </div>
  );
}

// Live oscilloscope-style waveform fed by the mic's smoothed RMS level.
// Holds a fixed-length ring buffer of recent samples and renders one
// vertical bar per sample. Newest sample is rightmost; the buffer
// shifts left as new values arrive on each render tick from useVoiceInput.
// 14 bars at 60ms sample cadence ≈ 840ms of audible memory — enough that
// the wave reads as "wave" rather than "dot pulse", but short enough that
// the bars react snappily to a word starting.
const WAVEFORM_BARS = 14;

function VoiceWaveform({ level }: { level: number }) {
  const bufferRef = useRef<number[]>(Array(WAVEFORM_BARS).fill(0));
  // We don't useState for the buffer (would re-render on every push and
  // tearing the bars from the smooth animation). Instead we mutate the
  // ref and trigger one render via a tick counter — React reconciles the
  // bars, the CSS transition handles the smoothing.
  const [, force] = useState(0);
  // Tracks whether the component is still mounted. The decay interval
  // below is cancelled on unmount via the useEffect cleanup, but if the
  // unmount happens between an interval tick and the next React render,
  // a setState inside the tick can leak. The mounted flag short-
  // circuits the push and avoids the leak on every-90ms-while-talking.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (level <= 0) return;
    if (!mountedRef.current) return;
    bufferRef.current.shift();
    bufferRef.current.push(level);
    force((n) => (n + 1) % 1024);
  }, [level]);
  // Idle decay tick: when the user falls silent, level → 0 and the
  // useEffect above stops firing. A 90ms interval pushes a 0 onto the
  // buffer so the bars drain smoothly to flat instead of freezing on the
  // last spoken sample.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!mountedRef.current) return;
      const last = bufferRef.current[bufferRef.current.length - 1];
      if (last < 0.02) return;
      bufferRef.current.shift();
      bufferRef.current.push(last * 0.55);
      force((n) => (n + 1) % 1024);
    }, 90);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-[2px] h-3" aria-hidden>
      {bufferRef.current.map((v, i) => {
        // Each bar's height is a blend of its slot value AND a small
        // floor so the wave never collapses to invisible. The exp curve
        // emphasizes spoken content (mid-to-high levels) over background
        // noise (low levels), matching the mic VAD threshold.
        const h = Math.max(2, Math.round(2 + Math.pow(v, 0.7) * 10));
        return (
          <span
            key={i}
            className="inline-block w-[2px] rounded-full bg-accent transition-[height] duration-100 ease-out"
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

// Three-bar recording indicator that reacts to the live mic RMS level
// instead of bouncing on a fixed CSS animation. Each bar's scaleY is
// driven by the level with a stagger offset so they ripple outward.
function VoiceLevelBars({ level }: { level: number }) {
  const base = 0.25;
  const scales = [
    base + Math.pow(level, 0.8) * 0.75,
    base + Math.pow(level, 0.9) * 0.70,
    base + Math.pow(level, 0.7) * 0.65,
  ];
  return (
    <span className="spirit-loader-bars" aria-hidden="true">
      <span style={{ transform: `scaleY(${scales[0]})` }} />
      <span style={{ transform: `scaleY(${scales[1]})` }} />
      <span style={{ transform: `scaleY(${scales[2]})` }} />
    </span>
  );
}

export { HELP_TEXT };
export { COMMANDS };

// Placeholder tile shown while the AI is still streaming a [UI]/[QUESTIONS]/
// [MERMAID]/[DIAGRAM] block. The block's raw payload is masked out of the
// live stream on the main side, so this is the user-facing stand-in until the
// authoritative final answer replaces the stream with the real rendered
// widget.
const UI_LIVE_LABELS: Record<UiLiveBlock['kind'], string> = {
  ui: 'UI',
  questions: 'Questions',
  mermaid: 'Diagram',
  diagram: 'Diagram',
  openui: 'OpenUI',
};

function UiLiveTile({ live, onSubmit, onCopy }: { live: UiLiveBlock; onSubmit?: (prompt: string) => void; onCopy?: (text: string) => void }) {
  // OpenUI draws itself from the partial program — the placeholder tile would
  // be a downgrade, so stream the real components instead.
  if (live.kind === 'openui') {
    return <OpenUiBlock code={live.code} streaming onSubmit={onSubmit} onCopy={onCopy} />;
  }
  return (
    <div className="mt-1 mb-2 flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
      <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent dark:border-accent/40 dark:bg-accent/10">
        {UI_LIVE_LABELS[live.kind] ?? 'UI'}
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 dark:opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent dark:bg-accent" />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/90 dark:text-neutral-800">
        {live.title}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-white/40 dark:text-neutral-400">
        rendering…
      </span>
    </div>
  );
}

// Renders the final answer: plain markdown when there is no generated UI, or
// the exact interleaved sequence of text / [UI] / [QUESTIONS] / [MERMAID] /
// [DIAGRAM] segments when there is. Text segments carry the same content as
// `response` (marker-free), so UI answers are drawn solely from the segment
// list to avoid double-rendering the same text.
function AnswerBody({
  text,
  segments,
  audioMode,
  onSubmit,
  onCopy,
}: {
  text: string;
  segments: UiSegment[];
  audioMode: boolean;
  onSubmit?: (prompt: string) => void;
  onCopy?: (text: string) => void;
}) {
  return (
    <Suspense fallback={null}>
      {segments.length === 0 ? (
        <Markdown text={text} />
      ) : (
        segments.map((seg, i) => {
          switch (seg.kind) {
            case 'text':
              return <Markdown key={i} text={seg.text} />;
            case 'ui':
              return (
                <CustomUi
                  key={i}
                  block={seg.block}
                  onSubmit={(p) => onSubmit?.(p)}
                  onCopy={(t) => onCopy?.(t)}
                />
              );
            case 'questions':
              return (
                <QuestionWizard
                  key={i}
                  set={seg.questions}
                  onSubmit={(p) => onSubmit?.(p)}
                  audioMode={audioMode}
                />
              );
            case 'mermaid':
              return <MermaidDiagram key={i} code={seg.code} />;
            case 'diagram':
              return <DiagramWidget key={i} html={seg.html} title={seg.title || undefined} />;
            case 'openui':
              return (
                <OpenUiBlock
                  key={i}
                  code={seg.code}
                  onSubmit={(p) => onSubmit?.(p)}
                  onCopy={(t) => onCopy?.(t)}
                />
              );
            default:
              return null;
          }
        })
      )}
    </Suspense>
  );
}
