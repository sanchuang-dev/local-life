import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIVITY_THEME_KEYS,
  DEFAULT_ACTIVITY_THEME_KEY,
} from '@sanchuang-dev/local-life-contracts'
import {
  ACTIVITY_FALLBACK_IMAGE_PATH,
  ACTIVITY_THEME_TOKENS,
  activityThemeStyle,
  normalizeActivityImageUrl,
  resolveActivityArtworkImageUrl,
  resolveActivityHeroImageCandidates,
  resolveActivityPagePromo,
  resolveActivityPosterCopy,
  resolveActivityPosterImageCandidates,
  resolveActivityPromoCopy,
  resolveActivityThemeKey,
  resolveWechatShareImageUrl,
} from '../src/components/activity/activityVisual.ts'

const base = '/local-life/'
const fallback = `/local-life/${ACTIVITY_FALLBACK_IMAGE_PATH}`

test('four presets map to distinct scoped tokens; default green and unknown keys fall back', () => {
  assert.deepEqual(
    [...ACTIVITY_THEME_KEYS],
    ['community-green', 'festival-red', 'health-blue', 'warm-gold'],
  )
  assert.equal(DEFAULT_ACTIVITY_THEME_KEY, 'community-green')
  // Missing / unknown keys are the historical activity: same green page, not a blank one.
  assert.equal(resolveActivityThemeKey(undefined), 'community-green')
  assert.equal(resolveActivityThemeKey(null), 'community-green')
  assert.equal(resolveActivityThemeKey('not-a-theme'), 'community-green')
  assert.equal(resolveActivityThemeKey('festival-red'), 'festival-red')

  // The activity page consumes only these limited semantic CSS variables.
  const style = activityThemeStyle('health-blue')
  for (const variable of [
    '--activity-primary',
    '--activity-bg',
    '--activity-bg-soft',
    '--activity-surface',
    '--activity-border',
    '--activity-text',
    '--activity-button',
    '--activity-button-strong',
  ]) {
    assert.ok(style[variable], `${variable} must be defined`)
  }
  assert.equal(style['--activity-bg'], ACTIVITY_THEME_TOKENS['health-blue'].background)

  // Each preset is visibly different on the main surface + primary action.
  assert.equal(new Set(ACTIVITY_THEME_KEYS.map((key) => ACTIVITY_THEME_TOKENS[key].primary)).size, 4)
  assert.equal(new Set(ACTIVITY_THEME_KEYS.map((key) => ACTIVITY_THEME_TOKENS[key].background)).size, 4)
  assert.equal(new Set(ACTIVITY_THEME_KEYS.map((key) => ACTIVITY_THEME_TOKENS[key].button)).size, 4)

  // Default green reproduces the pre-#309 activity page tokens.
  assert.equal(ACTIVITY_THEME_TOKENS['community-green'].primary, '#126c38')
  assert.equal(ACTIVITY_THEME_TOKENS['community-green'].background, '#eaf5e9')
  assert.equal(ACTIVITY_THEME_TOKENS['community-green'].countdown, '#d8f0cc')
  assert.equal(ACTIVITY_THEME_TOKENS['community-green'].button, '#0f766e')

  // Business status colours are not part of the theme token map.
  const tokenKeys = Object.keys(ACTIVITY_THEME_TOKENS['community-green']).join(' ')
  assert.doesNotMatch(tokenKeys, /status|upcoming|active|paused|ended|error|warning/)
})

test('hero/poster artwork falls back poster -> hero -> bundled legacy image', () => {
  const configured = {
    themeKey: 'community-green',
    heroImageUrl: ' https://cdn.example.com/hero.jpg ',
    posterImageUrl: 'https://cdn.example.com/poster.jpg',
    promoTitle: null,
    promoSubtitle: null,
  }
  assert.deepEqual(resolveActivityPosterImageCandidates(configured, base), [
    'https://cdn.example.com/poster.jpg',
    'https://cdn.example.com/hero.jpg',
    fallback,
  ])
  assert.deepEqual(
    resolveActivityPosterImageCandidates({ ...configured, posterImageUrl: null }, base),
    ['https://cdn.example.com/hero.jpg', fallback],
  )
  assert.deepEqual(resolveActivityPosterImageCandidates(null, base), [fallback])
  // A missing visual config means the historical silver campaign keeps its artwork.
  assert.deepEqual(resolveActivityHeroImageCandidates(undefined, base), [fallback])
  assert.deepEqual(resolveActivityHeroImageCandidates(configured, base), [
    'https://cdn.example.com/hero.jpg',
    fallback,
  ])
})

