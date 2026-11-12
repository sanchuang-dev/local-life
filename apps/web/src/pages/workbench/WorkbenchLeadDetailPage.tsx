import { useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import {
  CalendarClock,
  ClipboardPlus,
  MapPin,
  Phone,
  Plus,
  UserRound,
} from 'lucide-react'
import {
  type CrmFollowUp,
  type CrmLeadDetail,
  type CrmLeadEvent,
  type CrmLeadStatus,
} from '@sanchuang-dev/local-life-contracts'
import { useCrmApi } from '../../hooks/useCrmApi'
import { useAsyncResource } from '../../hooks/useAsyncResource'
import { StaffGate } from '../../components/crm/StaffGate'
import {
  BottomActionBar,
  CrmBadge,
  EmptyBlock,
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
  datetimeLocalToIso,
  formatCrmDateTime,
  isNextContactOverdue,
  leadSourceLabels,
  leadStatusDescriptions,
  leadStatusLabels,
  leadStatusActions,
  nextContactLabel,
} from '../../components/crm/crmLabels'

const leadEventLabels: Record<string, string> = {
  'lead.created': '线索登记',
  'lead.status_changed': '线索状态变更',
  'lead.transferred': '归属转交',
  'lead.follow_up_added': '新增跟进记录',
}

function statusTone(status: CrmLeadStatus) {
  if (status === 'converted') return 'mint' as const
  if (status === 'invalid') return 'rose' as const
  if (status === 'contacting') return 'amber' as const
  return 'slate' as const
}

function eventDescription(event: CrmLeadEvent): string {
  const parts: string[] = []
  if (event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus) {
    parts.push(
      `${event.fromStatus ? leadStatusLabels[event.fromStatus] : '—'} → ${
        event.toStatus ? leadStatusLabels[event.toStatus] : '—'
      }`,
    )
  }
  if (event.fromOwnerStaff || event.toOwnerStaff) {
    parts.push(
      `归属 ${event.fromOwnerStaff?.displayName ?? '—'} → ${event.toOwnerStaff?.displayName ?? '—'}`,
    )
  }
  if (event.note) parts.push(event.note)
  return parts.join('；')
}

function followUpEntries(followUps: CrmFollowUp[]): CrmFollowUp[] {
  return [...followUps].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function LeadDetailView({ leadId }: { leadId: string }) {
  const api = useCrmApi()
  const resource = useAsyncResource(`lead:${leadId}`, async (signal) => {
    const [lead, followUps, events] = await Promise.all([
      api.getLead(leadId, signal),
      api.listFollowUps(leadId, signal),
      api.listLeadEvents(leadId, signal),
    ])
    return { lead, followUps: followUps.items, events: events.items }
  })

  return (
    <div className="px-4 pb-8 pt-4">
      {resource.state.status === 'loading' ? <LoadingBlock label="正在加载线索详情…" /> : null}
      {resource.state.status === 'error' ? (
        <ErrorBlock message={resource.state.message} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        <LeadDetailContent
          lead={resource.state.data.lead}
          followUps={resource.state.data.followUps}
          events={resource.state.data.events}
          reload={resource.reload}
        />
      ) : null}
    </div>
  )
}

function LeadDetailContent({
  lead,
  followUps,
  events,
  reload,
}: {
  lead: CrmLeadDetail
  followUps: CrmFollowUp[]
  events: CrmLeadEvent[]
  reload: () => void
}) {
  const api = useCrmApi()
  const [statusDraft, setStatusDraft] = useState<{
    status: 'contacting' | 'invalid'
    label: string
  } | null>(null)
  const [statusNote, setStatusNote] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const [content, setContent] = useState('')
  const [nextContactLocal, setNextContactLocal] = useState('')
  const [clearNextContact, setClearNextContact] = useState(false)
  const [followUpBusy, setFollowUpBusy] = useState(false)
  const [followUpError, setFollowUpError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const overdue = isNextContactOverdue(lead.nextContactAt)
  const actions = leadStatusActions(lead.status)

  const timeline = useMemo<TimelineEntry[]>(
    () =>
      [...events]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((event) => ({
          id: event.id,
          title: leadEventLabels[event.event] ?? event.event,
          time: formatCrmDateTime(event.createdAt),
          description: eventDescription(event) || undefined,
          tone: event.event === 'lead.follow_up_added' ? 'mint' : 'slate',
        })),
    [events],
  )

  const applyStatus = async () => {
    if (!statusDraft) return
    setStatusBusy(true)
    setStatusError(null)
    setSuccess(null)
    try {
      await api.updateLeadStatus(lead.id, {
        expectedUpdatedAt: lead.updatedAt,
        status: statusDraft.status,
        ...(statusNote.trim() ? { note: statusNote.trim() } : {}),
      })
      setSuccess(`线索状态已更新为“${leadStatusLabels[statusDraft.status]}”`)
      setStatusDraft(null)
      setStatusNote('')
      reload()
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : '更新线索状态失败')
    } finally {
      setStatusBusy(false)
    }
  }

  const submitFollowUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (followUpBusy) return
    if (!content.trim()) {
      setFollowUpError('请填写跟进内容')
      return
    }

    let nextContactAt: string | null | undefined
    if (clearNextContact) {
      nextContactAt = null
    } else if (nextContactLocal) {
      const iso = datetimeLocalToIso(nextContactLocal)
      if (!iso) {
        setFollowUpError('下次联系时间格式不正确')
        return
      }
      nextContactAt = iso
    }

    setFollowUpBusy(true)
    setFollowUpError(null)
    setSuccess(null)
    try {
      await api.createFollowUp(lead.id, {
        expectedUpdatedAt: lead.updatedAt,
        content: content.trim(),
        ...(nextContactAt !== undefined ? { nextContactAt } : {}),
      })
      setSuccess('跟进已记录，下次联系提醒已同步')
      setContent('')
      setNextContactLocal('')
      setClearNextContact(false)
      reload()
    } catch (cause) {
      setFollowUpError(cause instanceof Error ? cause.message : '保存跟进记录失败')
    } finally {
      setFollowUpBusy(false)
    }
  }

  return (
    <>
      <section className="rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-[21px] font-semibold tracking-tight text-slate-900">
              {lead.contactName}
            </h1>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {lead.community.name} · 归属 {lead.ownerStaff.displayName ?? '网格员'}
            </p>
          </div>
          <CrmBadge tone={statusTone(lead.status)}>{leadStatusLabels[lead.status]}</CrmBadge>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-slate-500">
          {leadStatusDescriptions[lead.status]}
        </p>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <a
            href={`tel:${lead.contactPhone}`}
            className="flex min-h-11 items-center gap-2 rounded-xl border border-teal-200 bg-teal-50/50 px-3 text-[13px] font-semibold text-teal-700"
          >
            <Phone size={15} aria-hidden="true" />
            {lead.contactPhone}
          </a>
          <div className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-50 px-3 text-[12px] text-slate-600">
            <MapPin size={15} className="text-slate-400" aria-hidden="true" />
            {lead.community.name}
          </div>
        </div>

        <dl className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          <InfoRow label="线索来源" value={leadSourceLabels[lead.sourceType]} />
          {lead.sourceActivity ? <InfoRow label="来源活动" value={lead.sourceActivity.title} /> : null}
          {lead.promotionStaff ? (
            <InfoRow label="推广网格员" value={lead.promotionStaff.displayName ?? '未命名'} />
          ) : null}
          <InfoRow label="当前归属" value={lead.ownerStaff.displayName ?? '未命名网格员'} />
          <InfoRow label="登记人" value={lead.createdByStaff.displayName ?? '未命名'} />
          <InfoRow label="登记时间" value={formatCrmDateTime(lead.createdAt)} />
          <InfoRow label="最近更新" value={formatCrmDateTime(lead.updatedAt)} />
          <InfoRow
            label="最近跟进"
            value={
              lead.lastContactedAt ? formatCrmDateTime(lead.lastContactedAt) : '尚未跟进'
            }
          />
        </dl>

        <div
          className={`mt-3 flex items-start gap-2 rounded-[14px] px-3.5 py-2.5 text-[12px] ${
            overdue ? 'bg-rose-50 text-rose-600' : 'bg-[#f4f8f6] text-slate-600'
          }`}
        >
          <CalendarClock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold">{nextContactLabel(lead.nextContactAt)}</p>
            <p className="mt-0.5 text-[11px] leading-4 opacity-80">
              {overdue
                ? '下次联系时间已过，请尽快联系并记录跟进。'
                : '在下方新增跟进记录时可以同时更新下次联系时间。'}
            </p>
          </div>
        </div>
      </section>

      {success ? (
        <div className="mt-3">
          <StatusNotice tone="success">{success}</StatusNotice>
        </div>
      ) : null}

      <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-slate-900">新增跟进</h2>
          <span className="text-[10px] text-slate-400">保存后更新下次联系时间</span>
        </div>
        <form className="mt-3" onSubmit={(event) => void submitFollowUp(event)}>
          <Field label="跟进内容" htmlFor="follow-up-content" required>
            <textarea
              id="follow-up-content"
              rows={3}
              maxLength={1000}
              required
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="例如：已电话联系居民，确认需要办理广电手机卡，等待提供受理单号。"
              className={`${inputClassName} resize-none py-2.5`}
            />
          </Field>

          <Field
            label="下次联系时间"
            htmlFor="follow-up-next-contact"
            hint="留空则保持当前下次联系时间；勾选下方可清除提醒。"
          >
            <input
              id="follow-up-next-contact"
              type="datetime-local"
              value={nextContactLocal}
              onChange={(event) => {
                setNextContactLocal(event.target.value)
                if (event.target.value) setClearNextContact(false)
              }}
              className={inputClassName}
            />
          </Field>

          {lead.nextContactAt ? (
            <label className="mt-2 flex min-h-10 items-center gap-2 text-[12px] text-slate-500">
              <input
                type="checkbox"
                checked={clearNextContact}
                onChange={(event) => {
                  setClearNextContact(event.target.checked)
                  if (event.target.checked) setNextContactLocal('')
                }}
                className="h-4 w-4 rounded border-slate-300 text-teal-600"
              />
              清除当前下次联系提醒（当前 {formatCrmDateTime(lead.nextContactAt)}）
            </label>
          ) : null}

          {followUpError ? (
            <div className="mt-2">
              <StatusNotice tone="error">{followUpError}</StatusNotice>
              <button
                type="button"
                onClick={() => {
                  setFollowUpError(null)
                  reload()
                }}
                className={`${secondaryButtonClassName} mt-2 min-h-10 px-3`}
              >
                刷新线索
              </button>
            </div>
          ) : null}

          <button type="submit" disabled={followUpBusy} className={`${primaryButtonClassName} mt-3`}>
            <Plus size={16} aria-hidden="true" />
            {followUpBusy ? '保存中…' : '保存跟进记录'}
          </button>
        </form>
      </section>

      {actions.length > 0 ? (
        <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <h2 className="text-[16px] font-semibold text-slate-900">更新线索状态</h2>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">
            “已成交”只能由运营核验业务单后系统写入，工作台不提供该按钮。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.map((action) => (
              <button
                key={action.status}
                type="button"
                onClick={() => {
                  setStatusDraft(action)
                  setStatusError(null)
                }}
                className={`${secondaryButtonClassName} flex-1`}
              >
                {action.label}
              </button>
            ))}
          </div>

          {statusDraft ? (
            <div className="mt-3 rounded-[14px] bg-slate-50 p-3">
              <p className="text-[12px] font-semibold text-slate-700">
                确认将线索更新为“{leadStatusLabels[statusDraft.status]}”？
              </p>
              <Field label="备注（可选）" htmlFor="lead-status-note">
                <input
                  id="lead-status-note"
                  type="text"
                  maxLength={500}
                  value={statusNote}
                  onChange={(event) => setStatusNote(event.target.value)}
                  className={inputClassName}
                  placeholder="例如：居民暂不需要 / 已转办"
                />
              </Field>
              {statusError ? (
                <div className="mt-2">
                  <StatusNotice tone="error">{statusError}</StatusNotice>
                  <button
                    type="button"
                    onClick={() => {
                      setStatusError(null)
                      reload()
                    }}
                    className={`${secondaryButtonClassName} mt-2 min-h-10 px-3`}
                  >
                    刷新线索
                  </button>
                </div>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={statusBusy}
                  onClick={() => void applyStatus()}
                  className={`${primaryButtonClassName} flex-1`}
                >
                  {statusBusy ? '提交中…' : '确认更新'}
                </button>
                <button
                  type="button"
                  disabled={statusBusy}
                  onClick={() => {
                    setStatusDraft(null)
                    setStatusError(null)
                  }}
                  className={`${secondaryButtonClassName} flex-1`}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">跟进记录</h2>
        <p className="mt-0.5 text-[11px] text-slate-400">共 {followUps.length} 条</p>
        {followUps.length === 0 ? (
          <div className="mt-3">
            <EmptyBlock
              title="还没有跟进记录"
              description="在下方新增第一条跟进，列表与详情会保持一致。"
            />
          </div>
        ) : (
          <ol className="mt-3 space-y-3">
            {followUpEntries(followUps).map((item) => (
              <li key={item.id} className="rounded-[14px] border border-slate-100 bg-[#fafcfb] p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[12px] font-semibold text-slate-700">
                    {item.staff.displayName ?? '网格员'}
                  </p>
                  <span className="shrink-0 text-[10px] text-slate-400">
                    {formatCrmDateTime(item.createdAt)}
                  </span>
                </div>
                <p className="mt-1 break-words text-[12px] leading-5 text-slate-600">
                  {item.content}
                </p>
                {item.nextContactAt ? (
                  <p className="mt-1 text-[11px] text-teal-700">
                    下次联系：{formatCrmDateTime(item.nextContactAt)}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">线索事件</h2>
        <p className="mt-0.5 text-[11px] text-slate-400">追加式审计事件，不可修改或删除</p>
        <div className="mt-3">
          <EventTimeline entries={timeline} emptyText="暂无事件记录" />
        </div>
      </section>

      <BottomActionBar>
        <Link
          to={`/workbench/leads/${lead.id}/orders/new`}
          state={{ from: `/workbench/leads/${lead.id}` }}
          className={`${primaryButtonClassName} text-center`}
        >
          <ClipboardPlus size={16} aria-hidden="true" />
          为该线索创建广电业务受理单
        </Link>
      </BottomActionBar>

      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
        <UserRound size={13} aria-hidden="true" />
        仅显示你有权查看的线索
      </div>

      <div className="mt-3">
        <TextLink to="/workbench/leads">返回我的线索</TextLink>
      </div>
    </>
  )
}

export function WorkbenchLeadDetailPage() {
  const { leadId } = useParams<{ leadId: string }>()
  return (
    <StaffGate>
      {leadId ? (
        <LeadDetailView leadId={leadId} />
      ) : (
        <div className="px-4 pt-4">
          <ErrorBlock title="线索不存在" message="缺少线索 ID，无法加载详情。" />
        </div>
      )}
    </StaffGate>
  )
}
