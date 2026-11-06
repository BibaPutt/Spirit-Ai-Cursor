import {
  getChipsSettingsLight,
  getDecryptedChipsProviderKey,
  getDecryptedProviderKey,
  getSettings,
  getSettingsLight,
  hasProviderKey,
} from '../../store/settings';
import { getLastDecryptFailure, resetDecryptFailure } from '../../store/secure-keys';
import { buildMessages, SYSTEM_PROMPT, type Message } from '../prompt';
import { promptWithSkills } from '../../llm/skills';
import { getTemplate } from '../templates';
import { buildClickTargetsMenu, buildScene, goalScoreFor, goalTokens } from '../../capture/scene';
import { frameHash } from '../../capture/frame-hash';
import { parseImageRequestsFromAnswer } from '../web-images-parse';
import { searchWebGround } from '../web-ground';
import { splitGoal } from '../split';
import { discoverApps, searchApps } from '../../apps/registry';
import { isValidEmail, isValidPhone } from '../../apps/deep-links';
import {
  describeToolForUI,
  executeTool,
  getToolDeclarations,
  TOOLS,
  type ToolDeclaration,
  type ToolExecutionContext,
} from '../tools';
import { getApprovalRequiredTools, isSmallPlainScroll } from '../tools/approval';
import {
  DOOM_STOP_AT,
  DOOM_WARN_AT,
  identicalStreak,
  isDoomLoop,
  SPILL_TRIGGER_CHARS,
  spillToolOutput,
  toolCallSignature,
} from '../tool-spill';
import { captureForeground, restoreForeground } from '../../input/focus';
import { refreshAgentTargetHwnd } from '../../capture/app-context';
import {
  estimateTokens,
  getMaxContextTokens,
  maskStaleObservations,
} from '../../memory/sessions';
import type {
  AgentContext,
  ProviderClient,
  ProviderId,
  ProviderRoundResult,
  RequestRequirements,
  StreamHandlers,
} from './types';
import { ProviderHttpError, shouldRetryStatus } from './types';
import { getAllProviders, getProvider, PROVIDER_ORDER } from './registry';
import { localaiChipsProvider } from './localai';
import { makeStreamCleaner, stripTemplateTokens } from '../stream-clean';
import { extractMermaidCode, validateMermaidCode } from '../mermaid-validate';
import { compactForBudgetKeepLast } from '../compact-history';
import { roundFuseMs } from '../models';
import { runWithRoundRetries, noteAIActivity } from './round-retry';
import type { TemplateId } from '../../types';
import { parseAnnotations, setCurrentPointGeo, type PointGeo } from '../point';
import { setCurrentImage } from '../current-image';
import { isVisionBridgeEnabled } from '../vision-bridge';
import { sanitizeMessagesPayload } from '../secret-redact';
import { verifyActionClaims } from '../claim-verify';
import {
  isAllErrorStreakHit,
  isBadInputStreakHit,
  isIdenticalStallHit,
  nextAllErrorStreak,
  nextBadInputStreak,
  nextIdenticalStallCount,
  toolRoundFingerprint,
} from '../loop-guards';
import { classifyError } from './error-classify';
import {
  circuitAllows,
  cooldownRemainingMs,
  partitionCooling,
  recordProviderFailure,
  recordProviderSuccess,
  recordTtft,
} from './circuit';

export type StreamHandle = { cancel: () => void };

// Deterministic JSON serialization with object keys sorted, so tool-call
// dedup keys match regardless of the argument order the model emitted.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// Tools whose repeated invocation with mutated args is almost always a model
// loop (it re-writes the same artifact) rather than legitimate distinct work.
// launch_app / system_action got added after the 5x-calendar incident: a weak
// model re-emitting "add to my calendar" under slightly different wording
// must be capped instead of spamming external apps. run_command is DELIBERATELY
// excluded: mutated shell commands are usually distinct steps of one job
// (find file → check tools → compress), and capping them kills real tasks.
// Identical repeats are still caught by the doom-loop guard; failures still
// cap per key. open_url stays unguarded — "open these 5 links" is legit.
const REPEAT_GUARDED_TOOLS = new Set([
  'save_document',
  'launch_app',
  'system_action',
]);
export const MAX_RUNS_PER_GUARDED_TOOL = 3;

// Info-lookup budget per run. History: 3 -> 6 -> 24; kept at 24 (>=6).
export const MAX_INFO_LOOKUPS_PER_RUN = 24;

// A completed agent run: the full message history (threaded forward for
// multi-part runs), the final cleaned answer, and whether the goal was
// actually accomplished (the status drives stop-on-failure between parts and
// the caller's honesty handling — never a user-facing checklist).
export type AgentRunResult = {
  messages: Message[];
  answer: string;
  status: 'done' | 'failed';
};

// Tracks whether the user's goal (a real on-screen action) was satisfied by
// an executed ui_click whose target name matched the goal tokens.
type GoalState = {
  done: boolean;
  name?: string;
  attempted: boolean;
  // The user DECLINED the goal click's approval prompt. Distinct from
  // `attempted`: the click was never tried because the user said no, so the
  // honesty gate must NOT treat the run as failed and must keep the model's
  // written answer.
  declined: boolean;
};

// Verbs that mark a goal as "do something on screen". The honesty gate only
// fires for these: "click download now" gets goal tokens + an action verb,
// while a follow-up like "ok" gets neither and never forces a click. The set
// is deliberately broader than just "click": a goal that says "create a
// folder", "make a table", "add a reminder", "delete that file" or "remove
// this row" is a real on-screen action and must not be accepted as done
// without anything actually having happened.
const ACTION_GOAL_VERBS = new Set([
  'click', 'press', 'tap', 'select', 'choose', 'open', 'download', 'install',
  'start', 'submit', 'get', 'grab', 'launch', 'hit', 'close', 'confirm',
  'continue', 'sign', 'log', 'register', 'buy',
  'create', 'make', 'add', 'remove', 'delete', 'type', 'write', 'send',
  'save', 'print', 'move', 'copy', 'paste', 'rename', 'edit', 'update',
  'setup', 'configure', 'turn', 'enable', 'disable', 'play', 'stop', 'pause',
  'mute', 'unmute', 'upload', 'uninstall', 'logout', 'reply',
]);

// Verbs that unambiguously mean a real on-screen action EVEN when they appear
// mid-sentence ("... then click the Download button", "please download the
// file"). Everything else in ACTION_GOAL_VERBS ("start", "get", "make",
// "create", …) is far too common in prose to match anywhere — those only count
// as a leading imperative. Kept small on purpose: a false negative here only
// delays the honesty gate (direct tool routing still handles the goal), while a
// false positive clobbers a good answer with a fake click failure.
const STRONG_ACTION_VERBS = new Set([
  'click', 'press', 'tap',
  'download', 'install', 'uninstall', 'launch',
  'type', 'paste', 'copy', 'delete',
  'submit', 'send', 'buy', 'reply', 'logout',
]);

// Polite lead-ins that precede a real imperative — the verb after them still
// counts ("please download the file", "can you open spotify"). Without this,
// "can you open spotify" (an imperative in disguise, NOT a question) would
// escape the honesty gate.
const GOAL_LEAD_FILLER_RE =
  /^(?:please|kindly|just|simply|can you|could you|would you|will you|i want you to|i need you to|i'd like you to|help me|do me a favor and)\s+/i;

// Read-only / observation tools: they never count as "having taken action".
// A model that only calls these (then claims success) trips the honesty gate.
const READ_ONLY_TOOLS = new Set([
  'ui_read',
  'see_screen',
  'read_clipboard',
  'read_table',
  'fetch_url',
  'web_search',
  'list_apps',
  'search_web',
  'wait',
]);

// Information lookups that put their result into the conversation. A round
// that only ran these must be pushed straight to writing the final answer —
// re-running one of them is the classic loop that ends in a degenerate
// one-liner like "I can find images of a cow for you." Deliberately excludes
// wait / ui_read / see_screen: waiting or observing is mid-task, not done.
const INFO_TOOLS = new Set([
  'search_web', 'fetch_url', 'web_search', 'list_apps', 'read_clipboard', 'read_table',
]);

// Did the USER (not the model) explicitly ask for pictures? Narrow — only
// their literal words. The [IMAGE] subject lines are the only way real
// pictures reach the answer; when the user asked for them and the model still
// wrote none, the router nudges once (see runAgenticLoopWithProvider).
const WANTS_IMAGES_RE = /\b(images?|pictures?|photos?|pics?|pic)\b/i;

function userExplicitlyWantsImages(goal: string): boolean {
  return WANTS_IMAGES_RE.test(goal ?? '');
}

// A read-only info lookup (search_web, fetch_url, …) already succeeded this
// run — its result is in the conversation, so an announced search is no longer
// unfulfilled and grounding again would be wasteful.
function infoToolSucceeded(done: Map<string, string>): boolean {
  return [...done.keys()].some((key) =>
    ['search_web', 'fetch_url', 'web_search', 'list_apps', 'read_clipboard', 'read_table'].some((name) =>
      key.startsWith(name + '\n'),
    ),
  );
}

// The final text ANNOUNCES a web search / lookup without ever executing it —
// the classic weak-model degenerate ("I need to perform a web search…"). The
// router completes the announced intent instead of finalizing the narration.
const ANNOUNCED_RESEARCH_RE =
  /\b(?:i (?:need|will|'ll|have|would|should|'m going to|am going to) to (?:perform|do|run|conduct|carry out|start|use|try) a? ?(?:web |online |internet |google )?search\b|i (?:will|'ll|'m going to|am going to|need to|should|want to) (?:search|look up|look it up|google|research)\b|let me (?:search|look up|google|research|find it)\b|searching (?:the web|online)\b)/i;

function announcedResearchIntent(text: string): boolean {
  return ANNOUNCED_RESEARCH_RE.test(text);
}

// Best subject for the completed search: whatever the narration names right
// after "search for/about", else the user's own goal cleaned of request
// filler words. The user's goal is the reliable fallback — it IS the query.
function extractResearchQuery(text: string, goal: string): string {
  const named = text.match(
    /\bsearch(?:ing)? (?:the web|online|for|about)\s+["']?([A-Za-z0-9][^"'\n.,;]{1,80})/i,
  );
  if (named) return named[1].replace(/\s+/g, ' ').trim().slice(0, 80);
  return (
    goal
      .replace(
        /\b(show me|give me|find|get|search for|some|a|an|the|of|and|pictures?|photos?|images?|please|tell me about|tell me|about|what is|what are|i want|i need|can you)\b/gi,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'the user asked about'
  );
}

// Actions that change the on-screen state and therefore invalidate any cached
// ui_read result. After any of these succeeds the next ui_read must re-walk
// the live accessibility tree instead of replaying the old element list.
const SCREEN_CHANGING_TOOLS = new Set([
  'click', 'ui_click', 'double_click', 'drag',
  'type_text', 'press_key', 'scroll',
  'open_url', 'launch_app', 'system_action', 'run_command',
]);

// Is the goal an on-screen action request rather than a question or a plain
// info request? Question-shaped goals ("how do I open settings", "what does
// this button do") must NOT trip the honesty gate — answering them in text is
// correct. The gate only cares about imperative/action requests.
//
// Verbs match as WHOLE WORDS (`\b` boundaries), not substrings — otherwise
// "explain fuzzy logic" trips the gate because "logic" contains the verb "log".
// A verb only counts when it LEADS the goal as an imperative ("click download
// now", "add dinner to my calendar"), optionally after a polite lead-in
// ("please open spotify", "can you download the file"). Verbs like
// "start"/"get"/"make"/"create" appear constantly in prose ("draw a flowchart
// from start to finish", "make sure", "get the results") and must never trip
// the gate from mid-sentence: matching `\bstart\b` anywhere used to clobber a
// perfectly good [MERMAID] diagram answer with a fake click failure. Only an
// unambiguous screen-action word (STRONG_ACTION_VERBS) still counts
// mid-sentence.
function goalRequestsAction(goal: string): boolean {
  const t = goal.toLowerCase().trim();
  if (/\?\s*$/.test(t)) return false;
  if (/^(how (do i|do you|to|does|can i|can you)|what (is|are|does|do|can))/.test(t)) return false;
  const words = t
    .replace(GOAL_LEAD_FILLER_RE, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length > 0 && ACTION_GOAL_VERBS.has(words[0])) return true;
  return words.some((w) => STRONG_ACTION_VERBS.has(w));
}

// Is the CURRENT turn shaped like a question? A question-shaped prompt must
// never be treated as an on-screen action request — the model answering it in
// text is the correct outcome. This is judged on the current prompt alone, NOT
// the merged session goal: the merged text can carry an action verb from an
// earlier turn ("create a table ... what laptops does msi sell" still contains
// "create"), which would otherwise trip the honesty gate and have the router
// clobber a reasonable text answer with a click failure.
//
// Deliberately narrow: a trailing "?" or a leading WH-word marks a question.
// "can you open spotify" is NOT one — it names a real action, so the gate must
// still hold it to account ("can you" without "?" is an imperative in disguise,
// exactly the shape the weak model answers with "done!" and no action).
function promptIsQuestion(prompt: string): boolean {
  const t = (prompt ?? '').toLowerCase().trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return /^(what|which|who|whom|whose|how|why|when|where)\b/.test(t);
}

// Should the honesty gate force an action for this run? Off entirely when the
// current turn is a question. Otherwise the merged goal's verbs decide.
function wantsClickFor(ctx: AgentContext): boolean {
  if (promptIsQuestion(ctx.originalPrompt)) return false;
  const goal = goalForMatch(ctx);
  return goalTokens(goal).length > 0 && goalRequestsAction(goal);
}

// Goal text for matching click targets: the session's original request plus
// the current turn's prompt. Follow-ups like "ok" add nothing meaningful but
// the session goal keeps "download" / the product name alive.
function goalForMatch(ctx: AgentContext): string {
  const goal = (ctx.sessionGoal || '').trim();
  const prompt = (ctx.originalPrompt || '').trim();
  if (!goal) return prompt;
  if (!prompt || prompt === goal) return goal;
  // When the raw prompt already contains the extracted goal, use the prompt
  // alone — joining both duplicates it ("add dinner to my calendar add dinner
  // to my calendar"), which corrupts things like the calendar event title.
  if (prompt.toLowerCase().includes(goal.toLowerCase())) return prompt;
  return `${goal} ${prompt}`;
}

// An ANNOTATION-request turn: the user (this turn or the session goal) asked to
// point/box/arrow/tag/tour/explain something VISIBLE. Mirrors the screen-
// annotation skill's hard triggers. These turns must end with [POINT]/[BOX]/
// [ARROW] tags drawable against the attached screenshot — never with a
// see_screen/ui_read loop or a "I need to see the screen first" refusal. The
// session goal is included so follow-ups like "continue"/"start" keep the
// nudging alive.
function wantsAnnotationFor(ctx: AgentContext): boolean {
  const ANNOTATE_INTENT_RE =
    /annotat|explain|point(?:ing)?|box(?:ing)?|arrow|highlight|outline|mark ?up|label|tour|tag |draw on|draw it|walk me through|what is this|break this down|screen in detail/i;
  const goal = ((ctx.sessionGoal || '') + ' ' + (ctx.originalPrompt || '')).trim();
  if (!goal) return false;
  return ANNOTATE_INTENT_RE.test(goal);
}

// Direct routing: goals that map 1:1 to an intent / app tool
//
// When the honesty gate fires and the model claims "done" without acting, some
// goals are a single, well-defined tool call waiting to happen: "open spotify",
// "email sarah@x.com", "directions to the airport", "find coffee near me",
// "add dinner to my calendar tomorrow". For those the router executes the
// matching tool DIRECTLY (with the normal approval flow) instead of asking the
// model to re-derive it — the model that just lied is unlikely to produce the
// right call now. If nothing matches, the router falls back to clicking the
// goal-matching element on screen.

type DirectGoalAction =
  | { tool: 'open_url'; args: { url: string } }
  | { tool: 'launch_app'; args: { app: string } }
  | { tool: 'system_action'; args: { kind: 'email'; recipient: string; subject?: string } }
  | { tool: 'system_action'; args: { kind: 'call_whatsapp'; phone: string; message?: string } }
  | { tool: 'system_action'; args: { kind: 'map_directions'; destination: string } }
  | { tool: 'system_action'; args: { kind: 'map_search'; query: string } }
  | {
      tool: 'system_action';
      args: { kind: 'calendar_event'; title: string; start?: string; end?: string; allDay?: boolean };
    };

// Filler words stripped from an app name extracted out of "open the settings".
const APP_NAME_FILLER = /\b(?:the|a|an|app|application|please|now|then|for me|right away)\b/gi;

function cleanAppName(raw: string): string {
  return raw
    .replace(APP_NAME_FILLER, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。]+$/g, '');
}

function cleanTail(raw: string): string {
  return raw
    .replace(/\b(?:please|now|then|right away)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。]+$/g, '');
}

// A concise event title from a calendar-shaped goal ("add a meeting with the
// team tomorrow at 2pm to my calendar" → "meeting with the team"). Imperfect
// is fine — the pre-filled form is user-editable.
function calendarTitleFromGoal(goal: string): string {
  const cleaned = goal
    .replace(/\b(?:add|create|make|schedule|set|put|book)\s+(?:a|an|the|this|that)?\s*(?:to|on|for)?\s*/i, ' ')
    .replace(
      /\b(?:to|on|for|into|in|my|the|a|an|calendar|meeting|appointment|event|reminder|remind|me|please|tomorrow|today|tonight|next|this|at|am|pm)\b/gi,
      ' ',
    )
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2})?\b/g, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。]+$/g, '');
  return (cleaned || goal.trim()).slice(0, 60);
}

