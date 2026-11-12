import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIVITY_DETAIL_PATH,
  activityDetailHref,
  communityRootRedirect,
  isActivityDetailReturn,
  isLegacyActivityHome,
  legacyActivityDetailHref,
} from '../src/lib/communityHomeRoute.ts'
import { wgs84ToGcj02 } from '../src/lib/communityCoordinates.ts'

test('old activity and invite links continue to open the activity workflow', () => {
  assert.equal(isLegacyActivityHome(''), false)
  assert.equal(isLegacyActivityHome('?activityId=abc'), true)
  assert.equal(isLegacyActivityHome('?invite=abc&activityId=def'), true)
  assert.equal(isLegacyActivityHome('?invite=abc'), true)
  assert.equal(isLegacyActivityHome('?auth=success'), false)
  assert.equal(isLegacyActivityHome('?auth_error=wechat_state_invalid'), false)
  assert.equal(activityDetailHref('uuid123'), `${ACTIVITY_DETAIL_PATH}?activityId=uuid123`)
})

test('the discovery activity list opens the one stable detail route', () => {
  const activityId = '123e4567-e89b-42d3-a456-426614174000'
  const href = activityDetailHref(activityId)
  assert.equal(href, `${ACTIVITY_DETAIL_PATH}?activityId=${activityId}`)
  assert.equal(new URL(href, 'https://local.proto.3cgroup.cn').pathname, ACTIVITY_DETAIL_PATH)
  assert.equal(
    new URL(href, 'https://local.proto.3cgroup.cn').searchParams.get('activityId'),
    activityId,
  )
  // No query means the discovery home still renders in place.
  assert.equal(communityRootRedirect('', null), null)
  assert.equal(communityRootRedirect('?auth=success', null), null)
})

test('legacy root links forward activityId, invite and OAuth query untouched', () => {
  const activityId = '123e4567-e89b-42d3-a456-426614174000'
  const invite = '1234567890abcdef1234567890abcdef'

  for (const search of [
    `?activityId=${activityId}`,
    `?activityId=${activityId}&invite=${invite}`,
    `?invite=${invite}`,
    `?activityId=${activityId}&invite=${invite}&auth=success`,
    `?activityId=${activityId}&invite=${invite}&auth_error=wechat_state_invalid`,
  ]) {
    const redirect = communityRootRedirect(search, null)
    assert.equal(redirect, `${ACTIVITY_DETAIL_PATH}${search}`)
    const target = new URL(redirect, 'https://local.proto.3cgroup.cn')
    assert.equal(target.pathname, ACTIVITY_DETAIL_PATH)
    // Every legacy parameter survives in the same order; `URLSearchParams`
    // decodes escaping so an encoded invite still compares by value.
    const expected = new URLSearchParams(search)
    for (const [key, value] of expected) {
      assert.equal(target.searchParams.get(key), value, key)
    }
  }

  assert.equal(
    legacyActivityDetailHref('?activityId=uuid123&invite=a%2Bb'),
    `${ACTIVITY_DETAIL_PATH}?activityId=uuid123&invite=a%2Bb`,
  )
})

test('the detail page back link returns to discovery instead of bouncing to itself', () => {
  const detailState = { from: ACTIVITY_DETAIL_PATH }
  assert.equal(isActivityDetailReturn(detailState), true)
  assert.equal(isActivityDetailReturn({ from: '/' }), false)
  assert.equal(isActivityDetailReturn({ from: '//evil.example' }), false)
  assert.equal(isActivityDetailReturn(null), false)
  assert.equal(isActivityDetailReturn('x'), false)

  const legacySearch = '?activityId=uuid123&invite=abc'
  assert.equal(communityRootRedirect(legacySearch, detailState), '/')
  // A clean root is already discovery, so it must not redirect again.
  assert.equal(communityRootRedirect('', detailState), null)
  // A legacy link without the detail-page state still forwards its context.
  assert.equal(communityRootRedirect(legacySearch, null), `${ACTIVITY_DETAIL_PATH}${legacySearch}`)
})

test('browser GPS is converted to Tencent GCJ-02 only inside China', () => {
  const overseas = wgs84ToGcj02(41.98, -87.9)
  assert.deepEqual(overseas, { latitude: 41.98, longitude: -87.9 })
  const mainland = wgs84ToGcj02(24.8, 113.6)
  assert.ok(Math.abs(mainland.latitude - 24.8) > 0.0001)
  assert.ok(Math.abs(mainland.longitude - 113.6) > 0.0001)
  assert.ok(Math.abs(mainland.latitude - 24.8) < 0.01)
  assert.ok(Math.abs(mainland.longitude - 113.6) < 0.01)
})
