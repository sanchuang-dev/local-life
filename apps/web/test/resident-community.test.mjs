import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  BROWSE_ONLY_NOTICE,
  LOCATION_NOT_PROOF_NOTICE,
  PERMANENT_BINDING_NOTICE,
  RESIDENT_COMMUNITY_CONFIRM_PAGE,
  browseBindingNotice,
  canOfferConfirmation,
  confirmationErrorMessage,
  confirmBlockedMessage,
  formatResidentCommunityDate,
  irreversibleWarning,
  isCommunityId,
  legacyAssignmentLines,
  readConfirmCommunityId,
  residentCommunityConfirmHref,
  residentCommunityConfirmHrefWithContext,
  residentCommunityStatusLabel,
  residentCommunitySummary,
} from '../src/lib/residentCommunity.ts'

/**
 * #171 LL-IDENTITY-001 resident H5 rules.
 *
 * The fixtures below are hand-written *contract-shaped* values, not a second
 * source of truth: every field name and enum value comes from
 * `packages/contracts/src/resident-community.ts`. The point of these tests is the
 * resident-visible promise — browse freely, confirm once, never rebind — and the
 * refusal copy, none of which can be proven by a typecheck.
 */

const COMMUNITY_A = {
  id: '3b16253c-cd91-437f-86b1-8bf553129d12',
  name: '梧桐里社区',
  serviceAddress: '梧桐路 18 号社区服务站',
}
const COMMUNITY_B = {
  id: '7c1f0f2a-5b3d-4e6f-8a90-0b1c2d3e4f50',
  name: '柳岸花城社区',
  serviceAddress: null,
}
const CONFIRMED_AT = '2026-11-11T03:04:05.678Z'
const SUGGESTED_AT = '2026-11-10T03:04:05.678Z'
const EXPIRES_AT = '2026-11-17T03:04:05.678Z'

function statusPayload(overrides = {}) {
  return {
    status: 'unbound',
    binding: null,
    candidate: null,
    legacyHistory: { assignmentCount: 0, pendingReview: false, assignments: [] },
    canConfirm: true,
    confirmBlockedReason: null,
    ...overrides,
  }
}

function bindingOf(community) {
  return { community, confirmedAt: CONFIRMED_AT, source: 'resident_h5_confirmed' }
}

test('the four resident states are told apart in copy, not merged into one label', () => {
  const unbound = residentCommunitySummary(statusPayload())
  assert.equal(unbound.badge, '未绑定')
  assert.match(unbound.detail, /主动确认/)
  assert.match(unbound.detail, /不会自动产生归属/)

  // A single legacy row is only a *candidate*: the copy must not claim a binding.
  const withCandidate = residentCommunitySummary(statusPayload({
    candidate: {
      community: COMMUNITY_A,
      source: 'activity_oauth_candidate',
      suggestedAt: SUGGESTED_AT,
      expiresAt: EXPIRES_AT,
    },
  }))
  assert.equal(withCandidate.badge, '未绑定')
  assert.match(withCandidate.detail, /候选社区/)
  assert.match(withCandidate.detail, /主动确认/)

  const confirmed = residentCommunitySummary(statusPayload({
    status: 'confirmed',
    binding: bindingOf(COMMUNITY_A),
    canConfirm: false,
    confirmBlockedReason: 'already_confirmed',
  }))
  assert.equal(confirmed.badge, '已确认')
  assert.equal(confirmed.title, COMMUNITY_A.name)
  assert.match(confirmed.detail, /确认日期/)
  assert.match(confirmed.detail, /不可修改/)

  const pending = residentCommunitySummary(statusPayload({
    status: 'pending_review',
    canConfirm: false,
    confirmBlockedReason: 'pending_review',
    legacyHistory: {
      assignmentCount: 2,
      pendingReview: true,
      assignments: [
        { community: COMMUNITY_A, assignedAt: SUGGESTED_AT },
        { community: COMMUNITY_B, assignedAt: SUGGESTED_AT },
      ],
    },
  }))
  assert.equal(pending.badge, '待核查')
  assert.match(pending.detail, /2 条/)
  assert.match(pending.detail, /不会自动挑选/)

  const conflict = residentCommunitySummary(statusPayload({
    status: 'conflict',
    binding: bindingOf(COMMUNITY_A),
    candidate: {
      community: COMMUNITY_B,
      source: 'activity_oauth_candidate',
      suggestedAt: SUGGESTED_AT,
      expiresAt: EXPIRES_AT,
    },
    canConfirm: false,
    confirmBlockedReason: 'candidate_conflict',
  }))
  assert.equal(conflict.badge, '不可修改')
  assert.equal(conflict.title, COMMUNITY_A.name)
  // The refused candidate is named, but the binding is stated as unchanged.
  assert.match(conflict.detail, /柳岸花城社区/)
  assert.match(conflict.detail, /不能改为/)
  assert.match(conflict.detail, /仍可以浏览/)
})

