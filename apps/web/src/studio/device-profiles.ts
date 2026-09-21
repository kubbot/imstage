/**
 * Framework-free device profile registry.
 *
 * A profile pairs a logical (CSS) viewport with the device pixel ratio used to
 * capture it. The native panel resolution is `width * pixelRatio` by
 * `height * pixelRatio`, but the renderer itself never hard-codes those pixels:
 * the surrounding preview/export frame owns the actual size. `deviceProfile`
 * is a pure resolver so the editor, the renderer and the tests agree on the
 * same preset without importing any UI framework.
 *
 * Official hardware references used for the two phone presets:
 * - iPhone 15 Pro: 1179 × 2556 native pixels (Apple, support.apple.com/111829)
 *   → 393 × 852 logical points at 3x, the value this project renders and
 *   captures. This is a project-chosen logical scale, not an app-version claim.
 * - Pixel 8: 1080 × 2400 native pixels (Google, support.google.com/pixelphone/answer/7158570)
 *   → 360 × 800 logical dp at 3x.
 *
 * `macos-window` is a *configurable desktop window preset*, not a hardware
 * screen claim. These presets are project-maintained references and do not
 * assert that any official app version is pixel-perfect verified.
 */

export type DeviceSurface = 'ios' | 'android' | 'desktop';

export interface DeviceProfile {
  id: string;
  label: string;
  surface: DeviceSurface;
  width: number;
  height: number;
  pixelRatio: number;
}

/** Minimal shape `deviceProfile` needs; avoids a runtime dependency on the scene model. */
export interface DeviceProfileSceneLike {
  surface?: string;
  deviceProfileId?: string;
}

const LEGACY_IOS: DeviceProfile = {
  id: 'legacy360',
  label: '通用手机 360×640',
  surface: 'ios',
  width: 360,
  height: 640,
  pixelRatio: 2,
};

const IPHONE_15_PRO: DeviceProfile = {
  id: 'iphone-15-pro',
  label: 'iPhone 15 Pro',
  surface: 'ios',
  width: 393,
  height: 852,
  pixelRatio: 3,
};

// Apple: https://support.apple.com/125090 — 1206 × 2622 native pixels.
const IPHONE_17_PRO: DeviceProfile = {
  id: 'iphone-17-pro', label: 'iPhone 17 Pro', surface: 'ios',
  width: 402, height: 874, pixelRatio: 3,
};

const PIXEL_8: DeviceProfile = {
  id: 'pixel-8',
  label: 'Pixel 8',
  surface: 'android',
  width: 360,
  height: 800,
  pixelRatio: 3,
};

const MACOS_WINDOW: DeviceProfile = {
  id: 'macos-window',
  label: 'macOS 桌面窗口',
  surface: 'desktop',
  width: 1000,
  height: 720,
  pixelRatio: 2,
};

/**
 * Selectable presets. `deviceProfile` may also return one of the two legacy
 * fallbacks below when a scene has no explicit id; those fallbacks are
 * deliberately not part of this array so the UI cannot offer them as new
 * choices.
 */
export const DEVICE_PROFILES: readonly DeviceProfile[] = [
  LEGACY_IOS,
  IPHONE_17_PRO,
  IPHONE_15_PRO,
  PIXEL_8,
  MACOS_WINDOW,
];

export const DEVICE_PROFILE_IDS: readonly string[] = DEVICE_PROFILES.map((profile) => profile.id);

const BY_ID = new Map(DEVICE_PROFILES.map((profile) => [profile.id, profile]));

/** Android compatibility fallback for a scene that has no explicit id. */
const LEGACY_ANDROID: DeviceProfile = {
  id: 'legacy-android',
  label: 'Android 兼容 360×640',
  surface: 'android',
  width: 360,
  height: 640,
  pixelRatio: 2,
};

/** Desktop compatibility fallback for a scene that has no explicit id. */
const LEGACY_DESKTOP: DeviceProfile = {
  id: 'legacy-desktop',
  label: '桌面兼容 900×640',
  surface: 'desktop',
  width: 900,
  height: 640,
  pixelRatio: 2,
};

/** The renderer treats anything that is not android/desktop as iOS. */
export function normaliseSurface(surface: string | undefined): DeviceSurface {
  return surface === 'android' || surface === 'desktop' ? surface : 'ios';
}

export function findDeviceProfile(id: string | undefined): DeviceProfile | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Legacy preset used when a scene has no explicit matching profile. */
export function legacyProfile(surface: string | undefined): DeviceProfile {
  switch (normaliseSurface(surface)) {
    case 'android':
      return LEGACY_ANDROID;
    case 'desktop':
      return LEGACY_DESKTOP;
    default:
      return LEGACY_IOS;
  }
}

/**
 * Resolve the profile for a scene. An explicit, surface-matching id wins;
 * otherwise fall back to the legacy preset for the scene surface. Pure and
 * total: it never throws and never returns undefined.
 */
export function deviceProfile(scene: DeviceProfileSceneLike): DeviceProfile {
  const surface = normaliseSurface(scene.surface);
  const explicit = findDeviceProfile(scene.deviceProfileId);
  if (explicit && explicit.surface === surface) return explicit;
  return legacyProfile(surface);
}

/**
 * Validation helper for explicit ids: returns a human-readable error when the
 * id is unknown or its surface does not match the scene surface, otherwise
 * `undefined`. Used by `validateScene` so invalid ids are rejected instead of
 * silently falling back at render time.
 */
export function deviceProfileError(id: string, surface: string | undefined): string | undefined {
  const profile = findDeviceProfile(id);
  const resolved = normaliseSurface(surface);
  if (!profile) return `未知设备配置：${id}`;
  if (profile.surface !== resolved) {
    return `设备配置 ${id} 属于 ${profile.surface}，与场景平台 ${resolved} 不匹配`;
  }
  return undefined;
}
