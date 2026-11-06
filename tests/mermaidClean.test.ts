import { describe, expect, it } from 'vitest';
import {
  sanitizeMermaidCode,
  stripMermaidColorDirectives,
} from '../electron/llm/mermaid-clean';
import {
  diagramFitWidth,
  normalizeAccentRgb,
} from '../renderer/components/MermaidDiagram';

describe('stripMermaidColorDirectives', () => {
  it('removes model-injected style lines', () => {
    const code = 'graph TD;\n  A[Rain] --> B[Cloud]\n  style A fill:#f9f,stroke:#333;\n  style B fill:#fff,stroke:#111;';
    expect(stripMermaidColorDirectives(code)).toBe(
      'graph TD;\n  A[Rain] --> B[Cloud]\n\n',
    );
  });

  it('removes classDef and linkStyle lines too', () => {
    const code = 'graph LR;\n  classDef X fill:#f96,stroke:#333;\n  A --> B;\n  class A,B X;\n  linkStyle 0 stroke:#ff3,stroke-width:4px;';
    const out = stripMermaidColorDirectives(code);
    expect(out).not.toContain('classDef');
    expect(out).not.toContain('linkStyle');
    expect(out).toContain('class A,B X');
    expect(out).toContain('A --> B;');
  });

  it('leaves plain diagram source untouched', () => {
    const code = 'graph TD;\n  A[Rain] --> B[Cloud] --> C[Sea];\n  B --> D[River];';
    expect(stripMermaidColorDirectives(code)).toBe(code);
  });

  it('strips the three directives at the start of a line with indentation', () => {
    const code = 'graph TD;\n   style A fill:#000\n   classDef B fill:#fff\n   linkStyle 1 stroke:#123';
    const out = stripMermaidColorDirectives(code);
    expect(out).not.toContain('style A');
    expect(out).not.toContain('classDef B');
    expect(out).not.toContain('linkStyle 1');
  });
});

describe('normalizeAccentRgb', () => {
  it('converts space-separated accent rgb to comma-separated for mermaid', () => {
    expect(normalizeAccentRgb('10 132 255')).toBe('10, 132, 255');
  });

  it('passes already-comma-separated values through', () => {
    expect(normalizeAccentRgb('10, 132, 255')).toBe('10, 132, 255');
  });

  it('normalizes inconsistent spacing', () => {
    expect(normalizeAccentRgb('  10   132  255  ')).toBe('10, 132, 255');
  });

  it('falls back to the default accent when unparseable', () => {
    expect(normalizeAccentRgb('')).toBe('10, 132, 255');
    expect(normalizeAccentRgb('1 2')).toBe('10, 132, 255');
  });
});

