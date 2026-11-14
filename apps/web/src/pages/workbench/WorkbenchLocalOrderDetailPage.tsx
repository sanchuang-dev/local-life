import { useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { Info, StickyNote } from 'lucide-react'
import type {
  LocalOrderDetail,
  LocalOrderEvent,
  LocalOrderTransitionStatus,
} from '@sanchuang-dev/local-life-contracts'
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
import { describeOrderAttribution } from '../../components/life/localOrderAttribution'
import {
  formatLocalDateTime,
  formatLocalPriceCents,
  localOrderStatusDescriptions,
  localOrderStatusLabels,
  localOrderStatusTone,
  localOrderTransitionActions,
  type LocalOrderTransitionAction,
} from '../../components/life/localOrderLabels'
import { useStaffLocalOrder, useStaffOrderTransition } from '../../hooks/useStaffLocalOrders'
import { useStaffSession } from '../../hooks/useStaffSession'
import { describeLocalError, isLocalApiError } from '../../services/localApi'

const eventLabels: Record<LocalOrderEvent['event'], string> = {
  'order.registered': '居民登记订单',
  'order.created_on_behalf': '工作人员代录订单',
  'order.status_changed': '处理状态变更',
  'order.verified': '运营人工核验通过',
  'order.rejected': '订单未通过',
}

function eventDescription(event: LocalOrderEvent): string | undefined {
  const parts: string[] = []
  if (event.fromStatus || event.toStatus) {
    parts.push(
      `${event.fromStatus ? localOrderStatusLabels[event.fromStatus] : '—'} → ${
        event.toStatus ? localOrderStatusLabels[event.toStatus] : '—'
      }`,
    )
  }
  if (event.note) parts.push(event.note)
  return parts.length > 0 ? parts.join('；') : undefined
}

function OrderContent({ order, onUpdated }: { order: LocalOrderDetail; onUpdated: () => void }) {
  const { session } = useStaffSession()
  const { busy, transition } = useStaffOrderTransition(session?.csrfToken ?? null)
  const [draft, setDraft] = useState<LocalOrderTransitionAction | null>(null)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const actions = localOrderTransitionActions(order.status)
  const timeline = useMemo<TimelineEntry[]>(
    () =>
      [...order.events]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((event) => ({
          id: event.id,
          title: eventLabels[event.event] ?? event.event,
          time: formatLocalDateTime(event.createdAt),
          description: eventDescription(event),
          tone:
            event.event === 'order.verified' ? 'mint' : event.event === 'order.rejected' ? 'rose' : 'slate',
        })),
    [order.events],
  )

  const submit = async () => {
    if (!draft) return
    if (draft.requiresNote && !reason.trim()) {
      setError('标记未通过必须填写原因。')
      return
    }
    setError(null)
    setSuccess(null)
    const noteParts = [reason.trim(), note.trim()].filter(Boolean)
    try {
      await transition(order, draft.status as LocalOrderTransitionStatus, noteParts.join('；') || undefined)
      setSuccess(`订单状态已更新为「${localOrderStatusLabels[draft.status]}」。`)
      setDraft(null)
      setReason('')
      setNote('')
      onUpdated()
    } catch (cause) {
      setError(describeLocalError(cause, '订单状态更新失败'))
      if (isLocalApiError(cause) && cause.status === 409) {
        // Another worker changed the order; reload to show the real current state.
        onUpdated()
      }
    }
  }

  return (
    <>
      <section className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
              本地商品订单
            </p>
            <h1 className="mt-0.5 truncate text-[20px] font-semibold tracking-tight text-slate-900">
              {order.snapshot.productName}
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {order.community.name} · 订单 {order.id.slice(0, 8)}…
            </p>
          </div>
          <CrmBadge tone={localOrderStatusTone(order.status)}>
            {localOrderStatusLabels[order.status]}
          </CrmBadge>
        </div>

        <div className="mt-3 rounded-xl bg-[#fff7ec] px-3.5 py-3 text-[11px] leading-5 text-[#8a6132]">
          <div className="flex items-start gap-2">
            <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold">{localOrderStatusDescriptions[order.status]}</p>
              <p className="mt-1">
                本平台只登记办理意向，不收款、不开通业务。「人工核验通过」只能由运营人员在后台完成，工作台不可直接设置。
              </p>
            </div>
          </div>
        </div>

        <dl className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          <InfoRow label="登记居民" value={order.resident.displayName ?? '未命名居民'} />
          <InfoRow
            label="登记方式"
            value={order.recordSource === 'resident' ? '居民自助登记' : '工作人员代录'}
          />
          {order.createdByStaff ? (
            <InfoRow label="代录工作人员" value={order.createdByStaff.displayName ?? '未命名'} />
          ) : null}
          {order.attributedStaff ? (
            <InfoRow label="归属网格员" value={order.attributedStaff.displayName ?? '未命名'} />
          ) : null}
          {order.sourceActivity ? (
            <InfoRow label="来源活动" value={order.sourceActivity.title} />
          ) : null}
          <InfoRow label="消费团归属" value={describeOrderAttribution(order)} />
          <InfoRow label="登记时间" value={formatLocalDateTime(order.createdAt)} />
          <InfoRow label="最后更新" value={formatLocalDateTime(order.updatedAt)} />
        </dl>
      </section>

      {success ? (
        <div className="mt-3">
          <StatusNotice tone="success">{success}</StatusNotice>
        </div>
      ) : null}

      <section className="mt-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">商品快照</h2>
        <p className="mt-0.5 text-[11px] leading-5 text-slate-400">
          商品后续改价或下架，不影响已登记的订单。
        </p>
        <dl className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
          <InfoRow label="商品名称" value={order.snapshot.productName} />
          <InfoRow label="冻结单价" value={formatLocalPriceCents(order.snapshot.unitPriceCents)} />
          <InfoRow label="数量" value={`${order.snapshot.quantity} 件`} />
          <InfoRow label="合计" value={formatLocalPriceCents(order.snapshot.totalCents)} />
        </dl>
        {order.note ? (
          <div className="mt-2 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">
            <StickyNote size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 break-words">居民备注：{order.note}</p>
          </div>
        ) : null}
        {order.statusNote ? (
          <p className="mt-2 break-words rounded-xl bg-[#fff7ec] px-3 py-2 text-[11px] leading-5 text-[#8a6132]">
            最近处理备注：{order.statusNote}
          </p>
        ) : null}
      </section>

      {order.verification ? (
        <section className="mt-4 rounded-2xl border border-teal-200/70 bg-[#eef7f2] p-4">
          <h2 className="text-[16px] font-semibold text-[#225c4c]">运营人工核验结果</h2>
          <dl className="mt-2 divide-y divide-[#d9ebe2]">
            <InfoRow
              label="核验人"
              value={order.verification.verifiedBy?.displayName ?? '运营人员'}
            />
            <InfoRow label="核验时间" value={formatLocalDateTime(order.verification.verifiedAt)} />
            <InfoRow label="核验备注" value={order.verification.note} />
          </dl>
          <p className="mt-2 text-[11px] leading-5 text-[#52786c]">
            该结论仅为人工事实核验，不代表收款、成交或业务办理已完成。
          </p>
        </section>
      ) : null}

      <section className="mt-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">处理状态</h2>
        <p className="mt-1 text-[11px] leading-5 text-slate-400">
          人工核验通过需由运营人员处理。
        </p>

        {actions.length === 0 ? (
          <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-500">
            {order.status === 'verified'
              ? '已由运营人员人工核验通过，状态锁定，工作台不可再修改。'
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
                className={`${
                  action.tone === 'primary'
                    ? primaryButtonClassName
                    : action.tone === 'danger'
                      ? `${secondaryButtonClassName} border-rose-200 text-rose-600`
                      : secondaryButtonClassName
                } flex-1`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {draft ? (
          <div className="mt-3 rounded-xl bg-slate-50 p-3">
            <p className="text-[12px] font-semibold text-slate-700">
              确认执行「{draft.label}」？
            </p>
            <p className="mt-0.5 text-[11px] leading-5 text-slate-400">
              如果订单已被其他人处理，请刷新后重试。
            </p>
            {draft.requiresNote ? (
              <Field label="未通过原因" htmlFor="local-order-reason" required>
                <textarea
                  id="local-order-reason"
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className={`${inputClassName} resize-none py-2.5`}
                  placeholder="例如：居民取消办理 / 商品已无货"
                />
              </Field>
            ) : null}
            <Field label="备注（可选）" htmlFor="local-order-note">
              <textarea
                id="local-order-note"
                rows={2}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className={`${inputClassName} resize-none py-2.5`}
                placeholder="补充本次操作说明，会写入订单时间线"
              />
            </Field>
            {error ? (
              <div className="mt-2">
                <StatusNotice tone="error">{error}</StatusNotice>
              </div>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
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
                  setReason('')
                  setNote('')
                }}
                className={`${secondaryButtonClassName} flex-1`}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {error && !draft ? (
          <div className="mt-2">
            <StatusNotice tone="error">{error}</StatusNotice>
          </div>
        ) : null}
      </section>

      <section className="mt-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">订单时间线</h2>
        <p className="mt-0.5 text-[11px] text-slate-400">处理记录</p>
        <div className="mt-3">
          <EventTimeline entries={timeline} emptyText="暂无事件记录" />
        </div>
      </section>

      <div className="mt-4">
        <TextLink to="/workbench/local-orders">返回社区订单</TextLink>
      </div>
    </>
  )
}

function LocalOrderDetailView({ orderId }: { orderId: string }) {
  const { session } = useStaffSession()
  const { state, reload } = useStaffLocalOrder({ orderId, enabled: Boolean(session) })

  return (
    <div className="px-4 pb-8 pt-4">
      {state.status === 'loading' ? <LoadingBlock label="正在加载订单详情…" /> : null}
      {state.status === 'error' ? (
        <section>
          <ErrorBlock
            title={state.notFound ? '订单不存在或不在授权社区' : '订单详情加载失败'}
            message={state.message}
            onRetry={state.notFound ? undefined : reload}
          />
          <div className="mt-3">
            <TextLink to="/workbench/local-orders">返回社区订单</TextLink>
          </div>
        </section>
      ) : null}
      {state.status === 'ready' ? (
        <OrderContent order={state.order} onUpdated={reload} />
      ) : null}
    </div>
  )
}

/**
 * `/workbench/local-orders/:localOrderId` — one order inside the worker's scope.
 *
 * Reading goes through `/staff/local-orders/:id` (all staff roles, community
 * scoped); an order outside the assignment answers 404 and is shown as such. The
 * status actions come from the shared transition table minus `verified`, so the
 * page can never offer a verification the worker is not allowed to perform.
 */
export function WorkbenchLocalOrderDetailPage() {
  const { localOrderId } = useParams<{ localOrderId: string }>()

  return (
    <StaffGate>
      {localOrderId ? (
        <LocalOrderDetailView orderId={localOrderId} />
      ) : (
        <div className="px-4 pt-4">
          <ErrorBlock title="订单不存在" message="缺少订单编号，无法加载详情。" />
          <div className="mt-3">
            <TextLink to="/workbench/local-orders">返回社区订单</TextLink>
          </div>
        </div>
      )}
    </StaffGate>
  )
}