// Pull an ISO date/datetime out of a calendar-shaped goal ("2026-08-17" or
// "2026-08-17 14:00"). Time → 1h slot; date only → all-day event.
function extractIsoDate(goal: string): { start?: string; end?: string; allDay?: boolean } {
  const m = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?\b/.exec(goal);
  if (!m) return {};
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] !== undefined) {
    const h = Number(m[4]);
    const start = `${date}T${String(h).padStart(2, '0')}:${m[5]}`;
    const end = `${date}T${String((h + 1) % 24).padStart(2, '0')}:${m[5]}`;
    return { start, end, allDay: false };
  }
  return { start: date, allDay: true };
}

function emailSubjectFromGoal(goal: string): string {
  const rest = goal.replace(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}\s*/i, '');
  return cleanTail(
    rest.replace(/\b(?:email|e-?mail|about|regarding|re|subject|write|send|draft|reply|to|a|an|the|please)\b/gi, ' '),
  );
}

// Map the user's goal to a single well-defined tool call, or null when the goal
// does not clearly name one. Conservative on purpose: a misfire runs an
// approval-required tool, so nothing is invented — "open X" only launches when
// the app is really in the registry, an email only when a real address appears,
// a phone message only when a real phone number plus an intent verb appears.
async function directGoalCall(goal: string): Promise<DirectGoalAction | null> {
  const g = goal.trim();
  if (!g) return null;

  // 1. Bare URL, or "open / go to <url>".
  const urlMatch = g.match(/(?:https?:\/\/|www\.)[^\s]+/i);
  if (urlMatch) {
    const bare = urlMatch[0].length === g.length;
    if (bare || /^(?:open|go to|visit|launch|take me to)\b/i.test(g)) {
      const raw = bare ? g : urlMatch[0];
      return { tool: 'open_url', args: { url: raw.startsWith('www.') ? `https://${raw}` : raw } };
    }
  }

  // 2. Email with a real address and an email-ish verb.
  const email = /[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/i.exec(g)?.[0];
  if (email && isValidEmail(email) && /^(?:email|e-?mail|send|write|draft|reply)\b/i.test(g)) {
    return {
      tool: 'system_action',
      args: { kind: 'email', recipient: email, subject: emailSubjectFromGoal(g) || undefined },
    };
  }

  // 3. WhatsApp / phone message. A goal that STARTS with an ISO date is a
  // calendar-ish string, never a number to dial.
  if (!/^\d{4}-\d{2}-\d{2}/.test(g)) {
    const phone = /\+?[0-9][0-9\s().-]{6,18}/.exec(g)?.[0];
    if (phone && isValidPhone(phone) && /\b(?:whatsapp|text|sms|message|call|dial)\b/i.test(g)) {
      return { tool: 'system_action', args: { kind: 'call_whatsapp', phone: phone.trim() } };
    }
  }

  // 4. Maps directions.
  const dir =
    /^(?:navigate|(?:get\s+)?directions|route|turn-by-turn)\s+(?:to\s+|for\s+)?(.+)$/i.exec(g) ??
    /\b(?:directions|navigate|route)\s+to\s+(.+)$/i.exec(g);
  if (dir && cleanTail(dir[1]).length > 0) {
    return { tool: 'system_action', args: { kind: 'map_directions', destination: cleanTail(dir[1]) } };
  }

  // 5. "find X near me".
  const near = /^find\s+(.+?)\s+near\s+(?:me|here)\b/i.exec(g);
  if (near) {
    return { tool: 'system_action', args: { kind: 'map_search', query: near[1].trim() } };
  }

  // 6. Calendar / reminder.
  if (
    /^(?:add|create|make|schedule|set|put|book|remind)\b/i.test(g) &&
    /\b(?:calendar|meeting|appointment|event|reminder|remind)\b/i.test(g)
  ) {
    return {
      tool: 'system_action',
      args: { kind: 'calendar_event', title: calendarTitleFromGoal(g), ...extractIsoDate(g) },
    };
  }

  // 7. App launch — only when the name resolves in the live registry.
  const app = /^(?:open|start|launch|run)\s+(.+)$/i.exec(g)?.[1];
  if (app) {
    const name = cleanAppName(app);
    if (!name) return null;
    const apps = await discoverApps();
    const match = searchApps(apps, name, 1)[0];
    if (match) return { tool: 'launch_app', args: { app: match.name } };
  }

  return null;
}

// Canonicalize tool-call args for dedup so the same intent under different
// formatting still matches ("open Spotify" == "open  spotify"), calendar times
// are ignored (re-adding the same event title is a loop), and phone numbers
// compare by digits only.
function normalizedKeyArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (v: unknown) => String(v ?? '').trim().toLowerCase();
  if (name === 'launch_app') return { app: str(args.app) };
  if (name === 'system_action') {
    const kind = str(args.kind);
    const out: Record<string, unknown> = { kind };
    if (kind === 'calendar_event') {
      out.title = str(args.title);
      if (args.location) out.location = str(args.location);
    } else if (kind === 'email') {
      if (args.recipient) out.recipient = str(args.recipient);
      if (args.subject) out.subject = str(args.subject);
    } else if (kind === 'call_whatsapp') {
      if (args.phone) out.phone = String(args.phone).replace(/[^+0-9]/g, '');
    } else if (kind === 'map_directions' || kind === 'map_search') {
      const key = kind === 'map_directions' ? 'destination' : 'query';
      if (args[key]) out[key] = str(args[key]);
    }
    return out;
  }
  return args;
}

function keyFor(name: string, args: Record<string, unknown>): string {
  return `${name}\n${stableStringify(normalizedKeyArgs(name, args))}`;
}

// Execute a directly-routed goal action with the normal approval flow, pushing
// the assistant tool call + tool result into the conversation so history stays
// coherent. Returns whether the goal tool ran, was declined, or nothing matched.
// An action already attempted this run is never re-attempted ('none'), and a
// declined action is remembered so the loop never asks again.
async function tryDirectToolForGoal(
  ctx: AgentContext,
  handlers: StreamHandlers,
  goalState: GoalState,
  messages: Message[],
  declinedCalls: Set<string>,
  directAttempted: Set<string>,
  done: Map<string, string>,
  execCountByName: Map<string, number>,
  lastSuccessByName: Map<string, string>,
  failedAttempts: Map<string, number>,
): Promise<'acted' | 'declined' | 'failed' | 'none'> {
  const action = await directGoalCall(goalForMatch(ctx));
  if (!action) return 'none';
  const { tool, args } = action;
  const key = keyFor(tool, args);
  if (declinedCalls.has(key) || directAttempted.has(key) || done.has(key)) return 'none';
  directAttempted.add(key);
  const id = `direct-goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const label = describeToolForUI(tool, args);
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: tool, arguments: JSON.stringify(args) },
      },
    ],
  });
  const approved = await ctx.requireToolApproval(id, tool, args);
  if (!approved) {
    declinedCalls.add(key);
    goalState.declined = true;
    console.warn(`[agentic] direct goal action declined: ${label}`);
    handlers.onToolStart(id, label, tool, args);
    handlers.onToolEnd(id, tool, false, 'User declined this action.');
    messages.push({ role: 'tool', tool_call_id: id, content: 'User declined this action.' });
    return 'declined';
  }
  console.log(`[agentic] direct goal action: ${label}`);
  handlers.onToolStart(id, label, tool, args);
  const result = await executeTool(tool, args, ctx);
  const ok = !result.startsWith('Error:');
  handlers.onToolEnd(id, tool, ok, summarizeOk(result));
  messages.push({ role: 'tool', tool_call_id: id, content: result });
  if (!ok) {
    goalState.attempted = true;
    // Mark the call as exhausted so a model that repeats it later gets the
    // give-up-skipped treatment instead of a fresh approval prompt for an
    // action that already failed.
    failedAttempts.set(key, 999);
    console.warn(`[agentic] direct goal action failed: ${label}`);
    return 'failed';
  }
  // Record the direct action in the SAME bookkeeping the tool loop uses, so a
  // model that re-emits the identical call later gets its result replayed
  // (dedup / capped) instead of triggering a second approval prompt.
  done.set(key, result);
  execCountByName.set(tool, (execCountByName.get(tool) ?? 0) + 1);
  lastSuccessByName.set(tool, result);
  // An external window just opened — point the agent's next ui_read/see_screen
  // at it instead of the trigger-time one.
  if (tool === 'open_url' || tool === 'launch_app' || tool === 'system_action' || tool === 'run_command') {
    void refreshAgentTargetHwnd();
  }
  return 'acted';
}

// Pull the clicked element's label out of a ui_click result
// ("Clicked el2 (text "Download Now") at (933, 533)." → "Download Now").
function extractClickedName(result: string): string | null {
  const m = /Clicked el\d+[^"]*"([^"]+)"/.exec(result);
  return m ? m[1] : null;
}

// Find the element on the CURRENT screen (fresh scene, not a cached ui_read)
// whose label best matches the goal. Returns its id, label and center so the
// router can click it directly — no reliance on the model having called
// ui_read or picked the right id.
async function goalClickCandidate(ctx: AgentContext): Promise<{
  id: string;
  label: string;
  center: [number, number];
} | null> {
  const goal = goalForMatch(ctx);
  const tokens = goalTokens(goal);
  if (tokens.length === 0) return null;
  try {
    const scene = await buildScene();
    if (scene.unavailable || scene.elements.length === 0) return null;
    const menu = buildClickTargetsMenu(scene, 6, goal);
    const hit = menu.find((e) => goalScoreFor(e.name, tokens) > 0) ?? null;
    if (!hit) return null;
    return { id: hit.id, label: hit.name, center: hit.center };
  } catch {
    return null;
  }
}

// Click the goal-matching element directly, with the normal approval flow.
// Pushes the assistant tool call + tool result into the conversation so the
// history stays coherent for later rounds / parts. Returns whether the click
// succeeded; on success the goal is marked done.
async function tryGoalClick(
  ctx: AgentContext,
  handlers: StreamHandlers,
  goalState: GoalState,
  messages: Message[],
): Promise<boolean> {
  const candidate = await goalClickCandidate(ctx);
  if (!candidate) {
    console.warn('[agentic] goal click requested but no matching element on screen');
    goalState.attempted = true;
    return false;
  }
  const approved = await ctx.requireToolApproval('goal-click', 'ui_click', { id: candidate.id });
  if (!approved) {
    console.warn('[agentic] goal click declined by user');
    goalState.attempted = true;
    goalState.declined = true;
    return false;
  }
  const label = `Clicking the "${candidate.label}" button`;
  console.warn(`[agentic] goal-click: ${label} (${candidate.id})`);
  handlers.onToolStart('goal-click', label, 'ui_click', { id: candidate.id });
  const result = await executeTool('ui_click', { id: candidate.id }, ctx);
  const ok = !result.startsWith('Error:');
  console.log(`[agentic] goal-click ${candidate.id} -> ${summarizeOk(result)}`);
  handlers.onToolEnd('goal-click', 'ui_click', ok, summarizeOk(result));
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'goal-click',
        type: 'function',
        function: { name: 'ui_click', arguments: JSON.stringify({ id: candidate.id }) },
      },
    ],
  });
  messages.push({ role: 'tool', tool_call_id: 'goal-click', content: result });
  if (ok) {
    goalState.done = true;
    goalState.name = candidate.label;
    return true;
  }
  goalState.attempted = true;
  // Retry note: tell the model the click failed so its next round looks at the
  // fresh screen instead of repeating the same assumption.
  messages.push({
    role: 'user',
    content:
      `The attempt to click "${candidate.label}" failed. Look at the current screen again ` +
      '(see_screen or ui_read) and try a different way — the button may have moved or not loaded yet.',
  });
  return false;
}

// Turn accumulated stream text into the final answer with an honesty check:
// when the user asked for a real on-screen action and NO action actually
// succeeded, the run is marked 'failed' and the answer is replaced with an
// honest "I could not do that" message instead of letting the model claim
// success it never performed.
function fallbackAnswer(goalState: GoalState, sawAction: boolean, goal: string): string {
  // The user (or the model's own report) declined the one action needed and
  // nothing else ran: say so plainly instead of re-litigating or inventing a
  // broken-tool excuse. Plain ASCII only — the em-dash mangles to "ΓÇö" in
  // some console codepages.
  if (goalState.declined && !sawAction) {
    return (
      `I couldn't "${goal.slice(0, 80)}": the action was declined, so nothing was done. ` +
      'Let me know if you would like to try a different way.'
    );
  }
  return 'I could not complete that automatically. Try asking again, or tell me the exact step you want done.';
}

// The one universal failure message. It fits every case the router can end a
// run in — a click that found no target, an action that genuinely failed, or a
// model that never produced a usable answer — so a user never sees the wrong
// failure for the situation again (the old "click the Download Now button"
// example was specific to exactly one scenario). The phrasing keeps the
// "could not complete" anchor the router tests assert on.
const GENERIC_FAILURE_ANSWER =
  'I could not complete that automatically. Try asking again, or tell me the exact step you want done.';

function finalizeRun(
  accumulatedText: string,
  ctx: AgentContext,
  goalState: GoalState,
  sawAction: boolean,
): { answer: string; status: 'done' | 'failed' } {
  let finalText = cleanFinalAnswer(accumulatedText);
  if (finalText.trim().length === 0) {
    finalText = fallbackAnswer(goalState, sawAction, goalForMatch(ctx));
    console.warn('[agentic] final was tool-junk; substituted fallback answer');
  }
  const wantsClick = wantsClickFor(ctx);
  // Defense-in-depth: even if the honesty gate conditions are met, preserve
  // the answer when the model delivered real structured content. A [MERMAID]
  // diagram, [UI] card, or [QUESTIONS] wizard IS the answer — replacing it
  // with GENERIC_FAILURE_ANSWER would discard actual work. Also preserves
  // substantial prose (>200 chars) that the model generated as a response.
  const hasRealContent =
    /\[(?:MERMAID|UI|QUESTIONS)\]/i.test(finalText) ||
    finalText.trim().length > 200;
  const status: 'done' | 'failed' =
    wantsClick && !goalState.done && !sawAction && !goalState.declined && !hasRealContent
      ? 'failed'
      : 'done';
  if (status === 'failed') {
    finalText = GENERIC_FAILURE_ANSWER;
  }
  return { answer: finalText, status };
}

