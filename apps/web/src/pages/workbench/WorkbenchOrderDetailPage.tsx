import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  BadgeCheck,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  Phone,
  StickyNote,
} from 'lucide-react'
import type {
  CrmOrderDetail,
  CrmOrderEvent,
  CrmServiceOrderStatus,
} from '@sanchuang-dev/local-life-contracts'
import { useCrmApi } from '../../hooks/useCrmApi'
import { useAsyncResource } from '../../hooks/useAsyncResource'
import { StaffGate } from '../../components/crm/StaffGate'
import {
  CrmBadge,
  ErrorBlock,
  EventTimeline,
  Field,
  InfoRow,
  LoadingBlock,
  StatusNotice,
  TextLink,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
  type TimelineEntry,
} from '../../components/crm/WorkbenchUi'
import {
  businessTypeLabels,
  formatCrmDateTime,
  orderStatusActions,
  orderStatusDescriptions,
  orderStatusLabels,
  type OrderStatusAction,
} from '../../components/crm/crmLabels'

const orderEventLabels: Record<string, string> = {
  'order.created': '受理单创建',
  'order.status_changed': '受理状态变更',
  'order.reviewed': '运营人工核验',
}

function orderTone(status: CrmServiceOrderStatus) {
  if (status === 'confirmed') return 'mint' as const
  if (status === 'failed') return 'rose' as const
  if (status === 'processing' || status === 'pending_verification') return 'amber' as const
  return 'slate' as const
}

function eventDescription(event: CrmOrderEvent): string {
  const parts: string[] = []
  if (event.fromStatus || event.toStatus) {
    parts.push(
      `${event.fromStatus ? orderStatusLabels[event.fromStatus] : '—'} → ${
        event.toStatus ? orderStatusLabels[event.toStatus] : '—'
      }`,
    )
  }
  if (event.note) parts.push(event.note)
  return parts.join('；')
}

