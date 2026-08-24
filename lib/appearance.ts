export type AccentColor = 'blue' | 'purple' | 'green' | 'orange' | 'pink';

export interface AppearanceSettings {
  /** 0-1 opacity applied to the popup's glass background. */
  glassOpacity: number;
  accentColor: AccentColor;
  reduceMotion: boolean;
  showBadgeCount: boolean;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  glassOpacity: 0.85,
  accentColor: 'blue',
  reduceMotion: false,
  showBadgeCount: true,
};

/** Light/dark system-color pairs, matching the existing --accent/--accent-strong token pattern. */
export const ACCENT_COLOR_VALUES: Record<AccentColor, { light: string; dark: string }> = {
  blue: { light: '#007aff', dark: '#0a84ff' },
  purple: { light: '#af52de', dark: '#bf5af2' },
  green: { light: '#34c759', dark: '#30d158' },
  orange: { light: '#ff9500', dark: '#ff9f0a' },
  pink: { light: '#ff2d55', dark: '#ff375f' },
};