export type StreamOptions = {
  web?: boolean;
  templateId?: TemplateId;
  // Hook so the router can ask the renderer for approval before a destructive
  // tool runs. Returning false aborts that tool with a benign "user declined"
  // message but the conversation continues.
  requestToolApproval?: (
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;
  // Pre-built message history for multi-turn sessions. When provided the
  // router skips the initial buildMessages call and uses this as-is.
  existingMessages?: Message[];
};

// Build the prioritized list of providers the user has actually configured.
// Order is fixed; presence and `enabled` is the user's choice.
//
// Provider keys live in safeStorage and decrypt lazily. We pull
// each enabled provider's plaintext key here (query time) rather than
// during settings load. On macOS this is where the keychain prompt
// fires for users with a saved key — once per session, with the user
// having actively triggered a query, which is the right UX moment.
// Returned alongside the chain so the caller can distinguish "no key
// configured" from "key exists on disk but decryption failed" — the
// former needs the user to open Settings, the latter needs them to
// retry keychain access or re-enter their key.
export type ChainResolution = {
  chain: Array<{ provider: ProviderClient; apiKey: string }>;
  hadConfiguredKeyButFailed: boolean;
  failureKind: ReturnType<typeof getLastDecryptFailure>;
};

export function resolveProviderChain(): ChainResolution {
  resetDecryptFailure();
  const settingsLight = getSettingsLight();
  const chain: Array<{ provider: ProviderClient; apiKey: string }> = [];
  let hadConfiguredKeyButFailed = false;
  for (const id of PROVIDER_ORDER) {
    const cfg = settingsLight.providers[id];
    if (!cfg || !cfg.enabled) continue;
    // Local servers (Local AI / opencode) are configured by their base URL,
    // not by an API key (which is optional). Skip the key-chain logic entirely;
    // a non-empty base URL is enough to call.
    if (id === 'localai' || id === 'opencode') {
      if (!(cfg.baseUrl ?? '').trim()) continue;
      chain.push({ provider: getProvider(id), apiKey: '' });
      continue;
    }
    if (!cfg.hasKey) continue;
    const apiKey = getDecryptedProviderKey(id);
    if (!apiKey) {
      // Provider IS configured (hasKey true, enabled) but the key
      // wasn't readable. Track this so the user-facing error is
      // actionable instead of generic.
      hadConfiguredKeyButFailed = true;
      continue;
    }
    chain.push({ provider: getProvider(id), apiKey });
  }
  // Cooldown ordering: providers on an open circuit sink to the back of the
  // chain (relative order otherwise preserved) so a fresh query starts on a
  // healthy lane instead of re-burning retries against a dead one.
  return {
    chain: partitionCooling(chain, (e) => e.provider.id),
    hadConfiguredKeyButFailed,
    failureKind: getLastDecryptFailure(),
  };
}

// The provider chain that produces "Suggest actions" chips. When the user
// keeps the default (`chipsUseMainProvider` true) this IS the main chain —
// chips then cost nothing extra and share the main provider's health. When
// the user configured a chips-only provider set in Settings (Behaviour →
// Suggest actions), the chain is built from THAT map instead, so the cheap
// text-only chip call can use a different key/model without touching the
// main provider config. Same order + enabled/hasKey rules as the main chain.
export function resolveChipsProviderChain(): ChainResolution {
  resetDecryptFailure();
  const { useMain, providers } = getChipsSettingsLight();
  if (useMain) return resolveProviderChain();
  const chain: Array<{ provider: ProviderClient; apiKey: string }> = [];
  let hadConfiguredKeyButFailed = false;
  for (const id of PROVIDER_ORDER) {
    const cfg = providers[id];
    if (!cfg || !cfg.enabled) continue;
    if (id === 'localai' || id === 'opencode') {
      if (!(cfg.baseUrl ?? '').trim()) continue;
      // The chips chain targets the chips-only Local AI slot: use the
      // provider instance whose pickModel/runRound read chipsLocalAiConfig
      // (the main localaiProvider would silently hit the main server).
      chain.push({ provider: id === 'localai' ? localaiChipsProvider : getProvider(id), apiKey: '' });
      continue;
    }
    if (!cfg.hasKey) continue;
    const apiKey = getDecryptedChipsProviderKey(id);
    if (!apiKey) {
      hadConfiguredKeyButFailed = true;
      continue;
    }
    chain.push({ provider: getProvider(id), apiKey });
  }
  return {
    chain: partitionCooling(chain, (e) => e.provider.id),
    hadConfiguredKeyButFailed,
    failureKind: getLastDecryptFailure(),
  };
}

// Plain single-round completion (no tools, no agentic loop). Walks the same
// configured provider chain as streamCompletion and returns the model's text.
// Used by background helpers (context memory extraction) that need a short
// LLM answer but not the full agent pipeline.
export async function runPlainCompletion(
  messages: Message[],
  opts: { tier?: 'fast' | 'capable' } = {},
): Promise<string> {
  const { chain, hadConfiguredKeyButFailed } = resolveProviderChain();
  if (chain.length === 0) {
    if (hadConfiguredKeyButFailed) {
      throw new Error('Could not read your stored API key. Open /settings and re-paste it.');
    }
    throw new Error('No provider configured. Add an API key, a Local AI server, or Opencode in /settings.');
  }
  const req: RequestRequirements = {
    web: false,
    vision: false,
    allowTools: false,
    tier: opts.tier ?? 'capable',
  };
  let firstError: unknown = null;
  let attemptsTried = 0;
  for (const { provider, apiKey } of chain) {
    if (!circuitAllows(provider.id)) {
      const wait = Math.ceil(cooldownRemainingMs(provider.id) / 1000);
      console.warn(`[router] ${provider.id} cooling down (${wait}s left); trying next provider`);
      firstError = new Error(
        `${provider.displayName} is cooling down after repeated failures (retry in ${wait}s).`,
      );
      continue;
    }
    attemptsTried++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), roundFuseMs(provider.id));
    try {
      const model = provider.pickModel(req);
      const round = await runWithRoundRetries(provider.id, controller.signal, () =>
        provider.runRound(
          model,
          messages,
          apiKey,
          undefined,
          controller.signal,
          () => {},
        ),
      );
      clearTimeout(timeout);
      const text = round.contentText.trim();
      if (text) {
        recordProviderSuccess(provider.id);
        return text;
      }
      recordProviderFailure(provider.id);
      firstError = new Error(`${provider.displayName} returned an empty response.`);
      continue;
    } catch (err) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        // Round-fuse timeout (this controller is only aborted by its own
        // fuse) — the provider hung; count it against the breaker.
        recordProviderFailure(provider.id);
        firstError = err;
        continue;
      }
      if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
        // Auth failures stop the chain — retrying just burns quota.
        throw err;
      }
      if (err instanceof ProviderHttpError && shouldRetryStatus(err.status)) {
        // 429 trips the breaker immediately (rate limits don't recover in
        // the seconds a normal cooldown covers); 5xx/408/425 count toward
        // ALLOWED_FAILS.
        recordProviderFailure(provider.id, { instant: err.status === 429 });
        firstError = err;
        continue;
      }
      // Same no-fallback bug as the streaming path had: a dead server threw
      // out of the whole chain. Timeouts/network fail over; anything else
      // still throws immediately.
      const { code } = classifyError(err, provider.displayName);
      if (code === 'timeout' || code === 'network') {
        console.warn(`[router] ${provider.id} unreachable (${code}); trying next provider`);
        recordProviderFailure(provider.id);
        firstError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      throw err;
    }
  }
  if (attemptsTried === 0 && chain.length > 0 && firstError) {
    // Every configured provider is on an open circuit — surface that
    // instead of a generic "all providers failed".
    throw firstError instanceof Error ? firstError : new Error('All providers are cooling down.');
  }
  throw firstError instanceof Error ? firstError : new Error('All providers failed.');
}

// Tool-surface pruning is deliberately CONSERVATIVE. The agent must never be
// prevented from acting because a heuristic guessed a tool "can't be relevant"
// — that is how hard-coded behaviours break real flows (a question that needs
// a lookup, a "reply" that turns out to need a web search). Two rules only:
//   - capability gating (no tools provider can't run);
//   - text-output templates (translate/improve/brief/define/identify) whose
//     system prompt MANDATES a pure-text deliverable and which therefore can
//     never legitimately operate the UI — dropping the UI-action schemas cuts
//     per-round tokens without ever preventing a real action.
function filterToolsForProvider(
  provider: ProviderClient,
  tools: ToolDeclaration[],
  req: RequestRequirements,
  templateId?: TemplateId,
): ToolDeclaration[] {
  if (!provider.supports('tools', req)) return [];
  let filtered = tools;
  // describe_region reads the screen through the vision bridge — it is dead
  // weight (and a guaranteed "not configured" round) when the bridge is off,
  // so never expose it then. VISION models blind to small text benefit from
  // it equally, so it stays up for them whenever the bridge is enabled.
  if (!isVisionBridgeEnabled()) {
    filtered = filtered.filter((t) => t.function.name !== 'describe_region');
  }
  if (templateId && TEXT_OUTPUT_TEMPLATES.has(templateId)) {
    return filtered.filter((t) => !TEXT_OUTPUT_TEMPLATE_DROPPED_TOOLS.has(t.function.name));
  }
  return filtered;
}

// Templates that produce ONLY a text deliverable: the model is told to output
// the translated / rewritten / briefed / defined text and nothing else, so no
// UI-action tool can ever be the legitimate next step.
const TEXT_OUTPUT_TEMPLATES = new Set<TemplateId>(['translate', 'improve', 'brief', 'define', 'identify']);
// The UI-action schemas pruned for text-output templates. Info/observation
// tools (web_search, fetch_url, ui_read, see_screen, wait, list_apps, …) stay
// — the model may still need to READ to answer, just never to ACT.
const TEXT_OUTPUT_TEMPLATE_DROPPED_TOOLS = new Set([
  'click', 'double_click', 'move_mouse', 'scroll', 'drag',
  'type_text', 'press_key', 'ui_click',
  'paste_table', 'paste_image',
  'system_action', 'run_command', 'launch_app', 'open_url',
  'set_volume', 'play_music', 'save_document', 'reveal_in_finder',
  'copy_to_clipboard', 'create_file', 'open_file',
]);

