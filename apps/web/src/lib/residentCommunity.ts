import type {
  ResidentCommunityConfirmBlockedReason,
  ResidentCommunityStatus,
  ResidentCommunityStatusResponse,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Pure residency-community presentation rules (#171 LL-IDENTITY-001).
 *
 * The resident surface separates three facts that must never be conflated:
 *
 * 1. the **browsing** community — `localStorage`, freely switchable (#149);
 * 2. the **permanent** community — read only from `GET /resident-community/status`,
 *    confirmed once by the resident themself;
 * 3. the **historical** `resident_community_assignments` rows — read-only facts
 *    that never prove a resident confirmed anything.
 *
 * Nothing in this module may turn a browse choice into a binding claim: there is
 * no function that derives a community id from `localStorage` for a write. The
 * confirm request carries only the community the resident is looking at, and the
 * API re-reads that community itself.
 *
 * The copy lives here (not inline in the pages) so the "binding cannot be changed"
 * promise, the browse-only promise and the refusal reasons are testable without a
 * DOM and cannot drift between the discovery home, 我的 and the confirm page.
 */

/** Shown next to every permanent-community confirmation surface. */
export const PERMANENT_BINDING_NOTICE =
  '常驻社区由你本人首次确认，确认后不可修改：居民端没有切换、解绑或重绑入口。'

/** Shown wherever the browsing selector is offered. */
export const BROWSE_ONLY_NOTICE =
  '切换社区只改变你正在浏览的公开内容，不会改变你的常驻社区。'

/** The discovery page's location feature is a recommendation, never proof. */
export const LOCATION_NOT_PROOF_NOTICE =
  '定位只用于推荐附近社区，不作为居住证明，也不会自动确认常驻社区。'

/** Ready-made query target for the explicit first-confirmation page. */
export const RESIDENT_COMMUNITY_PAGE = '/me/community'
export const RESIDENT_COMMUNITY_CONFIRM_PAGE = '/me/community/confirm'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A community id is a real UUID; anything else is refused before navigation. */
export function isCommunityId(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * Confirm-page URL for one community. `communityId` is a browsing target the
 * resident is looking at — the API still re-reads the row and owns the decision.
 */
export function residentCommunityConfirmHref(communityId: string): string {
  return `${RESIDENT_COMMUNITY_CONFIRM_PAGE}?communityId=${encodeURIComponent(communityId)}`
}

/** Read the target of the confirm page from a query string. */
export function readConfirmCommunityId(search: string): string | null {
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('communityId')
  return isCommunityId(value) ? value : null
}

/**
 * Confirm-page URL that keeps the entry context a resident arrived with.
 *
 * `activityId`, `invite`/`inviteInvalid` must survive a login round trip: the
 * activity page already treats them as UX context, and dropping them here would
 * silently lose an invitation. Only contract-shaped values are forwarded (an
 * activity id is a UUID, an invite code is 32 hex chars); anything else is left
 * behind rather than passed through. All other parameters are ignored.
 */
export function residentCommunityConfirmHrefWithContext(
  communityId: string,
  search: string,
): string {
  const source = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const params = new URLSearchParams({ communityId })
  const activityId = source.get('activityId')
  if (isCommunityId(activityId)) params.set('activityId', activityId)
  const invite = source.get('invite')
  if (invite && /^[0-9a-f]{32}$/i.test(invite)) params.set('invite', invite)
  if (source.get('inviteInvalid') === '1') params.set('inviteInvalid', '1')
  return `${RESIDENT_COMMUNITY_CONFIRM_PAGE}?${params.toString()}`
}

export interface ResidentCommunitySummary {
  badge: string
  title: string
  detail: string
}

/** 未绑定 / 已确认 / 待核查 / 冲突 — the four resident-readable states. */
export function residentCommunitySummary(
  data: ResidentCommunityStatusResponse,
): ResidentCommunitySummary {
  switch (data.status) {
    case 'confirmed': {
      const binding = data.binding
      return {
        badge: '已确认',
        title: binding ? binding.community.name : '已确认常驻社区',
        detail: binding
          ? `确认日期：${formatResidentCommunityDate(binding.confirmedAt)}。${PERMANENT_BINDING_NOTICE}`
          : PERMANENT_BINDING_NOTICE,
      }
    }
    case 'conflict': {
      const bindingName = data.binding?.community.name ?? '已确认的常驻社区'
      const candidateName = data.candidate?.community.name ?? '你正在浏览的社区'
      return {
        badge: '不可修改',
        title: bindingName,
        detail: `「${candidateName}」不是你的常驻社区。常驻社区已确认为「${bindingName}」，不能改为「${candidateName}」；你仍可以浏览「${candidateName}」的公开内容。`,
      }
    }
    case 'pending_review':
      return {
        badge: '待核查',
        title: '历史社区归属待核查',
        detail: `该账户存在 ${data.legacyHistory.assignmentCount} 条历史社区归属，需要人工核查后才能确认常驻社区；系统不会自动挑选其中一条，也不会随机锁定。`,
      }
    case 'unbound':
    default:
      return {
        badge: '未绑定',
        title: '尚未确认常驻社区',
        detail: data.candidate
          ? `可确认的候选社区：${data.candidate.community.name}。需要你本人主动确认，确认前不产生任何归属。`
          : '先选一个要浏览的社区，再由你本人主动确认；浏览和定位都不会自动产生归属。',
      }
  }
}

/** Resident-readable reason a confirmation is closed. */
export function confirmBlockedMessage(
  reason: ResidentCommunityConfirmBlockedReason,
): string {
  switch (reason) {
    case 'already_confirmed':
      return '你已确认常驻社区，不能再次确认或修改。'
    case 'pending_review':
      return '该账户存在多条历史社区归属，需人工核查后才能确认常驻社区。'
    case 'candidate_conflict':
      return '你已确认的常驻社区与这个社区不同，不能改为其他社区。'
    default:
      return '当前无法确认常驻社区。'
  }
}

/** True only when the resident may press the explicit confirmation. */
export function canOfferConfirmation(data: ResidentCommunityStatusResponse): boolean {
  return data.canConfirm && data.status === 'unbound' && data.confirmBlockedReason === null
}

/**
 * Browse-vs-binding sentence. Visiting another community is allowed and must
 * never read as if the permanent community changed, so the sentence names both
 * facts and states that switching only affects browsing.
 */
export function browseBindingNotice(input: {
  browsingCommunityId: string | null
  browsingCommunityName: string | null
  bindingCommunityId: string | null
  bindingCommunityName: string | null
}): string | null {
  const { browsingCommunityId, browsingCommunityName, bindingCommunityId, bindingCommunityName } = input
  if (!browsingCommunityId || !bindingCommunityId) return null
  if (browsingCommunityId === bindingCommunityId) {
    return '当前浏览社区就是你的常驻社区。'
  }
  return `你正在浏览「${browsingCommunityName ?? '其他社区'}」，常驻社区仍是「${bindingCommunityName ?? '已确认的社区'}」。${BROWSE_ONLY_NOTICE}`
}

/** Read-only historical relations, one `名称 · 日期` line per row. */
export function legacyAssignmentLines(data: ResidentCommunityStatusResponse): string[] {
  return data.legacyHistory.assignments.map(
    (row) => `${row.community.name} · 记录于 ${formatResidentCommunityDate(row.assignedAt)}`,
  )
}

/** `2026年11月11日` in Beijing time; unknown values are labelled, never guessed. */
export function formatResidentCommunityDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '日期未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

export interface ResidentCommunityErrorShape {
  code: string | null
  status: number
  message: string
}

/**
 * Resident-readable copy for a real confirmation failure.
 *
 * The shared error codes are refusals, not repairs: a conflict keeps the existing
 * binding, a multi-community account waits for a human. The API message is used
 * verbatim only when no specific rule applies, so the UI never invents a cause.
 */
export function confirmationErrorMessage(error: ResidentCommunityErrorShape): string {
  switch (error.code) {
    case 'resident_community_conflict':
      return '你已确认过其他常驻社区，本次不会修改原绑定。你仍可以浏览这个社区的公开内容。'
    case 'resident_community_pending_review':
      return '该账户存在多条历史社区归属，需人工核查后才能确认常驻社区。'
    case 'resident_community_not_found':
      return '这个社区不存在或已下线，无法绑定。请返回重新选择社区。'
    case 'resident_community_already_confirmed':
      return '你已确认常驻社区，不能再次确认或修改。'
    case 'resident_community_not_bound':
      return '请先确认常驻社区，再进行社区内的操作。'
    default:
      break
  }
  if (error.status === 401 || error.code === 'unauthorized') {
    return '登录状态已失效，请重新登录后再确认。'
  }
  if (error.status === 403 || error.code === 'forbidden') {
    return `本次确认未被接受：${error.message}`
  }
  if (error.status === 0 || error.code === 'network_error') {
    return '暂时无法连接服务，请检查网络后重试。'
  }
  return error.message
}

/**
 * Resident copy for the community-scope refusals (#171 LL-IDENTITY-001).
 *
 * Community-scoped writes — today's draw, participation, teams, local orders —
 * are refused with `403 resident_community_not_bound` (no confirmation yet) or
 * `403 resident_community_conflict` (confirmed for a different community). The
 * copy names the real reason and never suggests the resident can re-bind: a
 * conflict is a refusal, not a repair path. Returns `null` for other codes so a
 * caller keeps its own message.
 */
export function residentScopeRefusalText(
  code: string | null | undefined,
  serverMessage: string | null = null,
): string | null {
  if (code === 'resident_community_not_bound') {
    return '请先在「我的」中确认常驻社区，再进行社区内的操作。浏览其他社区不受影响。'
  }
  if (code === 'resident_community_conflict') {
    const detail = serverMessage ? `（${serverMessage}）` : ''
    return `你已确认的常驻社区不是这里，因此不能在这里进行社区内的操作${detail}。常驻社区确认后不能自行修改，你仍可以浏览这里的公开内容。`
  }
  return null
}

/** The value shown in the confirm button's irreversible warning. */export function irreversibleWarning(communityName: string, serviceAddress: string | null): string {
  return `确认后，你的常驻社区将固定为「${communityName}」${serviceAddress ? `（服务点：${serviceAddress}）` : ''}，之后无法在居民端自行修改。`
}

/** Every resident state a card/badge may render, from the shared enum. */
export function residentCommunityStatusLabel(status: ResidentCommunityStatus): string {
  switch (status) {
    case 'confirmed':
      return '已确认常驻社区'
    case 'pending_review':
      return '历史归属待核查'
    case 'conflict':
      return '存在冲突'
    case 'unbound':
    default:
      return '未绑定常驻社区'
  }
}
