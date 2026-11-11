/**
 * Contract self-check for the administrator user directory (LL-USER-001 / #153).
 *
 * Why this file exists: `userDirectoryResponseSchema` / `userDirectoryDetailSchema`
 * are produced by the API and parsed verbatim by apps/admin. A field-level drift
 * between the contract, the API response and the admin page only fails at runtime
 * inside `schema.parse` (i.e. when an admin opens the page), so the shape is
 * asserted here instead of trusted.
 *
 * It also pins the security boundary of this DTO: the detail contract must not
 * grow an OpenID, plaintext phone, token, session, password hash or login-history
 * field. A future "convenience" column would otherwise leak into the admin UI.
 *
 * Run from the repo root (the `test` script builds `dist` first):
 *   pnpm --filter @sanchuang-dev/local-life-contracts test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  USER_DIRECTORY_FALLBACK_DISPLAY_NAME,
  USER_DIRECTORY_ROUTES,
  userDirectoryDetailPath,
  userDirectoryDetailSchema,
  userDirectoryEntrySchema,
  userDirectoryQuerySchema,
  userDirectoryResponseSchema,
} from '@sanchuang-dev/local-life-contracts'

const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const at = '2026-10-01T00:00:00.000Z'
const communityA = uuid(9001)
const communityB = uuid(9002)

/** Keys declared by a zod schema, including nested objects/arrays/nullables. */
function schemaKeys(schema, keys = new Set()) {
  const def = schema?.def
  if (!def) return keys
  switch (def.type) {
    case 'object':
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        keys.add(key)
        schemaKeys(child, keys)
      }
      break
    case 'array':
      schemaKeys(def.element, keys)
      break
    case 'nullable':
    case 'optional':
    case 'default':
    case 'prefault':
      schemaKeys(def.innerType, keys)
      break
    case 'union':
      for (const option of def.options ?? []) schemaKeys(option, keys)
      break
    default:
      break
  }
  return keys
}

const unassignedEntry = {
  id: uuid(1),
  displayName: '微信花花',
  localDisplayName: null,
  wechatNickname: '微信花花',
  wechatAvatarUrl: 'https://thirdwx.qlogo.cn/avatar.png',
  wechatProfileAuthorizedAt: at,
  identityMethods: ['wechat'],
  staffRole: null,
  residentCommunities: [],
  createdAt: at,
}

const staffEntry = {
  id: uuid(2),
  displayName: '片区运营',
  localDisplayName: '片区运营',
  wechatNickname: null,
  wechatAvatarUrl: null,
  wechatProfileAuthorizedAt: null,
  identityMethods: ['phone', 'staff'],
  staffRole: 'operator',
  residentCommunities: [{ id: communityA, name: 'A 社区', joinedAt: at }],
  createdAt: at,
}

const staffDetail = {
  ...staffEntry,
  wechatLinkedIdentityCount: 0,
  maskedPhone: '138****8000',
  staffAccount: {
    username: 'operator-a',
    status: 'active',
    communities: [{ id: communityB, name: 'B 社区' }],
  },
}

describe('user directory routes', () => {
  it('defines the back-office routes and builds a concrete detail path', () => {
    assert.equal(USER_DIRECTORY_ROUTES.list, '/admin/users')
    assert.equal(USER_DIRECTORY_ROUTES.detail, '/admin/users/:userId')
    assert.equal(userDirectoryDetailPath(uuid(1)), `/admin/users/${uuid(1)}`)
  })

  it('exposes one shared display fallback', () => {
    assert.equal(USER_DIRECTORY_FALLBACK_DISPLAY_NAME, '未命名用户')
  })
})

