/**
 * Contract self-check for the permanent resident community (#171 LL-IDENTITY-001).
 *
 * Why this file exists: `residentCommunityStatusResponseSchema` is the one read
 * the resident H5 renders for 「未绑定 / 已绑定某社区 / 历史待核查 / 冲突」, and
 * `confirmResidentCommunityRequestSchema` is the only shape a resident may send
 * to create the binding. A drift here is invisible until a real resident is
 * bound, so the state machine is pinned here rather than trusted.
 *
 * The negative cases are the important ones:
 * - `confirmed` without a binding, or `conflict` whose candidate IS the bound
 *   community, must be unrepresentable;
 * - `pending_review` may only describe an account with two or more historical
 *   assignments (the API never picks one of them);
 * - `canConfirm` and `confirmBlockedReason` must be exact opposites, and only
 *   `unbound` may confirm;
 * - no credential/identifier field may sneak into these DTOs.
 *
 * Run from the repo root (the `test` script builds `dist` first):
 *   pnpm --filter @sanchuang-dev/local-life-contracts test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  API_ERROR_CODES,
  RESIDENT_COMMUNITY_BINDING_SOURCES,
  RESIDENT_COMMUNITY_ROUTES,
  confirmResidentCommunityRequestSchema,
  confirmResidentCommunityResponseSchema,
  residentCommunityStatusResponseSchema,
} from '@sanchuang-dev/local-life-contracts'

const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const at = '2026-11-11T04:00:00.000Z'
const communityA = uuid(9001)
const communityB = uuid(9002)

const refA = { id: communityA, name: 'A 社区', serviceAddress: 'A 社区服务站 1 号' }
const refB = { id: communityB, name: 'B 社区', serviceAddress: null }

const emptyHistory = { assignmentCount: 0, pendingReview: false, assignments: [] }

const unbound = {
  status: 'unbound',
  binding: null,
  candidate: null,
  legacyHistory: emptyHistory,
  canConfirm: true,
  confirmBlockedReason: null,
}

const confirmed = {
  status: 'confirmed',
  binding: { community: refA, confirmedAt: at, source: 'resident_h5_confirmed' },
  candidate: null,
  legacyHistory: emptyHistory,
  canConfirm: false,
  confirmBlockedReason: 'already_confirmed',
}

const conflict = {
  status: 'conflict',
  binding: { community: refA, confirmedAt: at, source: 'resident_h5_confirmed' },
  candidate: {
    community: refB,
    source: 'activity_oauth_candidate',
    suggestedAt: at,
    expiresAt: '2026-11-18T04:00:00.000Z',
  },
  legacyHistory: emptyHistory,
  canConfirm: false,
  confirmBlockedReason: 'candidate_conflict',
}

const pendingReview = {
  status: 'pending_review',
  binding: null,
  candidate: null,
  legacyHistory: {
    assignmentCount: 2,
    pendingReview: true,
    assignments: [
      { community: refA, assignedAt: at },
      { community: refB, assignedAt: at },
    ],
  },
  canConfirm: false,
  confirmBlockedReason: 'pending_review',
}

const legacySingle = {
  status: 'unbound',
  binding: null,
  candidate: {
    community: refA,
    source: 'activity_oauth_candidate',
    suggestedAt: at,
    expiresAt: '2026-11-18T04:00:00.000Z',
  },
  legacyHistory: {
    assignmentCount: 1,
    pendingReview: false,
    assignments: [{ community: refA, assignedAt: at }],
  },
  canConfirm: true,
  confirmBlockedReason: null,
}

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

describe('resident community routes and error codes', () => {
  it('exposes one status read and one confirm write', () => {
    assert.equal(RESIDENT_COMMUNITY_ROUTES.status, '/resident-community/status')
    assert.equal(RESIDENT_COMMUNITY_ROUTES.confirm, '/resident-community/confirm')
  })

  it('defines explicit refusal codes instead of reusing a generic conflict', () => {
    assert.equal(API_ERROR_CODES.residentCommunityAlreadyConfirmed, 'resident_community_already_confirmed')
    assert.equal(API_ERROR_CODES.residentCommunityConflict, 'resident_community_conflict')
    assert.equal(API_ERROR_CODES.residentCommunityPendingReview, 'resident_community_pending_review')
    assert.equal(API_ERROR_CODES.residentCommunityNotFound, 'resident_community_not_found')
    assert.equal(API_ERROR_CODES.residentCommunityNotBound, 'resident_community_not_bound')
  })

  it('allows only server-written binding sources', () => {
    assert.deepEqual([...RESIDENT_COMMUNITY_BINDING_SOURCES], [
      'resident_h5_confirmed',
      'admin_compliance_correction',
    ])
    assert.equal(
      residentCommunityStatusResponseSchema.safeParse({
        ...confirmed,
        binding: { ...confirmed.binding, source: 'client_said_so' },
      }).success,
      false,
    )
  })
})

describe('residentCommunityStatusResponseSchema', () => {
  it('represents every documented state', () => {
    for (const value of [unbound, confirmed, conflict, pendingReview, legacySingle]) {
      assert.equal(
        residentCommunityStatusResponseSchema.safeParse(value).success,
        true,
        JSON.stringify(value.status),
      )
    }
  })

  it('keeps 未绑定 visible with an empty history instead of omitting it', () => {
    const parsed = residentCommunityStatusResponseSchema.parse(unbound)
    assert.deepEqual(parsed.legacyHistory.assignments, [])
    assert.equal(parsed.binding, null)
    assert.equal(parsed.canConfirm, true)
  })

  it('refuses confirmed states without a binding and unbound states with one', () => {
    const invalid = [
      { ...confirmed, binding: null },
      { ...unbound, binding: confirmed.binding },
      { ...pendingReview, binding: confirmed.binding },
      { ...conflict, binding: null },
      { ...unbound, canConfirm: false },
      { ...confirmed, canConfirm: true, confirmBlockedReason: null },
      { ...unbound, status: 'pending_review' },
    ]
    for (const value of invalid) {
      assert.equal(
        residentCommunityStatusResponseSchema.safeParse(value).success,
        false,
        JSON.stringify(value),
      )
    }
  })

  it('refuses a conflict whose candidate is the already-bound community', () => {
    assert.equal(
      residentCommunityStatusResponseSchema.safeParse({
        ...conflict,
        candidate: { ...conflict.candidate, community: refA },
      }).success,
      false,
    )
    assert.equal(
      residentCommunityStatusResponseSchema.safeParse({ ...conflict, candidate: null }).success,
      false,
    )
  })

  it('ties pending_review to two or more historical assignments', () => {
    assert.equal(
      residentCommunityStatusResponseSchema.safeParse({
        ...pendingReview,
        legacyHistory: { assignmentCount: 1, pendingReview: false, assignments: [pendingReview.legacyHistory.assignments[0]] },
      }).success,
      false,
    )
    // A single historical relation stays a candidate: it can never be pre-bound.
    assert.equal(residentCommunityStatusResponseSchema.safeParse(legacySingle).success, true)
  })

  it('requires the history list to match its declared count', () => {
    assert.equal(
      residentCommunityStatusResponseSchema.safeParse({
        ...pendingReview,
        legacyHistory: { assignmentCount: 2, pendingReview: true, assignments: [pendingReview.legacyHistory.assignments[0]] },
      }).success,
      false,
    )
  })

  it('carries no credential or identifier column', () => {
    const forbidden = [
      'openId',
      'openid',
      'unionId',
      'unionid',
      'phone',
      'token',
      'tokenHash',
      'sessionId',
      'cookie',
      'appSecret',
      'passwordHash',
    ]
    const keys = new Set([
      ...schemaKeys(residentCommunityStatusResponseSchema),
      ...schemaKeys(confirmResidentCommunityResponseSchema),
    ])
    for (const key of forbidden) {
      assert.equal(keys.has(key), false, `contract must not declare ${key}`)
    }
    for (const extra of [{ openId: 'o-1' }, { phone: '13800138000' }, { token: 't' }]) {
      assert.equal(
        residentCommunityStatusResponseSchema.safeParse({ ...confirmed, ...extra }).success,
        false,
        JSON.stringify(extra),
      )
    }
  })
})

describe('first confirmation', () => {
  it('accepts exactly one community UUID', () => {
    assert.deepEqual(confirmResidentCommunityRequestSchema.parse({ communityId: communityA }), {
      communityId: communityA,
    })
  })

  it('refuses a client-chosen source, timestamp or user id', () => {
    const invalid = [
      { communityId: communityA, source: 'resident_h5_confirmed' },
      { communityId: communityA, confirmedAt: at },
      { communityId: communityA, userId: uuid(1) },
      { communityId: 'A 社区' },
      {},
    ]
    for (const value of invalid) {
      assert.equal(
        confirmResidentCommunityRequestSchema.safeParse(value).success,
        false,
        JSON.stringify(value),
      )
    }
  })

  it('reports idempotent replays without pretending a second binding', () => {
    const response = {
      status: 'confirmed',
      binding: confirmed.binding,
      idempotent: false,
    }
    assert.equal(confirmResidentCommunityResponseSchema.parse(response).idempotent, false)
    assert.equal(
      confirmResidentCommunityResponseSchema.parse({ ...response, idempotent: true }).idempotent,
      true,
    )
    for (const broken of [
      { ...response, status: 'unbound' },
      { ...response, binding: { ...response.binding, source: 'guess' } },
      { ...response, extra: true },
    ]) {
      assert.equal(confirmResidentCommunityResponseSchema.safeParse(broken).success, false)
    }
  })
})
