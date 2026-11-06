import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './data/en.json';
import pending from './newfeature/pending.json';

const resources = {
  en: { translation: en },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export function loadLocale(locale: string) {
  return import(`./data/${locale}.json`)
    .then((mod) => {
      i18n.addResourceBundle(locale, 'translation', mod.default);
      i18n.changeLanguage(locale);
    })
    .catch(() => {
      console.warn(`Locale ${locale} not found, using English`);
    });
}

export function getPendingKeys(): Record<string, string> {
  return pending as Record<string, string>;
}

export default i18n;
