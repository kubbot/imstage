/** Safe declarative chat layouts. No user-authored CSS or executable markup. */
export interface CustomLayout {
  kind: 'custom';
  name: string;
  avatarShape?: 'circle' | 'rounded' | 'square';
  showAvatars?: boolean;
  headerBackground?: string;
  incomingBackground?: string;
  outgoingBackground?: string;
  background?: string;
  textColor?: string;
  bubbleRadius?: number;
  messageSpacing?: number;
  headerHeight?: number;
  maxBubbleWidth?: number;
  fontFamily?: 'sans' | 'serif' | 'mono';
}
export const LAYOUT_NUMBER_LIMITS = Object.freeze({ bubbleRadius: [0, 40], messageSpacing: [0, 48], headerHeight: [36, 112], maxBubbleWidth: [120, 560] } as const);
const COLORS = ['headerBackground', 'incomingBackground', 'outgoingBackground', 'background', 'textColor'] as const;
const KEYS = new Set(['kind', 'name', 'avatarShape', 'showAvatars', 'fontFamily', ...COLORS, ...Object.keys(LAYOUT_NUMBER_LIMITS)]);
export function validateCustomLayout(raw: unknown): CustomLayout {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Layout must be an object.');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!KEYS.has(key)) throw new Error(`Unsupported layout field: ${key}.`);
  if (value.kind !== 'custom') throw new Error('Unsupported layout kind.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || /[\u0000-\u001f]/.test(value.name)) throw new Error('Layout name must contain 1–80 characters.');
  const layout: CustomLayout = { kind: 'custom', name: value.name.trim() };
  if (value.avatarShape !== undefined) {
    if (value.avatarShape !== 'circle' && value.avatarShape !== 'rounded' && value.avatarShape !== 'square') throw new Error('Unsupported avatar shape.');
    layout.avatarShape = value.avatarShape;
  }
  if (value.showAvatars !== undefined) { if (typeof value.showAvatars !== 'boolean') throw new Error('showAvatars must be boolean.'); layout.showAvatars = value.showAvatars; }
  if (value.fontFamily !== undefined) {
    if (value.fontFamily !== 'sans' && value.fontFamily !== 'serif' && value.fontFamily !== 'mono') throw new Error('Unsupported font family.');
    layout.fontFamily = value.fontFamily;
  }
  for (const key of COLORS) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value[key])) throw new Error(`${key} must be a six-digit hex color.`);
    layout[key] = value[key];
  }
  for (const key of Object.keys(LAYOUT_NUMBER_LIMITS) as (keyof typeof LAYOUT_NUMBER_LIMITS)[]) {
    const number = value[key]; if (number === undefined) continue;
    const [minimum, maximum] = LAYOUT_NUMBER_LIMITS[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${key} must be between ${minimum} and ${maximum}.`);
    layout[key] = number;
  }
  return layout;
}