export function streamCompletion(
  userPrompt: string,
  imageB64: string,
  clip: string,
  handlers: StreamHandlers,
  options: StreamOptions = {},
): StreamHandle {
  const controller = new AbortController();
  // The submit screenshot is this run's reference image for describe_region
  // until a see_screen attaches a fresher one (setCurrentImage below).
  setCurrentImage(imageB64.length > 0 ? imageB64 : null);
  // Per-round watchdog, not a whole-run deadline. Armed right before each
  // provider round and disarmed once the round returns, so tool execution
  // and approval waits never count against it. A multi-step task can run for
  // minutes on a slow local model; a provider that hangs mid-round is still
  // cut off within ROUND_TIMEOUT_MS.
  // FAILOVER: each provider attempt gets a FRESH AbortController. The old
  // code reused one controller for the whole chain, so after a watchdog
  // timeout every later provider inherited the aborted signal and died
  // instantly — failover never actually worked. The outer controller still
  // carries user-cancel (✕ / /stop), forwarded into the live attempt.
  let timeout: NodeJS.Timeout | null = null;
  let liveController: AbortController = controller;
  // Fuse follows the CURRENT attempt's provider (set at the top of each
  // chain-loop iteration), so failover to a slower lane re-arms longer.
  let fuseMs = roundFuseMs();
  const setRoundTimeout = (): void => {
    if (timeout) clearTimeout(timeout);
    // Slow lanes get a longer fuse: free-proxy upstreams queue for minutes
    // before the first token, and the old fixed 150s killed working rounds
    // (then the retry died the same way). Per-provider, armed per round.
    timeout = setTimeout(() => liveController.abort(new Error('timeout')), fuseMs);
  };
  const clearRoundTimeout = (): void => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
  setRoundTimeout();

  (async () => {
    const { chain, hadConfiguredKeyButFailed, failureKind } = resolveProviderChain();
    if (chain.length === 0) {
      if (hadConfiguredKeyButFailed) {
        let msg: string;
        switch (failureKind) {
          case 'keychain-denied':
            msg = process.platform === 'darwin'
              ? 'Could not read API key from macOS Keychain. Quit Spirit, open Keychain Access, allow Spirit, then relaunch. Or open /settings and re-paste your key.'
              : 'Could not read your stored API key. Open /settings and re-paste it.';
            break;
          case 'keychain-unavailable':
            msg = 'OS keychain is unavailable. Open /settings to re-enter your API key. On Linux: ensure libsecret (gnome-keyring) or KWallet is installed.';
            break;
          case 'corrupt-ciphertext':
            msg = 'Your stored API key is corrupted. Open /settings and re-paste it.';
            break;
          default:
            msg = 'Could not read your API key. Open /settings and re-paste it.';
        }
        handlers.onError(msg);
      } else {
        handlers.onError(
          'No provider configured. Type /settings to add an OpenRouter, Anthropic, OpenAI, Google Gemini key, or a Local AI server address.',
        );
      }
      return;
    }

    const lightSettings = getSettingsLight();

    // Template-driven turns swap in a template-specific system prompt.
    // Otherwise the baseline system prompt applies.
    let systemPromptOverride: string | undefined;
    let tier: 'fast' | 'capable' = 'fast';
    let effectiveWeb = options.web ?? lightSettings.webSearch;
    if (options.templateId) {
      const tpl = getTemplate(options.templateId);
      systemPromptOverride = tpl.systemPrompt;
      if (options.web === undefined) effectiveWeb = tpl.preferWeb;
      // Templates that produce long-form output deserve the capable tier.
      if (tpl.id === 'summary' || tpl.id === 'explain' || tpl.id === 'code') tier = 'capable';
    }

    const baseRequirements: RequestRequirements = {
      web: effectiveWeb,
      vision: imageB64.length > 0,
      allowTools: true,
      tier,
    };

    // Profile data only leaves the device when the user has explicitly opted
    // in via the "Personalize prompts" toggle in Settings. Default is off so
    // a populated profile from a previous version is never sent to the chosen
    // provider without an affirmative consent action.
    const personalize = getSettings().personalizePrompts === true;
    const profile = personalize ? getSettings().userProfile : null;
    const profileLine =
      profile && (profile.name || profile.role || profile.preferredLanguage)
        ? `# User profile\nThe person using Spirit is${profile.name ? ` ${profile.name}` : ''}${
            profile.role ? `, a ${profile.role}` : ''
          }${
            profile.preferredLanguage
              ? `. Prefer replies in ${profile.preferredLanguage} unless the request itself is in another language.`
              : '.'
          } Address them naturally when relevant; don't repeat the profile back at them.`
        : undefined;

    // Context budget for this run: Auto (default) resolves from the head
    // provider's model window; manual settings value only when Auto is off.
    // Computed once — fallbacks reuse it, overflow still self-corrects.
    const contextCap = (() => {
      try {
        const head = chain[0];
        return getMaxContextTokens(head.provider.pickModel(baseRequirements), head.provider.id);
      } catch {
        return getMaxContextTokens();
      }
    })();

    let messages: Message[] =
      options.existingMessages && options.existingMessages.length > 0
        ? options.existingMessages
        : buildMessages(
            userPrompt,
            imageB64,
            clip,
            '',
            '',
            [],
            promptWithSkills(systemPromptOverride ?? SYSTEM_PROMPT, { prompt: userPrompt }),
            profileLine,
          );

    // Byte-budget compaction (multi-turn sessions only): when the retained
    // history would overflow the provider window, fold the OLD turns into a
    // compact digest instead of dropping them — context is preserved rather
    // than deleted. The system message (the memory block lives there) and the
    // current-query tail are never touched; first-turn builds are tiny and
    // pass through unchanged.
    try {
      const compacted = compactForBudgetKeepLast(messages, contextCap);
      if (compacted.compacted) {
        console.warn(
          `[router] history compacted: ${messages.length} messages -> ${compacted.messages.length}`,
        );
        messages = compacted.messages;
      }
    } catch (err) {
      console.warn(
        '[agentic] history compaction skipped:',
        err instanceof Error ? err.message : err,
      );
    }

    // Token-budget observability: the assembled context (system + history +
    // memory block) versus the user's configured budget. The handler already
    // truncated before passing existingMessages; the RAG memory block is
    // appended AFTER that truncation, so this is where an over-budget context
    // actually surfaces — a warning tells the user to raise maxContextTokens
    // instead of silently overflowing the provider window.
    try {
      const est = messages.reduce((s, m) => s + estimateTokens(m), 0);
      const cap = contextCap;
      if (est > cap) {
        console.warn(
          `[router] context ≈${est} tokens exceeds budget ${cap} — the provider window may overflow. ` +
            'Turn off Auto context and raise maxContextTokens in settings, or shorten the session.',
        );
      } else {
        console.log(
          `[router] context input ≈${est} tokens (${Math.round((est / cap) * 100)}% of budget ${cap})`,
        );
      }
    } catch {
      /* observability only — never fail a query over the budget check */
    }

    let accumulated = '';

    const ctx: AgentContext = {
      latestAssistantText: '',
      originalPrompt: userPrompt,
      // First user message carries the original request (the trigger prompt
      // for turn 1, or the session's opening request on resume turns). Keep
      // it as the session goal so follow-ups like "ok" still target it.
      sessionGoal: sessionGoalFrom(messages),
      abort: controller.signal,
      requireToolApproval: async (id, name, args) => {
        if (!options.requestToolApproval) return true;
        // Read-only tools are always allowed without prompting.
        if (!getApprovalRequiredTools().has(name)) return true;
        // Small plain scrolls are never declined (low-risk view motion).
        if (isSmallPlainScroll(name, args)) return true;
        return options.requestToolApproval(id, name, args);
      },
    };

    let firstError: unknown = null;
    let attemptsTried = 0;

    // Terminal for a run that may already have text on screen. Committing the
    // partial and offering Continue beats throwing away a long answer for a
    // transient upstream fault.
    const failRun = (message: string, code?: unknown): void => {
      if (accumulated.trim() && handlers.onInterrupted) {
        handlers.onInterrupted(message, code, accumulated);
      } else {
        handlers.onError(message, code);
      }
    };

    for (const { provider, apiKey } of chain) {
      if (!circuitAllows(provider.id)) {
        const wait = Math.ceil(cooldownRemainingMs(provider.id) / 1000);
        console.warn(`[router] ${provider.id} cooling down (${wait}s left); trying next provider`);
        firstError = new Error(
          `${provider.displayName} is cooling down after repeated failures (retry in ${wait}s).`,
        );
        continue;
      }
      attemptsTried++;
      const tools = filterToolsForProvider(
        provider,
        getToolDeclarations(),
        baseRequirements,
        options.templateId,
      );
      // Fresh signal per attempt (see FAILOVER note above) + forward
      // user-cancel from the outer controller. `once` so a fired forward
      // never lingers; the controller is per-query so unfired ones die with
      // it — no listener leak.
      const attempt = new AbortController();
      liveController = attempt;
      const forwardAbort = (): void => {
        attempt.abort(controller.signal.reason);
      };
      if (controller.signal.aborted) forwardAbort();
      else controller.signal.addEventListener('abort', forwardAbort, { once: true });
      fuseMs = roundFuseMs(provider.id);
      // TTFT: stamped on the first streamed chunk of THIS attempt (see the
      // accumulate callback below).
      const attemptStart = Date.now();
      let ttftRecorded = false;
      try {
        await runAgentParts(
          provider,
          apiKey,
          messages,
          baseRequirements,
          tools,
          attempt.signal,
          handlers,
          ctx,
          (t) => {
            if (!ttftRecorded) {
              ttftRecorded = true;
              recordTtft(provider.id, Date.now() - attemptStart);
            }
            accumulated += t;
            ctx.latestAssistantText = accumulated;
          },
          { setRound: setRoundTimeout, clearRound: clearRoundTimeout },
        );
        recordProviderSuccess(provider.id);
        handlers.onDone();
        return;
      } catch (err) {
        if (attempt.signal.aborted) {
          // The per-round watchdog aborts with an explicit timeout error;
          // everything else is a USER cancel (✕ / /stop) — the reader wants
          // the partial answer, not an error banner, so the run ends as
          // "done" and whatever was already streamed is kept and committed.
          if (attempt.signal.reason instanceof Error && attempt.signal.reason.message === 'timeout') {
            // Watchdog, not user intent: the provider hung. Fail over to
            // the next provider instead of erroring the whole run.
            console.warn(`[router] ${provider.id} hung (round watchdog); trying next provider`);
            recordProviderFailure(provider.id);
            firstError = err;
            continue;
          }
          handlers.onDone();
          return;
        }
        if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
          // Keyless local servers (Local AI / opencode) have no
          // key to fix — a 401/403 means the upstream rejected this model or
          // request shape. Don't dead-end: try the next provider, and if the
          // chain is exhausted the message below says "rejected", never
          // "check the API key".
          if (provider.id === 'localai' || provider.id === 'opencode') {
            console.warn(`[router] ${provider.id} rejected the request (${err.status}); trying next provider`);
            recordProviderFailure(provider.id);
            firstError = new ProviderHttpError(
              `${provider.displayName} rejected the request (${err.status}). Try another model in /settings.`,
              err.status,
              provider.id,
            );
            continue;
          }
          // Auth failures stop the chain. Retrying with the next provider on
          // 401 just burns more quota when the next key is likely also wrong
          // or empty. Surface the auth error cleanly so the user fixes it in
          // /settings. No breaker record — auth needs a human, not a cooldown.
          failRun(
            `Auth failed for ${provider.displayName} (${err.status}). Check the API key in /settings.`,
            'auth',
          );
          return;
        }
        if (err instanceof ProviderHttpError && shouldRetryStatus(err.status)) {
          // Retryable status (408 / 425 / 429 / 5xx). Try the next configured
          // provider. 429 trips the breaker immediately; the rest count
          // toward ALLOWED_FAILS.
          console.warn(`[router] ${provider.id} failed: ${err.message}, trying next provider`);
          recordProviderFailure(provider.id, { instant: err.status === 429 });
          firstError = err;
          continue;
        }
        // Network-level death (timeout, refused, reset, down server): fail
        // OVER, not out. This was the no-fallback bug — opencode timing out
        // ended the whole run instead of trying local/cloud next.
        const { message, code } = classifyError(err, provider.displayName);
        if (code === 'timeout' || code === 'network') {
          console.warn(`[router] ${provider.id} unreachable (${code}); trying next provider`);
          recordProviderFailure(provider.id);
          firstError = err;
          continue;
        }
        failRun(message, code);
        return;
      }
    }

    if (attemptsTried === 0 && chain.length > 0 && firstError) {
      // Every configured provider is on an open circuit — say that instead
      // of the generic "All providers failed".
      const wait = Math.max(
        ...chain.map((e) => Math.ceil(cooldownRemainingMs(e.provider.id) / 1000)),
        1,
      );
      failRun(`All providers are cooling down after repeated failures. Retry in ~${wait}s.`, 'overloaded');
      return;
    }

    const { message: allFailedMsg, code: allFailedCode } = classifyError(
      firstError,
      'the providers',
    );
    failRun(
      firstError instanceof Error
        ? `All providers failed. Last error: ${allFailedMsg}`
        : 'All providers failed.',
      allFailedCode,
    );
  })().finally(() => clearRoundTimeout());

  return { cancel: () => controller.abort() };
}

// Resolves early when the signal aborts (user cancel) so a pending retry delay
// never outlasts a cancel.
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// Empty-stream recovery (GenOffice-style): a weak local model sometimes
// completes a round with nothing at all — no content, no tool calls, and not a
// token-limit cut-off. Retry the round with short backoff (cheaper than
// finalizing a silent empty box). Never retries truncated ('length') rounds,
// because those HAVE content and the output cap is the model's own going.
async function runRoundWithEmptyRetry(
  run: () => Promise<ProviderRoundResult>,
  signal: AbortSignal,
  log: (msg: string) => void = console.warn,
): Promise<ProviderRoundResult> {
  const delays = [1000, 3000];
  let attempt = 0;
  for (;;) {
    const round = await run();
    const empty =
      round.contentText.trim() === '' &&
      round.toolCalls.length === 0 &&
      (round.finishReason ?? '') !== 'length';
    if (!empty || attempt >= delays.length || signal.aborted) return round;
    const delay = delays[attempt++];
    log(`[agentic] empty stream (retry ${attempt}/${delays.length}); retrying in ${delay}ms`);
    await waitOrAbort(delay, signal);
  }
}

// Reduce-instead-of-fail: when a round dies to token-budget overflow
// (thinking-limit signature), retry ONCE with less — a directive demanding
// half the words and no new tool calls, plus input shrunk to half budget.
// Failure is the last resort, not the first response. Mirrors the
// empty-stream retry shape above.
const REDUCE_DIRECTIVE =
  'Your last attempt overflowed the token budget. Retry NOW, smaller: ' +
  'answer in half the words, make no new tool calls unless essential, ' +
  'do not quote prior context, and continue the task.';

async function runRoundWithReduceRetry(
  run: () => Promise<ProviderRoundResult>,
  signal: AbortSignal,
  log: (msg: string) => void = console.warn,
  onShrink?: () => void,
): Promise<ProviderRoundResult> {
  try {
    return await runRoundWithEmptyRetry(run, signal, log);
  } catch (err) {
    if (signal.aborted) throw err;
    let code = 'unknown';
    try {
      code = classifyError(err, '').code;
    } catch {
      /* fall through to rethrow */
    }
    if (code !== 'thinking-limit') throw err;
    log('[agentic] token overflow; shrinking input and retrying reduced');
    try {
      onShrink?.();
    } catch {
      /* shrink is best-effort */
    }
    return runRoundWithEmptyRetry(run, signal, log);
  }
}

// Sub-agent nesting depth (module scope: one run at a time per process).
// Depth 1 max — a nested loop never gets runSubtask, so `task` inside a
// subtask cleanly reports "unavailable" instead of recursing.
let subtaskDepth = 0;

