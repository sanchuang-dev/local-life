import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { ClipboardPlus, ShieldCheck, UserPlus } from 'lucide-react'
import type { CrmLeadSourceType } from '@sanchuang-dev/local-life-contracts'
import { useCrmApi } from '../../hooks/useCrmApi'
import { useAsyncResource } from '../../hooks/useAsyncResource'
import { useStaffSession } from '../../hooks/useStaffSession'
import { StaffGate } from '../../components/crm/StaffGate'
import {
  Field,
  LoadingBlock,
  PageSection,
  StatusNotice,
  inputClassName,
  primaryButtonClassName,
} from '../../components/crm/WorkbenchUi'
import {
  datetimeLocalToIso,
  leadSourceDescriptions,
  leadSourceOptions,
} from '../../components/crm/crmLabels'

function NewLeadView() {
  const api = useCrmApi()
  const { session } = useStaffSession()
  const navigate = useNavigate()

  const communities = session?.staff.communities ?? []
  const [communityId, setCommunityId] = useState(communities[0]?.id ?? '')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [sourceType, setSourceType] = useState<CrmLeadSourceType>('walk_in')
  const [sourceActivityId, setSourceActivityId] = useState('')
  const [nextContactLocal, setNextContactLocal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activities = useAsyncResource('public-activities', (signal) =>
    api.listPublicActivities(signal),
  )

  const communityActivities =
    activities.state.status === 'ready'
      ? activities.state.data.items.filter((item) => item.community.id === communityId)
      : []

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setError(null)

    if (!communityId) {
      setError('请选择社区')
      return
    }
    if (sourceType === 'activity' && !sourceActivityId) {
      setError('选择“活动来源”时必须选择一个已发布活动')
      return
    }

    let nextContactAt: string | undefined
    if (nextContactLocal) {
      const iso = datetimeLocalToIso(nextContactLocal)
      if (!iso) {
        setError('下次联系时间格式不正确')
        return
      }
      nextContactAt = iso
    }

    setBusy(true)
    try {
      const lead = await api.createLead({
        communityId,
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        sourceType,
        ...(sourceType === 'activity' ? { sourceActivityId } : {}),
        ...(nextContactAt ? { nextContactAt } : {}),
      })
      navigate(`/workbench/leads/${lead.id}`, {
        replace: true,
        state: { from: '/workbench/leads' },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登记线索失败')
    } finally {
      setBusy(false)
    }
  }

  if (communities.length === 0) {
    return (
      <div className="px-4 pb-8 pt-4">
        <StatusNotice tone="error">
          当前后台账号没有分配任何社区，无法登记线索。请联系管理员在后台完成社区分配。
        </StatusNotice>
      </div>
    )
  }

  return (
    <div className="px-4 pb-8 pt-4">
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <UserPlus size={21} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">登记新线索</h1>
          <p className="mt-0.5 text-[11px] text-slate-400">
            只登记经居民明确告知、同意跟进的联系线索
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-[14px] border border-teal-200 bg-[#eef7f2] px-3.5 py-2.5 text-[11px] leading-5 text-[#52786c]">
        <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>不要导入整社区居民名册，也不要收集身份证、银行卡等非必要敏感信息。</p>
      </div>

      <form className="mt-4" onSubmit={(event) => void submit(event)}>
        <section className="rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <PageSection title="联系人与社区" note="最小必要信息">
            <Field label="所属社区" htmlFor="new-lead-community" required>
              {communities.length === 1 ? (
                <div className="mt-1.5 flex min-h-11 items-center rounded-xl bg-slate-50 px-3 text-[14px] text-slate-700">
                  {communities[0]?.name}
                </div>
              ) : (
                <select
                  id="new-lead-community"
                  required
                  value={communityId}
                  onChange={(event) => {
                    setCommunityId(event.target.value)
                    setSourceActivityId('')
                  }}
                  className={inputClassName}
                >
                  {communities.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field label="居民称呼" htmlFor="new-lead-name" required>
              <input
                id="new-lead-name"
                type="text"
                required
                maxLength={40}
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                className={inputClassName}
                placeholder="例如：王阿姨"
              />
            </Field>

            <Field
              label="联系电话"
              htmlFor="new-lead-phone"
              hint="仅用于本次业务联系；列表只显示脱敏号码。"
              required
            >
              <input
                id="new-lead-phone"
                type="tel"
                inputMode="tel"
                required
                pattern="[0-9+\-() ]{5,20}"
                value={contactPhone}
                onChange={(event) => setContactPhone(event.target.value)}
                className={inputClassName}
                placeholder="例如：13800000000"
              />
            </Field>
          </PageSection>
        </section>

        <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <PageSection title="线索来源" note="来源决定后续归属">
            <Field label="来源类型" htmlFor="new-lead-source" required>
              <select
                id="new-lead-source"
                required
                value={sourceType}
                onChange={(event) => {
                  setSourceType(event.target.value as CrmLeadSourceType)
                  if (event.target.value !== 'activity') setSourceActivityId('')
                }}
                className={inputClassName}
              >
                {leadSourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">
              {leadSourceDescriptions[sourceType]}
            </p>

            {sourceType === 'activity' ? (
              <Field label="来源活动" htmlFor="new-lead-activity" required>
                {activities.state.status === 'loading' ? (
                  <div className="mt-2">
                    <LoadingBlock label="正在加载已发布活动…" />
                  </div>
                ) : activities.state.status === 'error' ? (
                  <div className="mt-2">
                    <StatusNotice tone="error">{activities.state.message}</StatusNotice>
                  </div>
                ) : communityActivities.length === 0 ? (
                  <div className="mt-2">
                    <StatusNotice tone="info">
                      该社区暂无已发布活动。请改用“到访登记”或联系运营发布活动。
                    </StatusNotice>
                  </div>
                ) : (
                  <select
                    id="new-lead-activity"
                    required
                    value={sourceActivityId}
                    onChange={(event) => setSourceActivityId(event.target.value)}
                    className={inputClassName}
                  >
                    <option value="">请选择活动</option>
                    {communityActivities.map((activity) => (
                      <option key={activity.id} value={activity.id}>
                        {activity.title}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}

            {sourceType === 'grid_promotion' ? (
              <p className="mt-2 rounded-[12px] bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">
                推广网格员默认为你本人，由服务端在创建时校验社区归属。
              </p>
            ) : null}
          </PageSection>
        </section>

        <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <PageSection title="跟进计划" note="可稍后补充">
            <Field
              label="下次联系时间"
              htmlFor="new-lead-next-contact"
              hint="留空表示暂不设置提醒；保存后可在线索详情继续跟进。"
            >
              <input
                id="new-lead-next-contact"
                type="datetime-local"
                value={nextContactLocal}
                onChange={(event) => setNextContactLocal(event.target.value)}
                className={inputClassName}
              />
            </Field>
          </PageSection>
        </section>

        {error ? (
          <div className="mt-3">
            <StatusNotice tone="error">{error}</StatusNotice>
          </div>
        ) : null}

        <button type="submit" disabled={busy} className={`${primaryButtonClassName} mt-4`}>
          <ClipboardPlus size={16} aria-hidden="true" />
          {busy ? '提交中…' : '登记线索'}
        </button>
        <p className="mt-2 text-center text-[11px] leading-5 text-slate-400">
          成功后进入线索详情，状态与归属均以服务端返回为准。
        </p>
      </form>
    </div>
  )
}

export function WorkbenchLeadNewPage() {
  return (
    <StaffGate>
      <NewLeadView />
    </StaffGate>
  )
}