describe('sanitizeMermaidCode', () => {
  it('prepends a flowchart header when the model omitted any diagram type', () => {
    expect(sanitizeMermaidCode('B --> C["Water Vapor Rises"]; C --> D')).toBe(
      'graph TD\nB --> C["Water Vapor Rises"];\nC --> D',
    );
  });

  it('prepends a header past a %% title comment line', () => {
    expect(sanitizeMermaidCode('%% title: Rain Cycle\n\nA --> B')).toBe(
      'graph TD\n%% title: Rain Cycle\n\nA --> B',
    );
  });

  it('never double-adds a header when one already exists', () => {
    const out = sanitizeMermaidCode('graph TD\nA[Rain] --> B[Cloud]');
    expect(out.startsWith('graph TD')).toBe(true);
    expect(out.match(/graph TD/g)).toHaveLength(1);
  });

  it('leaves non-graph prose alone (no header invented)', () => {
    expect(sanitizeMermaidCode('S% temperature rises ...')).toBe(
      'S% temperature rises ...',
    );
  });

  it('splits statements glued with ; or : before the next edge', () => {
    const out = sanitizeMermaidCode('D --> E[Cloud); E--> F(Precip)');
    expect(out).toContain('E["Cloud"];\nE--> F(Precip)');
    expect(out.startsWith('graph TD')).toBe(true);
  });

  it('repairs labels opened with [ but closed with )', () => {
    expect(sanitizeMermaidCode('D --> E[ Cloud Formation);')).toBe(
      'graph TD\nD --> E[" Cloud Formation"];',
    );
  });

  it('keeps parens INSIDE a bracket label intact and quotes the label', () => {
    // Regression: the old "["...")" repair matched the label's INTERNAL ")"
    // and produced `E["Time Series Input (Date/Time, mm"]]` — a double ] that
    // dropped the closing ) and broke the whole diagram.
    const out = sanitizeMermaidCode(
      'graph TD\nA[Rainfall (mm/day)] --> E[Time Series Input (Date/Time, mm)]',
    );
    expect(out).toContain('A["Rainfall (mm/day)"]');
    expect(out).toContain('E["Time Series Input (Date/Time, mm)"]');
    expect(out).not.toContain('"]]');
  });

  it('does not corrupt brace or legacy paren labels with parens', () => {
    const out = sanitizeMermaidCode(
      'graph TD\na{Track (Weekly)} --> b((Final Result))\nK --> c{Apply Aggregation (Daily/Hourly)}',
    );
    expect(out).toContain('a{"Track (Weekly)"}');
    expect(out).toContain('b((Final Result))');
    expect(out).toContain('c{"Apply Aggregation (Daily/Hourly)"}');
  });

  it('never swallows a %% title comment, header, or indented node (space-ID fix)', () => {
    // Regression: the space-ID fix used \s+ which crossed newlines and ate the
    // header + comment + node above the target label, mangling output to
    // `%% title: node_1["..."] --> B{...}` and `graph TD\n%% title: node_1...`.
    const src =
      '%% title: Conceptual Rainfall Diagram Workflow\n' +
      'graph TD\n' +
      '    %% Input Phase\n' +
      '    A[Observed Rainfall Data] --> B{Data Source Check};\n' +
      '    E --> F[Data Cleaning & Validation];';
    const out = sanitizeMermaidCode(src);
    expect(out).toContain('%% title: Conceptual Rainfall Diagram Workflow');
    expect(out).toContain('%% Input Phase');
    expect(out).toContain('A["Observed Rainfall Data"] --> B{"Data Source Check"};');
    expect(out).toMatch(/^graph TD$/m);
    expect(out).not.toContain('node_1');
    expect(out).not.toContain('%% title: node_1');
  });

  it('harms nothing on a stray garbled multi-word ID on a single line', () => {
    const out = sanitizeMermaidCode(
      'graph TD\nLong Garbled Text[Label] --> C["Sea"]',
    );
    expect(out).toMatch(/node_\d+\["Label"\] --> C\["Sea"\]/);
  });

  it('strips a trailing bare `end` that closes nothing', () => {
    const out = sanitizeMermaidCode(
      'graph TD\nA[Start] --> B[Hub]\nC[App] --> D[Light]\nend',
    );
    expect(out).not.toContain('end');
    expect(out).toBe(
      'graph TD\nA["Start"] --> B["Hub"]\nC["App"] --> D["Light"]\n',
    );
  });

  it('strips a bare `end;` glued onto the last node line', () => {
    const out = sanitizeMermaidCode('graph TD\nA --> B;end;');
    expect(out).toBe('graph TD\nA --> B');
    expect(out).not.toContain('end');
  });

  it('keeps a real subgraph... end block intact', () => {
    const out = sanitizeMermaidCode(
      'graph TD\nsubgraph One\nA --> B\nend\nC --> D',
    );
    expect(out).toContain('subgraph "One"');
    expect(out).toContain('\nend\n');
    expect(out).toContain('C --> D');
    expect(out.match(/end/g)).toHaveLength(1);
  });

  it('keeps the word `end` inside a quoted label', () => {
    const out = sanitizeMermaidCode('graph TD\nA["the end of days"] --> B');
    expect(out).toContain('A["the end of days"] --> B');
    expect(out).toContain('end');
  });

  it('does not eat an `end` used as a node id', () => {
    const out = sanitizeMermaidCode('graph TD\nend[X] --> B');
    expect(out).toContain('end["X"] --> B');
  });
});

describe('sanitizeMermaidCode — LaTeX in labels', () => {
  it('converts LaTeX math to Unicode before mermaid parsing', () => {
    const code = 'graph TD;\n  A["\\alpha \\neq 0"] --> B["E = mc^2"];';
    const out = sanitizeMermaidCode(code);
    expect(out).toContain('α ≠ 0');
    expect(out).toContain('E = mc²');
    expect(out).not.toContain('\\alpha');
  });

  it('leaves a plain flowchart parseable (labels still get quoted)', () => {
    const code = 'graph TD;\n  A[Start] --> B[Stop];';
    const out = sanitizeMermaidCode(code);
    expect(out).toContain('A["Start"] --> B["Stop"];');
    expect(out).not.toContain('\\');
  });
});

describe('diagramFitWidth', () => {
  it('fills the parent for a wide diagram', () => {
    expect(diagramFitWidth(460, 1000, 400)).toBe(460);
  });

  it('shrinks a tall diagram to fit the height budget', () => {
    // 500x800 at 320px max height -> 200px wide
    expect(diagramFitWidth(460, 500, 800)).toBe(200);
  });

  it('respects a custom height budget', () => {
    expect(diagramFitWidth(460, 500, 800, 200)).toBe(125);
  });

  it('falls back to the parent width without a usable viewBox', () => {
    expect(diagramFitWidth(460, 0, 0)).toBe(460);
    expect(diagramFitWidth(0, 1000, 500)).toBe(1);
  });
});
