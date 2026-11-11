import type {
  UserCommunityRelationSource,
  UserDirectoryEntry,
  UserResidentCommunityState,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Read-only presentation rules for a resident's permanent community in the back
 * office (#171 LL-IDENTITY-001).
 *
 * The contract keeps three facts apart and this module is the only place that
 * turns them into back-office copy:
 *
 * - `confirmedCommunity` — the resident's own confirmation, read from
 *   `resident_community_bindings`. The ONLY field that may be labelled
 *   「已确认常驻社区」.
 * - `residentCommunities` — historical `resident_community_assignments` rows.
 *   Since #171 these prove a relation was *observed*, never that the resident
 *   confirmed it, so they are labelled 历史归属 and must never be promoted.
 * - `communityRelationSource` — which of the above explains the account, including
 *   `out_of_scope` (a confirmation exists outside the caller's authorization) and
 *   `none`.
 *
 * Two absences are NOT the same as 「未绑定」 and must not be rendered as it:
 *
 * - `communityRelationSource` missing from the payload (the API always sends it;
 *   an absent value is an unknown fact, so the cell says so instead of guessing);
 * - `residentCommunityState: null`, which the contract defines as "not derivable
 *   for this community-scoped operator", never as `unbound`.
 *
 * There is deliberately no mutation helper here: no admin route can create, change
 * or delete a binding, and the page exposes no such control.
 */

/** Short badge for the resident's own #171 state, or `null` when not derivable. */
export function residentStateBadge(
  state: UserResidentCommunityState | null | undefined,
): { label: string; tone: 'success' | 'warning' | 'error' | 'neutral'; hint: string } | null {
  switch (state) {
    case 'confirmed':
      return {
        label: '已确认常驻社区',
        tone: 'success',
        hint: '该居民本人已在居民端确认常驻社区；后台只读，不可代为变更。',
      }
    case 'unbound':
      return {
        label: '待绑定',
        tone: 'warning',
        hint: '该居民尚未确认常驻社区；只能由本人首次确认，后台不能代选。',
      }
    case 'pending_review':
      return {
        label: '历史待核查',
        tone: 'warning',
        hint: '存在多条历史社区关系，需人工核查归属；核查完成前不视为已确认常驻社区，后台不能代选。',
      }
    case 'conflict':
      return {
        label: '常驻社区冲突',
        tone: 'error',
        hint: '历史关系与确认结果不一致，需人工核查；后台不提供改绑入口。',
      }
    default:
      // `null` = not derivable for this caller; `undefined` = not in the payload.
      return null
  }
}

/** Why the caller cannot see this account's #171 state, in operator words. */
export function residentStateUnavailableReason(
  state: UserResidentCommunityState | null | undefined,
): string | null {
  if (state !== null && state !== undefined) return null
  return state === null
    ? '该账户的常驻社区状态只对管理员计算；社区维度的账号不会据此推断为未绑定。'
    : '响应未包含常驻社区状态，后台不据此推断。'
}

/**
 * The relation fact for one account, as a short human sentence.
 *
 * Deliberately worded so the historical case can never be read as a confirmation,
 * and so an out-of-scope confirmation can never be read as 「未关联」. The same
 * function serves both directory contracts (`/admin/users` reports four sources
 * including `out_of_scope` and `none`; the legacy community-rooted
 * `/crm/residents` reports only `confirmed_binding` / `historical_assignment`),
 * because the two shared values must read identically wherever they appear.
 */
export function describeCommunityRelation(entry: {
  communityRelationSource?: UserCommunityRelationSource
  confirmedCommunity?: { name: string; confirmedAt: string } | null
  residentCommunities?: ReadonlyArray<{ name: string }>
}): { label: string; tone: 'success' | 'warning' | 'error' | 'neutral'; detail: string } {
  const historyCount = entry.residentCommunities?.length ?? 0
  switch (entry.communityRelationSource) {
    case 'confirmed_binding': {
      const community = entry.confirmedCommunity ?? null
      return {
        label: '已确认常驻',
        tone: 'success',
        detail: community
          ? `本人确认的常驻社区：${community.name}（确认时间 ${formatBackOfficeDate(community.confirmedAt)}）。`
          : '本人已确认常驻社区，但响应未附带社区明细。',
      }
    }
    case 'historical_assignment':
      return {
        label: '历史归属（未确认）',
        tone: 'warning',
        detail:
          historyCount > 0
            ? `只有 ${historyCount} 条历史社区关系记录，本人尚未确认常驻社区；历史记录不能作为常驻社区，也不构成任何权限。`
            : '只有历史社区关系记录，本人尚未确认常驻社区；历史记录不能作为常驻社区，也不构成任何权限。',
      }
    case 'out_of_scope':
      return {
        label: '授权范围外已确认',
        tone: 'neutral',
        detail:
          '该居民已确认常驻社区，但那个社区不在你的授权范围内，因此在此不展示其名称；这不代表「未关联社区」。',
      }
    case 'none':
      return {
        label: '未关联社区',
        tone: 'warning',
        detail: '该账号尚未确认常驻社区，也没有任何历史社区关系记录。',
      }
    default:
      return {
        label: '归属状态未知',
        tone: 'neutral',
        detail: '响应未包含社区归属来源，后台不据此推断；如持续出现请检查服务端版本。',
      }
  }
}

/**
 * What to print in the drawer's 「常驻社区」 row when there is no
 * `confirmedCommunity`. Every branch keeps history and scope withholding apart.
 */
export function confirmedCommunityAbsenceText(entry: {
  communityRelationSource?: UserCommunityRelationSource
}): string {
  switch (entry.communityRelationSource) {
    case 'confirmed_binding':
      return '本人已确认常驻社区，但响应未附带社区明细。'
    case 'historical_assignment':
      return '尚未确认常驻社区；现有记录只是历史归属，不能当作常驻社区。'
    case 'out_of_scope':
      return '已确认常驻社区，但该社区不在你的授权范围内，此处不展示名称（不代表未关联社区）。'
    case 'none':
      return '未关联社区（账号真实存在，可正常登录）'
    default:
      return '响应未包含常驻社区信息，后台不据此推断。'
  }
}

/**
 * Every community a row may show in the list cell, already labelled by kind.
 *
 * The confirmed community comes first (it is the only permanent fact) and the
 * historical ones are marked as history so they cannot be miscounted as
 * confirmations.
 */
export function communityCellEntries(entry: UserDirectoryEntry): Array<{
  id: string
  name: string
  kind: 'confirmed' | 'historical'
}> {
  const confirmed = entry.confirmedCommunity ?? null
  const historical = entry.residentCommunities ?? []
  return [
    ...(confirmed ? [{ id: confirmed.id, name: confirmed.name, kind: 'confirmed' as const }] : []),
    ...historical
      .filter((community) => community.id !== confirmed?.id)
      .map((community) => ({ id: community.id, name: community.name, kind: 'historical' as const })),
  ]
}

/** `2026年11月11日` in Beijing time; an unknown value is labelled, never guessed. */
export function formatBackOfficeDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '日期未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

/** Who produced a binding. Both values are written by the API, never the client. */
export function describeBindingSource(source: 'resident_h5_confirmed' | 'admin_compliance_correction'): string {
  return source === 'resident_h5_confirmed' ? '本人在居民端确认' : '合规纠正（已审计）'
}
