import {
  CRM_ORDER_STATUS_TRANSITIONS,
  CRM_LEAD_STATUS_TRANSITIONS,
  type CrmBusinessType,
  type CrmLeadSourceType,
  type CrmLeadStatus,
  type CrmOrderTransitionStatus,
  type CrmServiceOrderStatus,
  type StaffRole,
} from '@sanchuang-dev/local-life-contracts'

export const leadSourceLabels: Record<CrmLeadSourceType, string> = {
  activity: '活动来源',
  grid_promotion: '网格员推广',
  walk_in: '到访登记',
  resident_referral: '居民转介',
}

export const leadSourceDescriptions: Record<CrmLeadSourceType, string> = {
  activity: '来自社区活动的参与/报名线索',
  grid_promotion: '网格员在社区推广时登记',
  walk_in: '居民到访社区服务点登记',
  resident_referral: '由居民转介并已明确告知',
}

export const leadStatusLabels: Record<CrmLeadStatus, string> = {
  new: '新线索',
  contacting: '跟进中',
  converted: '已成交',
  invalid: '无效线索',
}

export const businessTypeLabels: Record<CrmBusinessType, string> = {
  gd_mobile: '广电手机卡',
  gd_tv: '广电电视业务',
}

export const orderStatusLabels: Record<CrmServiceOrderStatus, string> = {
  submitted: '已提交受理',
  processing: '处理中',
  pending_verification: '待运营核验',
  confirmed: '有效成交（人工核验）',
  failed: '失败',
  cancelled: '已取消',
}

export const orderStatusDescriptions: Record<CrmServiceOrderStatus, string> = {
  submitted: '受理单已登记，尚未进入处理。',
  processing: '网格员已提交处理，尚未送运营核验。',
  pending_verification: '等待运营人员人工核验，尚未确认成交。',
  confirmed: '运营人员已人工核验为有效成交，非运营商侧回执。',
  failed: '该受理未通过核验或处理失败。',
  cancelled: '受理单已取消，不会计入成交。',
}

export const leadStatusDescriptions: Record<CrmLeadStatus, string> = {
  new: '新登记线索，尚未开始跟进。',
  contacting: '正在联系或已联系，继续跟进。',
  converted: '该线索下已有运营人工核验的有效成交单。',
  invalid: '已确认无效，不再继续跟进。',
}

export const staffRoleLabels: Record<StaffRole, string> = {
  admin: '管理员',
  operator: '运营员',
  grid_worker: '网格员',
}

export const leadStatusOptions = (Object.keys(leadStatusLabels) as CrmLeadStatus[]).map((value) => ({
  value,
  label: leadStatusLabels[value],
}))

export const leadSourceOptions = (Object.keys(leadSourceLabels) as CrmLeadSourceType[]).map(
  (value) => ({ value, label: leadSourceLabels[value] }),
)

export const businessTypeOptions = (Object.keys(businessTypeLabels) as CrmBusinessType[]).map(
  (value) => ({ value, label: businessTypeLabels[value] }),
)

export const orderStatusOptions = (
  Object.keys(orderStatusLabels) as CrmServiceOrderStatus[]
).map((value) => ({ value, label: orderStatusLabels[value] }))

export type LeadStatusAction = {
  status: 'contacting' | 'invalid'
  label: string
}

/**
 * Grid workers may only apply the two manual lead transitions. `converted` is
 * system-only and must never appear as a button.
 */
export function leadStatusActions(current: CrmLeadStatus): LeadStatusAction[] {
  const allowed = CRM_LEAD_STATUS_TRANSITIONS[current]
  return allowed
    .filter((status): status is 'contacting' | 'invalid' => status !== 'converted')
    .map((status) => ({ status, label: status === 'contacting' ? '标记跟进中' : '标记无效' }))
}

export type OrderStatusAction = {
  status: Exclude<CrmOrderTransitionStatus, 'processing'> | 'processing'
  label: string
  tone: 'primary' | 'secondary' | 'danger'
}

/**
 * Actions a grid worker can take. `confirmed` is deliberately absent: only the
 * operator review endpoint can verify an order, so H5 must never offer it.
 */
export function orderStatusActions(current: CrmServiceOrderStatus): OrderStatusAction[] {
  const allowed = CRM_ORDER_STATUS_TRANSITIONS[current].filter((status) => status !== 'confirmed')
  return allowed.map((status) => {
    if (status === 'processing') {
      return { status, label: '提交处理中', tone: 'primary' as const }
    }
    if (status === 'pending_verification') {
      return { status, label: '提交运营核验', tone: 'primary' as const }
    }
    if (status === 'cancelled') {
      return { status, label: '取消受理单', tone: 'danger' as const }
    }
    return { status: 'failed' as const, label: '标记失败', tone: 'secondary' as const }
  })
}

/** Convert a server ISO timestamp to the local `datetime-local` input value. */
export function isoToDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Convert a `datetime-local` value to the API's ISO-8601 UTC timestamp. */
export function datetimeLocalToIso(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export function formatCrmDateTime(iso: string | null): string {
  if (!iso) return '未设置'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function isNextContactOverdue(iso: string | null): boolean {
  if (!iso) return false
  const time = Date.parse(iso)
  return Number.isFinite(time) && time < Date.now()
}

export function nextContactLabel(iso: string | null): string {
  if (!iso) return '未设置下次联系'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  const prefix = isNextContactOverdue(iso) ? '已逾期 · ' : sameDay ? '今日 · ' : ''
  return `${prefix}${formatCrmDateTime(iso)}`
}
