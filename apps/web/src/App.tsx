import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { IconArrowUpRight, IconBrandGithub, IconSun, IconMoon, IconDeviceDesktop, IconMenu2, IconX } from '@tabler/icons-react';
import { Home } from './Landing';
import { Templates, Docs } from './Pages';
import { Brand, Mark, LinkButton, github, templates } from './components';
import type { TemplateId } from './studio/model';
import '@fontsource/syne/latin-600.css';
import '@fontsource/syne/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './styles.css';
import './account/account.css';
import { canNavigate } from './account/navigation';
import { useAuth } from './account/Auth';
import { loginLink, safeNext } from './account/api';
import AuthPage from './account/AuthPage';
import Workspace from './account/Workspace';
import AccountPage from './account/AccountPage';
import AccountEditor, { AccountSave } from './account/AccountEditor';
import ProjectsPage from './projects/ProjectsPage';
import { LocaleProvider, useLocale } from './marketing/LocaleContext';
import { LocaleToggle } from './marketing/Controls';
import { SITE_COPY } from './marketing/copy';
import { createHandoffHref } from './marketing/locale';

const AgentStudio = lazy(() => import('./agent/AgentWorkspace'));
const Studio = lazy(() => import('./studio/Studio'));

type Theme = 'system' | 'light' | 'dark';
type Route = { page: string; template?: TemplateId; sceneId?: string; project?: string; caseId?: string; fresh: boolean; next: string };
function parseRoute(): Route {
  const [pathname, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const template = params.get('template');
  return { page: pathname || '/', caseId: params.get('case') || undefined, sceneId: params.get('scene') || undefined, project: params.get('project') || undefined, fresh: params.get('new') === '1', next: safeNext(params.get('next')), template: templates.some(t => t.id === template) ? template as TemplateId : undefined };
}
function getInitialTheme(): Theme {
  try { const stored = localStorage.getItem('imstage-theme'); return stored === 'light' || stored === 'dark' ? stored : 'system'; }
  catch { return 'system'; }
}
function ThemePicker({ theme, setTheme, labels }: { theme: Theme; setTheme: (t: Theme) => void; labels: { group: string; light: string; dark: string; system: string } }) {
  return <div className="theme-picker" role="group" aria-label={labels.group}>{([
    ['light', labels.light, IconSun], ['system', labels.system, IconDeviceDesktop], ['dark', labels.dark, IconMoon],
  ] as const).map(([id, label, Icon]) => <button type="button" key={id} title={label} aria-label={label} aria-pressed={theme === id} onClick={() => setTheme(id)}><Icon size={16} stroke={1.7} /></button>)}</div>;
}
function Header({ route, theme, setTheme }: { route: Route; theme: Theme; setTheme: (t: Theme) => void }) {
  const [menu, setMenu] = useState(false);
  const { locale } = useLocale();
  const site = SITE_COPY[locale];
  const { user, loading } = useAuth();
  useEffect(() => setMenu(false), [route.page]);
  return <header className="site-header"><div className="nav-wrap"><Brand label={site.nav.home} /><nav id="site-nav" className={menu ? 'main-nav open' : 'main-nav'} aria-label={site.nav.main}><div className="main-nav-links"><a href="#/projects" aria-current={route.page === '/projects' ? 'page' : undefined}>{site.nav.projects}</a><a href="#/templates" aria-current={route.page === '/templates' ? 'page' : undefined}>{site.nav.templates}</a><a href="#/docs" aria-current={route.page === '/docs' ? 'page' : undefined}>{site.nav.docs}</a><a href={github} target="_blank" rel="noreferrer">{site.nav.openSource} <IconArrowUpRight size={13} /></a></div><div className="main-nav-controls"><LocaleToggle /><ThemePicker theme={theme} setTheme={setTheme} labels={site.theme} /></div></nav><div className="nav-actions">{user ? <a href="#/workspace" className="nav-account" aria-label={site.nav.workspace}><span className="nav-account-avatar">{user.name.slice(0, 1)}</span><span className="nav-account-label">{site.nav.workspace}</span></a> : <a className="nav-login" href={loginLink()}>{loading ? site.nav.account : site.nav.login}</a>}<LinkButton href={createHandoffHref(locale)} className="nav-cta">{site.nav.start} <IconArrowUpRight size={16} /></LinkButton><button className="icon-btn menu-toggle" aria-label={menu ? site.menu.close : site.menu.open} aria-expanded={menu} aria-controls="site-nav" onClick={() => setMenu(!menu)}>{menu ? <IconX /> : <IconMenu2 />}</button></div></div></header>;
}
function Footer({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const { locale } = useLocale();
  const site = SITE_COPY[locale];
  return <footer className="site-footer section-shell"><div className="footer-main"><div><Brand label={site.nav.home} /><p>{site.footer.tagline}</p></div><div className="footer-links"><a href="#/templates">{site.footer.templates}</a><a href="#/docs">{site.footer.docs}</a><a href={github} target="_blank" rel="noreferrer"><IconBrandGithub size={16} />{site.footer.github}</a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} IMStage · {site.footer.license}</span><span className="footer-note">{site.footer.note}</span><ThemePicker theme={theme} setTheme={setTheme} labels={site.theme} /></div></footer>;
}
function AccountRoute({ route }: { route: Route }) {
  const { user, loading, unavailable, refresh } = useAuth();
  const next = route.page + (route.sceneId ? `?scene=${encodeURIComponent(route.sceneId)}` : route.project ? `?project=${encodeURIComponent(route.project)}` : '');
  useEffect(() => { if (!loading && !user && !unavailable && (location.hash.slice(1).split('?')[0] === route.page)) location.hash = loginLink(next).slice(1); }, [loading, user, unavailable, next]);
  if (loading) return <p className="page-loading" role="status">正在确认登录状态…</p>;
  if (!user) return <section className="account-gate"><h1>{unavailable ? '账号服务暂时不可用' : '登录后打开你的创作空间'}</h1><p>{unavailable ? '作品仍保存在服务端，恢复连接后可以继续。' : '正在为你打开登录页面…'}</p>{unavailable && <button className="btn btn-secondary" onClick={() => void refresh()}>重新连接</button>} <a className="text-link" href={loginLink(next)}>前往登录</a></section>;
  return route.page === '/account' ? <AccountPage /> : route.page === '/projects' ? <ProjectsPage key={user.id} projectId={route.project} /> : route.sceneId ? <AccountEditor key={`${user.id}:${route.sceneId}`} sceneId={route.sceneId} /> : <Workspace key={user.id} />;
}
function AppShell() {
  const { user } = useAuth();
  const { locale } = useLocale();
  const site = SITE_COPY[locale];
  const [route, setRoute] = useState<Route>(parseRoute);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [themeError, setThemeError] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { let previous = location.hash; const change = () => { if (!canNavigate()) { history.replaceState(null, '', location.pathname + location.search + previous); return; } previous = location.hash; setRoute(parseRoute()); window.scrollTo(0, 0); requestAnimationFrame(() => mainRef.current?.focus()); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  // https://react.dev/reference/react/useEffect#connecting-to-an-external-system
  useEffect(() => { const media = window.matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; document.documentElement.dataset.themePreference = theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [theme]);
  useEffect(() => {
    const title = route.page === '/login' ? site.titles.login : route.page === '/register' ? site.titles.register : route.page === '/workspace' ? site.titles.workspace : route.page === '/account' ? site.titles.account : route.page === '/projects' ? site.titles.projects : route.page === '/create' ? site.titles.create : route.page === '/studio' ? site.titles.studio : route.page === '/templates' ? site.titles.templates : route.page === '/docs' ? site.titles.docs : site.titles.home;
    document.title = `IMStage · ${title}`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', site.description);
  }, [route.page, site]);
  const updateTheme = (t: Theme) => { setTheme(t); try { localStorage.setItem('imstage-theme', t); setThemeError(false); } catch { setThemeError(true); } };
  const valid = ['/', '/create', '/studio', '/templates', '/docs', '/login', '/register', '/workspace', '/account', '/projects'].includes(route.page);
  return <><a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); mainRef.current?.focus(); }}>{site.skip}</a><Header route={route} theme={theme} setTheme={updateTheme} />{themeError && <div className="theme-notice" role="status">{site.storageNotice}</div>}<main id="main-content" tabIndex={-1} ref={mainRef} className={route.page === '/studio' || route.page === '/workspace' ? 'studio-main' : ''}>
    {['/login', '/register'].includes(route.page) && <AuthPage key={route.page} mode={route.page === '/register' ? 'register' : 'login'} next={route.next} />}
    {['/workspace', '/account', '/projects'].includes(route.page) && <AccountRoute route={route} />}
    {route.page === '/' && <Home />}{route.page === '/create' && <Suspense fallback={<p className="page-loading">{site.loading}</p>}><AgentStudio key={`${user?.id || 'guest'}:${route.caseId || 'draft'}:${route.project || ''}:${route.fresh ? 'new' : 'resume'}`} accountAction={(scene, locked, projectId, sessionId) => <AccountSave localSessionId={sessionId} projectId={projectId} key={user?.id || 'guest'} scene={scene} disabled={locked} />} /></Suspense>}{route.page === '/templates' && <Templates />}{route.page === '/docs' && <Docs />}{route.page === '/studio' && <Suspense fallback={<div className="page-loading" role="status"><Mark />{site.loading}</div>}><Studio key={route.template || 'default'} initialTemplate={route.template} accountAction={scene => <AccountSave key={user?.id || 'guest'} scene={scene} />} /></Suspense>}{!valid && <div className="not-found section-shell"><h1>{site.notFound.title}</h1><p>{site.notFound.body}</p><LinkButton href="#/">{site.notFound.back}</LinkButton></div>}
  </main>{!['/studio', '/create', '/workspace', '/account', '/projects', '/login', '/register'].includes(route.page) && <Footer theme={theme} setTheme={updateTheme} />}</>;
}
export default function App() {
  return <LocaleProvider><AppShell /></LocaleProvider>;
}