// Run one full agentic loop for a single goal. Split multi-step prompts into
// their own loops via runAgentParts — each part stays bounded (MAX_ROUNDS)
// and a failed part stops the remaining parts (status is agent-internal only;
// the user sees each part's real output, never a checklist).
export async function runAgenticLoopWithProvider(  provider: ProviderClient,
  apiKey: string,
  initialMessages: Message[],
  req: RequestRequirements,
  tools: ToolDeclaration[],
  signal: AbortSignal,
  handlers: StreamHandlers,
  ctx: AgentContext,
  onChunkSink: (text: string) => void,
  roundTimeout?: { setRound: () => void; clearRound: () => void },
): Promise<AgentRunResult> {
  let messages: Message[] = [...initialMessages];
  const model = provider.pickModel(req);

  // Fenced sub-agent entry for the `task` tool (opencode-style): depth 1 —
  // the nested loop hides `task` from its own tools so nesting is
  // impossible. Nested approvals still fire per tool; nested text stays out
  // of the main stream (only the final answer returns through the tool).
  const toolExecCtx = ctx as unknown as ToolExecutionContext;
  if (subtaskDepth === 0) {
    toolExecCtx.runSubtask = async (goal: string): Promise<string> => {
      subtaskDepth++;
      try {
        const nestedTools = getToolDeclarations().filter((t) => t.function.name !== 'task');
        const subHandlers: StreamHandlers = {
          ...handlers,
          onChunk: () => undefined,
          onFinalAnswer: async () => undefined,
          onDone: () => undefined,
          onError: (msg) => {
            throw new Error(msg);
          },
        };
        const subCtx: AgentContext = { ...ctx, sessionGoal: goal, originalPrompt: goal };
        const result = await runAgenticLoopWithProvider(
          provider,
          apiKey,
          [{ role: 'user', content: goal }],
          req,
          nestedTools,
          signal,
          subHandlers,
          subCtx,
          () => undefined,
          roundTimeout,
        );
        return result.answer;
      } finally {
        subtaskDepth--;
      }
    };
  }  // Whether THIS provider's model can read image blocks. see_screen's fresh
  // capture attaches as an image only for vision models; a text-only model
  // (local text build, vision toggle off) would hard-fail the round from the
  // server ("image input is not supported"). Text-only models still get the
  // OCR readback inside the tool result text.
  const providerVision = provider.supports('vision', req);
  // One cleaner per run: hides [IMAGE] lines and [NEXT_ACTIONS] blocks from
  // the streamed text across chunk boundaries (see makeStreamCleaner).
  const streamClean = makeStreamCleaner();

  // Honesty-gate state: did the model actually DO the thing the user asked?
  // `goalState.done` is set when a ui_click whose target matched the goal
  // succeeded; `sawAction` is set when any non-read-only tool succeeded. If
  // the goal asks for an action and neither is true, a "done" answer is never
  // accepted — the router clicks the goal target itself or answers honestly.
  const goalState: GoalState = { done: false, attempted: false, declined: false };
  let sawAction = false;

  // Agentic loop — a true iterative agent loop. Models (especially reasoning
  // models on local servers) may return tool calls ONE at a time and continue
  // when fed the result; the old design assumed the whole plan came in a
  // single response and then ran a tools-disabled "composition" round, which
  // silently dropped every tool call after the first. Each iteration: stream
  // a round with tools enabled, execute every tool call it returns, push the
  // assistant tool-call message + each tool result back into the
  // conversation, and loop. When a round returns no tool calls, its text is
  // the final answer.
  if (signal.aborted) throw new Error('Canceled');

  // Measuring stick only (logs, evals) — the loop itself is UNCAPPED by user
  // order. Termination comes from final answers, user cancel, the per-round
  // watchdog, and the stall guards below (doom-loop, error/input streaks,
  // identical rounds → corrective round → forced final).
  const MAX_ROUNDS = 8;
  let accumulatedText = '';

  // Loop-breaking guards for weak models that keep re-doing the job:
  // - `done` (key -> successful result): an identical tool call that already
  //   succeeded is NEVER re-run — the prior result is replayed. The key is
  //   canonicalized so `{a, b}` and `{b, a}` match.
  // - `execCountByName` (tool name -> successful executions): a model that
  //   keeps re-emitting the same action under slightly different args is
  //   allowed at most 2 successful runs per tool name per turn; after that the
  //   last successful result is replayed instead.
  // - `failedAttempts` (key -> count): a genuinely failing call gets at most
  //   two attempts, then further identical requests are skipped.
  const done = new Map<string, string>();
  const execCountByName = new Map<string, number>();
  const lastSuccessByName = new Map<string, string>();
  const failedAttempts = new Map<string, number>();
  // User-declined tool calls (by dedup key): never re-asked, never re-run.
  const declinedCalls = new Set<string>();
  // Directly-routed goal actions already attempted this run: never re-attempted.
  const directAttempted = new Set<string>();

  // Bound the number of `see_screen` captures per run: every screenshot
  // stays in context and costs image tokens on every later round.
  const MAX_SCREENSHOTS_PER_RUN = 3;
  let screenShotsThisRun = 0;

  // Bound read-only info lookups (search_web, fetch_url, read_clipboard,
  // read_table, list_apps) per run. A weak model that re-fetches the same
  // topic with mutated queries must be stopped and forced to
  // answer from what is already in the conversation — otherwise it burns every
  // round re-fetching and never writes the answer. Raised 3 → 6 → 24 (x4):
  // verify-each-reference tasks need headroom; the loop cap still bounds cost.
  let infoLookupsThisRun = 0;

  // web_search has its own, bigger budget: up to MAX_WEB_SEARCHES_PER_RUN real
  // searches per run. The first WEB_SEARCH_PENALTY_AFTER searches are free;
  // each one past that carries an escalating working-result penalty appended to
  // the tool result (see webSearchPenaltyNote below), so the model feels the
  // cost climbing and writes the answer instead of surfing forever. Past the
  // cap the tool is hard-blocked like any capped lookup.
  const MAX_WEB_SEARCHES_PER_RUN = 10;
  const WEB_SEARCH_PENALTY_AFTER = 5;
  let webSearchesThisRun = 0;
  let webSearchPenaltyNote = '';

  // Bound `ui_read` calls too: each returns a numbered element list that stays
  // in context, and a model that keeps re-reading the same screen is looping.
  const MAX_UI_READS_PER_RUN = 3;
  let uiReadsThisRun = 0;
  // Cache of the first successful ui_read result this run. A repeat ui_read
  // returns the short best-targets menu from it instead of re-walking — both
  // cheaper and far easier for a weak model to act on than a 60-line list.
  let lastUiReadResult: string | null = null;
  // The model stalled with no new action: give it ONE more tools-enabled round
  // with the goal-match named explicitly before forcing a plain-text answer.
  let gaveStuckNudge = false;
  // The user explicitly asked for pictures and the model still wrote no
  // [IMAGE] lines: nudge ONCE to name the subject, then accept whatever comes.
  let imageNudged = false;
  // The model announced a web search it never executed: complete it once with
  // real results (see the finalize branch), then accept whatever comes.
  let groundedNudged = false;
  // The model already fetched real results (an info lookup succeeded) but its
  // "final answer" is still just intent-talk ("I will search the web…").
  // Nudge ONCE to write the actual answer from the results already in context,
  // then accept whatever comes.
  let vacuousNudged = false;
  // Run-level degenerate-loop guards (GenOffice MAX_IDENTICAL/ALL_ERROR/INPUT
  // turns): consecutive identical rounds, consecutive all-failing rounds and
  // consecutive malformed-input rounds each get one corrective round, then the
  // final answer is forced. `claimCriticCorrected` is the claimed-action critic
  // (GenOffice verifyResponse): it fires at most ONCE per run.
  let identicalStallCount = 0;
  let lastRoundFingerprint: string | null = null;
  let allErrorStreak = 0;
  let badInputStreak = 0;
  let guardNudged = false;
  let verifyCorrected = false;
  let mermaidFixAttempts = 0;

  // NO round cap by user order: the loop runs until the goal is met, the
  // model writes a final answer, or a stall guard fires (doom-loop on 3×
  // identical calls, all-error/bad-input streaks, identical-round stall —
  // each forces a corrective round then a final answer). MAX_ROUNDS below is
  // kept only as a measuring stick for logs/evals, never enforced. User
  // cancel (abort) and the per-round watchdog still bound every run.
  let extended = false;
  for (let roundIndex = 0; ; roundIndex++) {
    if (signal.aborted) throw new Error('Canceled');
    if (!extended && roundIndex === MAX_ROUNDS && (sawAction || goalState.attempted)) {
      extended = true;
      console.warn(
        '[agentic] base budget passed with progress made and no finish — continuing uncapped with a finish nudge',
      );
      messages.push({
        role: 'user',
        content:
          'Keep going — earlier steps worked but the goal is not done. ' +
          'Do NOT repeat anything that already succeeded. Finish the goal NOW: ' +
          'if a numbered element list is above, call ui_click with the right id; ' +
          'if info is gathered, write the final answer.',
      });
    }

    // Input observability per agentic round: after tool results are appended
    // the payload the model actually sees can exceed the pre-run budget — log
    // its real size so "the model answered nonsense" can be traced to a
    // context overflow instead of guessed at.
    let roundEst = 0;
    try {
      const roundImgParts = messages.reduce(
        (s, m) =>
          s +
          (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0),
        0,
      );
      roundEst = messages.reduce((s, m) => s + estimateTokens(m), 0);
      console.log(
        `[agentic] round ${roundIndex + 1}: msgs=${messages.length} imgParts=${roundImgParts} estTokens=${roundEst}`,
      );
    } catch {
      /* observability only */
    }

    // Auto context: tool results grow the payload every round (fetch dumps,
    // OCR walls). Past the budget the provider 400s or thinks itself to
    // death — fold old turns into a digest automatically instead of dying.
    // System message + current tail are never touched (compactForBudgetKeepLast
    // guarantees it). Zero behavior change while under budget.
    try {
      const cap = getMaxContextTokens(model, provider.id);
      if (roundEst > cap) {
        const compacted = compactForBudgetKeepLast(messages, cap);
        if (compacted.compacted) {
          console.warn(
            `[agentic] auto-trim round ${roundIndex + 1}: ${messages.length} msgs (~${roundEst} tok) over budget ${cap} -> ${compacted.messages.length} msgs`,
          );
          messages = compacted.messages;
        }
      }
    } catch (err) {
      console.warn('[agentic] auto-trim skipped:', err instanceof Error ? err.message : err);
    }

    // F5: the payload the model receives is a sanitized COPY of the
    // conversation — pasted API keys / credentials in history never leave the
    // device. F6: an empty round is retried with short backoff instead of
    // finalizing a silent blank.
    const runRoundOnce = (): Promise<ProviderRoundResult> => {
      roundTimeout?.setRound();
      // Thinking patience: any arriving token OR thinking delta re-arms the
      // fuse, so a reasoning model is never killed mid-thought. roundLive
      // stops straggler chunks (after the round ended) re-arming a dead fuse.
      let roundLive = true;
      const touchFuse = (): void => {
        if (roundLive) roundTimeout?.setRound();
      };
      const payload = sanitizeMessagesPayload(messages);
      // Universal retry (5 attempts, backoff to 60s) wraps the single round
      // for EVERY provider — a down server never kills the run on try one.
      return runWithRoundRetries(provider.id, signal, () =>
        provider
          .runRound(
            model,
            payload,
            apiKey,
            tools.length > 0 ? tools : undefined,
            signal,
            (text) => {
              noteAIActivity();
              touchFuse();
              const clean = streamClean(text);
              if (!clean) return;
              onChunkSink(clean);
              handlers.onChunk(clean);
            },
            (delta) => {
              touchFuse();
              handlers.onReasoning?.(delta);
            },
          )
          .finally(() => {
            roundLive = false;
            roundTimeout?.clearRound();
          }),
      );
    };
    const round = await runRoundWithReduceRetry(
      runRoundOnce,
      signal,
      console.warn,
      () => {
        // Shrink for the reduced retry: fold old turns to half budget, then
        // pin the reduce directive last so it is the final thing the model
        // reads. System message is never touched.
        try {
          const cap = Math.max(2000, Math.floor(getMaxContextTokens(model, provider.id) / 2));
          const compacted = compactForBudgetKeepLast(messages, cap);
          messages = compacted.messages;
        } catch {
          /* keep messages as-is on shrink failure */
        }
        messages = [...messages, { role: 'user', content: REDUCE_DIRECTIVE }];
      },
    );

    // Weak models (e.g. the openrouter/free router) sometimes write a tool
    // call as plain text — `call:ui_click(id="el84")<tool_call|>` or a bare
    // `ui_read()` — instead of a structured tool_calls array. Parse those
    // back into real tool calls so the action actually happens instead of the
    // raw text becoming the "answer". The raw call text is stripped from the
    // content so the streamed/final answer stays clean.
    let toolCalls = round.toolCalls;
    if (toolCalls.length === 0) {
      const textCalls = parseTextToolCalls(round.contentText);
      if (textCalls.length > 0) {
        toolCalls = textCalls.map((tc, i) => ({
          id: `text-${roundIndex}-${i}-${Date.now()}`,
          name: tc.name,
          args: tc.args,
        }));
        round.contentText = stripTemplateTokens(
          textCalls.reduce((acc, tc) => acc.split(tc.raw).join(''), round.contentText),
        ).trim();
        console.warn(
          '[agentic] parsed text tool call: ' +
            textCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`).join(' → '),
        );
      }
    }

    if (round.contentText) accumulatedText += round.contentText;
    console.log('[agentic] ai: ' + (round.contentText || '(no text)'));
    if (round.reasoningText && round.reasoningText.trim()) {
      const t = round.reasoningText.replace(/\s+/g, ' ').trim();
      console.log('[agentic] thinking: ' + (t.length > 700 ? t.slice(0, 700) + '…' : t));
    }
    if (toolCalls.length > 0) {
      console.log(
        '[agentic] plan: ' +
          toolCalls
            .map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`)
            .join(' → '),
      );
    }

    if (toolCalls.length === 0) {
      // No more tools: this round's text is the answer candidate. Guard
      // against a round that produced nothing anywhere (silent empty box) or
      // only a stray "call:ui_read()" / "`ui_click()`" tool dump.
      if (accumulatedText.trim().length === 0) {
        accumulatedText = fallbackAnswer(goalState, sawAction, goalForMatch(ctx));
        console.warn('[agentic] final was tool-junk; substituted fallback answer');
      }

      // Mermaid safety (F): a broken [MERMAID] block fails the whole widget
      // client-side. If the candidate final answer carries a block that does
      // not structurally validate, run ONE corrective round asking the model
      // to re-emit the diagram; re-check, then ship the sanitized code either
      // way (the client shows a Remake card on a hopeless diagram, never a
      // crash).
      if (mermaidFixAttempts < 1) {
        mermaidFixAttempts++;
        const mermaidBlocks = extractMermaidCode(accumulatedText);
        const invalid = mermaidBlocks.filter((b) => !validateMermaidCode(b).ok);
        if (invalid.length > 0) {
          const reasons = invalid
            .map((b) => validateMermaidCode(b).reason ?? 'invalid syntax')
            .join('; ');
          console.warn(`[agentic] invalid [MERMAID] block detected (${reasons}); one corrective round`);
          messages.push({
            role: 'user',
            content:
              `The [MERMAID] diagram you wrote failed validation: ${reasons}. ` +
              'Rewrite ONLY the corrected [MERMAID]...[/MERMAID] block: valid mermaid ' +
              'syntax, start with a diagram-type directive (graph TD, flowchart LR, ' +
              'sequenceDiagram...), balanced brackets, no code fences. Do not repeat ' +
              'the prose answer.',
          });
          if (!signal.aborted) {
            try {
              const fix = await runRoundWithEmptyRetry(runRoundOnce, signal);
              const fixedCode = extractMermaidCode(fix.contentText);
              if (fixedCode.length > 0) {
                const patches = [...fixedCode];
                accumulatedText = accumulatedText.replace(
                  /\[MERMAID\][\s\S]*?\[\/MERMAID\]/g,
                  (block) => {
                    const next = patches.shift();
                    return next
                      ? `[MERMAID]\n${validateMermaidCode(next).sanitized}\n[/MERMAID]`
                      : block;
                  },
                );
                console.warn('[agentic] corrective [MERMAID] round produced a replacement');
              } else {
                console.warn('[agentic] corrective [MERMAID] round returned no new block');
              }
            } catch (e) {
              console.warn(
                '[agentic] mermaid corrective round failed: ' +
                  (e instanceof Error ? e.message : String(e)),
              );
            }
          }
        }
        // Normalize every surviving block to its sanitized form so the client
        // receives the best parseable bytes.
        accumulatedText = accumulatedText.replace(
          /\[MERMAID\]([\s\S]*?)\[\/MERMAID\]/g,
          (_m, body: string) => {
            return `[MERMAID]\n${validateMermaidCode(body).sanitized}\n[/MERMAID]`;
          },
        );
      }

      const wantsClick = wantsClickFor(ctx);
      const gateOpen = !goalState.done && !sawAction && !goalState.declined;
      // If the model already produced meaningful structured content ([MERMAID],
      // [UI], [QUESTIONS]) or substantial prose, it DID deliver real work —
      // the honesty gate must not fire and clobber that with a generic failure.
      // Without this check the gate wastes 2+ seconds trying to click an
      // element that doesn't exist (e.g. "make a diagram" → no diagram button
      // on screen) and then replaces the valid answer with GENERIC_FAILURE_ANSWER.
      const hasRealContent =
        accumulatedText.trim().length > 80 ||
        /\[(?:MERMAID|UI|QUESTIONS)\]/i.test(accumulatedText);
      if (wantsClick && gateOpen && !hasRealContent) {
        // Honesty gate: the user asked for a real action and the model claims
        // it's done without any action having actually succeeded (the weak
        // fallback model's favorite lie). Route the goal DIRECTLY to the
        // matching intent/app tool first ("open spotify", "email a@b.com",
        // "directions to X", "add dinner to calendar") — one shot per intent,
        // with the normal approval. If nothing matches, click the
        // goal-matching element on screen.
        const direct = await tryDirectToolForGoal(
          ctx, handlers, goalState, messages, declinedCalls, directAttempted,
          done, execCountByName, lastSuccessByName, failedAttempts,
        );
        if (direct === 'acted' || direct === 'failed' || direct === 'declined') {
          sawAction = direct === 'acted';
          accumulatedText = '';
          // An external app just opened / an intent just ran — invalidate any
          // cached ui_read so the model's next read is a fresh walk.
          lastUiReadResult = null;
          uiReadsThisRun = 0;
          messages.push({
            role: 'user',
            content:
              direct === 'declined'
                ? 'The action needed to complete the user\'s request was declined - do NOT retry it. Write a final answer that says it could not be done and offer to try a different way.'
                : 'I opened the matching app / ran the intent on your behalf (see the tool result above). Call see_screen() or ui_read() to confirm the result, then write the final answer.',
          });
          continue;
        }
        const clicked = await tryGoalClick(ctx, handlers, goalState, messages);
        if (clicked) {
          sawAction = true;
          accumulatedText = '';
          lastUiReadResult = null;
          uiReadsThisRun = 0;
          messages.push({
            role: 'user',
            content:
              `I clicked the "${goalState.name}" element on your behalf. ` +
              'Call see_screen() or ui_read() to confirm the result, then write the final answer.',
          });
          continue;
        }
      } else if (gateOpen && !promptIsQuestion(ctx.originalPrompt)) {
        // Not a click-shaped goal — but it may still be a DIRECT intent the
        // model skipped ("email sarah@x.com", "directions to the airport",
        // "find coffee near me", "add dinner to my calendar" — none of which
        // necessarily contain a click verb). Route it directly if the goal
        // clearly names one; otherwise answer normally. A question-shaped
        // current prompt never routes here either — answering it in text is
        // the correct outcome.
        const direct = await tryDirectToolForGoal(
          ctx, handlers, goalState, messages, declinedCalls, directAttempted,
          done, execCountByName, lastSuccessByName, failedAttempts,
        );
        if (direct === 'acted' || direct === 'failed' || direct === 'declined') {
          sawAction = direct === 'acted';
          accumulatedText = '';
          lastUiReadResult = null;
          uiReadsThisRun = 0;
          messages.push({
            role: 'user',
            content:
              direct === 'declined'
                ? 'The action needed to complete the user\'s request was declined - do NOT retry it. Write a final answer that says it could not be done and offer to try a different way.'
                : 'I opened the matching app / ran the intent on your behalf (see the tool result above). Call see_screen() or ui_read() to confirm the result, then write the final answer.',
          });
          continue;
        }
      }

      // Claimed-action critic (F1, GenOffice verifyResponse): the model's final
      // answer asserts a screen action ("I clicked Save", "I typed my name",
      // "I copied the link") that no executed tool can back up. This is the
      // ACTIVE lie the honesty gate above can't catch — a long answer (90+)
      // skips the gate, but a fabricated completion must still never reach the
      // user. Fires at most once per run; ONE corrective round only.
      if (!verifyCorrected) {
        const executedTools = new Set<string>();
        for (const key of done.keys()) {
          const name = key.split('\n')[0];
          if (name) executedTools.add(name);
        }
        // tryGoalClick succeeds without a `done` entry — `goalState.done`
        // records it, so mutating context must include both.
        const fix = verifyActionClaims(accumulatedText, {
          executedTools,
          hasMutatingAction: sawAction || goalState.done,
        });
        if (fix) {
          verifyCorrected = true;
          console.warn('[agentic] claimed action not backed by executed tools; correcting once');
          accumulatedText = '';
          messages.push({
            role: 'user',
            content:
              fix +
              '\nIf the action you claimed is genuinely needed, call the right tool NOW (see_screen()/ui_read() first if you need to look). ' +
              'Otherwise rewrite the final answer honestly — describe what really happened on screen, or say the step did not happen.',
          });
          continue;
        }
      }

      // The user EXPLICITLY asked for pictures but the model wrote no [IMAGE]
      // subject lines — without them no pictures are shown. Give the model ONE
      // more round to name the subject (the app then fetches the real
      // pictures). Never nudge twice, and never for implicit requests.
      if (!imageNudged && userExplicitlyWantsImages(ctx.originalPrompt)) {
        const { subjects } = parseImageRequestsFromAnswer(accumulatedText);
        if (subjects.length === 0) {
          imageNudged = true;
          const subject = goalForMatch(ctx)
            .replace(/\b(show me|give me|find|get|search for|some|a|an|the|of|and|pictures?|photos?|images?|pics?|please)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .slice(0, 4)
            .join(' ');
          console.warn('[agentic] explicit image request, but no [IMAGE] lines; nudging once');
          accumulatedText = '';
          messages.push({
            role: 'user',
            content:
              'The user explicitly asked for pictures, but your answer contains no [IMAGE] lines — so NO pictures will be shown.\n' +
              'Rewrite your answer starting with up to 3 [IMAGE] lines, one line per subject, each a SHORT search keyword, for example:\n' +
              '[IMAGE] ' +
              (subject || 'cow') +
              '\nThen write the same informative answer again after the lines. Do not put [IMAGE] lines inside the text.',
          });
          continue;
        }
      }

      // Announced-but-unexecuted research intent: the model says it "will
      // search the web" but never called a tool, so the plan narration would
      // otherwise BE the answer. Complete the announced intent for it — fetch
      // real results, feed them back, and demand a grounded answer. Never
      // grounds twice, and never when an info lookup already succeeded.
      if (
        !groundedNudged &&
        !infoToolSucceeded(done) &&
        announcedResearchIntent(accumulatedText)
      ) {
        groundedNudged = true;
        const query = extractResearchQuery(accumulatedText, goalForMatch(ctx));
        console.warn(`[agentic] announced web search; grounding "${query}"`);
        accumulatedText = '';
        let grounded = '';
        try {
          grounded = await searchWebGround(query, 5);
        } catch (err) {
          console.warn(
            '[agentic] grounding search failed:',
            err instanceof Error ? err.message : err,
          );
        }
        if (grounded) {
          messages.push({
            role: 'user',
            content:
              'You announced you would search the web but did not call a tool, so I ran the search for you.\n' +
              grounded +
              '\nNow write the final answer using the search results above. Your reasoning and plans are never shown to the user — output only the final answer (with any [IMAGE] lines and the [NEXT_ACTIONS] block).',
          });
          continue;
        }
      }

      // The model wrote "final" text that is still just intent-talk ("I will
      // search the web for…") even though a real lookup ALREADY succeeded and
      // its results are in the conversation. That is a non-answer — re-call the
      // model once and demand it write the actual answer from the results it
      // already has, instead of finalizing the empty promise. Never nudge
      // twice, so a stubborn model can't loop forever.
      if (!vacuousNudged && infoToolSucceeded(done) && announcedResearchIntent(accumulatedText)) {
        vacuousNudged = true;
        console.warn('[agentic] vacuous intent-talk final; nudging to write the real answer');
        accumulatedText = '';
        messages.push({
          role: 'user',
          content:
            'Your reply only said you would search the web — but the search results are ALREADY in the conversation above (the tool results you received). Do NOT search again. Write the complete, informative final answer NOW using the results already present. Your plans and reasoning are never shown to the user — output only the final answer.',
        });
        continue;
      }

      const { answer, status } = finalizeRun(accumulatedText, ctx, goalState, sawAction);
      console.log('[agentic] final: ' + answer);
      return { messages, answer, status };
    }

    // Echo the assistant's tool calls back into history so the next round
    // sees them, then execute each call and push its result.
    messages.push({
      role: 'assistant',
      // llama.cpp is picky about null content on tool-calling turns; empty
      // string is accepted by every OpenAI-compatible server.
      content: round.contentText || '',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      })),
    });

    let anyExecuted = false;
    let executedThisRound = 0;
    let failedThisRound = 0;
    let badInputsThisRound = 0;
    // Doom-loop signatures across the whole run: 3 identical calls in a row
    // (same tool + same args) means the model is stuck — stop it with words
    // instead of executing a fourth time.
    const recentToolSignatures: string[] = [];
    // Agent screenshots to attach after this round's tool results (keeps the
    // assistant → tool → user message ordering valid for OpenAI-compat servers).
    const pendingImageMessages: Message[] = [];

    for (const call of toolCalls) {
      if (signal.aborted) throw new Error('Canceled');
      const label = describeToolForUI(call.name, call.args);

      // Doom-loop guard: same tool + same args flagged at 5 in a row
      // (warning), hard-stopped at 8. The model is told both thresholds so
      // it can course-correct before the stop.
      const signature = toolCallSignature(call.name, call.args);
      const streak = identicalStreak(recentToolSignatures, signature);
      if (streak >= DOOM_STOP_AT) {
        const doomMsg =
          `Stopped: you called ${call.name} with identical arguments ${streak} times in a row — you are stuck in a loop. ` +
          `Do NOT call it again unchanged. Vary the input, try a different tool, or ask the user with [QUESTIONS].`;
        console.warn(`[agentic] doom-loop blocked: ${call.name} x${streak}`);
        handlers.onToolStart(call.id, label, call.name, call.args);
        handlers.onToolEnd(call.id, call.name, false, doomMsg);
        messages.push({ role: 'tool', tool_call_id: call.id, content: doomMsg });
        continue;
      }
      recentToolSignatures.push(signature);
      if (recentToolSignatures.length > 16) recentToolSignatures.shift();
      // From the 5th identical call on, warn inside the run so the model
      // knows 3 more identical repeats get it stopped.
      let doomWarning = '';
      if (streak >= DOOM_WARN_AT) {
        doomWarning =
          `\n[Note: this exact call has now run ${streak} times in a row. ` +
          `If you repeat it identically ${DOOM_STOP_AT - streak} more time(s), it will be stopped. Vary the input or move on.]`;
        console.warn(`[agentic] doom-loop warning: ${call.name} x${streak}`);
      }

      // Tool-input recovery (F3, GenOffice MAX_INPUT_PARSE_RETRIES): malformed
      // or truncated arguments are NEVER executed as-is. Feed a targeted "fix
      // your JSON" message back into the conversation; the loop guards below
      // finalize after repeated garbage instead of escalating forever.
      if (call.inputError || call.truncated) {
        badInputsThisRound++;
        const kind = call.truncated
          ? 'was cut off before its arguments were complete'
          : 'had malformed arguments that could not be parsed';
        const rawArg = call.truncated
          ? ''
          : `\nI received: ${JSON.stringify(call.args).slice(0, 260)}`;
        const fixMsg =
          `Error: your call to ${call.name} ${kind}, so the action did NOT run.${rawArg}\n` +
          `Re-send the call with valid JSON arguments matching the tool schema` +
          (call.name === 'ui_click'
            ? ' (use the id of a real element from your ui_read list)'
            : '') +
          '.';
        console.warn(`[agentic] bad tool input: ${call.name}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: fixMsg });
        continue;
      }

      // see_screen is read-only and never deduped: each call takes a fresh
      // capture and attaches it to the conversation for the next round.
      if (call.name === 'see_screen') {
        if (screenShotsThisRun >= MAX_SCREENSHOTS_PER_RUN) {
          console.warn(`[agentic] see_screen cap hit (${MAX_SCREENSHOTS_PER_RUN}); skipping`);
          handlers.onToolStart(call.id, label, call.name, call.args);
          handlers.onToolEnd(call.id, call.name, true, 'Screen capture limit reached.');
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Screen capture limit reached this run. Proceed using the screenshots you already have.',
          });
          continue;
        }
        screenShotsThisRun++;
        console.log('[agentic] step: Looking at the screen');
        handlers.onToolStart(call.id, label, call.name, call.args);
        const rawResult = await executeTool(call.name, call.args, ctx);
        let toolContent = rawResult;
        let imageMessage: Message | null = null;
        if (!rawResult.startsWith('Error:')) {
          try {
            const parsed = JSON.parse(rawResult) as {
              ok?: unknown;
              imageB64?: unknown;
              caption?: unknown;
              ocrText?: unknown;
              geo?: unknown;
              error?: unknown;
            };
            if (
              parsed?.ok &&
              typeof parsed.imageB64 === 'string' &&
              parsed.imageB64 &&
              typeof parsed.caption === 'string'
            ) {
              // This fresh image is now the reference frame for any [POINT]
              // tags the model emits in subsequent deltas (Phase 4), and for
              // describe_region crops too.
              if (parsed.geo && typeof parsed.geo === 'object') {
                setCurrentPointGeo(parsed.geo as PointGeo);
              }
              setCurrentImage(typeof parsed.imageB64 === 'string' ? parsed.imageB64 : null);
              const ocr = typeof parsed.ocrText === 'string' ? parsed.ocrText.trim() : '';
              toolContent = ocr
                ? `${parsed.caption} (fresh screenshot attached to the conversation; text on screen from OCR:\n${ocr})`
                : `${parsed.caption} (fresh screenshot attached to the conversation).`;
              // This fresh image REPLACES the submit screenshot for spatial
              // reference — an earlier caption giving the OLD shot's pixel
              // size no longer applies. Without this supersede note the model
              // kept estimating against the stale 1280x720 frame while the
              // attached image was smaller, and every annotation landed ahead.
              let imageText = parsed.caption;
              if (parsed.geo && typeof parsed.geo === 'object') {
                const g = parsed.geo as PointGeo;
                const iw = g.region ? g.region.w : g.imgW;
                const ih = g.region ? g.region.h : g.imgH;
                imageText += ` (This image supersedes any earlier screenshot for annotation coordinates — it is ${iw}x${ih}; tags use its own pixels.)`;
              }
              // Drop earlier agent screenshots (keep only the latest) so the
              // context budget isn't eaten by stale images. The first user
              // message (trigger screenshot) is never touched.
              messages = messages.filter(
                (m, idx) =>
                  !(
                    idx > 1 &&
                    m.role === 'user' &&
                    Array.isArray(m.content) &&
                    m.content.some((p) => p.type === 'image_url')
                  ),
              );
              // A text-only model cannot read the image block — for it the
              // caption + OCR text (already in toolContent) is the whole
              // story, and no imageMessage rides into the next round.
              if (providerVision) {
                imageMessage = {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: ocr
                        ? `${parsed.caption}\n\nText visible on screen (from screenshot OCR):\n${ocr}`
                        : parsed.caption,
                    },
                    {
                      type: 'image_url',
                      image_url: { url: `data:image/jpeg;base64,${parsed.imageB64}` },
                    },
                  ],
                };
              } else {
                imageMessage = {
                  role: 'user',
                  content: [{ type: 'text', text: imageText }],
                };
              }
            }
          } catch {
            /* non-JSON result — treat as plain text tool result */
          }
        }
        const ok = !toolContent.startsWith('Error:');
        console.log(`[agentic] ${ok ? 'ok' : 'failed'}: ${label} (${screenShotsThisRun}/${MAX_SCREENSHOTS_PER_RUN})`);
        handlers.onToolEnd(call.id, call.name, ok, toolContent.slice(0, 120));
        // Spill long outputs to disk (opencode-style Truncate.output): the
        // conversation keeps a capped head + a read_file pointer instead of a
        // context-eating wall. Errors stay inline (short by nature).
        if (ok && toolContent.length > SPILL_TRIGGER_CHARS) {
          try {
            const spilled = spillToolOutput(call.name, call.id, toolContent);
            if (spilled.spilledPath) {
              console.warn(`[agentic] tool output spilled: ${call.name} (${toolContent.length} chars) -> ${spilled.spilledPath}`);
              toolContent = spilled.content;
            }
          } catch {
            /* spill is best-effort; oversized content still flows inline */
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent + doomWarning });
        if (imageMessage) pendingImageMessages.push(imageMessage);
        anyExecuted = true;
        continue;
      }

      // ui_read is read-only and never deduped: the first call each run reads
      // a FRESH scene. A repeat ui_read after that is almost always a loop —
      // the screen hasn't changed and the full list is already in context — so
      // return the SHORT best-targets menu with a direct click order instead
      // of re-walking. This deliberately does NOT count as progress, so a
      // model that only repeats ui_read trips the forced-final path below.
      if (call.name === 'ui_read') {
        if (uiReadsThisRun >= 1 && lastUiReadResult) {
          console.warn(`[agentic] ui_read repeat (${uiReadsThisRun}); returning cached menu`);
          handlers.onToolStart(call.id, label, call.name, call.args);
          handlers.onToolEnd(call.id, call.name, true, 'Screen unchanged; menu replayed.');
          const menu = extractClickMenu(lastUiReadResult);
          const matches = findGoalMatches(goalForMatch(ctx), lastUiReadResult);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              'The screen is unchanged since your previous ui_read — the numbered list above is still current.\n' +
              (matches.length > 0
                ? `The user's goal matches these elements: ${matches.join('; ')}. Call ui_click with the id of the right one now.\n`
                : '') +
              (menu ? `Best click targets from that list:\n${menu}\n` : '') +
              'Call ui_click("<id>") for the element matching the user\'s goal. Do NOT call ui_read again — it will not change.',
          });
          continue;
        }

        if (uiReadsThisRun >= MAX_UI_READS_PER_RUN) {
          console.warn(`[agentic] ui_read cap hit (${MAX_UI_READS_PER_RUN}); skipping`);
          handlers.onToolStart(call.id, label, call.name, call.args);
          handlers.onToolEnd(call.id, call.name, true, 'Screen element read limit reached.');
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              'Element-read limit reached this run. The numbered list you already have is current — call ui_click with the id of the element matching the user\'s goal, or reply with the final answer.',
          });
          continue;
        }
        uiReadsThisRun++;
        console.log('[agentic] step: Reading the screen elements');
        handlers.onToolStart(call.id, label, call.name, call.args);
        const readResult = await executeTool(call.name, call.args, ctx);
        const readOk = !readResult.startsWith('Error:');
        console.log(`[agentic] ${readOk ? 'ok' : 'failed'}: ${label} (${uiReadsThisRun}/${MAX_UI_READS_PER_RUN})`);
        if (readOk) {
          lastUiReadResult = readResult;
          // Screen text is user content — fingerprint it for the dev log
          // instead of writing the raw window readback to disk.
          console.log(`[agentic] ui_read returned ${frameHash(readResult)} (${readResult.length} chars)`);
        }
        handlers.onToolEnd(call.id, call.name, readOk, summarizeOk(readResult));
        messages.push({ role: 'tool', tool_call_id: call.id, content: readResult + doomWarning });
        anyExecuted = true;
        continue;
      }

      const key = keyFor(call.name, call.args);

      // The user declined this exact action earlier in the run — never re-ask.
      if (declinedCalls.has(key)) {
        const declinedMsg = 'User declined this action earlier — it was not retried.';
        console.warn(`[agentic] declined-skip: ${label} was declined earlier`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: declinedMsg });
        continue;
      }

      const priorSuccess = done.get(key);
      if (priorSuccess !== undefined) {
        // Already ran successfully in an earlier round — replay the result
        // instead of repeating the side effect.
        console.warn(`[agentic] dedup: ${label} already succeeded; not re-running`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: priorSuccess });
        continue;
      }

      // The model keeps re-emitting the same action with mutated args (e.g.
      // re-saving the same document). Cap successful runs per guarded tool.
      const priorRuns = execCountByName.get(call.name) ?? 0;
      if (REPEAT_GUARDED_TOOLS.has(call.name) && priorRuns >= MAX_RUNS_PER_GUARDED_TOOL) {
        const replayed = lastSuccessByName.get(call.name) ?? 'This action already completed earlier in this run.';
        console.warn(`[agentic] capped: ${call.name} already ran ${priorRuns}x successfully; not re-running`);
        handlers.onToolStart(call.id, label, call.name, call.args);
        handlers.onToolEnd(call.id, call.name, true, replayed);
        messages.push({ role: 'tool', tool_call_id: call.id, content: replayed });
        continue;
      }

      const fails = failedAttempts.get(key) ?? 0;
      // ui_click gets 3 attempts to support the flow: click fails → see_screen
      // → try again with a new id or pixel coordinate. All other tools get 2.
      const maxFails = call.name === 'ui_click' ? 3 : 2;
      if (fails >= maxFails) {
        const msg = `This step already failed ${fails}x and was not retried.`;
        console.warn(`[agentic] give-up: ${label} failed ${fails}x; not retrying`);
        handlers.onToolStart(call.id, label, call.name, call.args);
        handlers.onToolEnd(call.id, call.name, false, 'Failed repeatedly; skipped.');
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${msg}` });
        continue;
      }

      // A model that keeps re-searching with mutated queries is looping, not
      // gathering more data. web_search has its own budget of
      // MAX_WEB_SEARCHES_PER_RUN with an escalating penalty past the 5th
      // (appended to the tool result below); all other info lookups share the
      // tighter MAX_INFO_LOOKUPS_PER_RUN. Once a budget is spent, refuse to
      // run another lookup: the results already in the conversation ARE the
      // picture, and the model must write the answer from them now. This does
      // NOT count as progress, so a loop that only re-searches trips the
      // nudge/forced-final path and actually answers instead of burning rounds.
      const isWebSearch = call.name === 'web_search';
      if (isWebSearch) {
        const searchNo = webSearchesThisRun + 1;
        if (searchNo > MAX_WEB_SEARCHES_PER_RUN) {
          console.warn(
            `[agentic] web cap hit (${MAX_WEB_SEARCHES_PER_RUN}); skipping ${call.name}`,
          );
          handlers.onToolStart(call.id, label, call.name, call.args);
          handlers.onToolEnd(call.id, call.name, true, 'Web search limit reached.');
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `Web search limit of ${MAX_WEB_SEARCHES_PER_RUN} reached this run. The results already in the conversation fully answer the request — write the final answer NOW using them. Do NOT call another search tool.`,
          });
          continue;
        }
        webSearchesThisRun = searchNo;
        infoLookupsThisRun++;
        if (searchNo > WEB_SEARCH_PENALTY_AFTER) {
          const over = searchNo - WEB_SEARCH_PENALTY_AFTER;
          const penalties = [
            `Penalty (search ${searchNo}/${MAX_WEB_SEARCHES_PER_RUN}): you are past the free quota of ${WEB_SEARCH_PENALTY_AFTER} searches. Prefer answering from the results already in the conversation.`,
            `Penalty (search ${searchNo}/${MAX_WEB_SEARCHES_PER_RUN}): each further web_search now penalises the budget. Only search if strictly necessary — answer from the results already in context.`,
            `Heavy penalty (search ${searchNo}/${MAX_WEB_SEARCHES_PER_RUN}): stop researching. Synthesise the answer from the results already in the conversation in your very next message.`,
            `Severe penalty (search ${searchNo}/${MAX_WEB_SEARCHES_PER_RUN}): this is your second-to-last allowed search. The next one is the final call.`,
            `Final-search penalty (search ${searchNo}/${MAX_WEB_SEARCHES_PER_RUN}): this is your LAST web_search. After it the tool is blocked — write the complete final answer NOW.`,
          ];
          webSearchPenaltyNote = penalties[over - 1] ?? penalties[penalties.length - 1];
        } else {
          webSearchPenaltyNote = '';
        }
      } else if (INFO_TOOLS.has(call.name)) {
        if (infoLookupsThisRun >= MAX_INFO_LOOKUPS_PER_RUN) {
          console.warn(
            `[agentic] info cap hit (${MAX_INFO_LOOKUPS_PER_RUN}); skipping ${call.name}`,
          );
          handlers.onToolStart(call.id, label, call.name, call.args);
          handlers.onToolEnd(call.id, call.name, true, 'Lookup limit reached.');
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              'Search/lookup limit reached this run. The results already in the conversation fully answer the request — write the final answer NOW using them. Do NOT call another lookup tool.',
          });
          continue;
        }
        infoLookupsThisRun++;
      }

      console.log(`[agentic] step: ${label}`);
      handlers.onToolStart(call.id, label, call.name, call.args);

      // Snapshot the foreground window BEFORE the approval UI steals focus, so
      // every input task (press_key, type_text, click, ...) later lands in the
      // app the user was working in and not in Spirit's own window.
      const focusTarget = await captureForeground();
      const approved = await ctx.requireToolApproval(call.id, call.name, call.args);
      console.log(`[agentic] approval ${approved ? 'granted' : 'denied'}: ${label}`);
      if (!approved) {
        const declineMsg = 'User declined this action.';
        console.warn(`[agentic] declined: ${label}`);
        declinedCalls.add(key);
        goalState.declined = true;
        handlers.onToolEnd(call.id, call.name, false, declineMsg);
        messages.push({ role: 'tool', tool_call_id: call.id, content: declineMsg });
        continue;
      }

      // Give the OS focus back to the captured app before synthesizing input.
      await restoreForeground(focusTarget);

      anyExecuted = true;
      executedThisRound++;
      const result = await executeTool(call.name, call.args, ctx);
      const ok = !result.startsWith('Error:');
      if (!ok) failedThisRound++;
      const summary = ok
        ? summarizeOk(result)
        : result.replace(/^Error:\s*/, '');
      console.log(`[agentic] ${ok ? 'ok' : 'failed'}: ${label} -> ${summary}`);
      handlers.onToolEnd(call.id, call.name, ok, summary);
      // Every tool result the model sees is stamped with its outcome. Weak
      // models routinely read a verbose/ambiguous raw result (or an empty
      // "no new info" one) as a failure and retry or give up; an explicit
      // [SUCCESS] marker makes the ground truth unmistakable. The raw result
      // still follows so callers like ui_read keep their full detail.
      const stamp = ok ? `[SUCCESS] ${call.name} executed successfully.\n\n` : '';
      const note =
        isWebSearch && webSearchPenaltyNote ? `\n\n${webSearchPenaltyNote}` : '';
      const toolContent = `${stamp}${result}${note}${doomWarning}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
      if (ok) {
        done.set(key, result);
        execCountByName.set(call.name, priorRuns + 1);
        lastSuccessByName.set(call.name, result);
        // Any successful non-read tool is real progress — it satisfies the
        // honesty gate ("something actually happened").
        if (!READ_ONLY_TOOLS.has(call.name)) sawAction = true;
        // Screen-changing actions invalidate the ui_read cache — a click,
        // scroll, type, or navigation puts the UI in a new state and the next
        // ui_read must re-walk the live tree, not replay the old list.
        if (SCREEN_CHANGING_TOOLS.has(call.name)) {
          lastUiReadResult = null;
          uiReadsThisRun = Math.max(0, uiReadsThisRun - 1); // allow one fresh read
          // Observation masking (zero-compute): earlier ui_read/see_screen
          // results are now stale — the screen changed after them. Replace
          // their full contents with a short superseded pointer so later
          // rounds don't burn context on (or worse, act on) UI that no longer
          // exists.
          messages = maskStaleObservations(messages);
          // launch_app/open_url/system_action/run_command opened a NEW window —
          // point the agent's next ui_read/see_screen/ui_click at it instead of
          // the trigger-time one.
          if (
            call.name === 'launch_app' ||
            call.name === 'open_url' ||
            call.name === 'system_action' ||
            call.name === 'run_command'
          ) {
            void refreshAgentTargetHwnd();
          }
        }
        // A successful ui_click whose target label matches the goal tokens
        // completes the goal, so a later "done" answer is accepted.
        if (call.name === 'ui_click') {
          const clickedName = extractClickedName(result);
          if (clickedName && goalScoreFor(clickedName, goalTokens(goalForMatch(ctx))) > 0) {
            goalState.done = true;
            goalState.name = clickedName;
          }
        }
      } else {
        failedAttempts.set(key, fails + 1);
        // Redirect a FAILED model ui_click to the goal target: the weak model
        // hallucinates ids (the container "el0" bug), so if it clicked the
        // wrong/nonexistent thing and the goal names a real on-screen target,
        // click that directly instead of letting the failure end the task.
        if (
          call.name === 'ui_click' &&
          !goalState.done &&
          !sawAction &&
          !goalState.declined &&
          wantsClickFor(ctx)
        ) {
          const clicked = await tryGoalClick(ctx, handlers, goalState, messages);
          if (clicked) anyExecuted = true;
        }
      }
    }

    // Attach any agent screenshots (see_screen) AFTER all tool results, so
    // the assistant → tool → user ordering stays valid for the server.
    if (pendingImageMessages.length > 0) {
      messages.push(...pendingImageMessages);
    }

    // This round EXECUTED tools, so its narration ("Opening excel.") is not the
    // answer — only a later no-tool round's text can be. Reset the
    // answer-candidate so the final answer is never a stale pre-action claim
    // glued onto the real one.
    accumulatedText = '';

    // Run-level degenerate-loop guards (F2, GenOffice MAX_IDENTICAL /
    // MAX_ALL_ERROR / MAX_INPUT_PARSE_RETRIES): a model that keeps re-doing the
    // job burns every remaining round. Detect the three cheapest run-killers
    // and brake: ONE corrective round, then force a plain-text final answer.
    const rawFp = toolRoundFingerprint(toolCalls.map((tc) => ({ name: tc.name, args: tc.args })));
    identicalStallCount = nextIdenticalStallCount(identicalStallCount, rawFp, lastRoundFingerprint);
    lastRoundFingerprint = rawFp;
    allErrorStreak = nextAllErrorStreak(allErrorStreak, toolCalls.length, executedThisRound, failedThisRound);
    badInputStreak = nextBadInputStreak(badInputStreak, toolCalls.length, badInputsThisRound, executedThisRound);

    if (
      isIdenticalStallHit(identicalStallCount) ||
      isAllErrorStreakHit(allErrorStreak) ||
      isBadInputStreakHit(badInputStreak)
    ) {
      const reason = isAllErrorStreakHit(allErrorStreak)
        ? `every tool action failed for ${allErrorStreak} rounds in a row`
        : isBadInputStreakHit(badInputStreak)
          ? `you sent malformed tool calls for ${badInputStreak} rounds in a row`
          : `you repeated the exact same tool round ${identicalStallCount} times`;
      console.warn(`[agentic] loop guard tripped: ${reason}`);
      if (!guardNudged) {
        guardNudged = true;
        messages.push({
          role: 'user',
          content:
            `STOP REPEATING: ${reason}. The repeated action will not be run again.\n` +
            (allErrorStreak > 0 || badInputStreak > 0
              ? 'Use the ui_read element list / screenshots already in the conversation and try a genuinely different step — or if the request is complete, write the final answer NOW.'
              : 'Judging from the run so far the request is likely complete. Write the final answer NOW describing what actually succeeded, with no further tool calls.'),
        });
        continue;
      }
      // Still repeating after the corrective round — force a plain-text final.
      console.warn('[agentic] loop guard repeat; forcing final answer');
      if (signal.aborted) throw new Error('Canceled');
      const finalRunOnce = (): Promise<ProviderRoundResult> => {
        roundTimeout?.setRound();
        let roundLive = true;
        const touchFuse = (): void => {
          if (roundLive) roundTimeout?.setRound();
        };
        return runWithRoundRetries(provider.id, signal, () =>
          provider
            .runRound(
              model,
              sanitizeMessagesPayload(messages),
              apiKey,
              undefined,
              signal,
              (text) => {
                noteAIActivity();
                touchFuse();
                const clean = streamClean(text);
                if (!clean) return;
                onChunkSink(clean);
                handlers.onChunk(clean);
              },
              (delta) => {
                touchFuse();
                handlers.onReasoning?.(delta);
              },
            )
            .finally(() => {
              roundLive = false;
              roundTimeout?.clearRound();
            }),
        );
      };
      const finalRound = await runRoundWithEmptyRetry(finalRunOnce, signal);
      if (finalRound.contentText) accumulatedText += finalRound.contentText;
      const { answer, status } = finalizeRun(accumulatedText, ctx, goalState, sawAction);
      console.log('[agentic] final: ' + answer);
      return { messages, answer, status };
    }

    // Reinforce the stop condition after every tool round: the results above
    // are real, completed actions — a looping model must not redo them. This
    // message must NOT forbid the legitimate next step though: an earlier
    // version said "do NOT call any tools again" which read to weak models as
    // "ui_read is done, don't touch anything", so they looped on ui_read
    // instead of clicking the element they had just found. Direct the next
    // step explicitly instead.
    // Was the screen changed this round? If so, the model SHOULD call
    // see_screen or ui_read to verify. If nothing changed, discourage it.
    const screenWasChanged = toolCalls.some((tc) =>
      ['click', 'ui_click', 'double_click', 'drag', 'type_text', 'press_key',
        'scroll', 'open_url', 'launch_app', 'system_action', 'run_command'].includes(tc.name)
    );
    // A round that only ran information lookups has put its information in
    // the conversation — the model must now write the answer, not re-run
    // the same lookup (see INFO_TOOLS above).
    const infoOnlyRound =
      toolCalls.length > 0 && toolCalls.every((tc) => INFO_TOOLS.has(tc.name));
    messages.push({
      role: 'user',
      content:
        'The actions above were executed on the machine and their outcomes are the tool results listed above.\n' +
        (screenWasChanged
          ? 'A screen-changing action ran — call see_screen() or ui_read() to verify the new state before proceeding.\n'
          : 'The numbered element list above is the CURRENT screen.\n') +
        (infoOnlyRound
          ? 'The lookups above succeeded and their results are now in the conversation — they are the complete picture. Write the final, informative answer NOW. Do NOT call the same tool again; a repeated call is a loop and will not be executed.\n'
          : 'If the user\'s request is now fully complete, reply with the final answer NOW.\n' +
            'If it is NOT complete, continue with the NEXT step — if you can see the matching element in the list, call ui_click with its id.\n') +
        'Do not repeat, re-verify, or "improve" any action that already succeeded.',
    });

    // The model only repeated already-done or exhausted calls — it is stuck
    // in a loop. First give it ONE more tools-enabled round with the goal
    // match named explicitly (weak models often need the exact id handed to
    // them before they will click). Only if it STILL takes no action do we
    // force a plain-text final round.
    if (!anyExecuted) {
      // The one action this run needed was declined and nothing else ran —
      // pushing a click nudge would be pointless (the user said no). Finalize
      // now with an honest decline message instead of dragging on.
      if (goalState.declined && !sawAction) {
        const { answer, status } = finalizeRun(accumulatedText, ctx, goalState, sawAction);
        console.log('[agentic] final: ' + answer);
        return { messages, answer, status };
      }
      if (!gaveStuckNudge) {
        gaveStuckNudge = true;
        const wantsClick = wantsClickFor(ctx);
        if (!goalState.done && !sawAction && !goalState.declined) {
          // The model stalled and the goal names a real on-screen action. Try
          // the direct intent/app route first ("open excel", "add to my
          // calendar", "email X") — the model is looping, so act for it — then
          // fall back to clicking the goal target. The weak fallback model
          // rarely acts on a plain-text nudge.
        const direct = await tryDirectToolForGoal(
          ctx, handlers, goalState, messages, declinedCalls, directAttempted,
          done, execCountByName, lastSuccessByName, failedAttempts,
        );
          if (direct === 'acted' || direct === 'failed' || direct === 'declined') {
            anyExecuted = direct === 'acted';
            lastUiReadResult = null;
            uiReadsThisRun = 0;
            continue;
          }
          if (wantsClick) {
            const clicked = await tryGoalClick(ctx, handlers, goalState, messages);
            if (clicked) {
              anyExecuted = true;
              continue;
            }
          }
        }
        const matches = findGoalMatches(goalForMatch(ctx), lastUiReadResult);
        console.warn('[agentic] no action this round; nudging');
        // If a read-only lookup (search_web, fetch_url, …)
        // already succeeded earlier in the run, its result is in the
        // conversation — the model should write the final answer, not reach
        // for a UI element that has nothing to do with the request.
        const infoSucceeded = infoToolSucceeded(done);
        const wantsAnnot = wantsAnnotationFor(ctx);
        const annotEmpty = parseAnnotations(accumulatedText).length === 0;
        messages.push({
          role: 'user',
          content:
            wantsAnnot && annotEmpty
              ? 'ANNOTATION REQUEST — the user asked you to annotate/explain/tour what is on screen. ' +
                'The screenshot is already attached. You CAN call see_screen() or ui_read() if you need a look — they are allowed. ' +
                'Write the final answer NOW with tags inline in your text, either bracket form ([POINT:x,y:label], [BOX:x,y,w,h:label], [ARROW:x1,y1:x2,y2:label]) or a JSON object ({"point":[x,y]}, {"box":[x,y,w,h]}, {"arrow":[x1,y1,x2,y2]}) — both are drawn. ' +
                'Numbers are image pixels from that screenshot: NO spaces after the brackets or commas, and every tag needs a label. ' +
                'Do not loop — answer with the tags.'
              : 'You have not taken any new action this round.\n' +
                (matches.length > 0
                  ? `The user's goal matches these elements: ${matches.join('; ')}. Pick the right one and call ui_click with its id now.`
                  : infoSucceeded
                    ? 'The information you already fetched is in the conversation — it fully answers the request. Write the final, complete answer NOW. Do NOT call any tool again.'
                    : 'Reply with the final answer now, or if the user\'s request genuinely needs an on-screen step, call the matching tool from the numbered list above.') +
                '\nDo not call ui_read or see_screen again.',
        });
        continue;
      }

      console.warn('[agentic] no new tool executed this round; forcing final answer');
      if (signal.aborted) throw new Error('Canceled');
      const finalRunOnce = (): Promise<ProviderRoundResult> => {
        roundTimeout?.setRound();
        let roundLive = true;
        const touchFuse = (): void => {
          if (roundLive) roundTimeout?.setRound();
        };
        return runWithRoundRetries(provider.id, signal, () =>
          provider
            .runRound(
              model,
              sanitizeMessagesPayload(messages),
              apiKey,
              undefined,
              signal,
              (text) => {
                noteAIActivity();
                touchFuse();
                const clean = streamClean(text);
                if (!clean) return;
                onChunkSink(clean);
                handlers.onChunk(clean);
              },
              (delta) => {
                touchFuse();
                handlers.onReasoning?.(delta);
              },
            )
            .finally(() => {
              roundLive = false;
              roundTimeout?.clearRound();
            }),
        );
      };
      const finalRound = await runRoundWithEmptyRetry(finalRunOnce, signal);
      if (finalRound.contentText) accumulatedText += finalRound.contentText;
      const { answer, status } = finalizeRun(accumulatedText, ctx, goalState, sawAction);
      console.log('[agentic] final: ' + answer);
      return { messages, answer, status };
    }
  }

  // MAX_ROUNDS exhausted: return honestly instead of throwing (a thrown error
  // surfaces an ugly "all providers failed" style message to the user; a final
  // answer — honest fallback when the goal needed an action — is friendlier).
  console.warn(`[agentic] round limit (${MAX_ROUNDS}) reached; finalizing`);
  const { answer, status } = finalizeRun(accumulatedText, ctx, goalState, sawAction);
  console.log('[agentic] final: ' + answer);
  return { messages, answer, status };
}

