/**
 * Locale provider for the public website.
 *
 * The bootstrap in `index.html` already sets `<html lang>` before React mounts;
 * this provider keeps state, persistence and the explicit `?lang=` URL in sync
 * afterwards. `setLocale` is the only way the UI changes language.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { detectLocale, documentLang, isLocale, LOCALE_KEY, withLangParam, type Locale } from './locale';

interface LocaleValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleValue>({ locale: 'en', setLocale: () => {} });

function storedLocale(): Locale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  return detectLocale({
    search: window.location.search,
    hash: window.location.hash,
    stored: storedLocale(),
    languages: browserLanguages(),
  });
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = documentLang(locale);
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* The current session still works when preference storage is blocked. */
    }
    try {
      window.history.replaceState(null, '', withLangParam(window.location.href, next));
    } catch {
      /* URL sync is a convenience; state already changed. */
    }
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  return useContext(LocaleContext);
}
