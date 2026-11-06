import { describe, expect, it } from 'vitest';
import { tesseractPathCandidates } from '../electron/capture/tesseract';
import { pasteComboForPlatform } from '../electron/input/paste-combo';
import { axRoleToType, axRoleClickable } from '../electron/capture/ax-scene';

describe('tesseractPathCandidates', () => {
  it('keeps the Windows install path as the first candidate (Windows regression)', () => {
    expect(tesseractPathCandidates('win32')[0]).toBe(
      'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
    );
  });

  it('covers the usual macOS brew/usr locations', () => {
    expect(tesseractPathCandidates('darwin')).toEqual([
      '/opt/homebrew/bin/tesseract',
      '/usr/local/bin/tesseract',
      '/usr/bin/tesseract',
    ]);
  });

  it('covers the usual Linux apt locations', () => {
    expect(tesseractPathCandidates('linux')).toEqual([
      '/usr/bin/tesseract',
      '/usr/local/bin/tesseract',
    ]);
  });
});

describe('pasteComboForPlatform', () => {
  it('uses Cmd+V on macOS', () => {
    expect(pasteComboForPlatform('darwin')).toBe('meta+v');
  });

  it('uses Ctrl+V on Windows and Linux (Windows regression: identical to before)', () => {
    expect(pasteComboForPlatform('win32')).toBe('ctrl+v');
    expect(pasteComboForPlatform('linux')).toBe('ctrl+v');
  });
});

describe('axRoleToType', () => {
  it('maps common macOS roles to the Windows-aligned scene types', () => {
    expect(axRoleToType('AXButton')).toBe('Button');
    expect(axRoleToType('AXCheckBox')).toBe('CheckBox');
    expect(axRoleToType('AXTextField')).toBe('Edit');
    expect(axRoleToType('AXTextArea')).toBe('Edit');
    expect(axRoleToType('AXLink')).toBe('Hyperlink');
    expect(axRoleToType('AXWindow')).toBe('Window');
    expect(axRoleToType('AXDialog')).toBe('Window');
    expect(axRoleToType('AXStaticText')).toBe('Text');
    expect(axRoleToType('AXMenuBar')).toBe('MenuBar');
  });

  it('marks clickable roles clickable and containers not', () => {
    expect(axRoleClickable('AXButton')).toBe(true);
    expect(axRoleClickable('AXCheckBox')).toBe(true);
    expect(axRoleClickable('AXTextField')).toBe(true);
    expect(axRoleClickable('AXWindow')).toBe(false);
    expect(axRoleClickable('AXStaticText')).toBe(false);
  });

  it('is tolerant of unknown roles', () => {
    expect(axRoleToType('AXMysteryThing')).toBe('unknown');
    expect(axRoleClickable('AXMysteryThing')).toBe(false);
  });
});