// Wrapper that runs a long multi-step prompt one bounded part at a time.
// "1. open excel 2. make a table 3. paste it" becomes three separate agent
// loops (each capped at MAX_ROUNDS), threaded through the same conversation.
// The FINAL ANSWER is the parts' own real output joined together — nothing is
// ever fabricated for display. Per-part done/failed status is agent-internal
// data only: a failed part stops the remaining parts and the overall run
// reports 'failed', but no "1. Done — …" checklist is ever shown to the user.
export async function runAgentParts(
  provider: ProviderClient,
  apiKey: string,
  initialMessages: Message[],
  req: RequestRequirements,
  tools: ToolDeclaration[],
  signal: AbortSignal,
  handlers: StreamHandlers,
  ctx: AgentContext,
  onChunkSink: (text: string) => void,
  roundTimeout?: { setRound: () => void; clearRound: () => void },
): Promise<AgentRunResult> {
  const goal = ctx.sessionGoal || ctx.originalPrompt || '';
  const parts = splitGoal(goal);
  if (parts.length <= 1) {
    // Single-task turn: run the normal loop; its answer is the final answer.
    const result = await runAgenticLoopWithProvider(
      provider, apiKey, initialMessages, req, tools, signal, handlers, ctx,
      onChunkSink, roundTimeout,
    );
    await handlers.onFinalAnswer(result.answer);
    return result;
  }

  console.log(`[agentic] split goal into ${parts.length} parts: ${parts.join(' | ')}`);
  let messages = [...initialMessages];
  const partAnswers: string[] = [];
  let allDone = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    console.log(`[agentic] part ${i + 1}/${parts.length}: ${part}`);
    messages = [
      ...messages,
      { role: 'user', content: `Task ${i + 1} of ${parts.length}: ${part}` },
    ];
    // Scope the session goal to the CURRENT part so the honesty gate targets
    // exactly this sub-task, not the whole multi-part request.
    const partCtx: AgentContext = { ...ctx, sessionGoal: part, originalPrompt: part };
    const result = await runAgenticLoopWithProvider(
      provider, apiKey, messages, req, tools, signal, handlers, partCtx,
      onChunkSink, roundTimeout,
    );
    messages = result.messages;
    // Keep the part's REAL output — that is the answer content, never a
    // synthesized "Done —" line. Status only feeds the agent loop below.
    partAnswers.push(result.answer);
    if (result.status !== 'done') {
      allDone = false;
      break;
    }
  }
  const answer = partAnswers.filter((a) => a.trim().length > 0).join('\n\n');
  console.log(`[agentic] parts answered ${partAnswers.length}/${parts.length}; final is the parts' own output`);
  await handlers.onFinalAnswer(answer);
  return { messages, answer, status: allDone ? 'done' : 'failed' };
}

