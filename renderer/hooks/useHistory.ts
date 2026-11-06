import { useCallback, useState } from 'react';
import { ipc } from '../lib/ipc';
import type { SessionSummary } from '../../electron/types';

export function useHistory() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await ipc.listSessions();
      setSessions(list);
      return list;
    } finally {
      setLoading(false);
    }
  }, []);

  const reveal = useCallback(async (path: string) => {
    await ipc.revealSession(path);
  }, []);

  return { sessions, loading, load, reveal };
}

export function formatHistoryMarkdown(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return `## History

You haven't saved any sessions yet.

Turn on **Save sessions to workspace** in \`/settings\` → Memory to start recording your Spirit conversations as JSON + styled HTML files in \`<workspace>/sessions/\`.`;
  }
  const lines: string[] = ['## Recent sessions', ''];
  sessions.slice(0, 20).forEach((s) => {
    const d = new Date(s.startedAt);
    const stamp = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const prompt = s.firstPrompt.replace(/\s+/g, ' ').slice(0, 90);
    const turns = s.turnCount === 1 ? '1 turn' : `${s.turnCount} turns`;
    const link = s.htmlRelativePath ?? s.jsonRelativePath;
    lines.push(`- **${stamp}** · ${turns} . [${prompt || 'untitled'}](session://${encodeURIComponent(link)})`);
  });
  lines.push('');
  lines.push('Click any item to reveal it in Finder.');
  return lines.join('\n');
}
