/**
 * Contract self-check for the activity visual configuration (#309 LL-ACT-VIS-001).
 *
 * These are the guardrails shared by the admin editor, the API and the resident
 * H5, so the negative cases matter more than the happy path:
 * - the theme vocabulary is exactly the four reviewed presets;
 * - promo/artwork URLs cannot smuggle `javascript:` or `data:` into `<img src>`
 *   or the WeChat JS-SDK metadata;
 * - `undefined` (omit -> keep) and explicit `null`/blank (clear) stay distinct;
 * - the public read shape only exposes the five presentation fields.
 *
 * Run from the repo root (the `test` script builds `dist` first):
 *   pnpm --filter @sanchuang-dev/local-life-contracts test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ACTIVITY_PROMO_SUBTITLE_MAX_LENGTH,
  ACTIVITY_PROMO_TITLE_MAX_LENGTH,
  ACTIVITY_THEME_KEYS,
  ACTIVITY_VISUAL_IMAGE_URL_MAX_LENGTH,
  DEFAULT_ACTIVITY_THEME_KEY,
  activityVisualConfigInputSchema,
  activityVisualConfigSchema,
  createActivityRequestSchema,
  publicActivityDetailSchema,
  updateActivityRequestSchema,
} from '@sanchuang-dev/local-life-contracts'

const PUBLIC_RULES = {
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
  notes: '活动最终解释权归社区所有',
}

const baseCreate = {
  communityId: '00000000-0000-4000-8000-000000000001',
  title: '银发社区欢乐季',
  summary: '秋季社区敬老活动',
  description: '面向本社区 60 岁以上居民的线下活动',
  keyRules: {
    startsAt: '2026-12-01T02:00:00.000Z',
    endsAt: '2026-12-01T10:00:00.000Z',
    location: '幸福社区党群服务中心',
    budgetCapCents: 100_000,
    prizeQuantityCap: 100,
    publicRules: PUBLIC_RULES,
  },
}

const visualConfig = {
  themeKey: 'festival-red',
  heroImageUrl: 'https://cdn.example.com/activity/hero.webp',
  promoTitle: '重阳敬老周',
  promoSubtitle: '三人成团，现场有礼',
  posterImageUrl: 'https://cdn.example.com/activity/poster.webp',
}

const parseCreate = (overrides = {}) =>
  createActivityRequestSchema.parse({ ...baseCreate, ...overrides })

describe('activity visual config contract', () => {
  it('exposes exactly four theme presets and a historical green default', () => {
    assert.deepEqual(ACTIVITY_THEME_KEYS, [
      'community-green',
      'festival-red',
      'health-blue',
      'warm-gold',
    ])
    assert.equal(DEFAULT_ACTIVITY_THEME_KEY, 'community-green')
  })

  it('accepts a complete visual configuration on create', () => {
    const parsed = parseCreate({ visualConfig })
    assert.deepEqual(parsed.visualConfig, visualConfig)
  })

  it('leaves the visual configuration unset when a legacy client omits it', () => {
    assert.equal(parseCreate().visualConfig, undefined)
    assert.equal(parseCreate({ visualConfig: null }).visualConfig, null)
  })

  it('rejects unknown themes', () => {
    assert.equal(
      createActivityRequestSchema.safeParse({
        ...baseCreate,
        visualConfig: { themeKey: 'neon-pink' },
      }).success,
      false,
    )
  })

  it('rejects non-http(s) artwork URLs including javascript: and data:', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:image/svg+xml,<svg/onload=alert(1)>',
      '//cdn.example.com/hero.webp',
      '/relative/hero.webp',
      'ftp://cdn.example.com/hero.webp',
      'https://',
      'https:///missing-host',
      ' https://cdn.example.com/hero.webp '.trim() + ' extra',
    ]) {
      for (const field of ['heroImageUrl', 'posterImageUrl']) {
        const result = createActivityRequestSchema.safeParse({
          ...baseCreate,
          visualConfig: { [field]: bad },
        })
        assert.equal(
          result.success,
          false,
          `${field}=${JSON.stringify(bad)} must be rejected`,
        )
      }
    }
  })

  it('accepts http and https URLs up to the shared length bound', () => {
    for (const good of [
      'https://cdn.example.com/hero.webp',
      'http://localhost:5173/images/hero.png',
      'https://cdn.example.com/a/b?x=1#frag',
    ]) {
      assert.equal(
        createActivityRequestSchema.safeParse({
          ...baseCreate,
          visualConfig: { heroImageUrl: good },
        }).success,
        true,
      )
    }

    const tooLong = `https://cdn.example.com/${'a'.repeat(ACTIVITY_VISUAL_IMAGE_URL_MAX_LENGTH)}.webp`
    assert.ok(tooLong.length > ACTIVITY_VISUAL_IMAGE_URL_MAX_LENGTH)
    assert.equal(
      createActivityRequestSchema.safeParse({
        ...baseCreate,
        visualConfig: { posterImageUrl: tooLong },
      }).success,
      false,
    )
  })

  it('enforces the promo copy bounds', () => {
    assert.equal(
      createActivityRequestSchema.safeParse({
        ...baseCreate,
        visualConfig: {
          promoTitle: 'a'.repeat(ACTIVITY_PROMO_TITLE_MAX_LENGTH + 1),
        },
      }).success,
      false,
    )
    assert.equal(
      createActivityRequestSchema.safeParse({
        ...baseCreate,
        visualConfig: {
          promoSubtitle: 'a'.repeat(ACTIVITY_PROMO_SUBTITLE_MAX_LENGTH + 1),
        },
      }).success,
      false,
    )
    assert.equal(
      createActivityRequestSchema.safeParse({
        ...baseCreate,
        visualConfig: { promoTitle: 'a'.repeat(ACTIVITY_PROMO_TITLE_MAX_LENGTH) },
      }).success,
      true,
    )
  })

  it('maps blank strings to explicit clears and trims text', () => {
    const parsed = activityVisualConfigInputSchema.parse({
      heroImageUrl: '   ',
      posterImageUrl: '',
      promoTitle: '  重阳敬老周  ',
      promoSubtitle: '   ',
    })
    assert.equal(parsed.heroImageUrl, null)
    assert.equal(parsed.posterImageUrl, null)
    assert.equal(parsed.promoTitle, '重阳敬老周')
    assert.equal(parsed.promoSubtitle, null)
  })

  it('keeps omitted and explicit null distinct on update', () => {
    assert.equal(
      updateActivityRequestSchema.parse({
        expectedUpdatedAt: '2026-11-24T00:00:00.000Z',
        title: '只改标题',
      }).visualConfig,
      undefined,
    )
    assert.equal(
      updateActivityRequestSchema.parse({
        expectedUpdatedAt: '2026-11-24T00:00:00.000Z',
        visualConfig: null,
      }).visualConfig,
      null,
    )
    assert.deepEqual(
      updateActivityRequestSchema.parse({
        expectedUpdatedAt: '2026-11-24T00:00:00.000Z',
        visualConfig: { heroImageUrl: null, themeKey: 'health-blue' },
      }).visualConfig,
      { heroImageUrl: null, themeKey: 'health-blue' },
    )
  })

  it('rejects an update with no fields or an empty visualConfig object', () => {
    assert.equal(
      updateActivityRequestSchema.safeParse({
        expectedUpdatedAt: '2026-11-24T00:00:00.000Z',
      }).success,
      false,
    )
    assert.equal(
      updateActivityRequestSchema.safeParse({
        expectedUpdatedAt: '2026-11-24T00:00:00.000Z',
        visualConfig: {},
      }).success,
      false,
    )
  })

  it('publishes only the five visual fields and strips unknown keys', () => {
    const parsed = activityVisualConfigSchema.parse({
      ...visualConfig,
      internalNote: 'must not leak',
      createdByUserId: '00000000-0000-4000-8000-000000000009',
    })
    assert.deepEqual(Object.keys(parsed).sort(), [
      'heroImageUrl',
      'posterImageUrl',
      'promoSubtitle',
      'promoTitle',
      'themeKey',
    ])
    assert.equal('internalNote' in parsed, false)
    assert.equal('createdByUserId' in parsed, false)
  })

  it('keeps the public detail schema tolerant of stored legacy values', () => {
    const parsed = publicActivityDetailSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      title: '历史银发活动',
      summary: null,
      community: { id: '00000000-0000-4000-8000-000000000002', name: '幸福社区' },
      location: '幸福社区党群服务中心',
      startsAt: '2026-12-01T02:00:00.000Z',
      endsAt: '2026-12-01T10:00:00.000Z',
      status: 'published',
      ruleVersion: 1,
      updatedAt: '2026-11-24T00:00:00.000Z',
      description: null,
      publicRules: PUBLIC_RULES,
      purchaseReward: null,
      publishedAt: '2026-11-24T00:00:00.000Z',
      visualConfig: {
        themeKey: 'community-green',
        heroImageUrl: null,
        promoTitle: null,
        promoSubtitle: null,
        posterImageUrl: null,
      },
    })
    assert.deepEqual(parsed.visualConfig, {
      themeKey: 'community-green',
      heroImageUrl: null,
      promoTitle: null,
      promoSubtitle: null,
      posterImageUrl: null,
    })
  })
})
