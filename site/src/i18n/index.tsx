import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Locale =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'it'
  | 'pt'
  | 'ru'
  | 'zh-CN'
  | 'zh-TW'
  | 'ja'
  | 'ko'
  | 'ar'
  | 'hi'
  | 'tr'
  | 'nl'
  | 'pl'
  | 'sv'
  | 'id';

export type LocaleMeta = { id: Locale; label: string; english: string };

export const LOCALES: LocaleMeta[] = [
  { id: 'en', label: 'English', english: 'English' },
  { id: 'es', label: 'Español', english: 'Spanish' },
  { id: 'fr', label: 'Français', english: 'French' },
  { id: 'de', label: 'Deutsch', english: 'German' },
  { id: 'it', label: 'Italiano', english: 'Italian' },
  { id: 'pt', label: 'Português', english: 'Portuguese' },
  { id: 'ru', label: 'Русский', english: 'Russian' },
  { id: 'zh-CN', label: '简体中文', english: 'Chinese (Simplified)' },
  { id: 'zh-TW', label: '繁體中文', english: 'Chinese (Traditional)' },
  { id: 'ja', label: '日本語', english: 'Japanese' },
  { id: 'ko', label: '한국어', english: 'Korean' },
  { id: 'ar', label: 'العربية', english: 'Arabic' },
  { id: 'hi', label: 'हिन्दी', english: 'Hindi' },
  { id: 'tr', label: 'Türkçe', english: 'Turkish' },
  { id: 'nl', label: 'Nederlands', english: 'Dutch' },
  { id: 'pl', label: 'Polski', english: 'Polish' },
  { id: 'sv', label: 'Svenska', english: 'Swedish' },
  { id: 'id', label: 'Bahasa Indonesia', english: 'Indonesian' },
];

const modules = import.meta.glob<Record<string, string>>('./locales/*.json', {
  eager: true,
  import: 'default',
});

const DICTS: Record<string, Record<string, string>> = {};
for (const [path, dict] of Object.entries(modules)) {
  const id = path.replace('./locales/', '').replace('.json', '');
  DICTS[id] = dict;
}

const FALLBACK = DICTS.en ?? {};
const STORAGE_KEY = 'spirit-locale';

function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved && DICTS[saved]) return saved as Locale;
  const raw = (navigator.language || 'en').toLowerCase();
  const exact = LOCALES.find((l) => l.id.toLowerCase() === raw);
  if (exact) return exact.id;
  const base = raw.split('-')[0];
  const match = LOCALES.find((l) => l.id.toLowerCase().split('-')[0] === base);
  return match?.id ?? 'en';
}

type I18nValue = {
  locale: Locale;
  meta: LocaleMeta;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    // The App boot-reveal listens for this: content scrambles out through the
    // ascii grid, then the new language decodes in.
    window.dispatchEvent(new CustomEvent('spirit:locale-changed'));
  }, []);

  useEffect(() => {
    const meta = LOCALES.find((l) => l.id === locale) ?? LOCALES[0];
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.title = meta.id === 'en' ? 'Spirit — Ask your cursor' : `Spirit — ${meta.label}`;
  }, [locale]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = DICTS[locale] ?? FALLBACK;
      const raw = dict[key] ?? FALLBACK[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
    },
    [locale],
  );

  const value = useMemo<I18nValue>(() => {
    const meta = LOCALES.find((l) => l.id === locale) ?? LOCALES[0];
    return { locale, meta, setLocale, t };
  }, [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
