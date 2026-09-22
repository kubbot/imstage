import type { ReactNode } from 'react';
export const github = 'https://github.com/kubbot/imstage';
/** Template ids recognised by the studio route. Copy lives with the pages. */
export const templates = [
  { id: 'weekend' as const, className: 'getaway' },
  { id: 'launch' as const, className: 'launch' },
  { id: 'welcome' as const, className: 'welcome' },
];
export function Mark({ className = '' }: { className?: string }) {
  // Preserved from the user's original OpenDesign brand asset.
  return <svg className={`brand-mark ${className}`} viewBox="0 0 40 40" aria-hidden="true"><path d="M15 7H7v26h8M25 7h8v26h-8M15 14l10 6-10 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" strokeLinejoin="miter" /><circle cx="15" cy="14" r="2.3" fill="currentColor" /><circle cx="25" cy="20" r="2.3" fill="currentColor" /><circle cx="15" cy="26" r="2.3" fill="currentColor" /></svg>;
}
export function Brand({ label = 'IMStage 首页' }: { label?: string } = {}) { return <a className="brand" href="#/" aria-label={label}><Mark /><span>IMStage</span></a>; }
export function LinkButton({ children, href, secondary = false, className = '' }: { children: ReactNode; href: string; secondary?: boolean; className?: string }) {
  return <a className={`btn ${secondary ? 'btn-secondary' : 'btn-primary'} ${className}`} href={href}>{children}</a>;
}