describe('userDirectoryQuerySchema', () => {
  it('defaults to server-side page 1 / size 20', () => {
    assert.deepEqual(userDirectoryQuerySchema.parse({}), { page: 1, pageSize: 20 })
  })

  it('coerces page numbers and trims the keyword', () => {
    assert.deepEqual(
      userDirectoryQuerySchema.parse({
        page: '2',
        pageSize: '50',
        keyword: '  花花  ',
        role: 'resident',
        community: 'unassigned',
      }),
      {
        page: 2,
        pageSize: 50,
        keyword: '花花',
        role: 'resident',
        community: 'unassigned',
      },
    )
  })

  it('accepts a community UUID and every supported role filter', () => {
    for (const role of ['admin', 'operator', 'grid_worker', 'resident']) {
      assert.equal(userDirectoryQuerySchema.parse({ role }).role, role)
    }
    assert.equal(
      userDirectoryQuerySchema.parse({ community: communityA }).community,
      communityA,
    )
  })

  it('rejects unbounded or contradictory filters', () => {
    const invalid = [
      { page: '0' },
      { page: '10001' },
      { pageSize: '0' },
      { pageSize: '101' },
      { keyword: 'x'.repeat(81) },
      { role: 'superadmin' },
      { community: 'none' },
      { community: 'Unassigned' },
      { unknown: '1' },
    ]
    for (const value of invalid) {
      assert.equal(userDirectoryQuerySchema.safeParse(value).success, false, JSON.stringify(value))
    }
  })
})

describe('userDirectoryEntrySchema / response', () => {
  it('accepts an account with zero communities (未关联社区) without hiding it', () => {
    const parsed = userDirectoryEntrySchema.parse(unassignedEntry)
    assert.deepEqual(parsed.residentCommunities, [])
    assert.deepEqual(parsed.identityMethods, ['wechat'])
  })

  it('accepts a staff account and its separate resident membership', () => {
    const parsed = userDirectoryEntrySchema.parse(staffEntry)
    assert.equal(parsed.staffRole, 'operator')
    assert.deepEqual(parsed.residentCommunities.map((x) => x.id), [communityA])
  })

  it('keeps WeChat nickname/avatar behind a recorded consent timestamp', () => {
    assert.equal(
      userDirectoryEntrySchema.safeParse({
        ...unassignedEntry,
        wechatProfileAuthorizedAt: null,
      }).success,
      false,
    )
    assert.equal(
      userDirectoryEntrySchema.safeParse({
        ...unassignedEntry,
        identityMethods: ['wechat', 'wechat'],
      }).success,
      false,
    )
    assert.equal(
      userDirectoryEntrySchema.safeParse({ ...unassignedEntry, staffRole: 'admin' }).success,
      false,
    )
  })

  it('can still represent a legacy account with no persistent identity row', () => {
    // Dev login (#AUTH_DEV_ENABLED) can create a `users` row with no WeChat,
    // phone or staff identity. The directory must list it, not 500 or hide it.
    const parsed = userDirectoryEntrySchema.parse({
      ...unassignedEntry,
      displayName: '开发登录用户',
      localDisplayName: '开发登录用户',
      wechatNickname: null,
      wechatAvatarUrl: null,
      wechatProfileAuthorizedAt: null,
      identityMethods: [],
    })
    assert.deepEqual(parsed.identityMethods, [])
  })

  it('rejects unknown fields so a leaked column cannot travel through a DTO', () => {
    for (const extra of [{ openId: 'o-1' }, { phone: '13800138000' }, { passwordHash: 'x' }]) {
      assert.equal(
        userDirectoryEntrySchema.safeParse({ ...unassignedEntry, ...extra }).success,
        false,
        JSON.stringify(extra),
      )
    }
  })

  it('validates the true total/page/pageSize shape', () => {
    const response = { items: [unassignedEntry], total: 137, page: 1, pageSize: 20 }
    assert.equal(userDirectoryResponseSchema.parse(response).total, 137)
    for (const broken of [
      { ...response, total: -1 },
      { ...response, total: 1.5 },
      { ...response, page: 0 },
      { ...response, pageSize: 0 },
      { ...response, extra: true },
    ]) {
      assert.equal(userDirectoryResponseSchema.safeParse(broken).success, false)
    }
  })
})

