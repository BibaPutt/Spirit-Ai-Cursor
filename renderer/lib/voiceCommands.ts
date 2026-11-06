import type { CommandId } from './commands';

// Pre-LLM voice-to-slash-command router.
//
// Spoken transcripts arrive from useVoiceInput. Before sending the
// transcript to the LLM as a query, the PromptInput passes it through
// matchVoiceCommand. If a phrase matches a slash command, we fire that
// command directly (no LLM round-trip). Otherwise the transcript is
// submitted normally.
//
// The matcher is intentionally a small static table plus a tiny inline
// Levenshtein. No external dep. We bail on long transcripts (more than
// six words) because real questions are longer than command phrases and
// fuzzy-matching a question against "settings" gives false positives.

export type VoiceCommandLang = 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'nl';

type PhraseTable = Partial<Record<VoiceCommandLang, string[]>>;

// Each command maps to phrases per language. The empty-string entry is
// used for "args after the phrase" — e.g. "search the web for cats"
// should route to { commandId: 'web', args: 'cats' }. If a phrase has
// trailing " for" or "after", the matcher captures everything after.

export const VOICE_COMMANDS: Record<CommandId, PhraseTable> = {
  settings: {
    en: ['open settings', 'settings', 'show settings', 'open preferences', 'preferences'],
    de: ['einstellungen', 'einstellungen öffnen', 'einstellungen offnen', 'optionen'],
    es: ['ajustes', 'configuración', 'configuracion', 'preferencias'],
    fr: ['paramètres', 'parametres', 'préférences', 'preferences'],
    it: ['impostazioni', 'preferenze'],
    pt: ['configurações', 'configuracoes', 'preferências'],
    nl: ['instellingen', 'voorkeuren'],
  },
  help: {
    en: ['help', 'what can you do', 'show help', 'commands'],
    de: ['hilfe', 'was kannst du', 'wie funktioniert das'],
    es: ['ayuda', 'qué puedes hacer'],
    fr: ['aide', "qu'est-ce que tu peux faire"],
    it: ['aiuto', 'cosa puoi fare'],
    pt: ['ajuda', 'o que você pode fazer'],
    nl: ['help', 'wat kun je'],
  },
  quit: {
    en: ['quit', 'quit spirit', 'close spirit', 'exit', 'shut down'],
    de: ['beenden', 'app schließen', 'app schliessen', 'spirit beenden', 'tschüss'],
    es: ['salir', 'cerrar spirit'],
    fr: ['quitter', 'fermer spirit'],
    it: ['esci', 'chiudi spirit'],
    pt: ['sair', 'fechar spirit'],
    nl: ['afsluiten', 'spirit sluiten'],
  },
  clear: {
    en: ['clear', 'dismiss', 'close this', 'close that'],
    de: ['löschen', 'loeschen', 'verwerfen', 'antwort schließen', 'antwort schliessen', 'schließen', 'schliessen'],
    es: ['cerrar', 'descartar'],
    fr: ['fermer', 'effacer'],
    it: ['chiudi', 'cancella'],
    pt: ['fechar', 'descartar'],
    nl: ['sluiten', 'wissen'],
  },
  history: {
    en: ['history', 'past sessions', 'previous answers', 'show history'],
    de: ['verlauf', 'historie', 'frühere fragen', 'fruehere fragen'],
    es: ['historial', 'sesiones pasadas'],
    fr: ['historique', "sessions précédentes"],
    it: ['cronologia', 'sessioni passate'],
    pt: ['histórico', 'sessões anteriores'],
    nl: ['geschiedenis', 'eerdere sessies'],
  },
  web: {
    en: ['search the web for', 'search online for', 'google'],
    de: ['suche im internet nach', 'suche im internet', 'im internet suchen nach', 'google'],
    es: ['busca en internet', 'búsqueda web'],
    fr: ['cherche sur internet', 'recherche web'],
    it: ['cerca su internet', 'ricerca web'],
    pt: ['busca na internet', 'pesquisa web'],
    nl: ['zoek op internet'],
  },
  // Templates are reserved for typed slash commands — recognising them
  // by voice tends to swallow legitimate questions like "summarize this
  // for me". Left empty intentionally; users can still TYPE /summary.
  summary: {}, brief: {}, translate: {}, explain: {}, code: {},
  improve: {}, define: {}, solve: {}, reply: {}, identify: {},
  // /lastsession is a typed-only recovery command — voice triggering
  // "last session" is too risky (every variation of "the last one"
  // would match). Users type the command.
  lastsession: {},
  // /memory is typed-only too: "what do you remember" is a real question
  // the model should answer (with recalled memories), not a UI trigger.
  memory: {},
  // /test is typed-only: it seeds fake UI data, never a voice action.
  test: {},
};

const MAX_PROMPT_WORDS = 6;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

export type VoiceCommandMatch = {
  commandId: CommandId;
  args: string;
};

