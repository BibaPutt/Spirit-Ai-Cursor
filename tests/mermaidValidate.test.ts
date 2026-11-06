import { describe, expect, it } from 'vitest';
import {
  extractMermaidCode,
  validateMermaidCode,
} from '../electron/llm/mermaid-validate';

describe('extractMermaidCode', () => {
  it('extracts block bodies', () => {
    const text = 'Hi\n[MERMAID]\ngraph TD\nA-->B\n[/MERMAID]\nBye';
    expect(extractMermaidCode(text)).toEqual(['graph TD\nA-->B']);
  });

  it('extracts multiple blocks', () => {
    const text =
      '[MERMAID]\ngraph TD\nA-->B\n[/MERMAID]\ntext\n[MERMAID]\npie\n[/MERMAID]';
    expect(extractMermaidCode(text)).toEqual(['graph TD\nA-->B', 'pie']);
  });

  it('returns [] when there are no blocks', () => {
    expect(extractMermaidCode('no diagram here')).toEqual([]);
  });
});

describe('validateMermaidCode', () => {
  it('accepts a plain flowchart', () => {
    const r = validateMermaidCode('graph TD\nA["Start"] --> B["End"]');
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('accepts each common diagram kind', () => {
    const kinds = [
      'graph TD\nA-->B',
      'flowchart LR\nA-->B',
      'sequenceDiagram\nA->>B: hi',
      'classDiagram\nclass A',
      'erDiagram\nCAR ||--o{ TRIP : takes',
      'stateDiagram-v2\n[*] --> Idle',
      'gantt\ntitle A\nsection B\nC : 1, 2',
      'pie\n"cats" : 2\n"dogs" : 3',
      'journey\ntitle Trip\nsection Day\nGo: 3: A',
      'timeline\ntitle t\nA: B',
      'quadrantChart\ntitle q\nx-axis a --> b\ny-axis lo --> hi\nA: 0.3, 0.6',
      'mindmap\nroot((x))\n  A[B]',
      'gitGraph\ncommit',
    ];
    for (const code of kinds) {
      expect(validateMermaidCode(code).ok, code).toBe(true);
    }
  });

  it('rejects empty diagrams', () => {
    const r = validateMermaidCode('');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty/);
  });

  it('rejects a body with no diagram-type directive', () => {
    const r = validateMermaidCode('stray words that are not a diagram');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/directive/);
  });

  it('accepts an edge-only body because the sanitizer rescues it with a header', () => {
    const r = validateMermaidCode('A --> B\nC --> D');
    expect(r.ok).toBe(true);
    expect(r.sanitized.startsWith('graph TD')).toBe(true);
  });

  it('rejects diagrams with unbalanced quotes', () => {
    const r = validateMermaidCode('graph TD\nA["unclosed');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/brackets|quotes/);
  });

  it('rejects triple-backtick fences inside the block', () => {
    const r = validateMermaidCode('graph TD\n```\nA-->B\n```');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fence/);
  });

  it('reports multiple reasons at once', () => {
    const r = validateMermaidCode('foo bar "unclosed');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/directive/);
    expect(r.reason).toMatch(/quotes/);
  });

  it('handles %% comments before and inside the diagram', () => {
    expect(validateMermaidCode('%% title: flow\ngraph TD\nA["Run"] --> B["— stop"]').ok).toBe(true);
    expect(
      validateMermaidCode('graph TD\n%% a comment\nA["x"] --> B["y"]').ok,
    ).toBe(true);
  });

  it('sanitizes unquoted labels into quoted labels', () => {
    const r = validateMermaidCode('graph TD\nA[ Hello world ]-->B');
    expect(r.ok).toBe(true);
    expect(r.sanitized).toContain('A["');
  });
});