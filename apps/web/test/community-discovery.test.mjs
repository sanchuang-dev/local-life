import assert from 'node:assert/strict'
import test from 'node:test'
import { activityDetailHref, isLegacyActivityHome } from '../src/lib/communityHomeRoute.ts'
import { wgs84ToGcj02 } from '../src/lib/communityGeolocation.ts'

test('old activity and invite links continue to open the activity workflow', () => {
  assert.equal(isLegacyActivityHome(''), false)
  assert.equal(isLegacyActivityHome('?activityId=abc'), true)
  assert.equal(isLegacyActivityHome('?invite=abc&activityId=def'), true)
  assert.equal(isLegacyActivityHome('?invite=abc'), true)
  assert.equal(isLegacyActivityHome('?auth=success'), false)
  assert.equal(activityDetailHref('uuid123'), '/?activityId=uuid123')
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
