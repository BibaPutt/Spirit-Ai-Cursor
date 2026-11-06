import { describe, expect, it } from 'vitest';
import {
  MAX_CHIPS,
  REPLY_CHIP_PROMPT,
  SAFETY_MARKER,
  cacheKeyFor,
  isCopyChipLabel,
  normalizeChipContext,
  parseChipSuggestions,
  parseNextActionsFromAnswer,
  stripCopyChips,
  summarizeSessionContext,
  textSimilarity,
  withReplyChip,
  isReplyChipLabel,
  stripAppLogNoise,
} from '../electron/llm/chips-parse';
import { conversationKindFromContext } from '../electron/capture/conversation-kind';
import type { AppContext } from '../electron/types';
import { fuzzyResolveIcon, ICON_ALIASES } from '../renderer/lib/iconMatch';

describe('parseChipSuggestions', () => {
  it('1. parses a JSON array of {label, icon}', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([
        { label: 'Summarize this page', icon: 'summarize' },
        { label: 'Translate to Spanish', icon: 'translate' },
      ]),
    );
    expect(chips).toHaveLength(2);
    expect(chips[0]).toEqual({ label: 'Summarize this page', icon: 'summarize' });
  });

  it('2. parses "icon | label" and "label (icon)" lines', () => {
    const chips = parseChipSuggestions('book | Summarize\nSummarize the page (translate)');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toEqual({ label: 'Summarize', icon: 'book' });
    expect(chips[1]).toEqual({ label: 'Summarize the page', icon: 'translate' });
  });

  it('2b. strips leaked annotation tags from chip labels', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([
        { label: 'Save File [BOX:100,50:320,80:Save File]', icon: 'save' },
        { label: 'Reactant [POINT:140,90:Reactant]', icon: 'chem' },
        { label: 'Guide [ARROW:0,0:100,100:Guide:screen1]', icon: 'compass' },
      ]),
    );
    expect(chips).toEqual([
      { label: 'Save File', icon: 'save' },
      { label: 'Reactant', icon: 'chem' },
      { label: 'Guide', icon: 'compass' },
    ]);
  });

  it('2c. strips annotation tags from line-form and element-snap labels', () => {
    const chips = parseChipSuggestions('Save [BOX:el#:Save]\nExplain [BOX:12,34:56,78:Explain]');
    expect(chips[0].label).toBe('Save');
    expect(chips[1].label).toBe('Explain');
  });

  it('3. falls back to plain lines with an empty icon', () => {
    const chips = parseChipSuggestions('- Summarize this page\n2. Email the report');
    expect(chips).toHaveLength(2);
    expect(chips[0].label).toBe('Summarize this page');
    expect(chips[1].label).toBe('Email the report');
  });

  it('4. returns [] for a safety refusal marker', () => {
    expect(parseChipSuggestions(SAFETY_MARKER)).toEqual([]);
    expect(parseChipSuggestions(`prefix ${SAFETY_MARKER.toLowerCase()} suffix`)).toEqual([]);
  });

  it('5. returns [] for empty input', () => {
    expect(parseChipSuggestions('')).toEqual([]);
    expect(parseChipSuggestions('   ')).toEqual([]);
    expect(parseChipSuggestions('\n\n')).toEqual([]);
  });

  it('5b. treats a single non-empty junk line as one permissive chip', () => {
    // Deliberate: the parser is best-effort — a model that ignores the format
    // contract still yields a usable suggestion rather than nothing.
    expect(parseChipSuggestions('garbage not a list at all')).toEqual([
      { label: 'garbage not a list at all', icon: '' },
    ]);
  });

  it('6. caps at MAX_CHIPS', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ label: `Chip ${i}`, icon: 'sparkles' }));
    expect(parseChipSuggestions(JSON.stringify(many))).toHaveLength(MAX_CHIPS);
  });

  it('7. truncates over-long labels and normalizes icons', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([{ label: 'x'.repeat(80), icon: 'Icon-Translate_' }]),
    );
    expect(chips[0].label).toHaveLength(45);
    expect(chips[0].icon).toBe('translate');
  });

  it('8. dedupes repeated labels', () => {
    const chips = parseChipSuggestions('Summarize\nSummarize\nSummarize');
    expect(chips).toHaveLength(1);
  });

  it('9. strips code fences and markdown decorations', () => {
    const chips = parseChipSuggestions('```json\n[{"label":"Summarize","icon":"book"}]\n```');
    expect(chips).toEqual([{ label: 'Summarize', icon: 'book' }]);
  });

  it('9a. strips quote marks that wrap a term mid-label', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([
        { label: "Explain 'Defect Ide'", icon: 'bulb' },
        { label: "Detail the steps for 'Ensuring'", icon: 'check' },
      ]),
    );
    expect(chips[0].label).toBe('Explain Defect Ide');
    expect(chips[1].label).toBe('Detail the steps for Ensuring');
  });

  it('9b. strips a dangling leading apostrophe but keeps real contractions', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([
        { label: "Explain 'rigger detection attached", icon: 'bulb' },
        { label: "You're ready, Spirit's calling", icon: 'sparkles' },
      ]),
    );
    expect(chips[0].label).toBe('Explain rigger detection attached');
    expect(chips[1].label).toBe("You're ready, Spirit's calling");
  });

  it('9c. salvages a cut-off array and keeps the chips that finished before the cut', () => {
    const raw =
      '[{"label":"Summarize the spec","icon":"summarize"},' +
      '{"label":"Explain Defect Ide","icon":"bulb"},' +
      '{"label":"Detail the steps for Ensure'; // truncated mid-string
    const chips = parseChipSuggestions(raw);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toEqual({ label: 'Summarize the spec', icon: 'summarize' });
    expect(chips[1]).toEqual({ label: 'Explain Defect Ide', icon: 'bulb' });
  });

  it('9d. accepts a key mangled into "label arc"', () => {
    const chips = parseChipSuggestions(
      JSON.stringify([{ 'label arc': 'Summarize context', icon: 'summarize' }]),
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toEqual({ label: 'Summarize context', icon: 'summarize' });
  });

  it('9e. repairs a dropped "label X" separator', () => {
    const chips = parseChipSuggestions(
      '[{"label Mac", "icon": "summarize", "prompt": "Summarize the visible text"}]',
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].label).toBe('Mac');
    expect(chips[0].icon).toBe('summarize');
  });

  it('10. cacheKeyFor is stable for identical text and differs for edits', () => {
    const a = cacheKeyFor('hello world');
    const b = cacheKeyFor('hello world');
    const c = cacheKeyFor('hello worlds');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('fuzzyResolveIcon', () => {
  it('11. resolves exact aliases to the matching icon component', () => {
    expect(fuzzyResolveIcon('summarize')).toBe(ICON_ALIASES.summarize);
    expect(fuzzyResolveIcon('translate')).toBe(ICON_ALIASES.translate);
    expect(fuzzyResolveIcon('email')).toBe(ICON_ALIASES.email);
  });

  it('12. resolves prefixed words ("summarize-these-notes")', () => {
    expect(fuzzyResolveIcon('summarize-these-notes')).toBe(ICON_ALIASES.summarize);
  });

  it('13. fuzzy-matches near-miss spellings', () => {
    expect(fuzzyResolveIcon('translte')).toBe(ICON_ALIASES.translate);
    expect(fuzzyResolveIcon('sumarize')).toBe(ICON_ALIASES.summarize);
  });

  it('14. resolves icon names without the Icon- prefix/case', () => {
    expect(fuzzyResolveIcon('Icon-Book')).toBe(ICON_ALIASES.book);
    expect(fuzzyResolveIcon('icon_translate')).toBe(ICON_ALIASES.translate);
  });

  it('15. falls back to sparkles for unknown / empty words', () => {
    expect(fuzzyResolveIcon('flurbalot')).toBe(ICON_ALIASES.sparkles);
    expect(fuzzyResolveIcon('')).toBe(ICON_ALIASES.sparkles);
    expect(fuzzyResolveIcon(null)).toBe(ICON_ALIASES.sparkles);
    expect(fuzzyResolveIcon(undefined)).toBe(ICON_ALIASES.sparkles);
  });
});

describe('parseNextActionsFromAnswer', () => {
  const block = '[NEXT_ACTIONS]\n[{"label":"Summarize it","icon":"summarize"}]\n[/NEXT_ACTIONS]';

  it('16. extracts chips and strips the block from the answer', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer(`Here is the answer.

${block}`);
    expect(chips).toEqual([{ label: 'Summarize it', icon: 'summarize' }]);
    expect(cleanText).toBe('Here is the answer.');
  });

  it('16b. parses a block where each chip is its own one-element array line', () => {
    const multiLine = `[NEXT_ACTIONS]
[{"label": "Search for cow breeds", "icon": "search"}]
[{"label": "Find facts about dairy farming", "icon": "list"}]
[{"label": "How do cows digest grass", "icon": "explain"}]
[/NEXT_ACTIONS]`;
    const { chips, cleanText } = parseNextActionsFromAnswer(
      `Cows are ruminants.\n\n${multiLine}`,
    );
    expect(chips).toEqual([
      { label: 'Search for cow breeds', icon: 'search' },
      { label: 'Find facts about dairy farming', icon: 'list' },
      { label: 'How do cows digest grass', icon: 'explain' },
    ]);
    expect(cleanText).toBe('Cows are ruminants.');
  });

  it('17. returns the raw text untouched when no block exists', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer('Just a normal answer.');
    expect(chips).toEqual([]);
    expect(cleanText).toBe('Just a normal answer.');
  });

  it('18. strips EVERY tagged block and keeps the last good chips', () => {
    const answer = `First bit [NEXT_ACTIONS]garbage[/NEXT_ACTIONS] end. ${block}`;
    const { chips, cleanText } = parseNextActionsFromAnswer(answer);
    expect(chips).toEqual([{ label: 'Summarize it', icon: 'summarize' }]);
    expect(cleanText).toBe('First bit end.');
  });

  it('19. drops a stray code fence left after stripping', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer(`Answer text

\`\`\`
${block}
\`\`\``);
    expect(chips).toEqual([{ label: 'Summarize it', icon: 'summarize' }]);
    expect(cleanText).toBe('Answer text');
  });

  it('20. empty / safety-refusal block yields no chips and clean text', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer(
      `Answer. [NEXT_ACTIONS]${SAFETY_MARKER}[/NEXT_ACTIONS]`,
    );
    expect(chips).toEqual([]);
    expect(cleanText).toBe('Answer.');
  });

  it('21. caps at MAX_CHIPS and keeps existing normalization', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `Next ${i}`, icon: 'star' }));
    const { chips } = parseNextActionsFromAnswer(
      `Answer.\n[NEXT_ACTIONS]\n${JSON.stringify(many)}\n[/NEXT_ACTIONS]`,
    );
    expect(chips).toHaveLength(MAX_CHIPS);
  });

  it('22. parses a BARE chip array under a "Next actions for you:" header', () => {
    const answer = `your workflow stays uninterrupted.

Next actions for you:
[{"label": "Download Now", "icon": "sparkles"}]

I've identified the download button.`;
    const { chips, cleanText } = parseNextActionsFromAnswer(answer);
    expect(chips).toEqual([{ label: 'Download Now', icon: 'sparkles' }]);
    expect(cleanText).toBe('your workflow stays uninterrupted.\nI\'ve identified the download button.');
  });

  it('23. parses a BARE chip array dangling at the end (no header/tags)', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer(
      `Here is the answer.\n[{"label": "Translate to French", "icon": "translate"}]`,
    );
    expect(chips).toEqual([{ label: 'Translate to French', icon: 'translate' }]);
    expect(cleanText).toBe('Here is the answer.');
  });

  it('24. purges mid-answer junk chip arrays once chips are found', () => {
    const answer = `Done.\n[{"label": "Download Now", "icon": "sparkles"}]\nFinal text.\n${block}`;
    const { chips, cleanText } = parseNextActionsFromAnswer(answer);
    expect(chips).toEqual([{ label: 'Summarize it', icon: 'summarize' }]);
    expect(cleanText).toBe('Done.\n\nFinal text.');
  });

  it('25. does not fabricate chips from real prose arrays without "label"', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer('The list is [a, b, c] here.');
    expect(chips).toEqual([]);
    expect(cleanText).toBe('The list is [a, b, c] here.');
  });
});

