/**
 * Locale resolution for the public website.
 *
 * Pure and framework-free so the rules can be unit-tested without a DOM:
 * an explicit `?lang=zh|en` URL always wins, then a saved preference, then the
 * browser's own language. The provider in `LocaleContext.tsx` is the only place
 * that touches `localStorage`, `navigator` and `document`.
 */
export type Locale = 'zh' | 'en';

export const LOCALES: readonly Locale[] = ['zh', 'en'] as const;
export const LOCALE_KEY = 'imstage-locale';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

/** Read `lang` from the query before the hash and from the hash query itself. */
export function readLangParam(search: string, hash: string): Locale | null {
  const queries: string[] = [];
  if (search) queries.push(search.startsWith('?') ? search : `?${search}`);
  const hashQuery = hash.indexOf('?');
  if (hashQuery >= 0) queries.push(hash.slice(hashQuery));
  for (const query of queries) {
    const value = new URLSearchParams(query).get('lang');
    if (isLocale(value)) return value;
  }
  return null;
}

export interface LocaleHint {
  search?: string;
  hash?: string;
  stored?: unknown;
  languages?: readonly string[];
}

/** Precedence: explicit URL → saved preference → browser language. */
export function detectLocale(hint: LocaleHint = {}): Locale {
  const explicit = readLangParam(hint.search ?? '', hint.hash ?? '');
  if (explicit) return explicit;
  if (isLocale(hint.stored)) return hint.stored;
  const languages = (hint.languages ?? []).filter((tag): tag is string => typeof tag === 'string' && tag !== '');
  for (const tag of languages) {
    if (/^zh\b/i.test(tag)) return 'zh';
    if (/^(en|de|fr|es|pt|it|nl|ja|ko)\b/i.test(tag)) return 'en';
  }
  // No usable signal (server render, emptied languages): English is the
  // international default for the public site.
  return 'en';
}

/** Language code for `<html lang>`. */
export function documentLang(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

/**
 * Set (or replace) the explicit `lang` query parameter in the address bar
 * without disturbing hash routing. Returns the new URL string.
 */
export function withLangParam(href: string, locale: Locale): string {
  const [beforeHash, hash = ''] = href.split('#');
  const [pathname, query = ''] = beforeHash.split('?');
  const params = new URLSearchParams(query);
  params.set('lang', locale);
  const nextQuery = params.toString();
  return `${pathname}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
}

/**
 * Build a create link that asks the Agent workspace for a brand new session in
 * the requested language/scenario. The workspace only obeys `new` when it is
 * opening a fresh session, so existing drafts are never replaced. An optional
 * handoff token points at a scene already written to sessionStorage.
 */
export function createHandoffHref(locale: Locale, scenario?: string, handoff?: string): string {
  const params = new URLSearchParams({ new: '1', lang: locale });
  if (scenario) params.set('scenario', scenario);
  if (handoff) params.set('handoff', handoff);
  return `#/create?${params.toString()}`;
}
