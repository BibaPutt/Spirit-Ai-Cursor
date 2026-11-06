import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeSkillsSection,
  filterSkillsByRelevance,
  parseFrontmatter,
  parseSkillDocument,
  promptWithSkills,
  skillApplies,
  SKILLS_BLOCK_END,
  SKILLS_BLOCK_START,
} from '../electron/llm/skills-parse';

describe('parseSkillDocument', () => {
  it('parses name, description, apps list and defaultEnabled', () => {
    const doc = [
      '---',
      'name: Check PDF documents',
      'description: Answer questions about a PDF',
      'apps: [Preview, Acrobat, Chrome]',
      'defaultEnabled: true',
      '---',
      'When the user asks about a PDF on screen:',
      '- quote the exact sentence',
    ].join('\n');
    const s = parseSkillDocument(doc, 'pdf-documents');
    expect(s.id).toBe('pdf-documents');
    expect(s.name).toBe('Check PDF documents');
    expect(s.description).toBe('Answer questions about a PDF');
    expect(s.apps).toEqual(['Preview', 'Acrobat', 'Chrome']);
    expect(s.defaultEnabled).toBe(true);
    expect(s.body).toContain('quote the exact sentence');
  });

  it('defaults apps absent / defaultEnabled false', () => {
    const s = parseSkillDocument(
      ['---', 'name: Foo', 'description: Does foo', '---', 'body'].join('\n'),
      'foo',
    );
    expect(s.apps).toBeUndefined();
    expect(s.defaultEnabled).toBe(false);
  });

  it('tolerates missing frontmatter entirely', () => {
    const s = parseSkillDocument('just body text', 'bare');
    expect(s.id).toBe('bare');
    expect(s.name).toBe('bare');
    expect(s.description).toBe('');
    expect(s.defaultEnabled).toBe(false);
    expect(s.body).toBe('just body text');
  });

  it('parses on-demand triggers + always from frontmatter', () => {
    const s = parseSkillDocument(
      [
        '---',
        'name: Screen annotation',
        'description: Annotate',
        'defaultEnabled: true',
        'triggers: [annotate, point, chemistry, diagram]',
        'always: false',
        '---',
        'body',
      ].join('\n'),
      'screen-annotation',
    );
    expect(s.triggers).toEqual(['annotate', 'point', 'chemistry', 'diagram']);
    expect(s.always).toBe(false);
  });
});

describe('skillApplies / filterSkillsByRelevance', () => {
  const onDemand = {
    id: 'ann',
    name: 'Annotation',
    description: '',
    defaultEnabled: true,
    triggers: ['chemistry', 'diagram', 'annotate'],
    body: 'tag rules',
  };
  const legacyAlways = {
    id: 'legacy',
    name: 'Legacy',
    description: '',
    defaultEnabled: true,
    body: 'always on',
  };

  it('always-on skill applies regardless of context', () => {
    expect(skillApplies(legacyAlways, { prompt: 'hello world' })).toBe(true);
    expect(skillApplies(legacyAlways, { prompt: '' })).toBe(true);
  });

  it('on-demand skill applies when a trigger matches the prompt', () => {
    expect(skillApplies(onDemand, { prompt: 'explain this chemistry reaction' })).toBe(true);
    expect(skillApplies(onDemand, { prompt: 'annotate the diagram' })).toBe(true);
  });

  it('on-demand skill does not apply when no trigger matches', () => {
    expect(skillApplies(onDemand, { prompt: 'what is your favorite color' })).toBe(false);
  });

  it('matches triggers case-insensitively', () => {
    expect(skillApplies(onDemand, { prompt: 'CHEMISTRY' })).toBe(true);
  });

  it('filterSkillsByRelevance returns all when no context is given', () => {
    expect(filterSkillsByRelevance([onDemand, legacyAlways], {})).toHaveLength(2);
  });

  it('filterSkillsByRelevance drops on-demand skills with no match, keeps always-on', () => {
    const out = filterSkillsByRelevance([onDemand, legacyAlways], {
      prompt: 'unrelated query',
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('legacy');
  });

  it('promptWithSkills omits on-demand skills that do not match the prompt', () => {
    const out = promptWithSkills('base', [onDemand], { prompt: 'unrelated' });
    expect(out).toBe('base');
  });
});

describe('bundled skill files', () => {
  const dir = join(process.cwd(), 'resources', 'skills');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch {
    files = [];
  }

  it('loads and parses every bundled skill file', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const s = parseSkillDocument(readFileSync(join(dir, f), 'utf-8'), f.replace(/\.md$/i, ''));
      expect(s.id).toBeTruthy();
      expect(typeof s.defaultEnabled).toBe('boolean');
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  it('the chemistry/annotation workflow keeps the screen skills enabled', () => {
    const all = files.map((f) =>
      parseSkillDocument(readFileSync(join(dir, f), 'utf-8'), f.replace(/\.md$/i, '')),
    );
    const enabled = all.filter((s) => s.defaultEnabled);
    const ctx = { prompt: 'explain this chemistry reaction and annotate the diagram on screen' };
    const fired = enabled.filter((s) => skillApplies(s, ctx));
    const ids = fired.map((s) => s.id);
    expect(ids).toContain('screen-annotation');
    expect(ids).toContain('desktop-tours');
    expect(ids).toContain('data-blocks');
  });

  it('an unrelated trivia prompt injects few heavy skills', () => {
    const all = files.map((f) =>
      parseSkillDocument(readFileSync(join(dir, f), 'utf-8'), f.replace(/\.md$/i, '')),
    );
    const enabled = all.filter((s) => s.defaultEnabled);
    const ctx = { prompt: 'who won the 1987 world cup' };
    const fired = enabled.filter((s) => skillApplies(s, ctx));
    // No chemistry/tour/diagram triggers fired — only screen-annotation (always:true) stays.
    expect(fired.every((s) => s.id === 'screen-annotation')).toBe(true);
  });
});

describe('parseFrontmatter', () => {
  it('parses scalar and list fields', () => {
    const fm = parseFrontmatter('name: Email\napps: [Mail, Gmail]\ndefaultEnabled: true\n');
    expect(fm.name).toBe('Email');
    expect(fm.apps).toEqual(['Mail', 'Gmail']);
    expect(fm.defaultEnabled).toBe('true');
  });
});

describe('composeSkillsSection', () => {
  it('returns empty string when no skills are enabled', () => {
    expect(composeSkillsSection([])).toBe('');
  });

  it('wraps enabled skills in the delimited block', () => {
    const out = composeSkillsSection([
      { id: 'a', name: 'Alpha', description: '', defaultEnabled: true, body: 'Use alpha.' },
    ]);
    expect(out.startsWith(SKILLS_BLOCK_START)).toBe(true);
    expect(out.endsWith(SKILLS_BLOCK_END)).toBe(true);
    expect(out).toContain('## Alpha');
    expect(out).toContain('Use alpha.');
  });
});

describe('promptWithSkills', () => {
  const base = 'You are Spirit.';

  it('returns the base prompt unchanged when no skills are active', () => {
    expect(promptWithSkills(base, [])).toBe(base);
  });

  it('appends the block after the base prompt', () => {
    const out = promptWithSkills(base, [
      { id: 'a', name: 'Alpha', description: '', defaultEnabled: true, body: 'Use alpha.' },
    ]);
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain(SKILLS_BLOCK_START);
    expect(out.indexOf(SKILLS_BLOCK_START) > base.length).toBe(true);
  });
});