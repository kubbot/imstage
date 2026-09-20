import type { ReactNode } from 'react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { SceneView } from './studio/SceneView';
import { createScene } from './studio/model';
export const github = 'https://github.com/kubbot/imstage';
export const templates = [
  { id: 'weekend' as const, title: '周末出逃计划', category: '生活叙事', description: '一句“去看海吧”，是整个故事的开始。', platform: '微信风格', className: 'getaway' },
  { id: 'launch' as const, title: '好想法，群里见', category: '产品演示', description: '把一次灵感碰撞，编排成产品的开场。', platform: '微信 · 群聊', className: 'launch' },
  { id: 'welcome' as const, title: '很高兴认识你', category: '教学示例', description: '从第一次打招呼开始，把沟通讲清楚。', platform: '小红书风格', className: 'welcome' },
];
export function Mark({ className = '' }: { className?: string }) {
  // Preserved from the user's original OpenDesign brand asset.
  return <svg className={`brand-mark ${className}`} viewBox="0 0 40 40" aria-hidden="true"><path d="M15 7H7v26h8M25 7h8v26h-8M15 14l10 6-10 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" strokeLinejoin="miter" /><circle cx="15" cy="14" r="2.3" fill="currentColor" /><circle cx="25" cy="20" r="2.3" fill="currentColor" /><circle cx="15" cy="26" r="2.3" fill="currentColor" /></svg>;
}
export function Brand() { return <a className="brand" href="#/" aria-label="IMStage 首页"><Mark /><span>IMStage</span></a>; }
export function LinkButton({ children, href, secondary = false, className = '' }: { children: ReactNode; href: string; secondary?: boolean; className?: string }) {
  return <a className={`btn ${secondary ? 'btn-secondary' : 'btn-primary'} ${className}`} href={href}>{children}</a>;
}
export function TemplateCard({ template, index }: { template: typeof templates[number]; index: number }) {
  const scene = createScene(template.id);
  if (template.id === 'welcome') scene.platform = 'xiaohongshu';
  return <a className={`template-card ${template.className}`} href={`#/studio?template=${template.id}`}>
    <div className="template-art"><div className="template-word" aria-hidden="true">{index === 0 ? '去看海' : index === 1 ? '有想法' : '初次见'}</div><div className="template-device" aria-hidden="true"><SceneView scene={scene} /></div><span className="template-open" aria-hidden="true"><IconArrowUpRight size={21} /></span></div>
    <div className="template-caption"><div><span>{template.category} / {template.platform}</span><h3>{template.title}</h3></div><IconArrowUpRight size={19} /></div><p>{template.description}</p>
  </a>;
}