function OrderDetailContent({ order, reload }: { order: CrmOrderDetail; reload: () => void }) {
  const api = useCrmApi()
  const [draft, setDraft] = useState<OrderStatusAction | null>(null)
  const [note, setNote] = useState('')
  const [failureReason, setFailureReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const actions = orderStatusActions(order.status)
  const timeline = useMemo<TimelineEntry[]>(
    () =>
      [...order.events]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((event) => ({
          id: event.id,
          title: orderEventLabels[event.event] ?? event.event,
          time: formatCrmDateTime(event.createdAt),
          description: eventDescription(event) || undefined,
          tone:
            event.event === 'order.reviewed'
              ? event.toStatus === 'confirmed'
                ? 'mint'
                : 'rose'
              : 'slate',
        })),
    [order.events],
  )

  // Only a human-verified order may be described as effective conversion.
  const attributionLabel =
    order.status === 'confirmed'
      ? '有效成交归属'
      : order.status === 'pending_verification'
        ? '待核验归属（不计成交）'
        : '归属快照（不计成交）'

  const submitTransition = async () => {
    if (!draft) return
    if (draft.status === 'failed' && !failureReason.trim()) {
      setError('标记失败时必须填写失败原因')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      await api.updateOrderStatus(order.id, {
        expectedUpdatedAt: order.updatedAt,
        status: draft.status,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(draft.status === 'failed' ? { failureReason: failureReason.trim() } : {}),
      })
      setSuccess(`受理单状态已更新为“${orderStatusLabels[draft.status]}”`)
      setDraft(null)
      setNote('')
      setFailureReason('')
      reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新受理单状态失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
              广电业务受理单
            </p>
            <h1 className="mt-0.5 truncate text-[21px] font-semibold tracking-tight text-slate-900">
              {order.orderNo}
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {businessTypeLabels[order.businessType]} · {order.community.name}
            </p>
          </div>
          <CrmBadge tone={orderTone(order.status)}>{orderStatusLabels[order.status]}</CrmBadge>
        </div>

        <div
          className={`mt-3 rounded-[14px] px-3.5 py-3 text-[12px] leading-5 ${
            order.status === 'confirmed'
              ? 'bg-[#e8f6f0] text-[#2f6b5d]'
              : order.status === 'failed'
                ? 'bg-rose-50 text-rose-700'
                : order.status === 'pending_verification'
                  ? 'bg-[#fff7ec] text-[#8a6132]'
                  : 'bg-slate-50 text-slate-600'
          }`}
        >
          <div className="flex items-start gap-2">
            {order.status === 'confirmed' ? (
              <BadgeCheck size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : order.status === 'pending_verification' ? (
              <Clock3 size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : order.status === 'failed' ? (
              <CircleAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <ClipboardCheck size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="font-semibold">{orderStatusLabels[order.status]}</p>
              <p className="mt-0.5 text-[11px] leading-5 opacity-90">
                {orderStatusDescriptions[order.status]}
              </p>
              {order.status === 'pending_verification' ? (
                <p className="mt-1 text-[11px] font-medium">
                  尚未成交：请等待运营人员在后台人工核验，不要向居民承诺业务已完成。
                </p>
              ) : null}
              {order.status === 'confirmed' && order.confirmation ? (
                <p className="mt-1 text-[11px] leading-5">
                  核验人：{order.confirmation.confirmedBy?.displayName ?? '运营人员'} ·{' '}
                  {formatCrmDateTime(order.confirmation.confirmedAt)}
                  {order.confirmation.note ? ` · ${order.confirmation.note}` : ''}
                </p>
              ) : null}
              {order.status === 'confirmed' ? (
                <p className="mt-1 text-[11px] font-medium">
                  该结果来自运营人工核验（activationSource=manual_verification），不是运营商侧回执。
                </p>
              ) : null}
              {order.status === 'failed' && order.failureReason ? (
                <p className="mt-1 text-[11px] leading-5">失败原因：{order.failureReason}</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2">
          <a
            href={`tel:${order.contactPhone}`}
            className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-teal-200 bg-teal-50/50 px-3 text-[13px] font-semibold text-teal-700"
          >
            <span className="min-w-0 truncate">
              {order.customerName} · {order.contactPhone}
            </span>
            <Phone size={15} aria-hidden="true" />
          </a>
          {order.confirmation?.confirmedBy ? null : (
            <p className="text-[11px] leading-5 text-slate-400">
              仅显示当前受理单的必要联系人信息，不导出居民名册。
            </p>
          )}
        </div>

        <dl className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          <InfoRow label="业务类型" value={businessTypeLabels[order.businessType]} />
          <InfoRow
            label="关联线索"
            value={
              <Link
                to={`/workbench/leads/${order.leadId}`}
                className="inline-flex min-h-11 items-center gap-1 text-teal-700"
              >
                {order.customerName}
                <ExternalLink size={12} aria-hidden="true" />
              </Link>
            }
          />
          <InfoRow label="登记人" value={order.createdByStaff.displayName ?? '未命名'} />
          <InfoRow label="创建时间" value={formatCrmDateTime(order.createdAt)} />
          <InfoRow label="最近更新" value={formatCrmDateTime(order.updatedAt)} />
        </dl>
      </section>

      {success ? (
        <div className="mt-3">
          <StatusNotice tone="success">{success}</StatusNotice>
        </div>
      ) : null}

      <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">成交归属快照</h2>
        <p className="mt-0.5 text-[11px] leading-5 text-slate-400">
          创建时冻结，后续线索转交不会改写本受理单归属。
        </p>
        <dl className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
          <InfoRow label={attributionLabel} value={order.attributedStaff.displayName ?? '未命名网格员'} />
          {order.sourceActivity ? <InfoRow label="来源活动" value={order.sourceActivity.title} /> : null}
          {order.promotionStaff ? (
            <InfoRow label="推广网格员" value={order.promotionStaff.displayName ?? '未命名'} />
          ) : null}
        </dl>
      </section>

      <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">受理信息</h2>
        <dl className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
          <InfoRow label="受理单号" value={order.orderNo} />
          <InfoRow label="脱敏凭据引用" value={order.evidenceRef || '未填写'} />
          <InfoRow
            label="备注"
            value={order.notes ? <span className="whitespace-pre-wrap">{order.notes}</span> : '无'}
          />
          <InfoRow
            label="核验来源"
            value={
              order.activationSource === 'manual_verification'
                ? '运营人工核验（manual_verification）'
                : '尚未产生有效成交'
            }
          />
        </dl>
        <div className="mt-2 flex items-start gap-2 rounded-[12px] bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">
          <StickyNote size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            只登记脱敏凭据引用，禁止填写身份证号、银行卡号、运营商密码或完整证件照片。
          </p>
        </div>
      </section>

      <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">状态流转</h2>
        <p className="mt-1 text-[11px] leading-5 text-slate-400">
          只能按服务端允许的动作提交；“确认有效成交”仅由运营后台人工核验完成。
        </p>

        {actions.length === 0 ? (
          <p className="mt-3 rounded-[12px] bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-500">
            {order.status === 'confirmed'
              ? '已由运营核验为有效成交，状态锁定，工作台不可再修改。'
              : '当前状态为终态，不可再流转。'}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.map((action) => (
              <button
                key={action.status}
                type="button"
                onClick={() => {
                  setDraft(action)
                  setError(null)
                }}
                className={`${action.tone === 'primary' ? primaryButtonClassName : secondaryButtonClassName} flex-1`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {draft ? (
          <div className="mt-3 rounded-[14px] bg-slate-50 p-3">
            <p className="text-[12px] font-semibold text-slate-700">
              确认执行“{draft.label}”？
            </p>
            <p className="mt-0.5 text-[11px] leading-5 text-slate-400">
              将提交给服务端校验状态机与并发版本；旧页面会被 409 拒绝。
            </p>
            {draft.status === 'failed' ? (
              <Field label="失败原因" htmlFor="order-failure-reason" required>
                <textarea
                  id="order-failure-reason"
                  rows={2}
                  maxLength={500}
                  value={failureReason}
                  onChange={(event) => setFailureReason(event.target.value)}
                  className={`${inputClassName} resize-none py-2.5`}
                  placeholder="例如：居民取消办理 / 资料不符"
                />
              </Field>
            ) : null}
            <Field label="备注（可选）" htmlFor="order-transition-note">
              <textarea
                id="order-transition-note"
                rows={2}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className={`${inputClassName} resize-none py-2.5`}
                placeholder="补充本次操作说明"
              />
            </Field>
            {error ? (
              <div className="mt-2">
                <StatusNotice tone="error">{error}</StatusNotice>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null)
                    setError(null)
                    reload()
                  }}
                  className={`${secondaryButtonClassName} mt-2 min-h-10 px-3`}
                >
                  刷新受理单
                </button>
              </div>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void submitTransition()}
                className={`${primaryButtonClassName} flex-1`}
              >
                {busy ? '提交中…' : '确认提交'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null)
                  setError(null)
                }}
                className={`${secondaryButtonClassName} flex-1`}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">事件时间线</h2>
        <p className="mt-0.5 text-[11px] text-slate-400">来自服务端追加式审计事件</p>
        <div className="mt-3">
          <EventTimeline entries={timeline} emptyText="暂无事件记录" />
        </div>
      </section>

      <div className="mt-4">
        <TextLink to="/workbench/orders">返回我的受理单</TextLink>
      </div>
      <div className="mt-1">
        <TextLink to={`/workbench/leads/${order.leadId}`}>查看关联线索</TextLink>
      </div>
    </>
  )
}

function OrderDetailView({ orderId }: { orderId: string }) {
  const api = useCrmApi()
  const resource = useAsyncResource(`order:${orderId}`, (signal) => api.getOrder(orderId, signal))

  return (
    <div className="px-4 pb-8 pt-4">
      {resource.state.status === 'loading' ? <LoadingBlock label="正在加载受理单…" /> : null}
      {resource.state.status === 'error' ? (
        <ErrorBlock message={resource.state.message} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        <OrderDetailContent order={resource.state.data} reload={resource.reload} />
      ) : null}
    </div>
  )
}

export function WorkbenchOrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>()
  return (
    <StaffGate>
      {orderId ? (
        <OrderDetailView orderId={orderId} />
      ) : (
        <div className="px-4 pt-4">
          <ErrorBlock title="受理单不存在" message="缺少受理单 ID，无法加载详情。" />
        </div>
      )}
    </StaffGate>
  )
}
