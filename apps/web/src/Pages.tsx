import { useMemo, useState } from 'react';
import { IconSearch, IconChevronRight, IconBrandGithub, IconArrowUpRight, IconHeart } from '@tabler/icons-react';
import { github } from './components';
import { useLocale } from './marketing/LocaleContext';
import { DOCS_COPY, TEMPLATES_COPY, type TemplateCategory, type TemplateEntry } from './marketing/pagesCopy';
import type { Locale } from './marketing/locale';
import { createScenario } from './marketing/scenes';
import { ScaledSceneFrame, DEMO_DEVICE } from './marketing/DeviceFrame';
import { SceneView } from './studio/SceneView';

export function Templates() {
  const { locale } = useLocale();
  const copy = TEMPLATES_COPY[locale];
  const [filter, setFilter] = useState<'all' | TemplateCategory>('all');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const shown = copy.entries.filter((entry) => {
    if (filter !== 'all' && entry.category !== filter) return false;
    if (!needle) return true;
    return `${entry.title}${entry.description}${entry.word}${copy.filters[entry.category]}`.toLocaleLowerCase().includes(needle);
  });
  const filterOrder: ('all' | TemplateCategory)[] = ['all', 'life', 'product', 'teaching'];

  return (
    <div className="templates-page section-shell">
      <div className="page-intro">
        <span className="section-label">{copy.label}</span>
        <h1>{copy.title}</h1>
        <p>{copy.lede}</p>
      </div>
      <div className="gallery-controls">
        <div className="filter-tabs" role="group" aria-label={copy.label}>
          {filterOrder.map((id) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {copy.filters[id]}
            </button>
          ))}
        </div>
        <label className="search-field">
          <IconSearch size={17} />
          <input aria-label={copy.searchLabel} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} />
        </label>
      </div>
      <div className="library-grid">
        {shown.map((entry) => (
          <TemplateCard key={entry.id} entry={entry} locale={locale} platform={copy.platform} category={copy.filters[entry.category]} open={copy.open} />
        ))}
      </div>
      {!shown.length && (
        <div className="empty-results">
          <IconSearch size={30} />
          <h2>{copy.emptyTitle}</h2>
          <p>{copy.emptyBody}</p>
          <button className="btn btn-secondary" onClick={() => { setQuery(''); setFilter('all'); }}>
            {copy.reset}
          </button>
        </div>
      )}
      <div className="template-note">
        <IconHeart size={18} />
        <p>{copy.note}</p>
      </div>
    </div>
  );
}

function TemplateCard({ entry, locale, platform, category, open }: {
  entry: TemplateEntry;
  locale: Locale;
  platform: string;
  category: string;
  open: string;
}) {
  const scene = useMemo(() => createScenario(entry.kind, locale), [entry.kind, locale]);
  return (
    <a className={`template-card ${entry.id}`} href={`#/studio?template=${entry.id}`} aria-label={`${entry.title} · ${open}`}>
      <div className="template-art">
        <div className="template-word" aria-hidden="true">{entry.word}</div>
        <div className="template-device" aria-hidden="true">
          <ScaledSceneFrame size={DEMO_DEVICE}>
            <SceneView scene={scene} exportMode locale={locale} />
          </ScaledSceneFrame>
        </div>
        <span className="template-open" aria-hidden="true"><IconArrowUpRight size={21} /></span>
      </div>
      <div className="template-caption">
        <div>
          <span>{category} / {platform}</span>
          <h3>{entry.title}</h3>
        </div>
        <IconArrowUpRight size={19} />
      </div>
      <p>{entry.description}</p>
    </a>
  );
}

export function Docs() {
  const { locale } = useLocale();
  const copy = DOCS_COPY[locale];
  const initial = new URLSearchParams(location.hash.split('?')[1]).get('tab');
  const [tab, setTab] = useState<'web' | 'mcp' | 'templates' | 'privacy'>(initial === 'mcp' ? 'mcp' : initial === 'templates' ? 'templates' : initial === 'privacy' ? 'privacy' : 'web');
  const order: ('web' | 'mcp' | 'templates' | 'privacy')[] = ['web', 'mcp', 'templates', 'privacy'];

  return (
    <div className="docs-page section-shell">
      <div className="page-intro">
        <span className="section-label">{copy.label}</span>
        <h1>{copy.title}</h1>
        <p>{copy.lede}</p>
      </div>
      <div className="docs-layout">
        <nav className="docs-nav" aria-label={copy.label}>
          {order.map((id) => (
            <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {copy.tabs[id]}
              <IconChevronRight size={15} />
            </button>
          ))}
          <a href={github} target="_blank" rel="noreferrer">
            <IconBrandGithub size={17} /> {copy.source} <IconArrowUpRight size={14} />
          </a>
        </nav>
        <article className="docs-content">
          {tab === 'web' && (
            <>
              <span className="available-tag">{copy.web.tag}</span>
              <h2>{copy.web.title}</h2>
              <p>{copy.web.body}</p>
              <ol className="doc-steps">
                {copy.web.steps.map((step) => (
                  <li key={step.title}>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                  </li>
                ))}
              </ol>
              <div className="doc-callout">{copy.web.callout}</div>
              <a className="btn btn-primary" href="#/create">{copy.web.cta} <IconArrowUpRight size={17} /></a>
            </>
          )}
          {tab === 'mcp' && (
            <>
              <span className="available-tag">{copy.mcp.tag}</span>
              <h2>{copy.mcp.title}</h2>
              <p>{copy.mcp.body}</p>
              <h3>{copy.mcp.authTitle}</h3>
              <ul>
                {copy.mcp.auth.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <div className="doc-callout">{copy.mcp.callout}</div>
              <a className="text-link" href={`${github}/tree/main/services/mcp`} target="_blank" rel="noreferrer">
                {copy.mcp.link} <IconArrowUpRight size={16} />
              </a>
            </>
          )}
          {tab === 'templates' && (
            <>
              <h2>{copy.templates.title}</h2>
              <p>{copy.templates.body}</p>
              <ol className="doc-steps">
                {copy.templates.steps.map((step) => (
                  <li key={step.title}>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                  </li>
                ))}
              </ol>
              <div className="doc-callout">{copy.templates.callout}</div>
              <a className="text-link" href="https://developer.apple.com/design/resources/" target="_blank" rel="noreferrer">
                {copy.templates.link} <IconArrowUpRight size={16} />
              </a>
            </>
          )}
          {tab === 'privacy' && (
            <>
              <h2>{copy.privacy.title}</h2>
              <p>{copy.privacy.body}</p>
              {copy.privacy.items.map((item) => (
                <section key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.detail}</p>
                </section>
              ))}
              <div className="doc-callout">
                <p>{copy.privacy.recovery}</p>
                <p>{copy.privacy.payment}</p>
                <p>{copy.privacy.cloudNote}</p>
              </div>
            </>
          )}
        </article>
      </div>
    </div>
  );
}
