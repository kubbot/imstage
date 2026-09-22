import { useViewportDrag } from './useViewportDrag';
import { timelinePresentation } from '../../../../packages/schema/timeline.mjs';
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
  interactiveViewport?: boolean;
  pendingAssets?: boolean;
  onSelectElement?: (id: string) => void;
  /** Localise group count and empty state; WhatsApp defaults to English chrome. */
  locale?: 'zh' | 'en';
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

function Avatar({ participant, locale = 'zh' }: { participant: Participant | undefined; locale?: 'zh' | 'en' }) {
  const name = participant?.name ?? '?';
  const id = participant?.id ?? 'unknown';
  if (participant?.avatar) {
    return <img className="scene-avatar" src={participant.avatar} alt={locale === 'en' ? `${name}'s avatar` : `${name} 的头像`} />;
  }
  return (
    <span className="scene-avatar scene-avatar-initials" style={{ background: avatarColor(id, name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function media(message: Message, locale: 'zh' | 'en' = 'zh') {
  return message.asset ? <img src={message.asset} alt={message.text || (locale === 'en' ? 'Image' : '图片')} /> : <span className="scene-media-empty">{locale === 'en' ? 'Image not set' : '图片未设置'}</span>;
}
function MessageBody({ message, pending = false, locale = 'zh' }: { message: Message; pending?: boolean; locale?: 'zh' | 'en' }) {
  if (message.type === 'album') return <div className="scene-album">{message.items?.map(item => <div key={item.id} className="scene-album-item">{item.asset ? <img src={item.asset} alt={item.caption} /> : <span>{item.caption || (locale === 'en' ? 'Image not set' : '图片未设置')}</span>}{item.kind === 'video' && <span className="scene-play">▶</span>}</div>)}</div>;
  if (message.type === 'video') return <div className="scene-video">{media(message, locale)}<span className="scene-play">▶</span><small>{message.subtitle || '0:10'}</small></div>;
  if (message.type === 'voice') return <div className="scene-bubble">◖ ıııııııııııı {message.text || (locale === 'en' ? 'Voice' : '语音')} <small>{message.subtitle}</small></div>;
  if (message.type === 'transfer') return <div className="scene-transfer"><strong>✓ {message.text}</strong><span>{message.subtitle || (locale === 'en' ? 'Simulated transfer' : '模拟转账')}</span></div>;
  if (message.type === 'contact') return <div className="scene-card scene-contact"><div className="scene-contact-main">{message.asset && media(message, locale)}<strong>{message.text}</strong></div><span>{message.subtitle || 'Contact Card'}</span></div>;
  if (message.type === 'link') return <div className="scene-card">{message.asset && media(message, locale)}<strong>{message.text}</strong><span>{message.subtitle || (locale === 'en' ? 'Link' : '链接')}</span></div>;
  if (message.type === 'system') {
    return <div className="scene-system">{message.text}</div>;
  }
  if (message.type === 'location') {
    return (
      <div className="scene-location" data-world={/火星|mars/i.test(message.text) ? 'mars' : undefined}>
        <div className="scene-location-map">
          {message.asset && <img src={message.asset} alt={locale === 'en' ? 'Location thumbnail' : '位置缩略图'} />}
          <IconMapPin size={26} stroke={1.6} aria-hidden="true" />
          <span className="scene-location-pin" />
        </div>
        <div className="scene-location-info">
          <span className="scene-location-title">{message.text || (locale === 'en' ? 'Location' : '位置')}</span>
          <span className="scene-location-sub">{message.subtitle || (/火星|mars/i.test(message.text) ? (locale === 'en' ? 'Mars · illustrative location' : '火星 · 示意定位') : (locale === 'en' ? 'Illustrative location' : '示意位置'))}</span>
        </div>
      </div>
    );
  }
  if (message.type === 'image') {
    return (
      <div className="scene-image">
        {message.asset ? (
          <img src={message.asset} alt={message.text || (locale === 'en' ? 'Conversation image' : '对话图片')} />
        ) : (
          <div className="scene-image-missing" aria-busy={pending}>
            <IconPhoto size={22} stroke={1.6} aria-hidden="true" />
            <span>{pending ? (locale === 'en' ? 'Preparing the image…' : '图片素材准备中…') : (locale === 'en' ? 'Image not set' : '图片未设置')}</span>
          </div>
        )}
        {message.text ? <div className="scene-image-caption">{message.text}</div> : null}
      </div>
    );
  }
  return <div className="scene-bubble">{message.text}</div>;
}

function headerTitle(scene: Scene, locale: 'zh' | 'en' = 'zh'): string {
  if (scene.headerText !== undefined) return scene.headerText;
  const self = scene.participants.find((participant) => participant.id === scene.selfId);
  if (scene.participants.length <= 2) {
    const other = scene.participants.find((participant) => participant.id !== scene.selfId);
    return other?.name ?? self?.name ?? (locale === 'en' ? 'Chat' : '对话');
  }
  return scene.title || (locale === 'en' ? 'Group chat' : '群聊');
}

/**
 * Reusable chat renderer. The same DOM is used for the landing preview, the
 * editor canvas and the PNG export — never a separate canvas renderer.
 */
export function SceneView({ scene, selectedId, onSelect, exportMode = false, pendingAssets = false, onSelectElement, interactiveViewport = false, locale = scene.platform === 'whatsapp' ? 'en' : 'zh' }: SceneViewProps) {
  const viewportDrag = useViewportDrag(interactiveViewport && !exportMode);
  const selectable = typeof onSelect === 'function' && !exportMode;
  const elementProps = (label: string) => onSelectElement && !exportMode ? {
    role: 'button' as const, tabIndex: 0, 'aria-label': label, 'data-editor-selectable': true,
    onClick: () => onSelectElement('@scene'),
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectElement('@scene'); } },
  } : {};
  const Bubble = selectable ? 'button' : 'div';
  function avatar(participant: Participant | undefined) {
    return onSelectElement && !exportMode && participant ? <button type="button" className="scene-avatar-select" aria-label={locale === 'en' ? `Edit ${participant.name}'s avatar` : `编辑 ${participant.name} 的头像`} aria-pressed={selectedId === `@participant:${participant.id}`} onClick={() => onSelectElement(`@participant:${participant.id}`)}><Avatar participant={participant} locale={locale}/></button> : <Avatar participant={participant} locale={locale}/>;
  }
  const participantMap = new Map(scene.participants.map((participant) => [participant.id, participant]));
  const title = headerTitle(scene, locale);
  const timeline = timelinePresentation(scene);
  const group = scene.participants.length > 2;
  const template = platformTemplate(scene.platform);
  const profile = deviceProfile(scene);
  const other = scene.participants.find(p => p.id !== scene.selfId);
  const showAvatar = (self:boolean) => template.messageAvatars === 'all' || (template.messageAvatars === 'incoming' && !self) || (template.messageAvatars === 'group' && group && !self);

  return (
    <div className="scene-view" data-platform={scene.platform} data-template={template.version} data-surface={scene.surface || profile.surface} data-device={profile.id} style={{'--scene-font':scene.appearance?.fontSize !== undefined ? `${scene.appearance.fontSize}px` : undefined,'--scene-radius':scene.appearance?.radius !== undefined ? `${scene.appearance.radius}px` : undefined,'--scene-spacing':scene.appearance?.spacing !== undefined ? `${scene.appearance.spacing}px` : undefined,'--scene-text':scene.appearance?.color,'--scene-bubble':scene.appearance?.background} as CSSProperties} data-watermark={Boolean(scene.watermark)} data-export={exportMode ? 'true' : undefined}>
      <div className="scene-status" data-element="@scene" {...elementProps(locale === 'en' ? 'Edit device status' : '编辑设备状态')}>
        <span className="scene-status-time">{scene.deviceTime}</span>
        <span className="scene-status-icons" aria-hidden="true">
          <span className="scene-signal" aria-hidden="true"><i/><i/><i/><i/></span>
          <IconWifi size={15} stroke={1.8} />

          <span className="scene-battery" aria-hidden="true"><i style={{width:`${scene.battery??80}%`}}/>{scene.battery!==undefined&&<b className="scene-battery-number">{scene.battery}</b>}</span>
        </span>
      </div>

      <div className="scene-header">
        <IconChevronLeft size={22} stroke={2} aria-hidden="true" className="scene-header-back" />
        {template.headerAvatar && (onSelectElement && !exportMode ? <button type="button" className="scene-profile-select" aria-label={locale === 'en' ? `Edit ${other?.name || 'Contact'}'s avatar` : `编辑 ${other?.name || "联系人"} 的头像`} onClick={event=>{event.stopPropagation();if(other)onSelectElement(`@participant:${other.id}`);}}><Avatar participant={other} locale={locale}/></button> : <Avatar participant={other} locale={locale}/>)}
        <div className="scene-header-title" {...elementProps(locale === 'en' ? 'Edit chat title' : '编辑会话标题')}>
          <span className="scene-header-name">{title}</span>
          {group ? <span className="scene-header-sub">{locale === 'en' ? `${scene.participants.length} members` : `${scene.participants.length} 人`}</span> : template.headerAvatar ? <span className="scene-header-sub">{scene.platform === 'whatsapp' ? 'tap for contact info' : other?.name}</span> : null}
        </div>
        {template.headerAvatar ? <span className="scene-header-actions" aria-hidden="true"><IconVideo size={23} stroke={1.7}/><IconPhone size={23} stroke={1.7}/></span> : <IconDots size={20} stroke={2} aria-hidden="true" className="scene-header-more" />}
      </div>

      <div className="scene-messages" {...viewportDrag} data-scrollable={interactiveViewport || undefined} tabIndex={interactiveViewport ? 0 : undefined} role={interactiveViewport ? 'region' : undefined} aria-label={interactiveViewport ? (locale === 'en' ? 'Chat content, scroll to set the capture range' : '聊天内容，可滚动调整截取范围') : undefined} onClick={event => { if (event.target === event.currentTarget && !exportMode) onSelectElement?.("@scene"); }} style={{backgroundColor:scene.background || template.background,backgroundImage:scene.backgroundImage ? `url("${scene.backgroundImage}")` : undefined,backgroundSize:scene.backgroundImage ? "cover" : undefined,backgroundPosition:"center"}}>
        {timeline.header && <div className="scene-date" {...elementProps(locale === 'en' ? 'Edit date text' : '编辑日期文字')}>{timeline.header}</div>}
        {scene.messages.length === 0 ? <div className="scene-empty">{locale === 'en' ? 'No messages yet' : '还没有消息'}</div> : null}
        {scene.messages.map((message, index) => {
          const { dateLabel, showTime, hidden } = timeline.entries[index];
          if (hidden && !dateLabel) return null;
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
              {dateLabel && <div className="scene-date scene-date-separator" data-date={message.date}>{dateLabel}</div>}
              {!hidden && !template.inlineTime && showTime && message.time ? <div className="scene-time">{message.time}</div> : null}
              {!hidden && <div className="scene-line">
                {!isSelf && showAvatar(false) && message.type !== 'system' ? avatar(participant) : null}
                <Bubble type={selectable ? "button" : undefined} className={`scene-bubble-wrap${selectable ? ' scene-message-select' : ''}`} aria-label={selectable ? (locale === 'en' ? `Select message: ${message.text || message.type}` : `选择消息：${message.text || message.type}`) : undefined} aria-pressed={selectable ? selectedId === message.id : undefined} onClick={selectable ? () => onSelect?.(message.id) : undefined} style={{width:message.width ? Math.min(message.width, scene.surface === 'desktop' ? 560 : 252) : undefined,height:message.height, '--scene-font':message.appearance?.fontSize ? `${message.appearance.fontSize}px` : undefined,'--scene-text':message.appearance?.color,'--scene-bubble':message.appearance?.background,'--scene-radius':message.appearance?.radius !== undefined ? `${message.appearance.radius}px` : undefined} as CSSProperties}>
                  {!isSelf && message.type !== 'system' && group ? (
                    <span className="scene-sender">{participant?.name}</span>
                  ) : null}
                  {message.quote && <div className="scene-quote">{message.quote}</div>}
                  <MessageBody message={message} pending={pendingAssets} locale={locale} />
                  {template.inlineTime && message.type !== 'system' && <div className="scene-message-meta"><span>{message.time}</span>{isSelf && <IconChecks size={16} stroke={1.7} aria-label={locale === 'en' ? 'Read' : '已读'}/>}</div>}
                </Bubble>
                {isSelf && showAvatar(true) ? avatar(participant) : null}
              </div>}
            </div>
          );

          return <div className={`scene-row-host${selectable ? ' scene-selectable' : ''}${selectable && selectedId === message.id ? ' is-selected' : ''}`} key={message.id} onClick={selectable ? event => { if (!(event.target as HTMLElement).closest('button')) onSelect?.(message.id); } : undefined}>{row}</div>;
        })}
      </div>

      {profile.id==='macos-window' ? <div className="scene-composer scene-desktop-composer" {...elementProps(locale === 'en' ? 'Edit composer' : '编辑输入栏')}><div className="scene-desktop-tools"><IconMoodSmile size={21}/><IconFolder size={21}/><IconScissors size={21}/><IconMicrophone size={21}/></div><div className="scene-desktop-input">{scene.composerText||''}</div><span className="scene-desktop-send" aria-hidden="true">{locale === 'en' ? 'Send' : '发送'}</span></div> : <div className="scene-composer" {...elementProps(locale === 'en' ? 'Edit composer' : '编辑输入栏')}>
        <span className="scene-composer-icon" aria-hidden="true">{template.composer === 'wechat' ? <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="13" cy="13" r="11"/><path d="M11 9q4 4 0 8M14 7q6 6 0 12M8 11q2 2 0 4"/></svg> : template.composer === 'instagram' ? <IconCamera size={25}/> : template.composer === 'default' ? <IconMoodSmile size={25} stroke={1.6}/> : <IconPlus size={25} stroke={1.6}/>}</span>
        <span className="scene-composer-field">{scene.composerText ?? (template.composer === 'instagram' ? 'Message…' : '')}</span>
        <span className="scene-composer-icon" hidden={template.composer==='default'} aria-hidden="true">{template.composer === 'whatsapp' ? <IconCamera size={24} stroke={1.6}/> : <IconMoodSmile size={25} stroke={1.6}/>}</span>
        <span className="scene-composer-icon" aria-hidden="true">{template.composer === 'whatsapp' ? <IconMicrophone size={24} stroke={1.7}/> : template.composer === 'wechat' ? <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="13" cy="13" r="11"/><path d="M7 13h12M13 7v12"/></svg> : <IconPlus size={25} stroke={1.6}/>}</span>
      </div>}

      {scene.watermark ? <div className="scene-watermark" {...elementProps(locale === 'en' ? 'Edit watermark' : '编辑水印')}>{scene.watermark}</div> : null}
    </div>
  );
}

export default SceneView;
