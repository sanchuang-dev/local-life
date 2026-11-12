/**
 * Contract self-check for the resident OAuth start query (LL-MVP-012 / #123).
 *
 * Why this file exists: `buildWechatStartQuery` is the single place where the H5
 * decides what context it hands to `GET /auth/wechat/start`. Two failure modes
 * are invisible to the compiler and to a green build:
 *
 *   1. **Leaking an attribution claim.** If `communityId` ever becomes part of
 *      this contract, the browser would be asserting "this resident belongs to
 *      this community" — an attribution nobody can verify client-side. The API
 *      rejects such a query outright, so a leak here would break every login,
 *      which is exactly why the emitted key set is asserted, not just the values.
 *   2. **Silently dropping a parameter.** A caller bug that produces `''` when an
 *      `activityId` was supplied would look like a successful login while the
 *      resident is never attributed. Invalid input must therefore throw.
 *
 * Run from the repo root (the `test` script builds `dist` first):
 *   pnpm --filter @sanchuang-dev/local-life-contracts test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildWechatStartQuery,
  isActivityId,
  RESIDENT_RETURN_TO_PREFIXES,
} from '@sanchuang-dev/local-life-contracts'

const ACTIVITY_ID = '0f5a1f9e-3a4e-4d5f-9d21-7c1f13a6b234'
const RETURN_TO = `/community/activity/silver-neighborhood?activityId=${ACTIVITY_ID}&invite=a1b2c3d4e5f60718293a4b5c6d7e8f90`

function searchOf(query) {
  return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
}

describe('buildWechatStartQuery', () => {
  it('emits only the context the API is allowed to receive', () => {
    const query = buildWechatStartQuery({ activityId: ACTIVITY_ID, returnTo: RETURN_TO })
    assert.ok(query.startsWith('?'), 'a non-empty query is prefixed with ?')

    const params = searchOf(query)
    assert.deepEqual(
      [...params.keys()].sort(),
      ['activityId', 'returnTo'],
      'the contract never mentions a community: attribution is derived server-side',
    )
    assert.equal(params.get('activityId'), ACTIVITY_ID)
    assert.equal(params.get('returnTo'), RETURN_TO, 'the return target survives verbatim')
  })

  it('returns an empty suffix when there is no context at all', () => {
    assert.equal(buildWechatStartQuery({}), '')
    assert.equal(buildWechatStartQuery({ activityId: null, returnTo: null }), '')
    assert.equal(buildWechatStartQuery({ activityId: undefined, returnTo: undefined }), '')
  })

  it('encodes the return target so nested query parameters stay intact', () => {
    const query = buildWechatStartQuery({ returnTo: RETURN_TO })
    assert.equal(searchOf(query).get('returnTo'), RETURN_TO)
    // The raw string must not contain an unescaped second `?` from the target.
    assert.equal(query.includes(RETURN_TO), false)
    assert.equal(searchOf(query).has('activityId'), false)
  })

  it('refuses a malformed activity id instead of degrading to an unattributed login', () => {
    for (const activityId of [
      'not-a-uuid',
      '',
      '0f5a1f9e-3a4e-4d5f-9d21',
      '0f5a1f9e3a4e4d5f9d217c1f13a6b234',
      `${ACTIVITY_ID}extra`,
    ]) {
      assert.throws(
        () => buildWechatStartQuery({ activityId }),
        RangeError,
        `${JSON.stringify(activityId)} must throw`,
      )
    }
  })

  it('refuses every return target the shared allowlist refuses', () => {
    for (const returnTo of [
      'https://attacker.invalid/community/activity/x',
      '//attacker.invalid/community/activity/x',
      '/admin/dashboard',
      'javascript:alert(1)',
      '#/community/activity/x',
      `/${'a'.repeat(600)}`,
    ]) {
      assert.throws(() => buildWechatStartQuery({ returnTo }), RangeError, `${returnTo} must throw`)
    }
  })

  it('accepts the resident paths the allowlist documents', () => {
    for (const prefix of RESIDENT_RETURN_TO_PREFIXES) {
      const returnTo = prefix === '/' ? '/' : prefix
      const query = buildWechatStartQuery({ returnTo })
      assert.equal(searchOf(query).get('returnTo'), returnTo)
    }
  })
})

describe('isActivityId', () => {
  it('accepts the UUID shape the API issues', () => {
    assert.equal(isActivityId(ACTIVITY_ID), true)
    assert.equal(isActivityId(ACTIVITY_ID.toUpperCase()), true)
  })

  it('rejects everything else, including non-strings', () => {
    for (const value of [
      null,
      undefined,
      42,
      {},
      ['x'],
      '',
      'not-a-uuid',
      `${ACTIVITY_ID} `,
      ` ${ACTIVITY_ID}`,
    ]) {
      assert.equal(isActivityId(value), false, `${JSON.stringify(value)} must be rejected`)
    }
  })
})
