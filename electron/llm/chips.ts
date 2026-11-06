// Action suggestions: given TEXT-ONLY context (OCR of the
// region under the cursor, on-screen selection, foreground app + tab), ask the
// active provider for up to 3 short action chips the user can tap. No
// screenshot, no vision tokens, no tools — a single cheap fast-tier round.
// Post-answer "next action" chips are NOT a second call: the main answer's
// model appends a [NEXT_ACTIONS] block, which chips-parse strips + parses.
import type { Message } from './prompt';
import { frameHash } from '../capture/frame-hash';
import { resolveChipsProviderChain } from './providers/router';
import { runWithRoundRetries } from './providers/round-retry';
import {
  circuitAllows,
  cooldownRemainingMs,
  recordProviderFailure,
  recordProviderSuccess,
} from './providers/circuit';
import { getChipsUseMainProvider, getSettingsLight } from '../store/settings';
import type { RequestRequirements } from './providers/types';
import { ProviderHttpError, shouldRetryStatus } from './providers/types';
import {
  REPLY_CHIP_PROMPT,
  SAFETY_MARKER,
  parseChipSuggestions,
  summarizeSessionContext,
  type SuggestionChip,
} from './chips-parse';
import { fallbackChipsFor, type FallbackOptions } from './chips-fallback';

export type { SuggestionChip };
export { summarizeSessionContext } from './chips-parse';

const CHIPS_TIMEOUT_MS = 30_000;

// A deliberately short list of icon words a weak model can pick from. The
// renderer fuzzy-matches whatever comes back to the installed Tabler set.
const ICON_VOCAB = [
  'sparkles', 'summarize', 'translate', 'search', 'bulb', 'write', 'mail',
  'table', 'code', 'list', 'link', 'math', 'calendar', 'idea',
  'quote', 'map', 'check', 'star', 'refresh', 'download', 'share', 'zoom',
].join(', ');

export const CHIP_SYSTEM_PROMPT = `You are the action-suggestion engine inside an AI cursor companion. Given only TEXT visible on the user's screen (OCR of the region they are pointing at, any on-screen text selection, and the foreground app / active browser tab), predict up to 3 short action chips the user can tap to act on that context.

OUTPUT FORMAT — return a STRICT, VALID JSON array. One chip per object, ONE object per line, no other text, no code fences, no markdown, nothing before or after. Use ONLY double quotes, a colon (:) between key and value, and a comma (,) after every field except the last. Never use semicolons. Copy this shape exactly:

[
  {"label":"Short visible text","icon":"summarize","prompt":"Hidden instruction sent to the AI when tapped"},
  {"label":"Second action","icon":"translate","prompt":"Hidden instruction for this chip"}
]

Put a comma between objects but NOT after the last object. Start with [ and end with ].

RULES:
- Return AT MOST 3 chips.
- When the user message includes a "RECENT CONVERSATION CONTEXT" section (an ongoing session is open), make exactly ONE of your chips a natural NEXT STEP in that conversation or task: a follow-up question, a continuation, or the next action that completes the work. Ground its hidden prompt in what the user last asked and what Spirit last said. The other chips (up to two) come from the visible SCREEN CONTEXT as before. Exception: when the on-screen conversation rule below applies (a live chat/email is visible), the Reply-as-me chip stays FIRST and this conversation-context chip becomes your SECOND.
- Each chip has THREE fields:
  - "label" — the short text the user SEES on the pill (45 characters or fewer).
  - "icon" — ONE lowercase icon word from the list below.
  - "prompt" — the HIDDEN, full, self-contained instruction that is sent to the AI when the user taps this chip. The user never sees it. It must clearly and directly tell the AI what to do with the visible context, in the user's language, so the AI does not have to guess from the short label. 400 characters or fewer. If you can't write a better instruction, expand the label into a sentence.
- If the SCREEN CONTEXT shows an open conversation — a chat/messaging thread or an email ("Conversation type: chat" or "Conversation type: email" is present, or the OCR/app clearly shows message text) — make your FIRST chip EXACTLY: {"label":"Suggest a reply","icon":"mail","prompt":"${REPLY_CHIP_PROMPT}"}. That chip means "draft a reply to the visible conversation the way the user writes", with tone matched to the app. Add it ONLY when a conversation is actually visible; then add up to 2 more distinct chips. Never add it otherwise.
- When NO conversation is on screen (a terminal, file explorer, code editor, system settings, shell flyout…), never emit any chip whose label mentions replying or responding — there is nothing to reply to.
- Each label is a DIRECT, executable prompt in the user's language: start with a strong action verb ("Summarize", "Translate", "Draft", "Turn this into...") or frame a direct question the assistant can answer from the screen context.
- Prefer first-person phrasing ("Help me draft a reply", "Explain what I selected").
- Each label is 45 characters or fewer. No quotes, numbering, bullets, or trailing punctuation.
- Chips must be DISTINCT and ideally span intents: understand (explain/summarize), transform (translate/table/code), ideate (brainstorm/next steps), execute (draft/send).
- NEVER suggest copying: no "Copy", "Copy this", "Copy to clipboard", or anything that merely puts text on the clipboard. Copying is a manual action, not a chip. Ground every chip in what is actually present (visible text, app, tab). Never invent content that is not there.
- Match the language and culture of the visible text. Stay neutral and inclusive.
- "icon": ONE lowercase word from this list — ${ICON_VOCAB} — that best matches the action. Use "sparkles" when unsure.

SAFETY: never suggest actions on sensitive data (passwords, account numbers, private messages) or anything harmful. If NO safe, useful chip exists, reply with exactly: ${SAFETY_MARKER}

SCREEN CONTEXT:`;

