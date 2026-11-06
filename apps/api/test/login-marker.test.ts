import assert from 'node:assert/strict'
import test from 'node:test'
import { presentLoginMarker, stripLoginResultParams } from '@sanchuang-dev/local-life-contracts'

/**
 * Regression tests for the resident login-return markers (#92).
 *
 * Both rules live in the shared contracts package because the API appends the
 * markers and the H5 renders them; the fake-success defect (a `?auth=success`
 * URL opened in a browser without a session showed "微信登录成功") came from
 * presenting the marker without asking the server for the session.
 */

const ACTIVITY_ROUTE =
  '/community/activity/silver-neighborhood?activityId=11111111-1111-1111-1111-111111111111&invite=a1b2c3d4e5f60718293a4b5c6d7e8f90'

test('one-off login markers are stripped and every other parameter is preserved', () => {
  // The activity and its invite code survive the cleanup byte-for-byte, so a
  // resident refresh or a copied link still points at the same activity.
  assert.equal(stripLoginResultParams(`${ACTIVITY_ROUTE}&auth=success`), ACTIVITY_ROUTE)
  assert.equal(
    stripLoginResultParams(`${ACTIVITY_ROUTE}&auth_error=wechat_state_invalid`),
    ACTIVITY_ROUTE,
  )

  // Order of the remaining parameters is kept, not re-serialised.
  assert.equal(
    stripLoginResultParams('/community?utm=poster&auth=success&invite=abc&auth_error=x'),
    '/community?utm=poster&invite=abc',
  )

  // A route with only markers falls back to the bare path.
  assert.equal(stripLoginResultParams('/me?auth=success'), '/me')
  assert.equal(stripLoginResultParams('/me?auth=success&auth_error=x'), '/me')

  // No markers: untouched, including an unrelated `auth`-looking key.
  assert.equal(stripLoginResultParams('/community'), '/community')
  assert.equal(stripLoginResultParams('/community?authentic=1&invite=abc'), '/community?authentic=1&invite=abc')
  assert.equal(stripLoginResultParams(ACTIVITY_ROUTE), ACTIVITY_ROUTE)
})

test('a success marker is never presented without a server-confirmed session', () => {
  // The defect: another browser opening `?auth=success` must not see success.
  assert.equal(presentLoginMarker('success', false, false), null)
  // Nor while the session request is still in flight.
  assert.equal(presentLoginMarker('success', false, true), null)
  assert.equal(presentLoginMarker('success', true, true), null)
  // Only the authenticated branch presents it.
  assert.equal(presentLoginMarker('success', true, false), 'success')

  // A failed authorization leaves no session and stays presentable (retry).
  assert.equal(presentLoginMarker('error', false, false), 'error')
  assert.equal(presentLoginMarker('error', true, false), 'error')
  assert.equal(presentLoginMarker('error', false, true), null)

  assert.equal(presentLoginMarker(null, true, false), null)
  assert.equal(presentLoginMarker(null, false, true), null)
})
