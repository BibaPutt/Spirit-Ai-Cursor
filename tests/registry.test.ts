import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegistryCache,
  discoverApps,
  launchAppByName,
  searchApps,
  type RegistryApp,
} from '../electron/apps/registry';

const SAMPLE: RegistryApp[] = [
  { name: 'Spotify', kind: 'name', ref: '' },
  { name: 'Spotify Web', kind: 'name', ref: '' },
  { name: 'Notes', kind: 'name', ref: '' },
  { name: 'Sublime Text', kind: 'name', ref: '' },
  { name: 'Photoshop', kind: 'name', ref: '' },
];

describe('searchApps', () => {
  it('ranks exact match above starts-with above contains', () => {
    const hits = searchApps(SAMPLE, 'spotify', 10);
    expect(hits[0].name).toBe('Spotify');
    expect(hits[1].name).toBe('Spotify Web');
  });

  it('finds contains matches that do not start with the query', () => {
    const hits = searchApps(SAMPLE, 'text', 10);
    expect(hits.map((a) => a.name)).toEqual(['Sublime Text']);
  });

  it('matches case-insensitively', () => {
    const hits = searchApps(SAMPLE, 'PHOTOSHOP', 10);
    expect(hits[0].name).toBe('Photoshop');
  });

  it('returns [] for an empty query or no match', () => {
    expect(searchApps(SAMPLE, '')).toEqual([]);
    expect(searchApps(SAMPLE, '  ')).toEqual([]);
    expect(searchApps(SAMPLE, 'vim')).toEqual([]);
  });

  it('honors the limit', () => {
    const hits = searchApps(SAMPLE, 's', 1);
    expect(hits).toHaveLength(1);
  });
});

describe('discoverApps', () => {
  afterEach(() => clearRegistryCache());

  it('returns an array without throwing (platform discovery runs)', async () => {
    const apps = await discoverApps();
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.every((a) => typeof a.name === 'string' && a.name.length > 0)).toBe(true);
  }, 20_000);

  it('caches results between calls within the TTL', async () => {
    const first = await discoverApps();
    const second = await discoverApps();
    expect(second).toBe(first);
  }, 20_000);

  it('keeps the absolute exe path from Get-StartApps for desktop apps', async () => {
    const apps = await discoverApps();
    const spotify = apps.find((a) => a.name.toLowerCase() === 'spotify');
    if (!spotify) return; // machine without Spotify — nothing to assert
    expect(spotify.kind).toBe('name');
    expect(spotify.ref).toMatch(/^[A-Za-z]:[\\/].*\.exe$/i);
  }, 20_000);
});

describe('launchAppByName', () => {
  it('rejects an empty name without spawning', async () => {
    const res = await launchAppByName('   ');
    expect(res).toMatchObject({ ok: false, error: 'No app name given.' });
  });
});
