import { describe, expect, it } from 'vitest';
import { classifyScreenRelevance, classifyTopicPivot } from '../electron/llm/relevance';

describe('classifyScreenRelevance', () => {
  it('returns uncertain when there is no screen context', () => {
    expect(classifyScreenRelevance('what is the capital of France?', '')).toBe('uncertain');
  });

  it('returns related for deictic references regardless of overlap', () => {
    expect(classifyScreenRelevance('what is this?', 'Cow milking schedule 06:00')).toBe('related');
    expect(classifyScreenRelevance('summarize the screenshot', 'Some text on screen')).toBe('related');
    expect(classifyScreenRelevance('read the selected text', 'Any content')).toBe('related');
  });

  it('returns related when a significant token is shared', () => {
    expect(
      classifyScreenRelevance('what time is the cow milking?', 'OCR: cow milking schedule 06:00'),
    ).toBe('related');
  });

  it('returns related via the built-in synonym map', () => {
    // "cost" and "vehicle" are synonym-family siblings of "price" and "car".
    expect(
      classifyScreenRelevance('what is the cost of the vehicle?', 'Car price list: 20k'),
    ).toBe('related');
  });

  it('returns unrelated for a clearly different topic', () => {
    expect(
      classifyScreenRelevance(
        'What is the capital of France?',
        'Cows graze on green grass during summer months',
      ),
    ).toBe('unrelated');
  });

  it('returns uncertain for a single-word prompt', () => {
    expect(classifyScreenRelevance('Hello', 'Cow milking schedule 06:00')).toBe('uncertain');
  });
});

describe('classifyTopicPivot', () => {
  it('returns uncertain when there is no prior topic', () => {
    expect(classifyTopicPivot('what is a widget', '')).toBe('uncertain');
  });

  it('returns uncertain for a single-word prompt', () => {
    expect(classifyTopicPivot('ok', 'what are cows milking schedules')).toBe('uncertain');
  });

  it('returns pivot when the question changed topic away from the session opening', () => {
    expect(classifyTopicPivot('what is a widget', 'what are cows')).toBe('pivot');
    expect(classifyTopicPivot('What is the capital of France?', 'Cow milking schedule')).toBe('pivot');
  });

  it('returns same when the new question stays on the prior topic', () => {
    expect(classifyTopicPivot('how are cows milked?', 'what are cows')).toBe('same');
    expect(classifyTopicPivot('tell me more about cows', 'what are cows')).toBe('same');
  });

  it('returns same via the synonym map', () => {
    expect(classifyTopicPivot('how much does the vehicle cost', 'car price list')).toBe('same');
  });

  it('returns same for deictic references regardless of overlap', () => {
    expect(classifyTopicPivot('what is this?', 'Cow milking schedule')).toBe('same');
    expect(classifyTopicPivot('back to that page', 'Cow milking schedule')).toBe('same');
    expect(classifyTopicPivot('the ones shown above', 'Cow milking schedule')).toBe('same');
  });
});
