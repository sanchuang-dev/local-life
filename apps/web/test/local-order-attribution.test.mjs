import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLocalOrderRegistration,
  chooseTeamOption,
  describeOrderAttribution,
  resolveOrderAttribution,
  resolveSubmissionAttempt,
  shortTeamId,
  teamSelectionMode,
} from '../src/components/life/localOrderAttribution.ts'

/**
 * #209 LL-PUR-004 resident consumption-team attribution.
 *
 * These fixtures follow the shared `localOrderTeamOptionSchema`: the API returns
 * only the caller's own activity/team pair, status and joinedAt. The tests prove
 * the resident-visible rules — no team, one automatic team, explicit choice for
 * several teams — plus the retry invariant that one attempt can never switch
 * attribution or mint a second idempotency key.
 */

const ACTIVITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', title: '周末惠邻消费团' }
const ACTIVITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', title: '秋季助农消费团' }
const TEAM_A = { id: '123e4567-e89b-42d3-a456-4266141740c3', status: 'open' }
const TEAM_B = { id: '123e4567-e89b-42d3-a456-4266141740d4', status: 'locked' }
const JOINED_AT = '2026-11-11T03:04:05.678Z'

function option(activity, team, overrides = {}) {
  return { activity, team, joinedAt: JOINED_AT, ...overrides }
}

const ONE = [option(ACTIVITY_A, TEAM_A)]
const TWO = [option(ACTIVITY_A, TEAM_A), option(ACTIVITY_B, TEAM_B)]

test('zero, one and several eligible teams are distinct selection modes', () => {
  assert.equal(teamSelectionMode([]), 'none')
  assert.equal(teamSelectionMode(ONE), 'auto')
  assert.equal(teamSelectionMode(TWO), 'choice')
})

test('no team means an order without attribution, never an invented team', () => {
  const resolved = resolveOrderAttribution([], null)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.option, null)
  assert.deepEqual(resolved.attribution, {})
})

test('the single eligible team is selected automatically with both ids', () => {
  const resolved = resolveOrderAttribution(ONE, null)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.option.team.id, TEAM_A.id)
  assert.deepEqual(resolved.attribution, {
    sourceActivityId: ACTIVITY_A.id,
    sourceTeamId: TEAM_A.id,
  })
})

test('several teams require an explicit selection and never fall back to the first', () => {
  const missing = resolveOrderAttribution(TWO, null)
  assert.equal(missing.ok, false)
  assert.match(missing.message, /选择/)

  const stale = resolveOrderAttribution(TWO, '123e4567-e89b-42d3-a456-4266141740ff')
  assert.equal(stale.ok, false)

  const chosen = resolveOrderAttribution(TWO, TEAM_B.id)
  assert.equal(chosen.ok, true)
  assert.deepEqual(chosen.attribution, {
    sourceActivityId: ACTIVITY_B.id,
    sourceTeamId: TEAM_B.id,
  })
})

test('a removed selection resolves to no option instead of another team', () => {
  assert.equal(chooseTeamOption(TWO, TEAM_A.id)?.team.id, TEAM_A.id)
  assert.equal(chooseTeamOption([option(ACTIVITY_B, TEAM_B)], TEAM_A.id)?.team.id, TEAM_B.id)
  assert.equal(
    chooseTeamOption(TWO, '123e4567-e89b-42d3-a456-4266141740ff'),
    null,
  )
})

test('a retry keeps the first idempotency key and attribution', () => {
  let keyCalls = 0
  const createKey = () => {
    keyCalls += 1
    return `key-${keyCalls}`
  }
  const first = resolveSubmissionAttempt(
    null,
    { sourceActivityId: ACTIVITY_A.id, sourceTeamId: TEAM_A.id },
    createKey,
  )
  assert.deepEqual(first, {
    idempotencyKey: 'key-1',
    attribution: { sourceActivityId: ACTIVITY_A.id, sourceTeamId: TEAM_A.id },
  })

  // A later UI selection change must not turn the same retry into another team.
  const retry = resolveSubmissionAttempt(
    first,
    { sourceActivityId: ACTIVITY_B.id, sourceTeamId: TEAM_B.id },
    createKey,
  )
  assert.equal(retry.idempotencyKey, 'key-1')
  assert.deepEqual(retry.attribution, {
    sourceActivityId: ACTIVITY_A.id,
    sourceTeamId: TEAM_A.id,
  })
  assert.equal(keyCalls, 1)
})

test('the submitted payload carries the selected activity/team and a trimmed optional note', () => {
  const payload = buildLocalOrderRegistration({
    productId: '123e4567-e89b-42d3-a456-4266141740e5',
    quantity: 2,
    note: '  周末自提  ',
    attribution: { sourceActivityId: ACTIVITY_A.id, sourceTeamId: TEAM_A.id },
    idempotencyKey: '123e4567-e89b-42d3-a456-4266141740f6',
  })
  assert.deepEqual(payload, {
    productId: '123e4567-e89b-42d3-a456-4266141740e5',
    quantity: 2,
    note: '周末自提',
    sourceActivityId: ACTIVITY_A.id,
    sourceTeamId: TEAM_A.id,
    idempotencyKey: '123e4567-e89b-42d3-a456-4266141740f6',
  })

  const withoutNoteOrTeam = buildLocalOrderRegistration({
    productId: '123e4567-e89b-42d3-a456-4266141740e5',
    quantity: 1,
    note: '   ',
    attribution: {},
    idempotencyKey: '123e4567-e89b-42d3-a456-4266141740f7',
  })
  assert.equal('note' in withoutNoteOrTeam, false)
  assert.equal('sourceActivityId' in withoutNoteOrTeam, false)
  assert.equal('sourceTeamId' in withoutNoteOrTeam, false)
})

test('the frozen attribution is described without inventing a team or a name', () => {
  assert.equal(describeOrderAttribution({ sourceActivity: null, sourceTeam: null }), '不参与消费团')
  assert.equal(shortTeamId(TEAM_A.id), '123e4567…')
  assert.equal(
    describeOrderAttribution({
      sourceActivity: ACTIVITY_A,
      sourceTeam: { id: TEAM_A.id, activityId: ACTIVITY_A.id },
    }),
    `周末惠邻消费团 · 团号 123e4567…（已锁定）`,
  )
})
