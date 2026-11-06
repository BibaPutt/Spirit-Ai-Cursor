// GENUINE latency probe: wall-clock timing of REAL pure pipeline functions.
// Run: npx vitest run tests/latency-probe.test.ts
// GDI/display capture is NOT measured here (headless CI has no display).
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getName: () => 'Spirit', getVersion: () => 'test', whenReady: () => Promise.resolve(), on: vi.fn(), quit: vi.fn() },
  desktopCapturer: { getSources: vi.fn(async () => []) },
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getCursorScreenPoint: () => ({ x: 100, y: 100 }) },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../electron/store/settings', () => ({
  getSettings: () => ({ contextMemoryEnabled: true }),
  getSettingsLight: () => ({}),
  getWorkspaceFolder: () => tmpdir(),
}));

vi.mock('../electron/llm/providers/router', () => ({
  runPlainCompletion: vi.fn(async () => ''),
}));

import { buildClickTargetsMenu, clusterWords, formatScene, goalScoreFor, goalTokens, resolveElementById, type Scene, type SceneElement } from '../electron/capture/scene';
import { mergeSceneLayers } from '../electron/llm/scene-merge';
import { mapPointToScreen, parseAnnotations, type PointGeo } from '../electron/llm/point';
import { scoreMemory } from '../electron/memory/contextMemory';
import { parseChipSuggestions } from '../electron/llm/chips-parse';
import { parseImageRequestsFromAnswer } from '../electron/llm/web-images-parse';
import { estimateTokens } from '../electron/memory/sessions';

const N = 100;

function stats(name: string, samples: number[]): { name: string; mean: number; sd: number; median: number } {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { name, mean, sd, median };
}

function bench(name: string, fn: () => void): { name: string; mean: number; sd: number; median: number } {
  fn(); // warmup
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return stats(name, samples);
}

// Synthetic scene: ~200 elements (60 uia + 140 ocr) resembling a real ui_read.
function makeScene(): Scene {
  const elements: SceneElement[] = [];
  const labels = ['Download Now', 'Sign in', 'Search', 'Settings', 'Download', 'Cancel', 'Submit', 'Close', 'Play video', 'Add to cart'];
  for (let i = 0; i < 60; i++) {
    const cx = 100 + (i * 37) % 1700, cy = 100 + (i * 53) % 900;
    elements.push({ id: `uia${i}`, type: 'Button', name: labels[i % labels.length] + ` ${i}`, bounds: [cx - 40, cy - 12, cx + 40, cy + 12], center: [cx, cy], enabled: true, clickable: true, source: 'uia' });
  }
  for (let i = 0; i < 140; i++) {
    const cx = 50 + (i * 61) % 1800, cy = 60 + (i * 41) % 950;
    elements.push({ id: `ocr${i}`, type: 'text', name: `word${i} phrase here`, bounds: [cx - 30, cy - 8, cx + 30, cy + 8], center: [cx, cy], enabled: true, clickable: false, source: 'ocr' });
  }
  return { windowTitle: 'Test Window', elements, monitor: { width: 1920, height: 1080 } };
}

const GEO: PointGeo = { imgW: 1920, imgH: 1080, absLeft: 0, absTop: 0, winW: 1920, winH: 1080 };
const ANNOTATED = 'Click the button [POINT:933,533:Download Now] then see [BOX:100,200,300,150:Search box] and [ARROW:100,760:300,760:flow]. ';
const CHIP_RAW = '[{"label": "Summarize page", "icon": "doc"}, {"label": "Translate", "icon": "lang"}, {"label": "Search the web", "icon": "globe"}]';
const IMG_ANSWER = '[IMAGE] Eiffel Tower at night\n\nThe Eiffel Tower is a famous landmark in Paris.';
const MEM = { id: 'm1', text: 'The user prefers dark mode in VS Code and works on the spirit desktop app', createdAt: Date.now(), updatedAt: Date.now() } as never;

describe('latency probe (real wall-clock, N=100)', () => {
  it('times pure pipeline stages and prints the table', () => {
    const scene = makeScene();
    const tokens = goalTokens('click Download Now please');
    const words = Array.from({ length: 60 }, (_, i) => ({ text: `w${i}`, bounds: [i * 20, 100, i * 20 + 15, 116] as [number, number, number, number] }));
    const uiaLayer = scene.elements.filter((e) => e.source === 'uia');
    const ocrLayer = scene.elements.filter((e) => e.source === 'ocr');
    const tags = parseAnnotations(ANNOTATED);
    const msg = { role: 'user', content: 'x'.repeat(4000) } as never;

    const rows = [
      bench('scene merge (200 els)', () => { mergeSceneLayers([uiaLayer, ocrLayer]); }),
      bench('goal tokens+score', () => { const t = goalTokens('click Download Now please'); goalScoreFor('Download Now', t); }),
      bench('click-targets menu', () => { buildClickTargetsMenu(scene, 6, 'click Download Now please'); }),
      bench('formatScene (70)', () => { formatScene(scene); }),
      bench('resolveElementById', () => { resolveElementById(scene.elements, scene.elements[10].id); }),
      bench('clusterWords (60)', () => { clusterWords(words); }),
      bench('point parse+resolve', () => { const ts = parseAnnotations(ANNOTATED); for (const t of ts) if (t.kind === 'point') mapPointToScreen(t, GEO); }),
      bench('memory scoreMemory', () => { scoreMemory('dark mode editor preference', MEM); }),
      bench('chip parse', () => { parseChipSuggestions(CHIP_RAW); }),
      bench('image-req parse', () => { parseImageRequestsFromAnswer(IMG_ANSWER); }),
      bench('estimateTokens (4k)', () => { estimateTokens(msg); }),
    ];
    // Touch vars so benchmarks aren't dead-code eliminated.
    expect(tokens.length).toBeGreaterThan(0);
    expect(tags.length).toBeGreaterThan(0);
    console.log(`\nLATENCY PROBE N=${N} (ms per call)`);
    console.log('stage | mean | sd | median');
    for (const r of rows) console.log(`${r.name} | ${r.mean.toFixed(4)} | ${r.sd.toFixed(4)} | ${r.median.toFixed(4)}`);
    expect(true).toBe(true);
  });
});
