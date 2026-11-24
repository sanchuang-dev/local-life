import type { CSSProperties } from 'react'
import {
  ACTIVITY_THEME_KEYS,
  DEFAULT_ACTIVITY_THEME_KEY,
  type ActivityThemeKey,
  type ActivityVisualConfig,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Resident H5 projection of the activity visual config (LL-ACT-VIS-001 / #309).
 *
 * The functions here are deliberately pure and DOM-free so the theme map, the
 * artwork fallback order and the promo copy can be unit-tested with Node. The
 * real page only composes them; it never invents artwork or copy of its own.
 */

export type ActivityVisualSource =
  | (Pick<ActivityVisualConfig, 'themeKey' | 'heroImageUrl' | 'promoTitle' | 'promoSubtitle' | 'posterImageUrl'>)
  | null
  | undefined

/**
 * Limited semantic token set for the activity page and its sheets/poster.
 *
 * Business status colours (upcoming/active/paused/ended, error/warning) are NOT
 * part of this map: they stay semantic and are not dyed by the theme.
 */
export type ActivityThemeTokens = {
  /** Headings, links and outlined controls. */
  primary: string
  /** Strong primary; countdown blocks, poster QR foreground and key accents. */
  primaryStrong: string
  /** Page hero background. */
  background: string
  /** Top of the page body gradient. */
  backgroundSoft: string
  /** Bottom of the page body gradient. */
  backgroundDeep: string
  /** Card surface (promo band). */
  surface: string
  /** Light tinted surface for chips and poster shell. */
  surfaceMuted: string
  /** Theme-aware border colour. */
  border: string
  /** Primary text on the themed background. */
  text: string
  /** Secondary/meta text on the themed background. */
  textMuted: string
  /** Primary action button fill. */
  button: string
  /** Primary action button hover fill. */
  buttonStrong: string
  /** Text/icon colour on the primary button. */
  buttonText: string
  /** Foreground on `primaryStrong`. */
  onPrimary: string
  /** Countdown panel top colour (kept close to the pre-#309 gradient). */
  countdown: string
  /** Countdown panel middle colour. */
  countdownMid: string
}

/**
 * Four reviewed palettes. `community-green` reproduces the pre-#309 look; the
 * others visibly differ on the hero, countdown, primary actions and poster.
 */
export const ACTIVITY_THEME_TOKENS: Record<ActivityThemeKey, ActivityThemeTokens> = {
  'community-green': {
    primary: '#126c38',
    primaryStrong: '#154f2c',
    background: '#eaf5e9',
    backgroundSoft: '#edf8e9',
    backgroundDeep: '#d8eee5',
    surface: '#ffffff',
    surfaceMuted: '#eef7f2',
    border: '#deebdf',
    text: '#1f4d3c',
    textMuted: '#4a6f61',
    button: '#0f766e',
    buttonStrong: '#115e59',
    buttonText: '#ffffff',
    onPrimary: '#ffffff',
    countdown: '#d8f0cc',
    countdownMid: '#e1f3d8',
  },
  'festival-red': {
    primary: '#a52a20',
    primaryStrong: '#7c1d16',
    background: '#fbede8',
    backgroundSoft: '#fde3da',
    backgroundDeep: '#f6d9cf',
    surface: '#fffdfc',
    surfaceMuted: '#fbe9e4',
    border: '#efd1c6',
    text: '#571f18',
    textMuted: '#7b4a41',
    button: '#b02f24',
    buttonStrong: '#8d241b',
    buttonText: '#ffffff',
    onPrimary: '#ffffff',
    countdown: '#f6c9bd',
    countdownMid: '#f8d7cc',
  },
  'health-blue': {
    primary: '#1c5d9e',
    primaryStrong: '#154a7d',
    background: '#eaf3fb',
    backgroundSoft: '#e2eef9',
    backgroundDeep: '#d7e7f6',
    surface: '#fdfeff',
    surfaceMuted: '#e9f2fb',
    border: '#cfdfef',
    text: '#173a5c',
    textMuted: '#4a6a86',
    button: '#1d63aa',
    buttonStrong: '#174f89',
    buttonText: '#ffffff',
    onPrimary: '#ffffff',
    countdown: '#cfe2f5',
    countdownMid: '#d9e9f8',
  },
  'warm-gold': {
    primary: '#8f6514',
    primaryStrong: '#6f4c08',
    background: '#fdf5e4',
    backgroundSoft: '#fbedd2',
    backgroundDeep: '#f7e4bd',
    surface: '#fffefb',
    surfaceMuted: '#faf0da',
    border: '#ecd9ad',
    text: '#574010',
    textMuted: '#7a6434',
    button: '#8f6514',
    buttonStrong: '#7f590b',
    buttonText: '#ffffff',
    onPrimary: '#ffffff',
    countdown: '#f4dfae',
    countdownMid: '#f7e7c6',
  },
}

/**
 * Closed enum -> known theme. A missing or unknown key (for example a stored row
 * written before #309) silently maps to the historical green theme instead of
 * rendering an unstyled or broken page.
 */
export function resolveActivityThemeKey(themeKey: string | null | undefined): ActivityThemeKey {
  if (typeof themeKey === 'string' && (ACTIVITY_THEME_KEYS as readonly string[]).includes(themeKey)) {
    return themeKey as ActivityThemeKey
  }
  return DEFAULT_ACTIVITY_THEME_KEY
}

/**
 * Scoped CSS custom properties for the activity page root. They are applied as
 * an inline style on that one subtree, so the rest of the H5 keeps its tokens.
 */
export function activityThemeStyle(themeKey: string | null | undefined): CSSProperties {
  const tokens = ACTIVITY_THEME_TOKENS[resolveActivityThemeKey(themeKey)]
  return {
    '--activity-primary': tokens.primary,
    '--activity-primary-strong': tokens.primaryStrong,
    '--activity-bg': tokens.background,
    '--activity-bg-soft': tokens.backgroundSoft,
    '--activity-bg-deep': tokens.backgroundDeep,
    '--activity-surface': tokens.surface,
    '--activity-surface-muted': tokens.surfaceMuted,
    '--activity-border': tokens.border,
    '--activity-text': tokens.text,
    '--activity-text-muted': tokens.textMuted,
    '--activity-button': tokens.button,
    '--activity-button-strong': tokens.buttonStrong,
    '--activity-button-text': tokens.buttonText,
    '--activity-on-primary': tokens.onPrimary,
    '--activity-countdown': tokens.countdown,
    '--activity-countdown-mid': tokens.countdownMid,
  } as CSSProperties
}

/** Bundled legacy artwork; also the last fallback for hero and poster. */
export const ACTIVITY_FALLBACK_IMAGE_PATH = 'images/community-activity-artwork.webp'
const LEGACY_SILVER_IMAGE_PATH = 'images/silver-neighborhood-hero.webp'

// Narrow compatibility for the original named campaign, not every new activity.
export function isLegacySilverActivity(title?: string | null): boolean {
  return title?.trim() === '银发社区欢乐季'
}

const HTTP_IMAGE_URL_PATTERN = /^https?:\/\/[^\s]+$/iu
const MAX_IMAGE_URL_LENGTH = 2048

/**
 * The read contract is intentionally lenient (stored rows must stay readable),
 * so the H5 re-checks that an operator URL is an absolute http(s) URL before it
 * reaches `<img src>` or a WeChat `imgUrl`. Anything else falls back.
 */
export function normalizeActivityImageUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > MAX_IMAGE_URL_LENGTH) return null
  if (!HTTP_IMAGE_URL_PATTERN.test(trimmed)) return null
  return trimmed
}