test('unsafe or non-absolute artwork URLs never reach an image source', () => {
  const badValues = [
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '/images/local.webp',
    'ftp://example.com/a.png',
    '   ',
    `https://cdn.example.com/${'a'.repeat(2100)}`,
  ]
  for (const bad of badValues) {
    assert.equal(normalizeActivityImageUrl(bad), null, `${bad} must be rejected`)
    assert.deepEqual(
      resolveActivityPosterImageCandidates(
        { heroImageUrl: bad, posterImageUrl: bad },
        base,
      ),
      [fallback],
    )
  }
  assert.equal(
    normalizeActivityImageUrl('http://cdn.example.com/a.png'),
    'http://cdn.example.com/a.png',
  )
  // Activity list thumbnails reuse the same projection and fallback.
  assert.equal(
    resolveActivityArtworkImageUrl({ heroImageUrl: 'https://cdn.example.com/hero.jpg' }),
    'https://cdn.example.com/hero.jpg',
  )
  assert.equal(resolveActivityArtworkImageUrl(null), null)
  assert.equal(resolveActivityArtworkImageUrl({ heroImageUrl: 'data:image/png;base64,AA' }), null)
})

test('page promo band always shows a real title for a configured activity', () => {
  const baseConfig = {
    themeKey: 'community-green',
    heroImageUrl: null,
    posterImageUrl: null,
    promoTitle: null,
    promoSubtitle: null,
  }
  const activity = {
    title: '社区健康筛查',
    visualConfig: baseConfig,
  }

  // F1: hero configured, promoTitle empty -> the real activity title is visible.
  assert.deepEqual(
    resolveActivityPagePromo({
      ...activity,
      visualConfig: { ...baseConfig, heroImageUrl: 'https://cdn.example.com/hero.jpg' },
    }),
    { visible: true, title: '社区健康筛查', subtitle: null },
  )

  // F1: only promoSubtitle -> headline falls back to the activity title.
  assert.deepEqual(
    resolveActivityPagePromo({
      ...activity,
      visualConfig: { ...baseConfig, promoSubtitle: '本周六上午，先到先得' },
    }),
    { visible: true, title: '社区健康筛查', subtitle: '本周六上午，先到先得' },
  )

  // Theme-only configuration is still a configured activity.
  assert.deepEqual(
    resolveActivityPagePromo({
      ...activity,
      visualConfig: { ...baseConfig, themeKey: 'health-blue' },
    }),
    { visible: true, title: '社区健康筛查', subtitle: null },
  )

  // A poster-only configuration is also a new campaign, so its title is visible.
  assert.deepEqual(
    resolveActivityPagePromo({
      ...activity,
      visualConfig: { ...baseConfig, posterImageUrl: 'https://cdn.example.com/poster.jpg' },
    }),
    { visible: true, title: '社区健康筛查', subtitle: null },
  )

  // Configured promo title wins over the activity title.
  assert.deepEqual(
    resolveActivityPagePromo({
      ...activity,
      visualConfig: { ...baseConfig, promoTitle: '健康筛查进社区' },
    }),
    { visible: true, title: '健康筛查进社区', subtitle: null },
  )

  // New default activities always show their real title; only the original campaign keeps its embedded title.
  assert.deepEqual(resolveActivityPagePromo(activity), { visible: true, title: activity.title, subtitle: null })
  assert.deepEqual(resolveActivityHeroImageCandidates(null, base, '银发社区欢乐季'), [`${base}images/silver-neighborhood-hero.webp`])
  assert.deepEqual(resolveActivityHeroImageCandidates(null, base, '社区健康筛查'), [fallback])
  assert.deepEqual(resolveActivityPagePromo({ ...activity, title: '银发社区欢乐季' }), {
    visible: false,
    title: null,
    subtitle: null,
  })
  assert.deepEqual(resolveActivityPagePromo(null), {
    visible: false,
    title: null,
    subtitle: null,
  })
})

