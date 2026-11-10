import assert from 'node:assert/strict'
import test from 'node:test'
import { isResidentGateExempt } from '../src/components/auth/residentGlobalGate.ts'
import { decideResidentGate } from '../src/components/auth/residentGate.ts'
import { buildResidentLoginHref, normalizeActivityId, resolveResidentLoginTarget } from '../src/components/auth/residentLoginUrl.ts'

const emptyContext = { activityId: null, inviteCode: null, inviteInvalid: false }

test('all resident routes, including activity invitations, are gated when unauthenticated', () => {
  for (const path of ['/', '/community', '/community/activity/silver-neighborhood', '/life', '/health', '/points', '/gd', '/me', '/me/orders']) {
    assert.equal(isResidentGateExempt(path), false, path)
    assert.equal(decideResidentGate('unauthenticated', false), 'login')
  }
})

test('login never gates itself and the separate staff workbench remains intact', () => {
  for (const path of ['/login', '/workbench', '/workbench/orders', '/workbench/leads']) {
    assert.equal(isResidentGateExempt(path), true, path)
  }
  assert.equal(isResidentGateExempt('/login/fake'), false)
  assert.equal(isResidentGateExempt('/workbenchevil'), false)
})

test('login links retain original resident targets, activity query and reject unsafe returns', () => {
  const original = '/?activityId=123e4567-e89b-42d3-a456-426614174000&invite=ABCDEF12'
  const href = buildResidentLoginHref(original, emptyContext)
  const query = new URLSearchParams(href.split('?')[1])
  assert.equal(query.get('next'), original)
  assert.equal(resolveResidentLoginTarget('//evil.example'), '/me')
  assert.equal(resolveResidentLoginTarget('/login?next=/me'), '/me')
  assert.equal(resolveResidentLoginTarget('/workbench/orders'), '/me')
})

test('WeChat login start derives valid activityId from preserved target query', () => {
  const activityId = '123e4567-e89b-42d3-a456-426614174000'
  const target = resolveResidentLoginTarget('/?activityId=' + activityId)
  const params = new URL(target, 'https://local.proto.3cgroup.cn').searchParams
  assert.equal(normalizeActivityId(params.get('activityId')), activityId)
  assert.equal(normalizeActivityId('not-a-valid-id'), null)
  assert.equal(resolveResidentLoginTarget('/login?next=/me'), '/me')
})
