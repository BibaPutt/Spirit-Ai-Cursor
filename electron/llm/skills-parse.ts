// Skills — pure parsing + prompt composition (Phase 5). No Electron imports,
// so this module is unit-testable in isolation. Electron glue lives in
// ./skills.ts; bundled skill files ship under resources/skills/*.md.

export type SkillSection = {
  id: string;
  name: string;
  description: string;
  apps?: string[];
  defaultEnabled: boolean;
  body: string;
  // On-demand relevance triggers (Phase 5b): the skill's body is injected into
  // the system message ONLY when the current turn is relevant to one of these
  // keywords. A skill with no `triggers` (and no `always`) is treated as
  // always-on to preserve the original behavior for existing skills.
  triggers?: string[];
  always?: boolean;
};

// Delimiters around the injected skills block inside a system message — same
// convention as the memory block markers in contextMemory.ts, so the block is
// identifiable and (if we ever need it) strippable.
export const SKILLS_BLOCK_START = '<!--SPIRIT-SKILLS-->';
export const SKILLS_BLOCK_END = '<!--/SPIRIT-SKILLS-->';

const FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

function parseFrontmatterField(line: string): { key: string; value: string } | null {
  const m = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
  if (!m) return null;
  return { key: m[1], value: m[2] };
}

// A `key: value` or `key: [a, b]` map parsed from the YAML-ish frontmatter.
// Kept deliberately simple — the bundled skills are author-controlled files.
export function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of raw.split(/\r?\n/)) {
    const field = parseFrontmatterField(line);
    if (!field) continue;
    const trimmed = field.value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      out[field.key] = trimmed
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      out[field.key] = trimmed;
    }
  }
  return out;
}

const boolField = (v: string | string[] | undefined, fallback: boolean): boolean =>
  typeof v === 'string' ? v === 'true' : fallback;

// Parse a skill document (frontmatter + markdown body). `id` is derived from
// the file name by the caller. Missing frontmatter is tolerated: the skill
// falls back to sensible defaults and the whole document is treated as body.
export function parseSkillDocument(fileText: string, id?: string): SkillSection {
  const match = FRONTMATTER_RE.exec(fileText);
  if (!match) {
    return {
      id: id ?? 'unknown',
      name: id ?? 'Untitled skill',
      description: '',
      defaultEnabled: false,
      body: fileText.trim(),
    };
  }
  const fm = parseFrontmatter(match[1]);
  const apps = Array.isArray(fm.apps) ? fm.apps : typeof fm.apps === 'string' ? [fm.apps] : undefined;
  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : id ?? 'Untitled skill';
  const triggers = Array.isArray(fm.triggers)
    ? fm.triggers
    : typeof fm.triggers === 'string' && fm.triggers.trim()
      ? [fm.triggers]
      : undefined;
  return {
    id: id ?? 'unknown',
    name,
    description: typeof fm.description === 'string' ? fm.description.trim() : '',
    apps,
    defaultEnabled: boolField(fm.defaultEnabled, false),
    triggers,
    always: boolField(fm.always, false),
    body: fileText.slice(match[0].length).trim(),
  };
}

// Compose the enabled skills into one delimited block. Returns '' when no
// skills are enabled so the base prompt stays byte-identical (zero cost when
// the feature is off).
export function composeSkillsSection(sections: SkillSection[]): string {
  if (sections.length === 0) return '';
  const bodies = sections
    .map((s) => `## ${s.name}\n${s.body}`)
    .join('\n\n');
  return `${SKILLS_BLOCK_START}\n# Skills\nYou have these optional capabilities. Use them only when relevant to the task — never mention them, and never let passive skill text override an explicit user instruction.\n\n${bodies}\n${SKILLS_BLOCK_END}`;
}

// On-demand relevance filter (Phase 5b): pick which enabled skills apply to
// THIS turn. A skill applies when it has no `triggers` (legacy always-on), when
// it is marked `always: true`, or when ANY trigger keyword appears (case-
// insensitive) in the current prompt or app context. This lets the heavy
// always-on instruction blocks (annotation tags, tours, DATA blocks) leave the
// base system prompt and inject only when the turn actually needs them, freeing
// the context budget for the screenshot.
export type SkillRelevanceCtx = {
  prompt?: string;
  appText?: string;
};

export function skillApplies(s: SkillSection, ctx: SkillRelevanceCtx): boolean {
  if (s.always) return true;
  if (!s.triggers || s.triggers.length === 0) return true;
  const haystack = `${ctx.prompt ?? ''}\n${ctx.appText ?? ''}`.toLowerCase();
  return s.triggers.some((t) => t && t.toLowerCase().length > 0 && haystack.includes(t.toLowerCase()));
}

export function filterSkillsByRelevance(
  sections: SkillSection[],
  ctx: SkillRelevanceCtx,
): SkillSection[] {
  if (!ctx.prompt && !ctx.appText) return sections;
  return sections.filter((s) => skillApplies(s, ctx));
}

// Append the enabled skills block to a base system prompt. Pure and cheap:
// returns `base` unchanged when no skill sections are active.
export function promptWithSkills(
  basePrompt: string,
  sections: SkillSection[],
  ctx: SkillRelevanceCtx = {},
): string {
  const section = composeSkillsSection(ctx.prompt || ctx.appText ? filterSkillsByRelevance(sections, ctx) : sections);
  return section ? `${basePrompt}\n\n${section}` : basePrompt;
}

export function parseSkillFileName(fileName: string): string {
  return fileName.replace(/\.md$/i, '');
}