export function activityFallbackImageUrl(baseUrl: string, activityTitle?: string | null): string {
  return `${baseUrl}${isLegacySilverActivity(activityTitle) ? LEGACY_SILVER_IMAGE_PATH : ACTIVITY_FALLBACK_IMAGE_PATH}`
}

/**
 * Hero artwork candidates in display order: the configured hero first, then the
 * bundled legacy image that the page used before #309.
 */
export function resolveActivityHeroImageCandidates(
  visualConfig: Pick<ActivityVisualConfig, 'heroImageUrl'> | null | undefined,
  baseUrl: string,
  activityTitle?: string | null,
): string[] {
  const configured = normalizeActivityImageUrl(visualConfig?.heroImageUrl)
  const fallback = activityFallbackImageUrl(baseUrl, activityTitle)
  return configured ? [configured, fallback] : [fallback]
}

/**
 * Single share poster candidates: poster -> hero -> legacy fallback. A failed
 * remote image simply advances to the next candidate in `ActivityImage`.
 */
export function resolveActivityPosterImageCandidates(
  visualConfig: ActivityVisualSource,
  baseUrl: string,
  activityTitle?: string | null,
): string[] {
  const candidates = [
    normalizeActivityImageUrl(visualConfig?.posterImageUrl),
    normalizeActivityImageUrl(visualConfig?.heroImageUrl),
    activityFallbackImageUrl(baseUrl, activityTitle),
  ].filter((value): value is string => Boolean(value))
  return [...new Set(candidates)]
}

