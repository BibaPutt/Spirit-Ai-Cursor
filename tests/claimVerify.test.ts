import { describe, expect, it } from 'vitest';
import { extractActionClaims, verifyActionClaims } from '../electron/llm/claim-verify';

const noTools = { executedTools: new Set<string>(), hasMutatingAction: false };

describe('extractActionClaims', () => {
  it('finds first-person past-tense claims', () => {
    expect(extractActionClaims('I clicked the Download button.')).toEqual(['clicked']);
    expect(extractActionClaims("I've typed my name into the box.")).toEqual(['typed']);
    expect(extractActionClaims('Already downloaded it for you.')).toContain('downloaded');
  });

  it('finds bare past-tense statements', () => {
    expect(extractActionClaims('Clicked Save.')).toEqual(['clicked']);
    expect(extractActionClaims('Opened Spotify.')).toEqual(['opened']);
  });

  it('ignores plans, questions and instructions', () => {
    expect(extractActionClaims('I will click the button now.')).toEqual([]);
    expect(extractActionClaims('Should I type the address?')).toEqual([]);
    expect(extractActionClaims('Once clicked, the menu opens.')).toEqual([]);
    expect(extractActionClaims("You can click Save when ready.")).toEqual([]);
    expect(extractActionClaims('Please click the Download button.')).toEqual([]);
  });

  it('ignores negated claims', () => {
    expect(extractActionClaims("I didn't click anything.")).toEqual([]);
    expect(extractActionClaims('I did not type a password.')).toEqual([]);
  });

  it('ignores descriptive mentions that are not assert-first-person', () => {
    // "the file saved fine" is third-party voice, no first-person assertion.
    expect(extractActionClaims('The file saved fine.')).toEqual([]);
  });

  it('dedupes repeated verbs', () => {
    const claims = extractActionClaims('I clicked Save. Clicked it twice.');
    expect(claims.filter((c) => c === 'clicked')).toHaveLength(1);
  });
});

describe('verifyActionClaims', () => {
  it('returns null when no claims in the answer', () => {
    expect(verifyActionClaims('Here are the results you asked for.', noTools)).toBeNull();
  });

  it('catches a claimed click with no mutating action at all', () => {
    const fix = verifyActionClaims('Done. I clicked the download button and it worked.', noTools);
    expect(fix).toBeTruthy();
    expect(fix).toMatch(/clicked/);
  });

  it('lets a claimed click pass when any mutating action ran', () => {
    const ctx = {
      executedTools: new Set(['ui_click']),
      hasMutatingAction: true,
    };
    expect(verifyActionClaims('Done. I clicked the download button.', ctx)).toBeNull();
  });

  it('catches a typed claim even when a click ran (mouse cannot type)', () => {
    const ctx = {
      executedTools: new Set(['ui_click', 'web_search']),
      hasMutatingAction: true,
    };
    const fix = verifyActionClaims('I clicked submit and typed my email.', ctx);
    expect(fix).toBeTruthy();
    expect(fix).toMatch(/typed/);
    expect(fix).toMatch(/type_text/);
  });

  it('passes a typed claim when type_text ran', () => {
    const ctx = {
      executedTools: new Set(['type_text']),
      hasMutatingAction: true,
    };
    expect(verifyActionClaims('I typed my email address.', ctx)).toBeNull();
  });

  it('passes a copied claim when copy_to_clipboard ran', () => {
    const ctx = { executedTools: new Set(['copy_to_clipboard']), hasMutatingAction: true };
    expect(verifyActionClaims('I copied the link for you.', ctx)).toBeNull();
  });

  it('catches a copied claim when nothing ran', () => {
    const ctx = { executedTools: new Set(['web_search']), hasMutatingAction: false };
    const fix = verifyActionClaims('I copied the link for you.', ctx);
    expect(fix).toBeTruthy();
  });

  it('does not fire for mixed claims when mutating actions cover the mouse verbs', () => {
    const ctx = {
      executedTools: new Set(['type_text']),
      hasMutatingAction: true,
    };
    expect(verifyActionClaims('I saved the file.', ctx)).toBeNull();
  });

  it('fires when the only mouse claim is unsupported but no action ran', () => {
    // This is the exact case the gate is FOR — a fabricated completion.
    const fix = verifyActionClaims('All set. I downloaded it.', noTools);
    expect(fix).toBeTruthy();
    expect(fix).toMatch(/downloaded/);
  });

  it('extracts file-creation claims (created / wrote / generated / made)', () => {
    expect(extractActionClaims('Created dashboard.html for you.')).toEqual(['created']);
    expect(extractActionClaims('I wrote the report to disk.')).toEqual(['wrote']);
    expect(extractActionClaims('Generated the export file.')).toEqual(['generated']);
    expect(extractActionClaims('Made a new folder.')).toEqual(['made']);
  });

  it('catches a "created" claim with no file-writing tool executed', () => {
    // "created" is precise: a click never makes a file, so even when a click
    // ran, an unsupported creation claim must fire.
    const ctx = { executedTools: new Set(['ui_click']), hasMutatingAction: true };
    const fix = verifyActionClaims('Done. I created C:\\Users\\me\\deck.pptx.', ctx);
    expect(fix).toBeTruthy();
    expect(fix).toMatch(/created/);
    expect(fix).toMatch(/create_file/);
  });

  it('passes a "created" claim when a writing tool ran', () => {
    const ctx = { executedTools: new Set(['create_file']), hasMutatingAction: true };
    expect(verifyActionClaims('I created dashboard.html.', ctx)).toBeNull();
  });

  it('passes a "wrote" claim when run_command wrote the file', () => {
    const ctx = { executedTools: new Set(['run_command']), hasMutatingAction: true };
    expect(verifyActionClaims('I wrote the file to disk.', ctx)).toBeNull();
  });

  it('catches a "saved as" style file claim with no writing tool', () => {
    // "saved" alone is lenient (a Save button is a click), but combined with a
    // file verb context the strict set still applies — here a bare past-tense
    // "created" must remain caught even with a generic mutating history bogus.
    const fix = verifyActionClaims('Created the backup file.', noTools);
    expect(fix).toBeTruthy();
  });
});