import { useEffect, useState, type ReactNode } from 'react';
import { ThemeProvider } from '@openuidev/react-ui/ThemeProvider';

// Spirit's inverted Tailwind theme: `html.dark` is the LIGHT UI, no class is the
// dark UI. OpenUI calls those modes by their real names.
function currentMode(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'light' : 'dark';
}

// One ThemeProvider for the whole app: it injects the --openui-* design tokens
// and keeps them in sync with the Spirit theme, so generated views look native
// instead of carrying a second color system.
export function OpenUiTheme({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<'light' | 'dark'>(currentMode);

  useEffect(() => {
    setMode(currentMode());
    const observer = new MutationObserver(() => setMode(currentMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return <ThemeProvider mode={mode}>{children}</ThemeProvider>;
}
