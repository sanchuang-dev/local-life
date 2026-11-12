import {
  LOCAL_ORDER_STATUS_TRANSITIONS,
  type LocalOrderStatus,
  type LocalOrderTransitionStatus,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Resident-facing labels for the local order domain (#109).
 *
 * The wording is deliberately *not* the carrier-order wording: `verified` reads
 * 「人工核验通过」 and never 已付款 / 已成交 / 已开通, because the contract has no
 * payment or activation field at all. The same strings are used by the admin
 * console so an operator and a resident cannot describe one order differently.
 */
export const localOrderStatusLabels: Record<LocalOrderStatus, string> = {
  registered: '已登记',
  processing: '处理中',
  pending_review: '待人工核验',
  verified: '人工核验通过',
  cancelled: '已取消',
  rejected: '未通过',
}

export const localOrderStatusDescriptions: Record<LocalOrderStatus, string> = {
  registered: '办理意向已登记，等待工作人员处理。本平台不收款。',
  processing: '工作人员正在处理你登记的办理意向。',
  pending_review: '等待运营人员人工核验登记信息。',
  verified: '运营人员已人工核验订单事实；这不代表收款或业务办理已完成。',
  cancelled: '该订单已取消。',
  rejected: '该订单未通过，原因见订单详情。',
}

type Tone = 'mint' | 'amber' | 'rose' | 'slate' | 'teal'

export function localOrderStatusTone(status: LocalOrderStatus): Tone {
  if (status === 'verified') return 'mint'
  if (status === 'pending_review' || status === 'processing') return 'amber'
  if (status === 'rejected') return 'rose'
  if (status === 'cancelled') return 'slate'
  return 'teal'
}

export const localOrderStatusOrder: LocalOrderStatus[] = [
  'registered',
  'processing',
  'pending_review',
  'verified',
  'cancelled',
  'rejected',
]

export type LocalOrderTransitionAction = {
  status: LocalOrderTransitionStatus
  label: string
  tone: 'primary' | 'secondary' | 'danger'
  /** A rejection may not be submitted without a written reason. */
  requiresNote: boolean
}

/**
 * Workbench handling actions for one order.
 *
 * `verified` is filtered out by construction: it is absent from
 * `localOrderTransitionStatusSchema`, so the only way to reach it is the back
 * office's manual-verification endpoint. The H5 must never offer a button labelled
 * 「核验通过」 or 「完成」 here.
 */
export function localOrderTransitionActions(
  current: LocalOrderStatus,
): LocalOrderTransitionAction[] {
  return LOCAL_ORDER_STATUS_TRANSITIONS[current]
    .filter(
      (status): status is LocalOrderTransitionStatus =>
        status === 'processing' || status === 'pending_review' || status === 'cancelled' || status === 'rejected',
    )
    .map((status) => {
      if (status === 'processing') {
        return { status, label: '开始处理', tone: 'primary' as const, requiresNote: false }
      }
      if (status === 'pending_review') {
        return { status, label: '提交人工核验', tone: 'primary' as const, requiresNote: false }
      }
      if (status === 'cancelled') {
        return { status, label: '取消订单', tone: 'danger' as const, requiresNote: false }
      }
      return { status, label: '标记未通过', tone: 'secondary' as const, requiresNote: true }
    })
}

/** `2026-11-04T02:00:00.000Z` → `2026-11-04 10:00` in Asia/Shanghai. */
export function formatLocalDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-')
}

/** `1230` → `¥12.30`. The server sends integer cents; the H5 only formats them. */
export function formatLocalPriceCents(cents: number): string {
  const safe = Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : 0
  return `¥${(safe / 100).toFixed(2)}`
}
