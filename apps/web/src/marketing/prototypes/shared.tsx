/**
 * Shared chrome for the two launch-direction prototypes.
 *
 * Prototypes are design artifacts for visual selection: they reuse the real
 * SceneView renderer and the existing brand mark, but keep their own copy,
 * layout and theme so both directions can be judged on their own terms.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
import { Mark } from '../../components';
import '@fontsource/syne/latin-600.css';
import '@fontsource/syne/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './shared.css';

export type Locale = 'zh' | 'en';
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const LOCALE_KEY = 'imstage-prototype-locale';
const THEME_KEY = 'imstage-prototype-theme';

export interface ThemeLabels {
  group: string;
  light: string;
  dark: string;
  system: string;
}
export interface LocaleLabels {
  group: string;
  zh: string;
  en: string;
}

function readLocale(): Locale {
  try {
    return localStorage.getItem(LOCALE_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

function readTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Locale + theme state for a prototype document. Theme follows the OS by
 * default, is stored under a prototype-owned key, and never touches the
 * application's own `imstage-theme` preference.
 */
export function usePrototypeChrome() {
  const [locale, setLocaleState] = useState<Locale>(readLocale);
  const [theme, setThemeState] = useState<ThemePreference>(readTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const next: ResolvedTheme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      setResolvedTheme(next);
      document.documentElement.dataset.theme = next;
      document.documentElement.dataset.themePreference = theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* Preference persistence is optional; the current session still works. */
    }
  };

  const setTheme = (next: ThemePreference) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* Preference persistence is optional; the current session still works. */
    }
  };

  return { locale, setLocale, theme, setTheme, resolvedTheme };
}

export function BrandLockup({ label, href = '/' }: { label: string; href?: string }) {
  return (
    <a className="pf-brand" href={href} aria-label={label}>
      <Mark />
      <span>IMStage</span>
    </a>
  );
}

export function LocaleToggle({ locale, onChange, labels }: { locale: Locale; onChange: (next: Locale) => void; labels: LocaleLabels }) {
  return (
    <div className="pf-toggle" role="group" aria-label={labels.group}>
      <button type="button" aria-pressed={locale === 'zh'} onClick={() => onChange('zh')}>
        {labels.zh}
      </button>
      <button type="button" aria-pressed={locale === 'en'} onClick={() => onChange('en')}>
        {labels.en}
      </button>
    </div>
  );
}

export function ThemeToggle({ theme, onChange, labels }: { theme: ThemePreference; onChange: (next: ThemePreference) => void; labels: ThemeLabels }) {
  const options = [
    ['light', labels.light, IconSun],
    ['system', labels.system, IconDeviceDesktop],
    ['dark', labels.dark, IconMoon],
  ] as const;
  return (
    <div className="pf-toggle" role="group" aria-label={labels.group}>
      {options.map(([id, label, Icon]) => (
        <button key={id} type="button" className="pf-toggle-icon" title={label} aria-label={label} aria-pressed={theme === id} onClick={() => onChange(id)}>
          <Icon size={16} stroke={1.7} />
        </button>
      ))}
    </div>
  );
}

export function Cta({
  href,
  children,
  variant = 'solid',
  small = false,
  onClick,
}: {
  href?: string;
  children: ReactNode;
  variant?: 'solid' | 'ghost';
  small?: boolean;
  onClick?: () => void;
}) {
  const className = ['pf-btn', variant === 'ghost' ? 'pf-btn-ghost' : '', small ? 'pf-btn-sm' : ''].filter(Boolean).join(' ');
  if (href) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  );
}
