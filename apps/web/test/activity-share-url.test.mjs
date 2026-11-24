import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildActivityShareUrl,
  parseInviteParam,
} from '../src/components/activity/share.ts'

const activityId = '3b16253c-cd91-437f-86b1-8bf553129d12'
const invite = '1234567890abcdef1234567890abcdef'
const route = '/community/activity/silver-neighborhood'

test('share URL keeps the real activityId and the existing invite parameter', () => {
  const url = buildActivityShareUrl(activityId, invite, {
    origin: 'https://local.proto.3cgroup.cn',
    baseUrl: '/',
  })
  const parsed = new URL(url)
  assert.equal(parsed.origin, 'https://local.proto.3cgroup.cn')
  assert.equal(parsed.pathname, route)
  assert.equal(parsed.searchParams.get('activityId'), activityId)
  assert.equal(parsed.searchParams.get('invite'), invite)
})

test('no invite identity means the activity-only URL never invents one', () => {
  const url = buildActivityShareUrl(activityId, null, {
    origin: 'https://local.proto.3cgroup.cn',
    baseUrl: '/',
  })
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('activityId'), activityId)
  assert.equal(parsed.searchParams.has('invite'), false)
})

test('Pages preview keeps the /local-life/ base and hash route', () => {
  assert.equal(
    buildActivityShareUrl(activityId, invite, {
      origin: 'https://sanchuang-dev.github.io',
      baseUrl: '/local-life/',
    }),
    `https://sanchuang-dev.github.io/local-life/#${route}?activityId=${activityId}&invite=${invite}`,
  )
})

test('invite parsing only forwards a well-formed code', () => {
  assert.deepEqual(parseInviteParam(invite), { code: invite, invalid: false })
  assert.deepEqual(parseInviteParam(null), { code: null, invalid: false })
  assert.deepEqual(parseInviteParam('not-a-code'), { code: null, invalid: true })
})
