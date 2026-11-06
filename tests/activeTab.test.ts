import { describe, expect, it } from 'vitest';
import { isHostLikeLabel, reconcileActiveTab } from '../electron/capture/active-tab';
import type { AppContext } from '../electron/types';

function ctx(partial: Partial<AppContext>): AppContext {
  return {
    title: 'Arc',
    process: 'arc',
    pid: 1234,
    ...partial,
  };
}

describe('isHostLikeLabel', () => {
  it('accepts bare domains', () => {
    expect(isHostLikeLabel('instagram.com')).toBe(true);
    expect(isHostLikeLabel('demo.example.com')).toBe(true);
    expect(isHostLikeLabel('docs.google.com')).toBe(true);
    expect(isHostLikeLabel('sub.domain.example.org')).toBe(true);
  });

  it('accepts localhost and IPv4', () => {
    expect(isHostLikeLabel('localhost')).toBe(true);
    expect(isHostLikeLabel('127.0.0.1')).toBe(true);
    expect(isHostLikeLabel('192.168.1.10')).toBe(true);
  });

  it('rejects page titles and non-host strings', () => {
    expect(isHostLikeLabel('Sample App — A Page Title')).toBe(false);
    expect(isHostLikeLabel('Google Search')).toBe(false);
    expect(isHostLikeLabel('Instagram')).toBe(false);
    expect(isHostLikeLabel('')).toBe(false);
    expect(isHostLikeLabel('127.0.0.1:5173')).toBe(false);
  });
});

describe('reconcileActiveTab', () => {
  it('prefers the live label as the title even when not host-shaped', () => {
    const c = ctx({
      url: 'https://demo.example.com/?src=peerpush',
      activeTab: 'Sample App — A Page Title',
    });
    reconcileActiveTab(c);
    expect(c.title).toBe('Sample App — A Page Title');
    expect(c.url).toBe('https://demo.example.com/?src=peerpush');
  });

  it('rewrites a stale URL to the live host when they disagree', () => {
    const c = ctx({
      url: 'https://demo.example.com/?src=peerpush',
      activeTab: 'localhost',
    });
    reconcileActiveTab(c);
    expect(c.title).toBe('localhost');
    expect(c.url).toBe('https://localhost/');
  });

  it('keeps the URL untouched when the label matches the URL host', () => {
    const c = ctx({
      url: 'http://localhost:5173/dashboard',
      activeTab: 'localhost',
    });
    reconcileActiveTab(c);
    expect(c.title).toBe('localhost');
    expect(c.url).toBe('http://localhost:5173/dashboard');
  });

  it('ignores a missing label or URL', () => {
    const c = ctx({ url: 'https://example.com/x' });
    reconcileActiveTab(c);
    expect(c.title).toBe('Arc');
    expect(c.url).toBe('https://example.com/x');
  });

  it('synthesizes a host URL from the label when the URL walk came back empty', () => {
    const c = ctx({ activeTab: 'demo.example.com' });
    reconcileActiveTab(c);
    expect(c.title).toBe('demo.example.com');
    expect(c.url).toBe('https://demo.example.com/');
  });

  it('does not corrupt a good URL for a page titled like a host', () => {
    const c = ctx({
      url: 'https://docs.google.com/spreadsheets',
      activeTab: 'docs.google.com',
    });
    reconcileActiveTab(c);
    expect(c.url).toBe('https://docs.google.com/spreadsheets');
  });
});