test('only an unbound resident with an open confirmation may be offered the action', () => {
  assert.equal(canOfferConfirmation(statusPayload()), true)

  const confirmedPayload = statusPayload({
    status: 'confirmed',
    binding: bindingOf(COMMUNITY_A),
    canConfirm: false,
    confirmBlockedReason: 'already_confirmed',
  })
  assert.equal(canOfferConfirmation(confirmedPayload), false)

  const pendingPayload = statusPayload({
    status: 'pending_review',
    canConfirm: false,
    confirmBlockedReason: 'pending_review',
    legacyHistory: { assignmentCount: 2, pendingReview: true, assignments: [] },
  })
  assert.equal(canOfferConfirmation(pendingPayload), false)

  // Defensive: a payload claiming `canConfirm` outside `unbound` still cannot open
  // the resident action, so a future API/contract slip cannot enable a rebind.
  assert.equal(canOfferConfirmation({ ...statusPayload(), status: 'confirmed' }), false)
})

test('a confirmed community is terminal on the resident surface', () => {
  const payload = statusPayload({
    status: 'confirmed',
    binding: bindingOf(COMMUNITY_A),
    canConfirm: false,
    confirmBlockedReason: 'already_confirmed',
  })
  // The components render no action when canOfferConfirmation is false; the copy
  // additionally states permanence and that no resident-side edit exists.
  assert.match(PERMANENT_BINDING_NOTICE, /确认后不可修改/)
  assert.match(PERMANENT_BINDING_NOTICE, /没有切换、解绑或重绑入口/)
  assert.equal(canOfferConfirmation(payload), false)
  // The whole source tree exposes no rebind/unbind route or helper name.
  const source = readSourceTree(join(import.meta.dirname, '..', 'src'))
  for (const forbidden of ['/resident-community/rebind', '/resident-community/unbind', '/resident-community/update', '/resident-community/delete']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

test('browse and binding are described as separate facts', () => {
  assert.equal(browseBindingNotice({
    browsingCommunityId: null,
    browsingCommunityName: null,
    bindingCommunityId: COMMUNITY_A.id,
    bindingCommunityName: COMMUNITY_A.name,
  }), null)

  assert.equal(browseBindingNotice({
    browsingCommunityId: COMMUNITY_A.id,
    browsingCommunityName: COMMUNITY_A.name,
    bindingCommunityId: COMMUNITY_A.id,
    bindingCommunityName: COMMUNITY_A.name,
  }), '当前浏览社区就是你的常驻社区。')

  const other = browseBindingNotice({
    browsingCommunityId: COMMUNITY_B.id,
    browsingCommunityName: COMMUNITY_B.name,
    bindingCommunityId: COMMUNITY_A.id,
    bindingCommunityName: COMMUNITY_A.name,
  })
  assert.ok(other)
  assert.match(other, /正在浏览「柳岸花城社区」/)
  assert.match(other, /常驻社区仍是「梧桐里社区」/)
  assert.equal(other.endsWith(BROWSE_ONLY_NOTICE), true)
  assert.match(BROWSE_ONLY_NOTICE, /不会改变你的常驻社区/)

  // An unbound resident has no binding sentence at all: browsing is not a binding.
  assert.equal(browseBindingNotice({
    browsingCommunityId: COMMUNITY_A.id,
    browsingCommunityName: COMMUNITY_A.name,
    bindingCommunityId: null,
    bindingCommunityName: null,
  }), null)

  // Location is a recommendation, never a residence proof.
  assert.match(LOCATION_NOT_PROOF_NOTICE, /不作为居住证明/)
  assert.match(LOCATION_NOT_PROOF_NOTICE, /不会自动确认常驻社区/)
})

test('confirmation failures keep the real refusal reason and never promise a rebind', () => {
  assert.match(confirmationErrorMessage({ code: 'resident_community_conflict', status: 409, message: 'x' }), /不会修改原绑定/)
  assert.match(confirmationErrorMessage({ code: 'resident_community_pending_review', status: 409, message: 'x' }), /人工核查/)
  assert.match(confirmationErrorMessage({ code: 'resident_community_not_found', status: 404, message: 'x' }), /不存在或已下线/)
  assert.match(confirmationErrorMessage({ code: 'resident_community_already_confirmed', status: 409, message: 'x' }), /不能再次确认或修改/)
  assert.match(confirmationErrorMessage({ code: 'resident_community_not_bound', status: 403, message: 'x' }), /先确认常驻社区/)
  assert.match(confirmationErrorMessage({ code: 'unauthorized', status: 401, message: 'x' }), /登录状态已失效/)
  assert.match(confirmationErrorMessage({ code: 'network_error', status: 0, message: 'x' }), /检查网络/)
  // Unknown failures keep the API message instead of inventing a friendlier cause.
  assert.equal(
    confirmationErrorMessage({ code: 'invalid_request', status: 400, message: '请选择要确认的常驻社区' }),
    '请选择要确认的常驻社区',
  )

  assert.match(confirmBlockedMessage('already_confirmed'), /不能再次确认或修改/)
  assert.match(confirmBlockedMessage('pending_review'), /人工核查/)
  assert.match(confirmBlockedMessage('candidate_conflict'), /不能改为其他社区/)
})

test('the confirmation page target keeps the entry context and drops everything else', () => {
  const activityId = '123e4567-e89b-42d3-a456-426614174000'
  const invite = '1234567890abcdef1234567890abcdef'

  const plain = residentCommunityConfirmHref(COMMUNITY_A.id)
  assert.equal(plain, `${RESIDENT_COMMUNITY_CONFIRM_PAGE}?communityId=${COMMUNITY_A.id}`)
  assert.equal(readConfirmCommunityId(plain.split('?')[1]), COMMUNITY_A.id)

  const withContext = residentCommunityConfirmHrefWithContext(
    COMMUNITY_A.id,
    `?activityId=${activityId}&invite=${invite}&inviteInvalid=1&evil=1&next=https://evil.example`,
  )
  const params = new URLSearchParams(withContext.split('?')[1])
  assert.equal(params.get('communityId'), COMMUNITY_A.id)
  assert.equal(params.get('activityId'), activityId)
  assert.equal(params.get('invite'), invite)
  assert.equal(params.get('inviteInvalid'), '1')
  // Anything not part of the validated entry context is not forwarded.
  assert.equal(params.has('evil'), false)
  assert.equal(params.has('next'), false)
  assert.equal(withContext.includes('evil.example'), false)

  // A malformed activity id or invite is not forwarded as if it were valid.
  const invalid = new URLSearchParams(
    residentCommunityConfirmHrefWithContext(COMMUNITY_A.id, '?activityId=abc&invite=zzz').split('?')[1],
  )
  assert.equal(invalid.has('activityId'), false)
  assert.equal(invalid.has('invite'), false)

  // The confirm page refuses a missing/malformed target rather than guessing one.
  assert.equal(readConfirmCommunityId(''), null)
  assert.equal(readConfirmCommunityId('communityId=not-a-uuid'), null)
  assert.equal(readConfirmCommunityId(`communityId=${COMMUNITY_A.id}&communityId=${COMMUNITY_B.id}`), COMMUNITY_A.id)
  assert.equal(isCommunityId(COMMUNITY_A.id), true)
  assert.equal(isCommunityId('梧桐里社区'), false)
})

test('the irreversible warning names the community and its service point', () => {
  const warning = irreversibleWarning(COMMUNITY_A.name, COMMUNITY_A.serviceAddress)
  assert.match(warning, /固定为「梧桐里社区」/)
  assert.match(warning, /服务点：梧桐路 18 号社区服务站/)
  assert.match(warning, /无法在居民端自行修改/)

  // A community without a recorded address must not render a fake one.
  const withoutAddress = irreversibleWarning(COMMUNITY_B.name, null)
  assert.match(withoutAddress, /柳岸花城社区/)
  assert.equal(withoutAddress.includes('服务点：'), false)
  assert.equal(withoutAddress.includes('null'), false)
})

test('legacy history is read-only and dated in Beijing time', () => {
  const legacy = legacyAssignmentLines(statusPayload({
    legacyHistory: {
      assignmentCount: 2,
      pendingReview: true,
      assignments: [
        { community: COMMUNITY_A, assignedAt: SUGGESTED_AT },
        { community: COMMUNITY_B, assignedAt: SUGGESTED_AT },
      ],
    },
  }))
  assert.equal(legacy.length, 2)
  assert.match(legacy[0], /梧桐里社区/)
  assert.match(legacy[0], /记录于/)

  // 2026-11-11T03:04:05.678Z is 2026-11-11 11:04 in Asia/Shanghai.
  assert.equal(formatResidentCommunityDate(CONFIRMED_AT), '2026年11月11日')
  assert.equal(formatResidentCommunityDate('not-a-date'), '日期未知')

  assert.equal(residentCommunityStatusLabel('confirmed'), '已确认常驻社区')
  assert.equal(residentCommunityStatusLabel('pending_review'), '历史归属待核查')
  assert.equal(residentCommunityStatusLabel('conflict'), '存在冲突')
  assert.equal(residentCommunityStatusLabel('unbound'), '未绑定常驻社区')
})

test('the browse picker never becomes a confirmation target', () => {
  const discovery = readFileSync(
    join(import.meta.dirname, '..', 'src', 'pages', 'CommunityDiscoveryPage.tsx'),
    'utf8',
  )
  // The confirm target is built from the community row the resident is looking at
  // (public directory), never from the persisted browsing id.
  assert.match(discovery, /residentCommunityConfirmHrefWithContext\(community\.id/)
  assert.equal(
    /residentCommunityConfirmHref(?:WithContext)?\(selectedId/.test(discovery),
    false,
    'localStorage browsing id must never build a confirmation target',
  )
  assert.equal(/selectedId[^\n]*confirm/i.test(discovery), false)
  // Picking a community only writes the browsing key; the copy says so explicitly.
  assert.match(discovery, /\{BROWSE_ONLY_NOTICE\}/)
  assert.match(discovery, /这里只改变浏览的社区，不会确认或改变你的常驻社区。/)
  assert.match(discovery, /确认浏览这个社区/)
  // Location is labelled as a recommendation, never as a residence proof, and the
  // manual picker stays available regardless of geolocation state.
  assert.match(discovery, /\{LOCATION_NOT_PROOF_NOTICE\}/)
  assert.match(discovery, /手动选择社区/)
})

test('no resident page offers a switch, unbind or rebind control', () => {
  for (const name of ['CommunityDiscoveryPage', 'CommunityPage', 'MePage', 'ResidentCommunityPage', 'ResidentCommunityConfirmPage']) {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'pages', `${name}.tsx`), 'utf8')
    for (const forbidden of ['解绑', '重绑', '改绑', '切换到常驻', '更换常驻社区']) {
      assert.equal(source.includes(forbidden), false, `${name}: ${forbidden}`)
    }
  }
  // The only mention of these words is the promise that such controls do not exist.
  const copy = readFileSync(
    join(import.meta.dirname, '..', 'src', 'lib', 'residentCommunity.ts'),
    'utf8',
  )
  assert.match(copy, /没有切换、解绑或重绑入口/)
})

test('the H5 read/write paths come only from the shared contract constants', () => {
  const source = readSourceTree(join(import.meta.dirname, '..', 'src'))
  // The service builds both URLs from RESIDENT_COMMUNITY_ROUTES, so the literal
  // paths may appear only in the shared contract module, never hand-written here.
  assert.equal(source.includes("'/resident-community/status'"), false)
  assert.equal(source.includes("'/resident-community/confirm'"), false)
  assert.match(source, /RESIDENT_COMMUNITY_ROUTES\.status/)
  assert.match(source, /RESIDENT_COMMUNITY_ROUTES\.confirm/)

  // The confirm body is exactly `{ communityId }`: no identity/source/time field
  // is ever sent, so a resident cannot claim who confirmed for whom.
  const transport = readFileSync(
    join(import.meta.dirname, '..', 'src', 'services', 'residentCommunity.ts'),
    'utf8',
  )
  assert.match(transport, /body: \{ communityId \}/)
  assert.equal(transport.includes('confirmedAt'), false)
  assert.equal(transport.includes('source:'), false)
  assert.equal(transport.includes('userId'), false)
})

function readSourceTree(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry)) files.push(readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return files.join('\n')
}
