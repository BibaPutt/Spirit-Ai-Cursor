import { describe, expect, it } from 'vitest';
import { splitGoal } from '../electron/llm/split';
import { REPLY_CHIP_PROMPT } from '../electron/llm/chips-parse';

describe('splitGoal', () => {
  it('never splits a goal carrying the [REPLY] contract tags', () => {
    expect(splitGoal(REPLY_CHIP_PROMPT)).toEqual([REPLY_CHIP_PROMPT]);
  });

  it('splits a numbered list into parts', () => {
    expect(splitGoal('1. open excel 2. make a table 3. paste it')).toEqual([
      'open excel',
      'make a table',
      'paste it',
    ]);
  });

  it('splits numbered lists with parentheses style numbering', () => {
    expect(splitGoal('1) open excel  2) paste a table')).toEqual([
      'open excel',
      'paste a table',
    ]);
  });

  it('splits a bulleted list', () => {
    expect(splitGoal('- open excel\n- paste a table')).toEqual([
      'open excel',
      'paste a table',
    ]);
  });

  it('never splits natural-language sentences on "and", commas or "then"', () => {
    expect(splitGoal('open excel, make a table, paste it')).toEqual([
      'open excel, make a table, paste it',
    ]);
    expect(splitGoal('open excel then paste the sales table into a new document')).toEqual([
      'open excel then paste the sales table into a new document',
    ]);
    expect(splitGoal('open the file, please')).toEqual(['open the file, please']);
  });

  it('does not split a single sentence without list markers', () => {
    expect(splitGoal('download the file for me')).toEqual(['download the file for me']);
  });

  it('never splits a single summarize/comparison question (no fake "1. Done" parts)', () => {
    expect(
      splitGoal(
        'Summarize the provided comparison table between Taxonomy and Ontology to give a concise overview of the key differences.',
      ),
    ).toEqual([
      'Summarize the provided comparison table between Taxonomy and Ontology to give a concise overview of the key differences.',
    ]);
    expect(splitGoal('What is the difference between Taxonomy and Ontology?')).toEqual([
      'What is the difference between Taxonomy and Ontology?',
    ]);
  });

  it('never splits inside quoted strings', () => {
    expect(splitGoal('save the note as "Q3, draft" and then export it')).toEqual([
      'save the note as "Q3, draft" and then export it',
    ]);
  });

  it('returns [goal] for an empty-ish input', () => {
    expect(splitGoal('')).toEqual([]);
    expect(splitGoal('ok')).toEqual(['ok']);
  });
});
