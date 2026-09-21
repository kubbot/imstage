import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { IconArrowUpRight, IconBrandGithub, IconSun, IconMoon, IconDeviceDesktop, IconMenu2, IconX } from '@tabler/icons-react';
import { Home } from './Landing';
import PromptStudio from './create/PromptStudio';
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

const AgentStudio = lazy(() => import('./agent/AgentStudio'));
const Studio = lazy(() => import('./studio/Studio'));

type Theme = 'system' | 'light' | 'dark';
type Route = { page: string; template?: TemplateId; sceneId?: string; project?: string; caseId?: string; next: string };
function parseRoute(): Route {
  const [pathname, query = ''] = location.hash.slice(1).split('?');
  const template = new URLSearchParams(query).get('template');
  return { page: pathname || '/', caseId: new URLSearchParams(query).get('case') || undefined, sceneId: new URLSearchParams(query).get('scene') || undefined, project: new URLSearchParams(query).get('project') || undefined, next: safeNext(new URLSearchParams(query).get('next')), template: templates.some(t => t.id === template) ? template as TemplateId : undefined };
}
function getInitialTheme(): Theme {
  try { const stored = localStorage.getItem('imstage-theme'); return stored === 'light' || stored === 'dark' ? stored : 'system'; }
  catch { return 'system'; }
}
function ThemePicker({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return <div className="theme-picker" role="group" aria-label="外观主题">{([
    ['light', '浅色', IconSun], ['system', '跟随系统', IconDeviceDesktop], ['dark', '深色', IconMoon],
  ] as const).map(([id, label, Icon]) => <button type="button" key={id} title={label} aria-label={label} aria-pressed={theme === id} onClick={() => setTheme(id)}><Icon size={16} stroke={1.7} /></button>)}</div>;
}
function Header({ route, theme, setTheme }: { route: Route; theme: Theme; setTheme: (t: Theme) => void }) {
  const [menu, setMenu] = useState(false);
  const { user, loading } = useAuth();
  useEffect(() => setMenu(false), [route.page]);
  return <header className="site-header"><div className="nav-wrap"><Brand /><nav className={menu ? 'main-nav open' : 'main-nav'} aria-label="主导航"><a href="#/projects" aria-current={route.page === '/projects' ? 'page' : undefined}>项目</a><a href="#/templates" aria-current={route.page === '/templates' ? 'page' : undefined}>场景灵感</a><a href="#/docs" aria-current={route.page === '/docs' ? 'page' : undefined}>使用与接入</a><a href={github} target="_blank" rel="noreferrer">开源 <IconArrowUpRight size={13} /></a></nav><div className="nav-actions">{user ? <a href="#/workspace" className="nav-account" aria-label="我的作品"><span className="nav-account-avatar">{user.name.slice(0, 1)}</span><span className="nav-account-label">我的作品</span></a> : <a className="nav-login" href={loginLink()}>{loading ? '账号' : '登录'}</a>}<ThemePicker theme={theme} setTheme={setTheme} /><LinkButton href="#/create" className="nav-cta">开始创作 <IconArrowUpRight size={16} /></LinkButton><button className="icon-btn menu-toggle" aria-label={menu ? '关闭导航' : '打开导航'} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <IconX /> : <IconMenu2 />}</button></div></div></header>;
}
function Footer({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return <footer className="site-footer section-shell"><div className="footer-main"><div><Brand /><p>给每段对话，一个舞台。</p></div><div className="footer-links"><a href="#/templates">场景灵感</a><a href="#/docs">使用与接入</a><a href={github} target="_blank" rel="noreferrer"><IconBrandGithub size={16} />GitHub</a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} IMStage · MIT License</span><span className="footer-note">为设计、教学与虚构叙事而作</span><ThemePicker theme={theme} setTheme={setTheme} /></div></footer>;
}
function AccountRoute({ route }: { route: Route }) {
  const { user, loading, unavailable, refresh } = useAuth();
  const next = route.page + (route.sceneId ? `?scene=${encodeURIComponent(route.sceneId)}` : route.project ? `?project=${encodeURIComponent(route.project)}` : '');
  useEffect(() => { if (!loading && !user && !unavailable && (location.hash.slice(1).split('?')[0] === route.page)) location.hash = loginLink(next).slice(1); }, [loading, user, unavailable, next]);
  if (loading) return <p className="page-loading" role="status">正在确认登录状态…</p>;
  if (!user) return <section className="account-gate"><h1>{unavailable ? '账号服务暂时不可用' : '登录后打开你的创作空间'}</h1><p>{unavailable ? '作品仍保存在服务端，恢复连接后可以继续。' : '正在为你打开登录页面…'}</p>{unavailable && <button className="btn btn-secondary" onClick={() => void refresh()}>重新连接</button>} <a className="text-link" href={loginLink(next)}>前往登录</a></section>;
  return route.page === '/account' ? <AccountPage /> : route.page === '/projects' ? <ProjectsPage key={user.id} projectId={route.project} /> : route.sceneId ? <AccountEditor key={`${user.id}:${route.sceneId}`} sceneId={route.sceneId} /> : <Workspace key={user.id} />;
}
export default function App() {
  const { user } = useAuth();
  const [route, setRoute] = useState<Route>(parseRoute);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [themeError, setThemeError] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { let previous = location.hash; const change = () => { if (!canNavigate()) { history.replaceState(null, '', location.pathname + location.search + previous); return; } previous = location.hash; setRoute(parseRoute()); window.scrollTo(0, 0); requestAnimationFrame(() => mainRef.current?.focus()); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  // https://react.dev/reference/react/useEffect#connecting-to-an-external-system
  useEffect(() => { const media = window.matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme; document.documentElement.dataset.themePreference = theme; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [theme]);
  useEffect(() => { const title = route.page === '/login' ? '登录' : route.page === '/register' ? '注册' : route.page === '/workspace' ? '我的作品' : route.page === '/account' ? '账号设置' : route.page === '/projects' ? '项目' : route.page === '/create' ? '一句话创作' : route.page === '/studio' ? '工作台' : route.page === '/templates' ? '场景灵感' : route.page === '/docs' ? '使用与接入' : '一句话，聊到想象之外'; document.title = `IMStage · ${title}`; }, [route.page]);
  const updateTheme = (t: Theme) => { setTheme(t); try { localStorage.setItem('imstage-theme', t); setThemeError(false); } catch { setThemeError(true); } };
  const valid = ['/', '/create', '/studio', '/templates', '/docs', '/login', '/register', '/workspace', '/account', '/projects'].includes(route.page);
  return <><a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); mainRef.current?.focus(); }}>跳到主要内容</a><Header route={route} theme={theme} setTheme={updateTheme} />{themeError && <div className="theme-notice" role="status">当前浏览器无法保存主题偏好，本次切换仍然有效。</div>}<main id="main-content" tabIndex={-1} ref={mainRef} className={route.page === '/studio' || route.page === '/workspace' ? 'studio-main' : ''}>
    {['/login', '/register'].includes(route.page) && <AuthPage key={route.page} mode={route.page === '/register' ? 'register' : 'login'} next={route.next} />}
    {['/workspace', '/account', '/projects'].includes(route.page) && <AccountRoute route={route} />}
    {route.page === '/' && <Home />}{route.page === '/create' && <Suspense fallback={<p className="page-loading">正在打开创作台…</p>}><AgentStudio key={`${user?.id || 'guest'}:${route.caseId || 'draft'}`} accountAction={(scene, locked, projectId) => <AccountSave projectId={projectId} key={user?.id || 'guest'} scene={scene} disabled={locked} />} /></Suspense>}{route.page === '/templates' && <Templates />}{route.page === '/docs' && <Docs />}{route.page === '/studio' && <Suspense fallback={<div className="page-loading" role="status"><Mark />正在准备你的创作台…</div>}><Studio key={route.template || 'default'} initialTemplate={route.template} accountAction={scene => <AccountSave key={user?.id || 'guest'} scene={scene} />} /></Suspense>}{!valid && <div className="not-found section-shell"><h1>这个场景还没有开场。</h1><p>页面不存在，回到首页继续创作。</p><LinkButton href="#/">返回首页</LinkButton></div>}
  </main>{!['/studio', '/create', '/workspace', '/account', '/projects', '/login', '/register'].includes(route.page) && <Footer theme={theme} setTheme={updateTheme} />}</>;
}