describe('chip cache smart helpers', () => {
  it('26. normalizeChipContext collapses whitespace and drops blank lines', () => {
    expect(
      normalizeChipContext('  Region:\nOCR   text   here  \n\n\n\n  App:  Edge '),
    ).toBe('Region:\nOCR text here\nApp: Edge');
  });

  it('27. textSimilarity is 1 for identical, near-1 for tiny diffs, 0 for different', () => {
    const a = 'Region text about the current screen content';
    expect(textSimilarity(a, a)).toBe(1);
    expect(textSimilarity(a, `${a} `)).toBeGreaterThan(0.97);
    expect(textSimilarity(a, a.slice(0, 5))).toBeLessThan(0.5);
    expect(textSimilarity('completely different text', a)).toBeLessThan(0.4);
  });

  it('28. fuzzy reuse threshold rejects clearly different contexts', () => {
    const a = 'Current app: Edge\nActive tab: weather forecast';
    const b = 'Current app: Excel\nActive tab: sales report';
    expect(textSimilarity(a, b)).toBeLessThan(0.93);
  });
});

describe('reply chip + conversation detection', () => {
  const ctx = (p: Partial<AppContext>): AppContext => ({
    title: '',
    process: '',
    pid: 0,
    ...p,
  });

  it('29. detects email apps (process, web URL, tab)', () => {
    expect(conversationKindFromContext(ctx({ process: 'OUTLOOK.EXE' }))).toBe('email');
    expect(conversationKindFromContext(ctx({ process: 'thunderbird' }))).toBe('email');
    expect(
      conversationKindFromContext(ctx({ url: 'https://mail.google.com/mail/u/0/#inbox' })),
    ).toBe('email');
    expect(
      conversationKindFromContext(ctx({ activeTab: 'Inbox - sara@gmail.com - Gmail' })),
    ).toBe('email');
  });

  it('30. detects chat apps (process, web URL, tab)', () => {
    expect(conversationKindFromContext(ctx({ process: 'WhatsApp.exe' }))).toBe('chat');
    expect(conversationKindFromContext(ctx({ process: 'telegram' }))).toBe('chat');
    expect(conversationKindFromContext(ctx({ url: 'https://web.whatsapp.com/' }))).toBe('chat');
    expect(
      conversationKindFromContext(ctx({ title: 'John - Discord', process: 'msedge' })),
    ).toBe('chat');
  });

  it('31. non-conversation apps return null', () => {
    expect(conversationKindFromContext(ctx({ process: 'Code.exe', title: 'index.ts' }))).toBeNull();
    expect(
      conversationKindFromContext(ctx({ process: 'msedge', url: 'https://example.com/docs' })),
    ).toBeNull();
  });

  it('32. withReplyChip prepends "Suggest a reply" for chat/email only', () => {
    const general = [{ label: 'Summarize it', icon: 'summarize' }];
    expect(withReplyChip(general, null)).toEqual(general);
    const replyChip = { label: 'Suggest a reply', icon: 'mail', prompt: REPLY_CHIP_PROMPT };
    expect(withReplyChip(general, 'chat')).toEqual([replyChip, ...general]);
    expect(withReplyChip(general, 'email')).toEqual([replyChip, ...general]);
  });

  it('33. withReplyChip keeps an existing reply chip, carrying its label, and respects MAX_CHIPS', () => {
    expect(withReplyChip([{ label: 'Draft a reply', icon: 'mail' }], 'chat')).toEqual([
      { label: 'Draft a reply', icon: 'mail', prompt: REPLY_CHIP_PROMPT + '\nDraft a reply' },
    ]);
    const three = Array.from({ length: 3 }, (_, i) => ({ label: `Chip ${i}`, icon: 'sparkles' }));
    const out = withReplyChip(three, 'email');
    expect(out).toHaveLength(MAX_CHIPS);
    expect(out[0]).toEqual({ label: 'Suggest a reply', icon: 'mail', prompt: REPLY_CHIP_PROMPT });
  });

  it('33b. withReplyChip passes a custom reply chip label verbatim so the instruction is not lost', () => {
    const chips = withReplyChip([{ label: 'Reply in Hindi', icon: 'write' }], 'chat');
    expect(chips[0].prompt).toBe(REPLY_CHIP_PROMPT + '\nReply in Hindi');
    const formal = withReplyChip([{ label: 'Respond politely', icon: 'mail' }], 'email');
    expect(formal[0].prompt).toBe(REPLY_CHIP_PROMPT + '\nRespond politely');
  });

  it('34. withReplyChip strips hallucinated reply chips when NO conversation is on screen', () => {
    const chips = [
      { label: 'Suggest a reply', icon: 'mail' },
      { label: 'Summarize it', icon: 'summarize' },
    ];
    expect(withReplyChip(chips, null)).toEqual([{ label: 'Summarize it', icon: 'summarize' }]);
    expect(withReplyChip([{ label: 'Respond to John', icon: 'mail' }], null)).toEqual([]);
    expect(withReplyChip([{ label: 'Send a reply', icon: 'mail' }], null)).toEqual([]);
    const general = [{ label: 'Open file explorer', icon: 'sparkles' }];
    expect(withReplyChip(general, null)).toEqual(general);
  });

  it('35. isReplyChipLabel matches reply/respond but not unrelated words', () => {
    expect(isReplyChipLabel('Suggest a reply')).toBe(true);
    expect(isReplyChipLabel('Reply as me')).toBe(true);
    expect(isReplyChipLabel('Respond to email')).toBe(true);
    expect(isReplyChipLabel('Summarize the thread')).toBe(false);
    expect(isReplyChipLabel('Copy the URL')).toBe(false);
  });
});

