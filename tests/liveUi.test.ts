import { describe, expect, it } from 'vitest';
import { liveUiFrom } from '../electron/llm/live-ui';

const UI_BLOCK = `{"title":"Comparison","t":"card","children":[{"t":"stat","label":"CPU","text":"42%"}]}`;

describe('liveUiFrom — streaming block masking', () => {
  it('passes plain text through with no live block', () => {
    const { maskedText, live } = liveUiFrom('The answer starts here.');
    expect(maskedText).toBe('The answer starts here.');
    expect(live).toBeNull();
  });

  it('passes an empty string through', () => {
    expect(liveUiFrom('')).toEqual({ maskedText: '', live: null });
  });

  it('masks a mid-stream [UI] block and reads the title once it streams', () => {
    // Title has not arrived yet → fallback kind title.
    const partial = liveUiFrom(`Lead. [UI] {"t":"card","children":[{\"t\":` + '}');
    expect(partial.maskedText).not.toContain('[UI]');
    expect(partial.live).toEqual({ kind: 'ui', title: 'Component' });
    // Once the title field streams, the tile shows it.
    const titled = liveUiFrom(`Lead. [UI] ${UI_BLOCK}`);
    expect(titled.maskedText).toBe('Lead. ');
    expect(titled.live).toEqual({ kind: 'ui', title: 'Comparison' });
  });

  it('keeps the live placeholder on the last block once closed (final not landed)', () => {
    const { maskedText, live } = liveUiFrom(`Done. [UI] ${UI_BLOCK} [/UI]`);
    expect(maskedText).toBe('Done. ');
    expect(live).toEqual({ kind: 'ui', title: 'Comparison' });
  });

  it('hides raw JSON even for a closed block', () => {
    const { maskedText } = liveUiFrom(`Pre [UI] ${UI_BLOCK} [/UI] Post.`);
    expect(maskedText).toBe('Pre  Post.');
    expect(maskedText).not.toContain('"t":"card"');
    expect(maskedText).not.toContain('[/UI]');
  });

  it('extracts [QUESTIONS] titles from the JSON object', () => {
    const questions = liveUiFrom(`[QUESTIONS] {"title":"Budget quiz","questions":[{"q":"How much?","type":"number"}]}`);
    expect(questions.live).toEqual({ kind: 'questions', title: 'Budget quiz' });
    expect(questions.maskedText).toBe('');
  });

  it('extracts [MERMAID] titles from the %% first comment line', () => {
    const mermaid = liveUiFrom('[MERMAID]\n%% Deploy pipeline\ngraph TD; A-->B;\n[/MERMAID]');
    expect(mermaid.live).toEqual({ kind: 'mermaid', title: 'Deploy pipeline' });
    const emptyFirst = liveUiFrom('[MERMAID]\ngraph TD; A-->B;');
    expect(emptyFirst.live).toEqual({ kind: 'mermaid', title: 'Diagram' });
    const prefixed = liveUiFrom('[MERMAID]\n%% title: User flow\ngraph TD; A-->B;');
    expect(prefixed.live).toEqual({ kind: 'mermaid', title: 'User flow' });
  });

  it('extracts [DIAGRAM] titles from the %% first line and masks the raw HTML', () => {
    const diagram = liveUiFrom(
      '[DIAGRAM]\n%% Release pipeline\n<div class="dg-flow"><div class="dg-box">Build</div></div>\n[/DIAGRAM]',
    );
    expect(diagram.live).toEqual({ kind: 'diagram', title: 'Release pipeline' });
    expect(diagram.maskedText).not.toContain('dg-box');
    expect(diagram.maskedText).not.toContain('[DIAGRAM]');
    const notitle = liveUiFrom('[DIAGRAM]\n<div class="dg-box">x</div>');
    expect(notitle.live).toEqual({ kind: 'diagram', title: 'Diagram' });
  });

  it('handles sequential closed + trailing in-progress blocks', () => {
    const both = liveUiFrom(`[UI] ${UI_BLOCK} [/UI] [MERMAID]\n%% Flow\ngraph LR; X-->Y;`);
    // Only the whitespace between the two blocks survives (raw JSON is gone).
    expect(both.maskedText).toBe(' ');
    // Trailing in-progress mermaid drives the placeholder.
    expect(both.live).toEqual({ kind: 'mermaid', title: 'Flow' });
  });

  it('tolerates sloppy tag formatting', () => {
    const sloppy = liveUiFrom('[ ui ]\n{\n  "title": "Stats",\n  "t": "card",\n  "children": []\n}\n[/ui]');
    expect(sloppy.live).toEqual({ kind: 'ui', title: 'Stats' });
    expect(sloppy.maskedText).toBe('');
  });

  it('masks [NEXT_ACTIONS] chips JSON/labels without showing a placeholder', () => {
    const chips = liveUiFrom(
      'Answer. [NEXT_ACTIONS]\n{"chips":[{"label":"Save File","prompt":"Save that"}]}\n[/NEXT_ACTIONS]',
    );
    expect(chips.maskedText).toBe('Answer. ');
    expect(chips.maskedText).not.toContain('chips');
    expect(chips.maskedText).not.toContain('Save File');
    // Next-actions never drives a placeholder tile — chips appear at finalize.
    expect(chips.live).toBeNull();
  });

  it('masks an unclosed trailing [NEXT_ACTIONS] block', () => {
    const partial = liveUiFrom('Answer text.\n[NEXT_ACTIONS]\n{"chips":[{');
    expect(partial.maskedText).toBe('Answer text.\n');
    expect(partial.maskedText).not.toContain('NEXT_ACTIONS');
    expect(partial.maskedText).not.toContain('chips');
    expect(partial.live).toBeNull();
  });

  it('does not let NEXT_ACTIONS steal the placeholder when a UI block is also open', () => {
    const both = liveUiFrom(`[UI] ${UI_BLOCK} [NEXT_ACTIONS]\n{"chips":[1]}`);
    expect(both.maskedText).toBe('');
    expect(both.live).toEqual({ kind: 'ui', title: 'Comparison' });
  });
});