import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getName: () => 'Spirit',
    getVersion: () => 'test',
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {},
  desktopCapturer: { getSources: vi.fn() },
  screen: { getAllDisplays: vi.fn(), getPrimaryDisplay: vi.fn(), getCursorScreenPoint: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

import {
  buildClickTargetsMenu,
  formatQuickElementMap,
  formatScene,
  goalScoreFor,
  goalTokens,
  isActionGoal,
  resolveElementById,
  textSourceForGoal,
  type Scene,
  type SceneElement,
} from '../electron/capture/scene';

function el(partial: Partial<SceneElement> & { id: string; name: string }): SceneElement {
  return {
    type: 'text',
    bounds: [0, 0, 10, 10],
    center: [0, 0],
    enabled: true,
    clickable: true,
    source: 'ocr',
    ...partial,
  };
}

function scene(elements: SceneElement[]): Scene {
  return { windowTitle: 'Arc', elements, monitor: { width: 1920, height: 1080 } };
}

describe('goalTokens', () => {
  it('extracts the meaningful noun, dropping action/function words', () => {
    expect(goalTokens('click download now please')).toEqual(['download']);
    expect(goalTokens('download the latest build')).toEqual(['download', 'latest', 'build']);
  });

  it('returns empty for goal-less requests', () => {
    expect(goalTokens('please click the button now')).toEqual([]);
  });
});

describe('goalScoreFor', () => {
  it('scores by substring overlap, case-insensitively', () => {
    expect(goalScoreFor('Download Now', ['download'])).toBe(1);
    expect(goalScoreFor('Home', ['download'])).toBe(0);
    expect(goalScoreFor('Download beta v2', ['download', 'beta'])).toBe(2);
  });
});

describe('buildClickTargetsMenu', () => {
  const home = el({ id: 'el61', name: 'demo.example.com', center: [976, 18] });
  const navDownload = el({ id: 'el65', name: 'Download', center: [1145, 79] });
  const ctaDownloadNow = el({ id: 'el82', name: 'Download Now', center: [933, 533] });
  const chromeIcon = el({
    id: 'el10',
    name: 'downloadButton',
    center: [96, 17],
    source: 'uia',
  });
  const plans = el({ id: 'el66', name: 'Plans', center: [1261, 81] });

  it('leads with the goal-matched OCR CTA, then other matches, then fillers', () => {
    const menu = buildClickTargetsMenu(
      scene([home, navDownload, ctaDownloadNow, chromeIcon, plans]),
      5,
      'click download now',
    );
    expect(menu.map((e) => e.id)).toEqual(['el82', 'el65', 'el10', 'el61', 'el66']);
  });

  it('falls back to screen order when there is no goal', () => {
    const menu = buildClickTargetsMenu(scene([home, navDownload, ctaDownloadNow, chromeIcon]), 3);
    expect(menu.map((e) => e.id)).toEqual(['el61', 'el65', 'el82']);
  });
});

describe('isActionGoal / textSourceForGoal', () => {
  it('marks action requests as OCR (they need screen coordinates)', () => {
    expect(isActionGoal('click Download Now please')).toBe(true);
    expect(isActionGoal('download the latest build')).toBe(true);
    expect(isActionGoal('type my name into the field')).toBe(true);
    expect(isActionGoal('scroll down on this page')).toBe(true);
  });

  it('marks pure reading requests as web (webfetch, no OCR)', () => {
    expect(isActionGoal('what does this page say')).toBe(false);
    expect(isActionGoal('summarize this article')).toBe(false);
    expect(isActionGoal('what is the price on this site')).toBe(false);
    expect(isActionGoal('')).toBe(false);
  });

  it('does not treat function-word lookalikes as actions', () => {
    expect(isActionGoal('display this for me')).toBe(false);
    expect(isActionGoal('find out what time it is')).toBe(false);
  });

  it('maps the goal to a text source', () => {
    expect(textSourceForGoal('click download now')).toBe('ocr');
    expect(textSourceForGoal('read this page for me')).toBe('web');
  });
});

describe('formatScene with fetched page text', () => {
  const chromeControls = [
    {
      id: 'el1',
      type: 'Button',
      name: 'Back',
      bounds: [0, 0, 40, 20],
      center: [20, 10],
      enabled: true,
      clickable: true,
      source: 'uia' as const,
    },
  ];

  it('appends the fetched page text as a PAGE CONTENT block', () => {
    const out = formatScene({
      windowTitle: 'Weather - Google Search - Microsoft Edge',
      elements: chromeControls,
      monitor: { width: 1920, height: 1080 },
      pageText: { url: 'https://weather.example/?q=seattle', text: 'Seattle, WA 12°C partly cloudy.' },
    });
    expect(out).toContain('PAGE CONTENT (fetched from https://weather.example/?q=seattle):');
    expect(out).toContain('Seattle, WA 12°C partly cloudy.');
    expect(out).toContain('fetched from the site, so it has no screen positions');
  });

  it('shows fetched page text even when no interactive elements exist', () => {
    const out = formatScene({
      windowTitle: 'Example',
      elements: [],
      monitor: { width: 1920, height: 1080 },
      pageText: { url: 'https://example.com/', text: 'Example Domain page body text.' },
    });
    expect(out).toContain('No interactive elements found');
    expect(out).toContain('Example Domain page body text.');
  });

  it('renders unchanged when there is no fetched page text', () => {
    const out = formatScene(scene([chromeControls[0] as SceneElement]));
    expect(out).not.toContain('PAGE CONTENT');
    expect(out).toContain('el1  Button  "Back"');
  });
});

describe('formatQuickElementMap', () => {
  const saveBtn = el({
    id: 'el4',
    type: 'Button',
    name: 'Save',
    center: [640, 400],
    source: 'uia',
    clickable: true,
  });
  const container = el({ id: 'el0', type: 'Window', name: 'Arc', center: [960, 516], source: 'uia' });
  const ocrWord = el({ id: 'el9', name: 'Download Now', center: [933, 533], source: 'ocr', clickable: false });

  it('lists interesting UIA elements first, then OCR words', () => {
    const map = formatQuickElementMap(scene([container, ocrWord, saveBtn]));
    expect(map).toBe('el4 Button "Save" at (640, 400)\nel9 text "Download Now" at (933, 533)');
  });

  it('skips container noise (Window/Frame/Pane) and too-small frames', () => {
    const tiny = el({ id: 'el3', type: 'Button', name: 'x', bounds: [0, 0, 1, 1], center: [0, 0], source: 'uia', clickable: true });
    const map = formatQuickElementMap(scene([container, tiny]));
    expect(map).toBe('');
  });

  it('caps the map at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      el({
        id: `el${i}`,
        type: 'Button',
        name: `Button ${i}`,
        center: [i * 10, 10],
        source: 'uia',
        clickable: true,
      }),
    );
    expect(formatQuickElementMap(scene(many), 5).split('\n')).toHaveLength(5);
    expect(formatQuickElementMap(scene(many)).split('\n')).toHaveLength(14);
  });

  it('truncates very long labels', () => {
    const long = el({
      id: 'el1',
      type: 'Button',
      name: 'a '.repeat(30),
      center: [5, 5],
      source: 'uia',
      clickable: true,
    });
    const row = formatQuickElementMap(scene([long])) as string;
    expect(row).toContain('…');
    expect(row.length).toBeLessThan(80);
  });

  it('returns empty for an empty/unavailable scene', () => {
    expect(formatQuickElementMap(scene([]))).toBe('');
    expect(
      formatQuickElementMap({ ...scene([saveBtn]), unavailable: 'Could not identify the active window' }),
    ).toBe('');
  });
});

describe('resolveElementById', () => {
  const windowRoot = el({ id: 'el0', type: 'Window', name: 'Arc', center: [960, 516] });
  const minimize = el({ id: 'el1', type: 'Button', name: 'Minimize', center: [1805, 16] });
  const downloadNow = el({
    id: 'el2',
    type: 'text',
    name: 'Download Now',
    center: [933, 533],
    clickable: false,
    source: 'ocr',
  });
  const elements = [windowRoot, minimize, downloadNow];

  it('resolves a real button by id', () => {
    expect(resolveElementById(elements, 'el1')).toBe(minimize);
  });

  it('resolves an OCR text target (page buttons are OCR words)', () => {
    expect(resolveElementById(elements, 'el2')).toBe(downloadNow);
  });

  it('resolves by bare number', () => {
    expect(resolveElementById(elements, 1)).toBe(minimize);
  });

  it('refuses container elements like the window root el0', () => {
    expect(resolveElementById(elements, 'el0')).toBeUndefined();
  });

  it('returns undefined for unknown ids', () => {
    expect(resolveElementById(elements, 'el9')).toBeUndefined();
  });
});