export function matchVoiceCommand(
  transcript: string,
  lang: VoiceCommandLang,
): VoiceCommandMatch | null {
  const text = transcript.toLowerCase().trim().replace(/[.?!,;:]+$/, '');
  if (!text) return null;
  const wordCount = text.split(/\s+/).length;
  if (wordCount > MAX_PROMPT_WORDS) return null;

  // 1. Exact match across the table.
  for (const [cmdId, table] of Object.entries(VOICE_COMMANDS)) {
    const phrases = table[lang] ?? VOICE_COMMANDS[cmdId as CommandId].en ?? [];
    for (const phrase of phrases) {
      if (text === phrase) return { commandId: cmdId as CommandId, args: '' };
    }
  }
  // 2. Prefix match — "search the web for <args>" → { web, args }.
  for (const [cmdId, table] of Object.entries(VOICE_COMMANDS)) {
    const phrases = table[lang] ?? VOICE_COMMANDS[cmdId as CommandId].en ?? [];
    for (const phrase of phrases) {
      if (text.startsWith(phrase + ' ')) {
        return { commandId: cmdId as CommandId, args: text.slice(phrase.length + 1).trim() };
      }
    }
  }
  // 3. Levenshtein for transcription wobble. Threshold ramps up with
  //    phrase length so we don't accept "hello" → "help" (both short,
  //    very different intents) but we DO accept "settngs" → "settings"
  //    (long enough that a 1-char edit is clearly a typo). Rule:
  //      phrase.length ≥ 6: allow distance ≤ 2
  //      phrase.length 4-5: allow distance ≤ 1
  //      phrase.length < 4: no fuzzy match at all
  if (text.length >= 4) {
    for (const [cmdId, table] of Object.entries(VOICE_COMMANDS)) {
      const phrases = table[lang] ?? VOICE_COMMANDS[cmdId as CommandId].en ?? [];
      for (const phrase of phrases) {
        if (phrase.length < 4) continue;
        // Only fuzzy-match single-token phrases; multi-word fuzz is too risky.
        if (phrase.includes(' ')) continue;
        const allowed = phrase.length >= 6 ? 2 : 1;
        if (levenshtein(text, phrase) <= allowed) {
          return { commandId: cmdId as CommandId, args: '' };
        }
      }
    }
  }
  return null;
}

// Voice-loop interrupt keywords. When the user is in audio-mode and says
// any of these (and ONLY these — text must be short, ≤4 words), we suppress
// the auto-submit, stop any in-flight TTS, and disarm the next mic re-arm
// so the loop pauses until the user manually presses the mic again.
//
// Why a separate list (not folded into VOICE_COMMANDS): a stop-word is not
// a slash-command — it MUST NOT round-trip through the LLM or even surface
// as a command, it just halts the conversation loop. Keeping it isolated
// also makes it easy to add languages without affecting the command table.
const VOICE_STOP_PHRASES: Record<VoiceCommandLang, string[]> = {
  en: ['stop', 'halt', 'pause', 'quiet', 'be quiet', 'shut up', 'shush', 'hush', 'enough', 'that\'s enough', 'thats enough'],
  de: ['stop', 'stopp', 'halt', 'pause', 'pausiere', 'ruhig', 'sei ruhig', 'sei still', 'still', 'hör auf', 'hor auf', 'hoer auf', 'aufhören', 'aufhoeren', 'genug'],
  fr: ['stop', 'arrête', 'arrete', 'pause', 'silence', 'tais-toi', 'tais toi', 'assez'],
  es: ['para', 'alto', 'pausa', 'silencio', 'cállate', 'callate', 'basta'],
  it: ['ferma', 'fermati', 'pausa', 'silenzio', 'zitto', 'basta'],
  pt: ['para', 'pare', 'pausa', 'silêncio', 'silencio', 'cale-se', 'cala-te', 'basta'],
  nl: ['stop', 'pauze', 'stil', 'zwijg', 'genoeg'],
};

const MAX_STOP_WORDS = 4;

export function isStopUtterance(
  transcript: string,
  lang: VoiceCommandLang,
): boolean {
  const text = transcript.toLowerCase().trim().replace(/[.?!,;:]+$/g, '');
  if (!text) return false;
  const wordCount = text.split(/\s+/).length;
  if (wordCount > MAX_STOP_WORDS) return false;
  const list = VOICE_STOP_PHRASES[lang] ?? VOICE_STOP_PHRASES.en;
  // Exact + cross-language fallback: a user mid-conversation in DE who
  // shouts "stop" (English) should still pause the loop. So check the
  // active language first, then English.
  if (list.includes(text)) return true;
  if (lang !== 'en' && VOICE_STOP_PHRASES.en.includes(text)) return true;
  return false;
}

// Helper: derive the active voice-command language. Resolves to the
// stored voice-input language if the user fixed one; otherwise the
// browser navigator language with English as the final fallback.
export function effectiveVoiceLang(voiceLanguage: string | undefined): VoiceCommandLang {
  const candidate = (voiceLanguage && voiceLanguage !== 'auto')
    ? voiceLanguage
    : (typeof navigator !== 'undefined' ? navigator.language : 'en');
  const short = (candidate ?? 'en').slice(0, 2).toLowerCase();
  const known: VoiceCommandLang[] = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl'];
  return (known.includes(short as VoiceCommandLang) ? (short as VoiceCommandLang) : 'en');
}