describe('copy-chip filter', () => {
  it('36. isCopyChipLabel matches copy verbs but not copywriting/copyright', () => {
    expect(isCopyChipLabel('Copy')).toBe(true);
    expect(isCopyChipLabel('Copy this text')).toBe(true);
    expect(isCopyChipLabel('Copy the URL')).toBe(true);
    expect(isCopyChipLabel('Copied to clipboard')).toBe(true);
    expect(isCopyChipLabel('Summarize the page')).toBe(false);
    expect(isCopyChipLabel('Rewrite this paragraph')).toBe(false);
    expect(isCopyChipLabel('Write copywriting tips')).toBe(false);
    expect(isCopyChipLabel('Check copyright')).toBe(false);
  });

  it('37. stripCopyChips removes only copy-intent chips', () => {
    const chips = [
      { label: 'Copy the URL', icon: 'copy' },
      { label: 'Summarize this page', icon: 'summarize' },
      { label: 'Translate to French', icon: 'translate' },
    ];
    expect(stripCopyChips(chips)).toEqual([
      { label: 'Summarize this page', icon: 'summarize' },
      { label: 'Translate to French', icon: 'translate' },
    ]);
    expect(stripCopyChips([{ label: 'Draft a reply', icon: 'mail' }])).toEqual([
      { label: 'Draft a reply', icon: 'mail' },
    ]);
  });

  it('38. parseChipSuggestions drops copy chips from JSON and line input', () => {
    const fromJson = parseChipSuggestions(
      JSON.stringify([
        { label: 'Copy this', icon: 'copy' },
        { label: 'Summarize it', icon: 'summarize' },
      ]),
    );
    expect(fromJson).toEqual([{ label: 'Summarize it', icon: 'summarize' }]);
    expect(parseChipSuggestions('Copy the text\nExplain this')).toEqual([
      { label: 'Explain this', icon: '' },
    ]);
  });

  it('39. parseNextActionsFromAnswer strips copy chips from the block', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer(
      `Answer text.
[NEXT_ACTIONS]
[{"label":"Copy the URL","icon":"copy"},{"label":"Open the link","icon":"link"}]
[/NEXT_ACTIONS]`,
    );
    expect(chips).toEqual([{ label: 'Open the link', icon: 'link' }]);
    expect(cleanText).toBe('Answer text.');
  });

  it('39b. repairs semicolon key/value separators from weak models', () => {
    // Real log output: `"label"; "execute", "icon": "search", ...`
    const chips = parseChipSuggestions(
      '[\n  {\n    "label"; "execute",\n    "icon": "search",\n    "prompt": "Run the command in the terminal."\n  },\n  {\n    "label"; "search",\n    "icon": "search",\n    "prompt": "Find information."\n  }\n]',
    );
    expect(chips).toEqual([
      { label: 'execute', icon: 'search', prompt: 'Run the command in the terminal.' },
      { label: 'search', icon: 'search', prompt: 'Find information.' },
    ]);
  });

  it('39c. repairs missing commas between fields', () => {
    // Real log output: `"label"; "terminal_goal"\n"icon": "terminal"\n"prompt": ...`
    const chips = parseChipSuggestions(
      '[\n  {\n  "label"; "terminal_goal"\n  "icon": "terminal"\n  "prompt": "Explain the purpose of the terminal output in detail"\n}\n]',
    );
    expect(chips).toEqual([
      { label: 'terminal_goal', icon: 'terminal', prompt: 'Explain the purpose of the terminal output in detail' },
    ]);
  });

  it('39d. never surfaces unparseable JSON fragments as chip labels', () => {
    // Real log output (broken key `"label 同,`). The garbage must NOT become a
    // visible label; either the well-formed object is salvaged or nothing is.
    const chips = parseChipSuggestions(
      '[{"label 同, "icon": "search", "prompt": "Summarize the file explorer contents and explain the window situation"}]',
    );
    expect(chips.some((c) => c.label.includes('label 同'))).toBe(false);
    expect(chips.some((c) => c.label.startsWith('['))).toBe(false);
  });

  it('39f. salvages a valid object buried in an otherwise-broken array', () => {
    // Real log output: first object has a mangled `इन icon",` field, third
    // object opens with `(` and is truncated — but the MIDDLE object is valid
    // JSON and must survive.
    const chips = parseChipSuggestions(`[
  {
    "label": "Summarize the progress and tokens",इन icon",
    "prompt": "Summarize the token and progress data provided and identify the progress status"
  },
  {
    "label": "Analyze Progress",
    "icon": "progress",
    "prompt": "Analyze the progress data provided and identify the current state based on the metrics."
  },
  {
    ("label": "summarize", "icon": "summarize", "pro`);
    expect(chips).toEqual([
      { label: 'Analyze Progress', icon: 'progress', prompt: 'Analyze the progress data provided and identify the current state based on the metrics.' },
    ]);
  });

  it('39e. repairs unquoted and single-quoted keys', () => {
    const chips = parseChipSuggestions("[{label: 'Translate', icon: 'translate', prompt: 'Translate to French'}]");
    expect(chips).toEqual([{ label: 'Translate', icon: 'translate', prompt: 'Translate to French' }]);
  });

  it('39g. rescues the second chip when the array is split by a stray `]` and a later object uses an `=` separator', () => {
    // Real log output: the array closes early (`"}], {`) and the second
    // object writes `"icon="mail"` with an equals instead of a colon. Both
    // chips must survive — the mangled key `"label arcs"` is handled by the
    // `^label` key-prefix fallback, and the `=` separator is repaired.
    const chips = parseChipSuggestions(
      '[{"label arcs": "Summarize context", "icon":"summarize","prompt":"Summarize the current document contents"}], {"label": "Draft a response", "icon="mail", "prompt":"Draft a professional email responding to the user\'s request."} ]',
    );
    expect(chips).toEqual([
      { label: 'Summarize context', icon: 'summarize', prompt: 'Summarize the current document contents' },
      { label: 'Draft a response', icon: 'mail', prompt: "Draft a professional email responding to the user's request." },
    ]);
  });

  it('39h. repairs the `"key"="value"` separator shape too', () => {
    const chips = parseChipSuggestions(
      '[{"label"="Translate", "icon"="translate", "prompt"="Translate to French"}]',
    );
    expect(chips).toEqual([
      { label: 'Translate', icon: 'translate', prompt: 'Translate to French' },
    ]);
  });

  it('39i. recovers chips after the model closes the array after every object (stray `]` between objects)', () => {
    // Real log output: each chip wrapped in its own `[ ... ]` array.
    const chips = parseChipSuggestions(
      '[{"label":"Summarize","icon":"summarize","prompt":"Summarize the main points of this text"}], [ {"label":"Translate","icon":"translate","prompt":"Translate the content into English"}], [ {"label":"Search","icon":"search","prompt":"Search for more info"} ]',
    );
    expect(chips.map((c) => c.label)).toEqual(['Summarize', 'Translate', 'Search']);
  });

  it('39j. recovers objects that lost their opening brace after a stray `]`', () => {
    // Real log output: `[{...}],"label":…}],"label":…}` — the objects after
    // the first are missing their opening `{`.
    const chips = parseChipSuggestions(
      '[{"label":"Summarize context","icon":"summarize","prompt":"Summarize the current screen context for me"}],"label":"Analyze Context","icon":"summarize","prompt":"What is the main topic here"}],"label":"Context Analysis","icon":"analyze","prompt":"Explain what I see on the screen"}',
    );
    expect(chips.map((c) => c.label)).toEqual([
      'Summarize context',
      'Analyze Context',
      'Context Analysis',
    ]);
  });

  it('39k. repairs a comma written inside a quoted label that swallowed the next key\'s opening quote', () => {
    // Real log output: `"label":"Translate,"icon":"translate"` — the comma
    // belongs between the members, not inside the label string.
    const chips = parseChipSuggestions(
      '[{"label":"Summarize context","icon":"summarize","prompt":"Summarize the current screen context for me"}], [{"label":"Translate,"icon":"translate","prompt":"Translate the content of the active website into English"}, {"label":"Check,"icon":"check","prompt":"Check if the site is working correctly"} ]',
    );
    expect(chips.map((c) => c.label)).toEqual([
      'Summarize context',
      'Translate',
      'Check',
    ]);
  });

  it('40. parseNextActionsFromAnswer handles an UNCLOSED block (model forgot close tag)', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer(
      `Answer text.
[NEXT_ACTIONS]
[{"label":"Show me gaming laptops","icon":"list"},{"label":"Show me MSI specs","icon":"search"}]`,
    );
    expect(chips).toEqual([
      { label: 'Show me gaming laptops', icon: 'list' },
      { label: 'Show me MSI specs', icon: 'search' },
    ]);
    expect(cleanText).toBe('Answer text.');
  });

  it('41. parseNextActionsFromAnswer purges a leftover open tag with no array', () => {
    const { chips, cleanText } = parseNextActionsFromAnswer('Answer text.\n[NEXT_ACTIONS]');
    expect(chips).toEqual([]);
    expect(cleanText).toBe('Answer text.');
  });
});

