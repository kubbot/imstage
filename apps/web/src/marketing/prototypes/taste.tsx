import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { IconArrowUpRight, IconBrandGithub, IconPencil } from '@tabler/icons-react';
import { Brand } from '../../components';
import { SceneView } from '../../studio/SceneView';
import { createScenario } from '../scenes';
import { ScaledSceneFrame } from '../DeviceFrame';
import '@fontsource/syne/latin-600.css';
import '@fontsource/syne/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '../../styles.css';
import '../../studio/studio.css';
import '../marketing.css';
import './taste.css';

function Taste() {
  const archive = new URLSearchParams(location.search).get('direction') === 'b';
  const [scene, setScene] = useState(createScenario('evaluation', 'zh'));
  const [reply, setReply] = useState('好呀，谢谢。周五中午前我确认。');
  function change(value: string) {
    setReply(value);
    setScene({ ...scene, messages: scene.messages.map((m, i) => i === scene.messages.length - 1 ? { ...m, text: value } : m) });
  }
  return <div className={`taste ${archive ? 'archive' : 'atelier'}`}>
    <header><Brand /><div><a href="?direction=a">创作台 A</a><a href="?direction=b">样本档案 B</a><IconBrandGithub size={21} /><a className="taste-action" href="/#/create">开始创作 <IconArrowUpRight size={17}/></a></div></header>
    {archive ? <>
      <main className="taste-archive-hero"><span className="taste-eyebrow">合成聊天 · 测试与评测</span><h1>一个设定。<br/><em>每一种可能。</em></h1><p>固定上下文，逐条推敲回答。把可对照的样本，放在同一张工作桌上。</p><a className="taste-action" href="/#/create">建立第一份样本 <IconArrowUpRight size={17}/></a></main>
      <section className="taste-archive-shelf">{['固定上下文','修改回答','生成变体'].map((label,i)=><article key={label}><span>样本 {String.fromCharCode(65+i)}</span><div className="taste-archive-phone"><ScaledSceneFrame><SceneView scene={{...scene,title:label}} exportMode locale="zh"/></ScaledSceneFrame></div><h2>{label}</h2><p>{['让每次评测都有同一个起点。','一处变化，其他内容保持。','从同一设定延伸不同回答。'][i]}</p></article>)}</section>
    </> : <main className="taste-atelier-hero"><div className="taste-manifesto"><span className="taste-eyebrow">合成对话，用于测试与评测</span><h1>把一句话，<br/><em>放进场景里。</em></h1><p>写下设定，推敲对话。把可编辑的合成样本，变成可用的测试素材。</p><form onSubmit={e=>e.preventDefault()}><label htmlFor="taste-prompt">从这个设定开始</label><textarea id="taste-prompt" defaultValue="固定同一段上下文，让对方在周五前确认，生成可对照的回答。"/><button className="taste-action">发送并创建 <IconArrowUpRight size={17}/></button></form></div><div className="taste-table"><div className="taste-table-top"><span>一份可编辑的合成样本</span><span>IMStage</span></div><div className="taste-specimen"><ScaledSceneFrame><SceneView scene={scene} exportMode locale="zh"/></ScaledSceneFrame></div><div className="taste-note"><span><IconPencil size={16}/> 试着改一句</span><label htmlFor="taste-reply">回答</label><textarea id="taste-reply" value={reply} onChange={e=>change(e.target.value)}/><small>这句话已在场景中同步</small></div><div className="taste-table-caption">虚构人物 · 合成示例 · 默认标识</div></div></main>}
    <section className="taste-mid"><div><h2>{archive?'差异有迹可循。':'细节，由你决定。'}</h2><p>人物、时间与措辞各自修改。浏览示例无需调用 AI。</p></div><div className="taste-proof"><span>固定的上下文</span><blockquote>这周末要不要一起去看展？</blockquote><span>可控的回答</span><label htmlFor="taste-mid-reply">试改回复</label><input id="taste-mid-reply" value={reply} onChange={e=>change(e.target.value)}/><p>同一份场景用于预览和 PNG 导出</p></div></section>
  </div>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Taste/>);