/**
 * Artist URL used by the activity list thumbnail. `null` keeps the shared
 * ActivityArtwork placeholder.
 */
export function resolveActivityArtworkImageUrl(
  visualConfig: Pick<ActivityVisualConfig, 'heroImageUrl'> | null | undefined,
): string | null {
  return normalizeActivityImageUrl(visualConfig?.heroImageUrl)
}

export type ActivityPromoCopy = {
  title: string | null
  subtitle: string | null
}

export function resolveActivityPromoCopy(
  visualConfig: Pick<ActivityVisualConfig, 'promoTitle' | 'promoSubtitle'> | null | undefined,
): ActivityPromoCopy {
  const title = visualConfig?.promoTitle?.trim()
  const subtitle = visualConfig?.promoSubtitle?.trim()
  return { title: title || null, subtitle: subtitle || null }
}

export type ActivityPagePromo = {
  /** Whether the page renders the promo band at all. */
  visible: boolean
  /** Configured promo title, or the real activity title for a configured activity. */
  title: string | null
  /** Configured promo subtitle only; never a duplicated activity title. */
  subtitle: string | null
}

/**
 * Page promo band copy for the activity detail page.
 *
 * A new activity may configure only a hero image or a theme (P2 allows this), so
 * the resident page must still show the real activity title: the headline falls
 * back to `activity.title` whenever any visual is configured. Historical
 * activities with no visual config (default green, no hero/promo) keep the
 * pre-#309 page instead of stacking a second title over the bundled artwork,
 * which already carries its campaign title.
 */
export function resolveActivityPagePromo(
  activity:
    | {
        title: string
        visualConfig: Pick<
          ActivityVisualConfig,
          'themeKey' | 'heroImageUrl' | 'posterImageUrl' | 'promoTitle' | 'promoSubtitle'
        >
      }
    | null
    | undefined,
  /** Optional pre-parsed promo copy, so callers do not parse the config twice. */
  promo: ActivityPromoCopy = resolveActivityPromoCopy(activity?.visualConfig),
): ActivityPagePromo {
  if (!activity) return { visible: false, title: null, subtitle: null }

  const hasConfiguredVisual =
    promo.title !== null ||
    promo.subtitle !== null ||
    normalizeActivityImageUrl(activity.visualConfig.heroImageUrl) !== null ||
    normalizeActivityImageUrl(activity.visualConfig.posterImageUrl) !== null ||
    resolveActivityThemeKey(activity.visualConfig.themeKey) !== DEFAULT_ACTIVITY_THEME_KEY

  if (!hasConfiguredVisual && isLegacySilverActivity(activity.title)) return { visible: false, title: null, subtitle: null }

  return {
    visible: true,
    title: promo.title ?? activity.title,
    subtitle: promo.subtitle,
  }
}

export type ActivityPosterCopy = {
  /** Current activity headline: promo title, else the real activity title. */
  title: string
  /** Configured promo subtitle, else community/seats line. */
  subtitle: string
}

/**
 * Poster copy: the poster headline is always derived from *this* activity
 * (configured promo title, else the real activity title). The old fixed silver
 * slogan is deliberately not reused as a headline, so a non-silver activity can
 * never inherit another campaign's promotional title.
 */
export function resolveActivityPosterCopy(
  activity: {
    title: string
    community: { name: string }
    visualConfig: Pick<ActivityVisualConfig, 'promoTitle' | 'promoSubtitle'>
  },
  seatsFilled: number | null,
  seatsTotal: number | null,
): ActivityPosterCopy {
  const promo = resolveActivityPromoCopy(activity.visualConfig)
  return {
    title: promo.title ?? activity.title,
    subtitle:
      promo.subtitle ??
      `${activity.community.name} · 已有 ${seatsFilled ?? 0} / ${seatsTotal ?? 3} 位街坊`,
  }
}

/**
 * WeChat JS-SDK cover image: the public poster wins over the hero; otherwise the
 * same bundled asset as before. Remote values are already absolute http(s).
 */
export function resolveWechatShareImageUrl(
  visualConfig: Pick<ActivityVisualConfig, 'heroImageUrl' | 'posterImageUrl'> | null | undefined,
  origin: string,
  baseUrl: string,
  activityTitle?: string | null,
): string {
  const remote =
    normalizeActivityImageUrl(visualConfig?.posterImageUrl) ??
    normalizeActivityImageUrl(visualConfig?.heroImageUrl)
  if (remote) return remote
  return new URL(activityFallbackImageUrl(baseUrl, activityTitle), origin).href
}