describe('summarizeSessionContext', () => {
  it('42. returns empty for no messages or junk-only history', () => {
    expect(summarizeSessionContext([])).toBe('');
    expect(summarizeSessionContext([{ role: 'system', content: 'be nice' }])).toBe('');
    expect(summarizeSessionContext([{ role: 'tool', tool_call_id: 'x', content: '' }])).toBe('');
  });

  it('43. extracts text from string and ContentBlock[] contents', () => {
    const out = summarizeSessionContext([
      { role: 'user', content: 'help me pick a laptop' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here are 3 options. ' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
        ],
      },
    ]);
    expect(out).toBe('User: help me pick a laptop\nSpirit: Here are 3 options.');
  });

  it('44. keeps only the last 3 user/assistant pairs', () => {
    const messages = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `question ${i}` });
      messages.push({ role: 'assistant', content: `answer ${i}` });
    }
    const out = summarizeSessionContext(messages);
    expect(out).toContain('User: question 3');
    expect(out).toContain('Spirit: answer 5');
    expect(out).not.toContain('question 0');
    expect(out).not.toContain('answer 1');
  });

  it('45. trims long single lines to 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = summarizeSessionContext([{ role: 'user', content: long }]);
    expect(out.startsWith('User: ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual('User: '.length + 200 + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('46. collapses internal whitespace on each line', () => {
    const out = summarizeSessionContext([
      { role: 'user', content: 'line1   \n\n   line2' },
    ]);
    expect(out).toBe('User: line1 line2');
  });

  it('47. skips assistant tool_calls messages (content null)', () => {
    const out = summarizeSessionContext([
      { role: 'user', content: 'click the button' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'ui_click', arguments: '{}' } }] },
    ]);
    expect(out).toBe('User: click the button');
  });
});

