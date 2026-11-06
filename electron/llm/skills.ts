// Skills — Electron glue (Phase 5). Loads the bundled skill .md files from
// resources/skills (packaged via electron-builder extraResources into
// `<resources>/skills`, project-relative in dev), resolves which are enabled
// from settings, and exposes the catalog + prompt injection points to the IPC
// and chat paths. Pure parsing/composition lives in ./skills-parse.ts.
import { app } from 'electron';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnabledSkillIds, setEnabledSkills } from '../store/settings';
import {
  composeSkillsSection,
  parseSkillDocument,
  promptWithSkills as composePrompt,
  parseSkillFileName,
  type SkillRelevanceCtx,
  type SkillSection,
} from './skills-parse';
import type { SkillInfo } from '../types';

let catalog: SkillSection[] | null = null;

// Where bundled skills live:
//  - packaged: <resources>/skills (electron-builder extraResources, outside
//    the ASAR, same root as bin/)
//  - dev:      <appPath>/resources/skills
function skillsDirectory(): string | null {
  const candidates = [
    join(process.resourcesPath, 'skills'),
    join(app.getAppPath(), 'resources', 'skills'),
  ];
  for (const dir of candidates) {
    try {
      if (existsSync(dir) && readdirSync(dir).some((f) => f.toLowerCase().endsWith('.md'))) {
        return dir;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

// Load + parse every bundled skill file. Synchronous — a handful of small
// markdown files at app startup, mirrors the store's own sync init.
export function initSkills(): void {
  const dir = skillsDirectory();
  if (!dir) {
    catalog = [];
    return;
  }
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort();
  catalog = files.map((f) => {
    try {
      const id = parseSkillFileName(f);
      const raw = readFileSync(join(dir, f), 'utf-8');
      return parseSkillDocument(raw, id);
    } catch (err) {
      console.warn(`[skills] failed to load ${f}:`, err);
      return null;
    }
  }).filter((s): s is SkillSection => s !== null);
}

// Catalog with `enabled` resolved from the user's settings. null stored state
// → each skill falls back to its frontmatter defaultEnabled.
export function getSkillsCatalog(): SkillInfo[] {
  const all = catalog ?? [];
  const configured = getEnabledSkillIds();
  return all.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    apps: s.apps,
    defaultEnabled: s.defaultEnabled,
    enabled: configured ? configured.includes(s.id) : s.defaultEnabled,
  }));
}

// Persist a single toggle. First explicit change adopts the defaults as the
// baseline so only the toggled skill differs.
export function setSkillEnabled(id: string, enabled: boolean): void {
  const all = catalog ?? [];
  if (!all.some((s) => s.id === id)) return;
  const configured = getEnabledSkillIds();
  const baseline = configured ?? all.filter((s) => s.defaultEnabled).map((s) => s.id);
  const next = enabled ? Array.from(new Set([...baseline, id])) : baseline.filter((x) => x !== id);
  setEnabledSkills(next);
}

// The current enabled-skill section (cached string; recomputed on toggle/init).
let sectionCache: string | null = null;

export function refreshSkillsSection(): string {
  const all = catalog ?? [];
  const configured = getEnabledSkillIds();
  const enabled = all.filter((s) =>
    configured ? configured.includes(s.id) : s.defaultEnabled,
  );
  sectionCache = composeSkillsSection(enabled);
  return sectionCache;
}

export function currentSkillsSection(): string {
  if (sectionCache === null) refreshSkillsSection();
  return sectionCache ?? '';
}

// Append the enabled (and on-demand-relevant) skills block to the base system
// prompt. Pass the current turn's prompt + app context to trigger on-demand
// skills. Token- and byte-neutral when no skills are active (returns `base`
// unchanged).
export function promptWithSkills(basePrompt: string, ctx: SkillRelevanceCtx = {}): string {
  const all = catalog ?? [];
  const configured = getEnabledSkillIds();
  const enabled = all.filter((s) =>
    configured ? configured.includes(s.id) : s.defaultEnabled,
  );
  return composePrompt(basePrompt, enabled, ctx);
}

export function initSkillsRuntime(): void {
  initSkills();
  refreshSkillsSection();
}