describe('resident community relation (#171)', () => {
  const confirmedAt = '2026-11-11T04:00:00.000Z'
  const confirmedEntry = {
    ...staffEntry,
    confirmedCommunity: {
      id: communityA,
      name: 'A 社区',
      confirmedAt,
      source: 'resident_h5_confirmed',
    },
    communityRelationSource: 'confirmed_binding',
    residentCommunityState: 'confirmed',
  }

  it('keeps 已确认常驻社区 and 历史未确认归属 as independent fields', () => {
    // History only: the confirmed field stays empty, history stays populated.
    const historyOnly = userDirectoryEntrySchema.parse({
      ...staffEntry,
      confirmedCommunity: null,
      communityRelationSource: 'historical_assignment',
      residentCommunityState: 'unbound',
    })
    assert.equal(historyOnly.confirmedCommunity, null)
    assert.deepEqual(historyOnly.residentCommunities.map((x) => x.id), [communityA])

    // Confirmation only: the confirmed field is populated, history is empty.
    const confirmedOnly = userDirectoryEntrySchema.parse({
      ...staffEntry,
      residentCommunities: [],
      confirmedCommunity: {
        id: communityB,
        name: 'B 社区',
        confirmedAt,
        source: 'resident_h5_confirmed',
      },
      communityRelationSource: 'confirmed_binding',
      residentCommunityState: 'confirmed',
    })
    assert.equal(confirmedOnly.confirmedCommunity.id, communityB)
    assert.deepEqual(confirmedOnly.residentCommunities, [])

    // Both at once: each field reports its own fact, never a merged one.
    const both = userDirectoryEntrySchema.parse(confirmedEntry)
    assert.equal(both.confirmedCommunity.id, communityA)
    assert.equal(both.confirmedCommunity.source, 'resident_h5_confirmed')
    assert.equal(both.confirmedCommunity.confirmedAt, confirmedAt)
    assert.deepEqual(both.residentCommunities.map((x) => x.id), [communityA])

    // Both, but the two facts disagree: still two separate fields.
    const disagree = userDirectoryEntrySchema.parse({
      ...confirmedEntry,
      residentCommunities: [{ id: communityB, name: 'B 社区', joinedAt: confirmedAt }],
      residentCommunityState: 'conflict',
    })
    assert.equal(disagree.confirmedCommunity.id, communityA)
    assert.deepEqual(disagree.residentCommunities.map((x) => x.id), [communityB])
  })

  it('refuses to fabricate a confirmation from history or to hide one behind it', () => {
    const invalid = [
      // A confirmation flag must carry the confirmation itself.
      { ...staffEntry, communityRelationSource: 'confirmed_binding' },
      // History must not be promoted into the confirmed field.
      { ...staffEntry, communityRelationSource: 'historical_assignment', confirmedCommunity: confirmedEntry.confirmedCommunity },
      // "no relation" must not coexist with a historical relation.
      { ...staffEntry, communityRelationSource: 'none' },
      // A withheld (out-of-scope) confirmation must not leak its community.
      { ...staffEntry, communityRelationSource: 'out_of_scope', confirmedCommunity: confirmedEntry.confirmedCommunity },
      // `source` is an enum, not free text.
      { ...confirmedEntry, confirmedCommunity: { ...confirmedEntry.confirmedCommunity, source: 'client_supplied' } },
    ]
    for (const value of invalid) {
      assert.equal(userDirectoryEntrySchema.safeParse(value).success, false, JSON.stringify(value))
    }
    // `none` is fine once history is genuinely empty.
    assert.equal(
      userDirectoryEntrySchema.safeParse({
        ...unassignedEntry,
        residentCommunities: [],
        confirmedCommunity: null,
        communityRelationSource: 'none',
      }).success,
      true,
    )
  })

  it('accepts every resident-facing state and an omitted (not derivable) one', () => {
    for (const state of ['unbound', 'confirmed', 'pending_review', 'conflict']) {
      assert.equal(
        userDirectoryEntrySchema.safeParse({ ...confirmedEntry, residentCommunityState: state }).success,
        true,
        state,
      )
    }
    assert.equal(
      userDirectoryEntrySchema.safeParse({ ...confirmedEntry, residentCommunityState: null }).success,
      true,
    )
    assert.equal(
      userDirectoryEntrySchema.safeParse({ ...confirmedEntry, residentCommunityState: 'bound' }).success,
      false,
    )
    // The #171 fields are optional, so an older consumer/fixture still parses.
    const legacy = { ...unassignedEntry }
    assert.equal(userDirectoryEntrySchema.safeParse(legacy).success, true)
  })
})