describe('stripAppLogNoise', () => {
  it('48. strips the app\'s own debug log lines from a polluted OCR/selection blob', () => {
    const polluted = [
      `title='Arc' raw={"tab":"demo.example.com","url":""}`,
      `[chips] localai | model=gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf | raw=[{"label":"Summarize context","icon":"summarize","prompt":"Summarize the current screen context for me"}]`,
      `t-UD-Q2_K_XL.gguf | raw=[{"Llabel": "Summarize context", "i`,
      `for me"}], "label": "Analyze Context", "icon": "summarize", "`,
      `s", "icon": "analyze", "prompt": "Explain what I see on the :`,
      `[chips] result: "Summarize context" | source=generated`,
      `[app-context] url-walk empty hwnd=197312 title='Arc' raw={"tab":"demo.example.com","url":""}`,
      `CONTEXT AS OF 6:04:50 pm`,
      `[forward-click] synthesizing left click at 461,569`,
      `[chips] sessionCtx=(none)`,
      `[chips] chainFp=openrouter:off|localai:http://localhost:8082/`,
      `The screen shows the Sample App landing page.`,
    ].join('\n');
    const out = stripAppLogNoise(polluted);
    expect(out).not.toContain('[chips]');
    expect(out).not.toContain('[app-context]');
    expect(out).not.toContain('raw=');
    expect(out).not.toContain('gguf');
    expect(out).not.toContain('chainFp=');
    expect(out).not.toContain('sessionCtx=');
    expect(out).not.toContain('CONTEXT AS OF');
    expect(out).toContain('Sample App landing page');
  });

  it('49. keeps ordinary screen text and empty input untouched', () => {
    expect(stripAppLogNoise('Hello\nworld')).toBe('Hello\nworld');
    expect(stripAppLogNoise('')).toBe('');
    expect(stripAppLogNoise('  \n  ')).toBe('');
  });

  it('50. does not strip a bare JSON-ish line that is not a chip payload', () => {
    // A single `"label":` on a line must survive — the chip-JSON rule needs
    // two of the three fields.
    expect(stripAppLogNoise('Some page text "label": "Settings"')).toBe(
      'Some page text "label": "Settings"',
    );
  });
});