function summarizeOk(result: string): string {
  const firstLine = result.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return 'done';
  if (firstLine.length > 80) return firstLine.slice(0, 80) + '…';
  return firstLine;
}

// Streaming and template-token cleaning live in the pure, unit-tested module
// stream-clean.ts (makeStreamCleaner / stripTemplateTokens) so the provider
// layer stays thin and the clean logic is verifiable directly.

// Strip leftover agentic junk from a final answer: llama.cpp chat-template
// special tokens (<tool_call|>, <|start_of_turn|>, </tool_call>…), a
// "call:ui_click(...)"-style tool invocation written as text, a bare
// backticked or plain tool invocation (`ui_read()`, ui_click()), and leaked
// raw message-serialization lines (a weak model sometimes dumps a JSON object
// as the answer). An answer that is ONLY such tool names cleans down to empty
// (the router then substitutes a plain-language fallback). Well-formed
// [NEXT_ACTIONS] / [IMAGE] blocks are deliberately LEFT alone — the IPC layer
// parses the chips and image subjects out of the final answer text itself.
function cleanFinalAnswer(text: string): string {
  return stripTemplateTokens(text)
    // llama.cpp-style text-emitted tool invocations: call:ui_click(id="el1")
    // or the brace variant some weak models emit: call:web_search{query: "…"}
    .replace(/call:\s*\w+\s*(?:\([^)]*\)|\{[^}]*\}|\[[^\]]*\])/g, '')
    .replace(/^`+/, '')
    .replace(/`+$/, '')
    .replace(/^\s*(?:ui_read|ui_click|see_screen|click|double_click|move_mouse|scroll|type_text|press_key|wait|web_search|search_web|fetch_url|read_clipboard|read_table|list_apps)\s*\([^)]*\)\s*$/, '')
    // Leaked message-serialization lines: '{"role":"assistant","content":"…"}'
    .replace(/^\s*\{[^}]*"(?:role|tool_calls|content|message)"[^}]*\}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Some weak models (notably whatever `openrouter/free` routes to) write tool
