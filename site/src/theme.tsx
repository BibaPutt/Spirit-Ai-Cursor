import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  toggle: () => undefined,
});

function readInitialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem('spirit-theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* storage blocked — fall through to the media query */
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('spirit-theme', theme);
    } catch {
      /* private mode */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#F5F4F2' : '#08090B');
  }, [theme]);

  const toggle = useCallback(() => {
    const flip = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
    // Smooth crossfade where the browser supports it (Chrome/Edge);
    // everywhere else the flip is instant.
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (typeof doc.startViewTransition === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      doc.startViewTransition(flip);
    } else {
      flip();
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function palette(theme: Theme): { accent: string; text: string; marker: string } {
  return theme === 'light'
    ? { accent: '#1f5fe0', text: '#565d6b', marker: 'rgba(20,22,27,0.3)' }
    : { accent: '#0a84ff', text: '#a3a3ac', marker: 'rgba(255,255,255,0.3)' };
}

/** Palette handed to the WebGL dither: ground → deep blue → signal → highlight. */
export function ditherPalette(theme: Theme): string[] {
  return theme === 'light'
    ? ['#f5f4f2', '#eef0f4', '#e6ebf4', '#d8e2f4', '#c6d6f2']
    : ['#08090b', '#0a1120', '#0c1a2e', '#102845', '#173c66'];
}
