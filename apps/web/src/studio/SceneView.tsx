import {
  IconBattery3,
  IconCellSignal4,
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

function MessageBody({ message }: { message: Message }) {
  if (message.type === 'system') {
    return <div className="scene-system">{message.text}</div>;
  }
  if (message.type === 'location') {
    return (
      <div className="scene-location">
        <div className="scene-location-map">
          <IconMapPin size={26} stroke={1.6} aria-hidden="true" />
          <span className="scene-location-pin" />
        </div>
        <div className="scene-location-info">
          <span className="scene-location-title">{message.text || '位置'}</span>
          <span className="scene-location-sub">示意位置</span>
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
          <div className="scene-image-missing">
            <IconPhoto size={22} stroke={1.6} aria-hidden="true" />
            <span>图片未设置</span>
          </div>
        )}
        {message.text ? <div className="scene-image-caption">{message.text}</div> : null}
      </div>
    );
  }
  return <div className="scene-bubble">{message.text}</div>;
}

function headerTitle(scene: Scene): string {
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
export function SceneView({ scene, selectedId, onSelect, exportMode = false }: SceneViewProps) {
  const selectable = typeof onSelect === 'function' && !exportMode;
  const participantMap = new Map(scene.participants.map((participant) => [participant.id, participant]));
  const title = headerTitle(scene);
  const group = scene.participants.length > 2;

  return (
    <div className="scene-view" data-platform={scene.platform} data-export={exportMode ? 'true' : undefined}>
      <div className="scene-status">
        <span className="scene-status-time">{scene.deviceTime}</span>
        <span className="scene-status-icons" aria-hidden="true">
          <IconCellSignal4 size={15} stroke={1.8} />
          <IconWifi size={15} stroke={1.8} />
          <IconBattery3 size={17} stroke={1.6} />
        </span>
      </div>

      <div className="scene-header">
        <IconChevronLeft size={22} stroke={2} aria-hidden="true" className="scene-header-back" />
        <div className="scene-header-title">
          <span className="scene-header-name">{title}</span>
          {group ? <span className="scene-header-sub">{scene.participants.length} 人</span> : null}
        </div>
        <IconDots size={20} stroke={2} aria-hidden="true" className="scene-header-more" />
      </div>

      <div className="scene-messages">
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
              {showTime && message.time ? <div className="scene-time">{message.time}</div> : null}
              <div className="scene-line">
                {!isSelf && message.type !== 'system' ? <Avatar participant={participant} /> : null}
                <div className="scene-bubble-wrap">
                  {!isSelf && message.type !== 'system' && group ? (
                    <span className="scene-sender">{participant?.name}</span>
                  ) : null}
                  <MessageBody message={message} />
                </div>
                {isSelf ? <Avatar participant={participant} /> : null}
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

      <div className="scene-composer">
        <span className="scene-composer-icon" aria-hidden="true">
          <IconMoodSmile size={22} stroke={1.7} />
        </span>
        <span className="scene-composer-field">输入消息</span>
        <span className="scene-composer-icon" aria-hidden="true">
          <IconPlus size={20} stroke={1.8} />
        </span>
      </div>

      {scene.watermark ? <div className="scene-watermark">{scene.watermark}</div> : null}
    </div>
  );
}

export default SceneView;