describe('userDirectoryDetailSchema', () => {
  it('accepts a staff account whose staff communities differ from resident communities', () => {
    const parsed = userDirectoryDetailSchema.parse(staffDetail)
    assert.deepEqual(parsed.residentCommunities.map((x) => x.id), [communityA])
    assert.deepEqual(parsed.staffAccount.communities.map((x) => x.id), [communityB])
    assert.equal(parsed.maskedPhone, '138****8000')
  })

  it('accepts a pure WeChat resident with no phone and no staff account', () => {
    const parsed = userDirectoryDetailSchema.parse({
      ...unassignedEntry,
      wechatLinkedIdentityCount: 2,
      maskedPhone: null,
      staffAccount: null,
    })
    assert.equal(parsed.staffAccount, null)
    assert.equal(parsed.wechatLinkedIdentityCount, 2)
  })

  it('accepts a legacy account with no identity, phone or staff account', () => {
    const parsed = userDirectoryDetailSchema.parse({
      ...unassignedEntry,
      wechatNickname: null,
      wechatAvatarUrl: null,
      wechatProfileAuthorizedAt: null,
      identityMethods: [],
      wechatLinkedIdentityCount: 0,
      maskedPhone: null,
      staffAccount: null,
    })
    assert.deepEqual(parsed.identityMethods, [])
  })

  it('refuses inconsistent identity flags', () => {
    const invalid = [
      { ...staffDetail, identityMethods: ['phone', 'staff'], maskedPhone: null },
      { ...staffDetail, staffAccount: null },
      {
        ...unassignedEntry,
        wechatLinkedIdentityCount: 0,
        maskedPhone: null,
        staffAccount: null,
      },
      {
        ...unassignedEntry,
        wechatLinkedIdentityCount: 1,
        maskedPhone: null,
        staffAccount: { username: 'ops', status: 'active', communities: [] },
      },
    ]
    for (const value of invalid) {
      assert.equal(userDirectoryDetailSchema.safeParse(value).success, false, JSON.stringify(value))
    }
  })

  it('exposes no plaintext phone, credential or identifier column', () => {
    const forbidden = [
      'openId',
      'openid',
      'unionId',
      'unionid',
      'phone',
      'phoneNumber',
      'passwordHash',
      'password',
      'tokenHash',
      'token',
      'sessionId',
      'cookie',
      'appSecret',
      'lastLoginAt',
      'loginHistory',
    ]
    const keys = new Set([
      ...schemaKeys(userDirectoryDetailSchema),
      ...schemaKeys(userDirectoryEntrySchema),
    ])
    for (const key of forbidden) {
      assert.equal(keys.has(key), false, `contract must not declare ${key}`)
    }
    const serialized = JSON.stringify({ detail: staffDetail, entry: unassignedEntry })
    for (const key of forbidden) {
      assert.equal(
        serialized.includes(`"${key}":`),
        false,
        `serialized DTO leaked ${key}`,
      )
    }
    for (const extra of [{ openId: 'o-1' }, { phone: '13800138000' }, { passwordHash: 'x' }]) {
      assert.equal(
        userDirectoryDetailSchema.safeParse({ ...staffDetail, ...extra }).success,
        false,
      )
    }
  })

  it('pins the top-level field sets so adding a field is a conscious change', () => {
    assert.deepEqual(Object.keys(userDirectoryEntrySchema.shape).sort(), [
      'communityRelationSource',
      'confirmedCommunity',
      'createdAt',
      'displayName',
      'id',
      'identityMethods',
      'localDisplayName',
      'residentCommunities',
      'residentCommunityState',
      'staffRole',
      'wechatAvatarUrl',
      'wechatNickname',
      'wechatProfileAuthorizedAt',
    ])
    assert.deepEqual(Object.keys(userDirectoryDetailSchema.shape).sort(), [
      'communityRelationSource',
      'confirmedCommunity',
      'createdAt',
      'displayName',
      'id',
      'identityMethods',
      'localDisplayName',
      'maskedPhone',
      'residentCommunities',
      'residentCommunityState',
      'staffAccount',
      'staffRole',
      'wechatAvatarUrl',
      'wechatLinkedIdentityCount',
      'wechatNickname',
      'wechatProfileAuthorizedAt',
    ])
  })
})