// User settings that tune the offline fallback chips (translate-to language,
// calendar provider). Read fresh at failure time so a settings save is picked
// up without a restart.
function fallbackOpts(): FallbackOptions {
  const light = getSettingsLight();
  return {
    translateTo: light.userProfile.translateLanguage,
    calendarProvider: light.calendarProvider,
  };
}

async function runChipRound(userText: string, sessionContext: string): Promise<SuggestionChip[]> {
  if (!userText.trim()) return [];
  // Chips use the MAIN provider chain by default (cheap, no extra setup).
  // When the user configured a chips-only provider set in Settings →
  // Behaviour → "Suggest actions", this resolves to THAT chain instead.
  const { chain } = resolveChipsProviderChain();
  if (chain.length === 0) return [];
  // Local-only setup: small local models are slow at chips and fail
  // offline — every hover waited out timeouts and retries. Serve the
  // instant built-in set instead (same as premade mode).
  if (chain.every(({ provider }) => provider.id === 'localai' || provider.id === 'opencode')) {
    console.log('[chips] local-only chain — serving premade set, skipping provider round');
    return userText.trim() ? fallbackChipsFor(userText, fallbackOpts()) : [];
  }
  console.log(
    `[chips] chain: ${chain.map((p) => p.provider.id).join(' → ') || '(empty)'} | useMain=${
      getChipsUseMainProvider()
    }`,
  );
  console.log(`[chips] user input ${frameHash(userText.trim())}`);

  const req: RequestRequirements = {
    web: false,
    vision: false,
    allowTools: false,
    tier: 'fast',
  };
  // The running conversation's brief excerpt (when an ongoing session exists)
  // rides along as its own block; the prompt asks for exactly one chip
  // grounded in it and the rest from the screen context.
  const userTextBlock = sessionContext.trim()
    ? `${userText}\n\nRECENT CONVERSATION CONTEXT (brief):\n${sessionContext}`
    : userText;
  const messages: Message[] = [
    { role: 'system', content: CHIP_SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'text', text: userTextBlock }] },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('chips timeout')), CHIPS_TIMEOUT_MS);

  try {
    let firstError: unknown = null;
    for (const { provider, apiKey } of chain) {
      // Same breaker as the main chain: a provider on an open circuit is
      // skipped so a hover never waits out a dead lane's retries.
      if (!circuitAllows(provider.id)) {
        const wait = Math.ceil(cooldownRemainingMs(provider.id) / 1000);
        console.warn(`[chips] ${provider.id} cooling down (${wait}s left); trying next provider`);
        firstError = new Error(
          `${provider.displayName} is cooling down after repeated failures (retry in ${wait}s).`,
        );
        continue;
      }
      try {
        const model = provider.pickModel(req);
        // Background path: 2 attempts max. Chips must fail fast — 5 attempts
        // against a dead server hung every hover for minutes (seen live).
        const round = await runWithRoundRetries(provider.id, controller.signal, () =>
          provider.runRound(
            model,
            messages,
            apiKey,
            undefined,
            controller.signal,
            () => {},
          ),
          undefined,
          2,
        );
        const raw = round.contentText ?? '';
        console.log(`[chips] ${provider.id} | model=${model} | raw=${raw.slice(0, 400)}`);
        // The HTTP round completed — that is what proves the lane healthy,
        // even when the text parses to nothing and chips fall back.
        recordProviderSuccess(provider.id);
        if (raw.trim() && raw.toUpperCase().includes(SAFETY_MARKER)) return fallbackChipsFor(userText, fallbackOpts());
        const parsed = parseChipSuggestions(raw);
        if (parsed.length > 0) return parsed;
        console.warn('[chips] model output parsed to nothing — using fallback chips');
        return fallbackChipsFor(userText, fallbackOpts());
      } catch (err) {
        // Shared 30s budget: an abort here may mean an EARLIER provider ate
        // the clock, so this lane is not guilty — never record aborts.
        if (controller.signal.aborted) return [];
        console.warn(`[chips] ${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        const status = err instanceof ProviderHttpError ? err.status : 0;
        const isAuth = status === 401 || status === 403;
        // Auth needs a human, not a cooldown — and recording it would mask
        // the auth error behind a "cooling down" message on the next query.
        // Local servers rejecting a request (no key involved) do count.
        const localRejected = isAuth && (provider.id === 'localai' || provider.id === 'opencode');
        if (!isAuth || localRejected) {
          recordProviderFailure(provider.id, { instant: status === 429 });
        }
        if (err instanceof ProviderHttpError && shouldRetryStatus(err.status)) {
          firstError = err;
          continue;
        }
        firstError = err;
        continue;
      }
    }
    if (firstError) {
      console.warn(
        `[chips] generation failed: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
      );
    }
    return fallbackChipsFor(userText, fallbackOpts());
  } finally {
    clearTimeout(timer);
  }
}

