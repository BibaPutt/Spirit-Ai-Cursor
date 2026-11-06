import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/syne';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/martian-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/pages.css';
import './styles/spirit.css';
import { ThemeProvider } from './theme';
import { I18nProvider } from './i18n';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <App page="devdocs" />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