test('poster headline is this activity title, never the old template slogan', () => {
  assert.deepEqual(resolveActivityPromoCopy(null), { title: null, subtitle: null })
  assert.deepEqual(
    resolveActivityPromoCopy({ promoTitle: '  ', promoSubtitle: ' 周末见 ' }),
    { title: null, subtitle: '周末见' },
  )

  const legacy = {
    title: '银发社区欢乐季',
    community: { name: '幸福社区' },
    visualConfig: { promoTitle: null, promoSubtitle: null },
  }
  // F2: the poster headline is the current activity title, not the old template slogan.
  assert.deepEqual(resolveActivityPosterCopy(legacy, 1, 3), {
    title: '银发社区欢乐季',
    subtitle: '幸福社区 · 已有 1 / 3 位街坊',
  })
  assert.notEqual(resolveActivityPosterCopy(legacy, 1, 3).title, '还差你，三人成团领好礼')

  // A brand-new activity without promo copy behaves the same way (no stale campaign title).
  const newActivity = {
    title: '社区健康筛查',
    community: { name: '幸福社区' },
    visualConfig: { promoTitle: null, promoSubtitle: null },
  }
  assert.deepEqual(resolveActivityPosterCopy(newActivity, 0, 3), {
    title: '社区健康筛查',
    subtitle: '幸福社区 · 已有 0 / 3 位街坊',
  })

  // Only a promo subtitle: headline stays the real activity title.
  assert.deepEqual(
    resolveActivityPosterCopy(
      { ...newActivity, visualConfig: { promoTitle: null, promoSubtitle: '本周六上午' } },
      2,
      3,
    ),
    {
      title: '社区健康筛查',
      subtitle: '本周六上午',
    },
  )

  const configured = {
    ...legacy,
    visualConfig: { promoTitle: '健康筛查进社区', promoSubtitle: '本周六上午，先到先得' },
  }
  assert.deepEqual(resolveActivityPosterCopy(configured, 0, 3), {
    title: '健康筛查进社区',
    subtitle: '本周六上午，先到先得',
  })
})

test('every theme button/buttonText pair meets WCAG AA contrast (>= 4.5)', () => {
  const channel = (value) => {
    const normalized = value / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const luminance = (hex) => {
    const match = /^#([0-9a-f]{6})$/i.exec(hex)
    assert.ok(match, `${hex} must be a 6-digit hex colour`)
    const value = Number.parseInt(match[1], 16)
    return (
      0.2126 * channel((value >> 16) & 0xff) +
      0.7152 * channel((value >> 8) & 0xff) +
      0.0722 * channel(value & 0xff)
    )
  }
  const contrast = (foreground, background) => {
    const lighter = Math.max(luminance(foreground), luminance(background))
    const darker = Math.min(luminance(foreground), luminance(background))
    return (lighter + 0.05) / (darker + 0.05)
  }

  // F3 regression: the previous warm-gold #a27112 on white was 4.28:1.
  assert.ok(contrast('#ffffff', '#a27112') < 4.5)
  assert.equal(ACTIVITY_THEME_TOKENS['warm-gold'].button, '#8f6514')

  for (const themeKey of ACTIVITY_THEME_KEYS) {
    const tokens = ACTIVITY_THEME_TOKENS[themeKey]
    const ratio = contrast(tokens.buttonText, tokens.button)
    assert.ok(
      ratio >= 4.5,
      `${themeKey} primary button contrast ${ratio.toFixed(2)} must be >= 4.5`,
    )
  }
})

test('WeChat cover prefers poster, then hero, then the bundled legacy image', () => {
  const origin = 'https://sanchuang-dev.github.io'
  assert.equal(
    resolveWechatShareImageUrl(
      {
        posterImageUrl: 'https://cdn.example.com/poster.jpg',
        heroImageUrl: 'https://cdn.example.com/hero.jpg',
      },
      origin,
      '/local-life/',
    ),
    'https://cdn.example.com/poster.jpg',
  )
  assert.equal(
    resolveWechatShareImageUrl(
      { posterImageUrl: null, heroImageUrl: 'https://cdn.example.com/hero.jpg' },
      origin,
      '/local-life/',
    ),
    'https://cdn.example.com/hero.jpg',
  )
  assert.equal(
    resolveWechatShareImageUrl(null, origin, '/local-life/'),
    'https://sanchuang-dev.github.io/local-life/images/community-activity-artwork.webp',
  )
})
