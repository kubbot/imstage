/**
 * Small marketing controls shared by the site header.
 * Kept separate from the landing page so navigation can translate itself.
 */
import { useLocale } from './LocaleContext';
import { SITE_COPY } from './copy';

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  const labels = SITE_COPY[locale].locale;
  return (
    <div className="mark-toggle" role="group" aria-label={labels.group}>
      <button type="button" aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}>
        {labels.zh}
      </button>
      <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
        {labels.en}
      </button>
    </div>
  );
}