// calls as plain text instead of a structured tool_calls array — e.g.
// `call:ui_click(id="el84")<tool_call|>`, `ui_click("el3")`, or
// `type_text(text="hello")`. These are real intentions that never execute, so
// the router parses them back into tool calls. Returns each call with the raw
// text to strip out of the answer, the tool name, and parsed args.
export function parseTextToolCalls(
  text: string,
): Array<{ raw: string; name: string; args: Record<string, unknown> }> {  const names = Object.keys(TOOLS);
  if (names.length === 0) return [];
  const inner = '((?:[^()]|\\([^()]*\\))*)';
  const calls: Array<{ raw: string; name: string; args: Record<string, unknown> }> = [];
  let working = text;

  // Strong form: prefixed with `call:` or wrapped in backticks. The prefix is
  // REQUIRED so bare short words in prose ("click (button)") never match — a
  // weak model almost always writes `call:ui_click(...)` anyway.
  const strongRe = new RegExp(
    '(?:call:\\s*|`)\\s*(' + names.join('|') + ')\\s*\\(' + inner + '\\)',
    'gi',
  );
  let m: RegExpExecArray | null;
  while (true) {
    strongRe.lastIndex = 0;
    m = strongRe.exec(working);
    if (!m) break;
    calls.push({ raw: m[0], name: m[1], args: textCallArgs(m[1], m[2]) });
    working = working.split(m[0]).join('');
  }

  // Weak form: bare `ui_click(...)`. Only for names that contain an underscore
  // — prose never contains `ui_click(` / `see_screen(` so false positives are
  // unlikely, unlike bare `click(500, 300)`.
  const underscoreNames = names.filter((n) => n.includes('_'));
  if (underscoreNames.length > 0) {
    const weakRe = new RegExp(
      '(?<![A-Za-z0-9])(' + underscoreNames.join('|') + ')\\s*\\(' + inner + '\\)',
      'gi',
    );
    while (true) {
      weakRe.lastIndex = 0;
      m = weakRe.exec(working);
      if (!m) break;
      calls.push({ raw: m[0], name: m[1], args: textCallArgs(m[1], m[2]) });
      working = working.split(m[0]).join('');
    }
  }

  return calls;
}

// Parse the inside of a text-emitted tool call into args. Accepts JSON
// objects, `key=value` / `key:value` pairs, and bare positional values.
function textCallArgs(name: string, inner: string): Record<string, unknown> {
  const body = inner.trim();
  if (!body) return {};
  if (body.startsWith('{') && body.endsWith('}')) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON — fall through to pair parsing */
    }
  }
  const parts = splitTopLevel(body);
  if (parts.some((p) => /^[A-Za-z_]\w*\s*[=:]/.test(p))) {
    const args: Record<string, unknown> = {};
    for (const part of parts) {
      const eq = part.search(/[=:]/);
      if (eq <= 0) continue;
      args[part.slice(0, eq).trim()] = parseScalar(part.slice(eq + 1));
    }
    return args;
  }
  return positionalArgs(name, parts);
}

// Split on top-level commas, ignoring commas inside quotes or parentheses.
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Coerce a parsed value to a number when it's a plain number, else a string
// with surrounding quotes stripped.
function parseScalar(raw: string): string | number {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// Map bare positional arguments (`ui_click("el3")`, `wait(1000)`,
// `click(500, 300)`) onto the per-tool argument names.
function positionalArgs(name: string, parts: string[]): Record<string, unknown> {
  if (name === 'click' || name === 'double_click' || name === 'move_mouse') {
    const [x, y, button] = parts;
    const args: Record<string, unknown> = {};
    if (x !== undefined) args.x = parseScalar(x);
    if (y !== undefined) args.y = parseScalar(y);
    if (button !== undefined) args.button = String(parseScalar(button));
    return args;
  }
  if (name === 'wait') return { ms: Number(parts[0]) || 0 };
  if (name === 'scroll') return { delta: Number(parts[0]) || 0 };
  if (name === 'set_volume') {
    const first = parts[0];
    if (first !== undefined && typeof parseScalar(first) === 'number') return { level: parseScalar(first) };
    return {};
  }
  const first = parts[0];
  if (first === undefined) return {};
  const singleKey: Record<string, string> = {
    ui_click: 'id',
    press_key: 'key',
    type_text: 'text',
    open_url: 'url',
    fetch_url: 'url',
    launch_app: 'app',
    search_web: 'query',
    play_music: 'query',
    copy_to_clipboard: 'text',
  };
  const key = singleKey[name];
  return key ? { [key]: parseScalar(first) } : {};
}

// Pull the "BEST CLICK TARGETS" block out of a cached ui_read result so a
// repeat read returns just the short menu instead of the whole list.
function extractClickMenu(uiReadResult: string): string {
  const start = uiReadResult.indexOf('BEST CLICK TARGETS');
  if (start === -1) {
    // Older/unmarked results: fall back to the first few lines.
    return uiReadResult.split('\n').slice(0, 12).join('\n').trim();
  }
  const end = uiReadResult.indexOf('FULL LIST:', start + 1);
  return (end === -1 ? uiReadResult.slice(start) : uiReadResult.slice(start, end)).trim();
}

// Pull the original request out of the conversation: the first user message's
// text (the first paragraph — the app-context/clipboard extras are appended
// after a blank line and are not the user's goal).
function sessionGoalFrom(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    }
    const firstParagraph = text.split(/\n\s*\n/)[0]?.trim();
    if (firstParagraph) return firstParagraph;
  }
  return '';
}

// Find elements in a cached ui_read result whose labels match the user's goal
// tokens ("click download now" → "Download Now"). Returns up to 3 hits as
// "el82 \"Download Now\""-style strings so the router can hand the weak model
// the exact id instead of making it map the goal to the list itself.
function findGoalMatches(goal: string | undefined, uiReadResult: string | null): string[] {
  if (!goal || !uiReadResult) return [];
  const tokens = goalTokens(goal);
  if (tokens.length === 0) return [];
  const hits: Array<{ id: string; name: string; score: number }> = [];
  const row = /el(\d+)\s+\S+\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = row.exec(uiReadResult)) !== null) {
    const name = m[2];
    const score = goalScoreFor(name, tokens);
    if (score > 0) hits.push({ id: m[1], name, score });
  }
  // Most-relevant first; longer (more specific) labels break ties.
  hits.sort((a, b) => b.score - a.score || b.name.length - a.name.length);
  return hits.slice(0, 3).map((h) => `el${h.id} "${h.name}"`);
}

export type { ProviderId };