export function generateChipSuggestions(
  contextText: string,
  sessionContext = '',
): Promise<SuggestionChip[]> {
  // Chips source setting: premade skips the provider and returns the
  // built-in offline set; custom returns the user's own list (empty list
  // falls back to premade so the box is never chipless). Smart on a
  // local-only setup also goes premade: small local models are slow at
  // chips and fail offline, and every hover waited out the retry storm.
  const light = getSettingsLight();
  if (light.chipsSource === 'premade') {
    return Promise.resolve(contextText.trim() ? fallbackChipsFor(contextText, fallbackOpts()) : []);
  }
  if (light.chipsSource === 'custom') {
    const custom = Array.isArray(light.customChips) ? light.customChips : [];
    const chips: SuggestionChip[] = custom
      .filter((c) => c && c.label?.trim() && c.prompt?.trim())
      .slice(0, 6)
      .map((c) => ({
        label: c.label.trim().slice(0, 45),
        icon: c.icon?.trim() || 'sparkles',
        prompt: c.prompt.trim().slice(0, 400),
      }));
    if (chips.length > 0) return Promise.resolve(chips);
    return Promise.resolve(contextText.trim() ? fallbackChipsFor(contextText, fallbackOpts()) : []);
  }
  return runChipRound(contextText, sessionContext);
}
