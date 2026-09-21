import {platformTemplate} from './platform-templates';
import {deviceProfile} from './device-profiles';
import type { CSSProperties } from 'react';
import {
  IconFolder,
  IconScissors,
  IconPhone,
  IconVideo,
  IconMicrophone,
  IconCamera,
  IconChecks,
  IconChevronLeft,
  IconDots,
  IconMapPin,
  IconMoodSmile,
  IconPhoto,
  IconPlus,
  IconWifi,
} from '@tabler/icons-react';
import type { Message, Participant, Scene } from './model';
import './studio.css';

export interface SceneViewProps {
  scene: Scene;
  selectedId?: string;
  onSelect?: (id: string) => void;
  exportMode?: boolean;
  pendingAssets?: boolean;
  onSelectElement?: (id: string) => void;
}

const AVATAR_COLORS = ['#5b8def', '#e3874f', '#4fb286', '#b06fd6', '#d6607a', '#4aa3c7'];

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(trimmed)) return trimmed.slice(0, 1);
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

function avatarColor(id: string, name: string): string {
  return AVATAR_COLORS[hashString(`${id}:${name}`) % AVATAR_COLORS.length];
}

function Avatar({ participant }: { participant: Participant | undefined }) {
  const name = participant?.name ?? '?';
  const id = participant?.id ?? 'unknown';
  if (participant?.avatar) {
    return <img className="scene-avatar" src={participant.avatar} alt={`${name} 的头像`} />;
  }
  return (
    <span className="scene-avatar scene-avatar-initials" style={{ background: avatarColor(id, name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function media(message: Message) {
  return message.asset ? <img src={message.asset} alt={message.text || '图片'} /> : <span className="scene-media-empty">图片未设置</span>;
}
function MessageBody({ message, pending = false }: { message: Message; pending?: boolean }) {
  if (message.type === 'album') return <div className="scene-album">{message.items?.map(item => <div key={item.id} className="scene-album-item">{item.asset ? <img src={item.asset} alt={item.caption} /> : <span>{item.caption || '图片未设置'}</span>}{item.kind === 'video' && <span className="scene-play">▶</span>}</div>)}</div>;
  if (message.type === 'video') return <div className="scene-video">{media(message)}<span className="scene-play">▶</span><small>{message.subtitle || '0:10'}</small></div>;
  if (message.type === 'voice') return <div className="scene-bubble">◖ ıııııııııııı {message.text || '语音'} <small>{message.subtitle}</small></div>;
  if (message.type === 'transfer') return <div className="scene-transfer"><strong>✓ {message.text}</strong><span>{message.subtitle || '模拟转账'}</span></div>;
  if (message.type === 'contact') return <div className="scene-card scene-contact"><div className="scene-contact-main">{message.asset && media(message)}<strong>{message.text}</strong></div><span>{message.subtitle || 'Contact Card'}</span></div>;
  if (message.type === 'link') return <div className="scene-card">{message.asset && media(message)}<strong>{message.text}</strong><span>{message.subtitle || '链接'}</span></div>;
  if (message.type === 'system') {
    return <div className="scene-system">{message.text}</div>;
  }
  if (message.type === 'location') {
    return (
      <div className="scene-location" data-world={/火星|mars/i.test(message.text) ? 'mars' : undefined}>
        <div className="scene-location-map">
          {message.asset && <img src={message.asset} alt="位置缩略图" />}
          <IconMapPin size={26} stroke={1.6} aria-hidden="true" />
          <span className="scene-location-pin" />
        </div>
        <div className="scene-location-info">
          <span className="scene-location-title">{message.text || '位置'}</span>
          <span className="scene-location-sub">{message.subtitle || (/火星|mars/i.test(message.text) ? '火星 · 示意定位' : '示意位置')}</span>
        </div>
      </div>
    );
  }
  if (message.type === 'image') {
    return (
      <div className="scene-image">
        {message.asset ? (
          <img src={message.asset} alt={message.text || '对话图片'} />
        ) : (
          <div className="scene-image-missing" aria-busy={pending}>
            <IconPhoto size={22} stroke={1.6} aria-hidden="true" />
            <span>{pending ? '图片素材准备中…' : '图片未设置'}</span>
          </div>
        )}
        {message.text ? <div className="scene-image-caption">{message.text}</div> : null}
      </div>
    );
  }
  return <div className="scene-bubble">{message.text}</div>;
}

function headerTitle(scene: Scene): string {
  if (scene.headerText !== undefined) return scene.headerText;
  const self = scene.participants.find((participant) => participant.id === scene.selfId);
  if (scene.participants.length <= 2) {
    const other = scene.participants.find((participant) => participant.id !== scene.selfId);
    return other?.name ?? self?.name ?? '对话';
  }
  return scene.title || '群聊';
}

/**
 * Reusable chat renderer. The same DOM is used for the landing preview, the
 * editor canvas and the PNG export — never a separate canvas renderer.
 */
export function SceneView({ scene, selectedId, onSelect, exportMode = false, pendingAssets = false, onSelectElement }: SceneViewProps) {
  const selectable = typeof onSelect === 'function' && !exportMode;
  const participantMap = new Map(scene.participants.map((participant) => [participant.id, participant]));
  const title = headerTitle(scene);
  const group = scene.participants.length > 2;
  const template = platformTemplate(scene.platform);
  const profile = deviceProfile(scene);
  const other = scene.participants.find(p => p.id !== scene.selfId);
  const showAvatar = (self:boolean) => template.messageAvatars === 'all' || (template.messageAvatars === 'incoming' && !self) || (template.messageAvatars === 'group' && group && !self);

  return (
    <div className="scene-view" data-platform={scene.platform} data-template={template.version} data-surface={scene.surface || profile.surface} data-device={profile.id} style={{'--scene-font':scene.appearance?.fontSize !== undefined ? `${scene.appearance.fontSize}px` : undefined,'--scene-radius':scene.appearance?.radius !== undefined ? `${scene.appearance.radius}px` : undefined,'--scene-spacing':scene.appearance?.spacing !== undefined ? `${scene.appearance.spacing}px` : undefined,'--scene-text':scene.appearance?.color,'--scene-bubble':scene.appearance?.background} as CSSProperties} data-watermark={Boolean(scene.watermark)} data-export={exportMode ? 'true' : undefined}>
      <div className="scene-status" data-element="@scene" onClick={() => onSelectElement?.("@scene")}>
        <span className="scene-status-time">{scene.deviceTime}</span>
        <span className="scene-status-icons" aria-hidden="true">
          <span className="scene-signal" aria-hidden="true"><i/><i/><i/><i/></span>
          <IconWifi size={15} stroke={1.8} />
          
          <span className="scene-battery" aria-hidden="true"><i style={{width:`${scene.battery??80}%`}}/>{scene.battery!==undefined&&<b className="scene-battery-number">{scene.battery}</b>}</span>
        </span>
      </div>

      <div className="scene-header" onClick={() => onSelectElement?.("@scene")}>
        <IconChevronLeft size={22} stroke={2} aria-hidden="true" className="scene-header-back" />
        {template.headerAvatar && (onSelectElement && !exportMode ? <button type="button" className="scene-profile-select" aria-label={`编辑 ${other?.name || "联系人"} 的头像`} onClick={event=>{event.stopPropagation();if(other)onSelectElement(`@participant:${other.id}`);}}><Avatar participant={other}/></button> : <Avatar participant={other}/>)}
        <div className="scene-header-title">
          <span className="scene-header-name">{title}</span>
          {group ? <span className="scene-header-sub">{scene.participants.length} 人</span> : template.headerAvatar ? <span className="scene-header-sub">{scene.platform === 'whatsapp' ? 'tap for contact info' : other?.name}</span> : null}
        </div>
        {template.headerAvatar ? <span className="scene-header-actions" aria-hidden="true"><IconVideo size={23} stroke={1.7}/><IconPhone size={23} stroke={1.7}/></span> : <IconDots size={20} stroke={2} aria-hidden="true" className="scene-header-more" />}
      </div>

      <div className="scene-messages" style={{backgroundColor:scene.background || template.background,backgroundImage:scene.backgroundImage ? `url("${scene.backgroundImage}")` : undefined,backgroundSize:scene.backgroundImage ? "cover" : undefined,backgroundPosition:"center"}}>
        {scene.date && <div className="scene-date">{scene.date}</div>}
        {scene.messages.length === 0 ? <div className="scene-empty">还没有消息</div> : null}
        {scene.messages.map((message, index) => {
          const previous = scene.messages[index - 1];
          const showTime = !previous || previous.time !== message.time;
          const participant = participantMap.get(message.participantId);
          const isSelf = message.type !== 'system' && message.participantId === scene.selfId;
          const rowClass = [
            'scene-row',
            isSelf ? 'is-self' : 'is-other',
            message.type === 'system' ? 'is-system' : '',
          ]
            .filter(Boolean)
            .join(' ');

          const row = (
            <div className={rowClass} data-message-id={message.id}>
              {!template.inlineTime && showTime && message.time ? <div className="scene-time">{message.time}</div> : null}
              <div className="scene-line">
                {!isSelf && showAvatar(false) && message.type !== 'system' ? <span onClick={event => { if (onSelectElement) { event.stopPropagation(); onSelectElement(`@participant:${participant?.id}`); } }}><Avatar participant={participant} /></span> : null}
                <div className="scene-bubble-wrap" style={{width:message.width ? Math.min(message.width, scene.surface === 'desktop' ? 560 : 252) : undefined,height:message.height, '--scene-font':message.appearance?.fontSize ? `${message.appearance.fontSize}px` : undefined,'--scene-text':message.appearance?.color,'--scene-bubble':message.appearance?.background,'--scene-radius':message.appearance?.radius !== undefined ? `${message.appearance.radius}px` : undefined} as CSSProperties}>
                  {!isSelf && message.type !== 'system' && group ? (
                    <span className="scene-sender">{participant?.name}</span>
                  ) : null}
                  {message.quote && <div className="scene-quote">{message.quote}</div>}
                  <MessageBody message={message} pending={pendingAssets} />
                  {template.inlineTime && message.type !== 'system' && <div className="scene-message-meta"><span>{message.time}</span>{isSelf && <IconChecks size={16} stroke={1.7} aria-label="已读"/>}</div>}
                </div>
                {isSelf && showAvatar(true) ? <span onClick={event => { if (onSelectElement) { event.stopPropagation(); onSelectElement(`@participant:${participant?.id}`); } }}><Avatar participant={participant} /></span> : null}
              </div>
            </div>
          );

          if (!selectable) {
            return (
              <div className="scene-row-host" key={message.id}>
                {row}
              </div>
            );
          }
          return (
            <button
              className={`scene-row-host scene-selectable${selectedId === message.id ? ' is-selected' : ''}`}
              key={message.id}
              type="button"
              aria-pressed={selectedId === message.id}
              aria-label={`选择消息：${message.text || message.type}`}
              onClick={() => onSelect?.(message.id)}
            >
              {row}
            </button>
          );
        })}
      </div>

      {profile.id==='macos-window' ? <div className="scene-composer scene-desktop-composer" onClick={()=>onSelectElement?.('@scene')}><div className="scene-desktop-tools"><IconMoodSmile size={21}/><IconFolder size={21}/><IconScissors size={21}/><IconMicrophone size={21}/></div><div className="scene-desktop-input">{scene.composerText||''}</div><span className="scene-desktop-send">发送</span></div> : <div className="scene-composer" onClick={() => onSelectElement?.("@scene")}>
        <span className="scene-composer-icon" aria-hidden="true">{template.composer === 'wechat' ? <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="13" cy="13" r="11"/><path d="M11 9q4 4 0 8M14 7q6 6 0 12M8 11q2 2 0 4"/></svg> : template.composer === 'instagram' ? <IconCamera size={25}/> : template.composer === 'default' ? <IconMoodSmile size={25} stroke={1.6}/> : <IconPlus size={25} stroke={1.6}/>}</span>
        <span className="scene-composer-field">{scene.composerText ?? (template.composer === 'instagram' ? 'Message…' : '')}</span>
        <span className="scene-composer-icon" hidden={template.composer==='default'} aria-hidden="true">{template.composer === 'whatsapp' ? <IconCamera size={24} stroke={1.6}/> : <IconMoodSmile size={25} stroke={1.6}/>}</span>
        <span className="scene-composer-icon" aria-hidden="true">{template.composer === 'whatsapp' ? <IconMicrophone size={24} stroke={1.7}/> : template.composer === 'wechat' ? <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="13" cy="13" r="11"/><path d="M7 13h12M13 7v12"/></svg> : <IconPlus size={25} stroke={1.6}/>}</span>
      </div>}

      {scene.watermark ? <div className="scene-watermark">{scene.watermark}</div> : null}
    </div>
  );
}

export default SceneView;
