import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router'
import { BadgeCheck, CircleSlash, ScanLine, TicketCheck } from 'lucide-react'
import {
  ACTIVITY_ROUTES,
  publicActivityListResponseSchema,
  type AdminActivityCheckinList,
  type ActivityCheckin,
  type PublicActivitySummary,
  type RewardRedeemResponse,
} from '@sanchuang-dev/local-life-contracts'
import { useStaffSession } from '../../hooks/useStaffSession'
import { DrawRedeemPanel } from '../../components/activity/DrawRedeemPanel'
import { useAsyncResource } from '../../hooks/useAsyncResource'
import { StaffGate, StaffIdentityCard } from '../../components/crm/StaffGate'
import {
  CrmBadge,
  EmptyBlock,
  ErrorBlock,
  Field,
  InfoRow,
  LoadingBlock,
  PageSection,
  StatusNotice,
  TextLink,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
} from '../../components/crm/WorkbenchUi'
import { formatCrmDateTime, staffRoleLabels } from '../../components/crm/crmLabels'
import {
  formatRewardDateTime,
  grantStatusLabels,
  isCredentialCodeShaped,
  normaliseCredentialCode,
} from '../../components/activity/rewardLabels'
import {
  getAdminRewardOverview,
  isRewardApiError,
  listActivityCheckins,
  redeemCredentialCode,
  revokeCheckin,
  verifyCheckin,
} from '../../services/rewards'

/** Priorities for the field flow: redeem a code, then verify on-site check-ins. */
type VerifyTab = 'redeem' | 'checkins' | 'draw'

const MAX_CODE_LENGTH = 10

/**
 * 网格员移动端 · 现场核验与核销。
 *
 * Two real field actions:
 *
 * 1. **核销凭据码** — `POST /rewards/redeem` with the 10-character code only. The
 *    code resolves the activity and its community on the server; the worker never
 *    picks an activity first, and an out-of-scope code is a real 403.
 * 2. **参与者签到核验** — list an activity's check-ins
 *    (`GET /admin/activities/:id/checkins`), verify a self-reported one, or revoke
 *    a wrong one with a mandatory reason. Only a verified check-in counts towards
 *    the three-check-in reward requirement.
 *
 * Role and community scope are never read from local state: they come from
 * `/auth/session`, and the API re-checks the scope on every call. The activity
 * picker uses the *public* activity list because `/admin/activities` correctly
 * rejects a grid worker with 403; the reward endpoints then enforce the real
 * community scope, and a 403 is rendered as a real 403.
 */
export function WorkbenchVerifyPage() {
  return (
    <StaffGate>
      <VerifyView />
    </StaffGate>
  )
}

function VerifyView() {
  const { session } = useStaffSession()
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<VerifyTab>('redeem')

  const activityParam = searchParams.get('activityId')
  const activities = useAsyncResource<PublicActivitySummary[]>('public-activities', async (signal) => {
    const response = await fetch(`/api${ACTIVITY_ROUTES.publicList}`, {
      signal,
      credentials: 'include',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`活动列表请求失败（HTTP ${response.status}）`)
    const parsed = publicActivityListResponseSchema.safeParse(await response.json())
    if (!parsed.success) throw new Error('活动列表数据格式异常，无法安全展示')
    return parsed.data.items
  })

  const activityList = activities.state.status === 'ready' ? activities.state.data : []
  const activeActivity =
    activityList.find((item) => item.id === activityParam) ?? activityList[0] ?? null

  const selectActivity = (activityId: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('activityId', activityId)
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="px-4 pb-8 pt-4">
      <div className="flex items-start gap-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <ScanLine size={24} strokeWidth={1.7} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">现场核验核销</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            核销凭据 · 现场签到
          </p>
        </div>
      </div>

      <div className="mt-4">
        <StaffIdentityCard />
      </div>

      {session ? (
        <p className="mt-2 rounded-[14px] bg-[#fff7ec] px-3.5 py-2.5 text-[11px] leading-5 text-[#8a6132]">
          当前身份：{staffRoleLabels[session.staff.role]}，可核销社区：
          {session.staff.communities.map((item) => item.name).join('、') || '未分配社区'}。
          {session.staff.role === 'grid_worker'
            ? ' 只能核销负责社区的凭据。'
            : ''}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-3 rounded-[14px] bg-slate-100 p-1">
        <button
          type="button"
          aria-pressed={tab === 'redeem'}
          onClick={() => setTab('redeem')}
          className={`min-h-11 rounded-[11px] px-3 text-[13px] font-bold transition ${
            tab === 'redeem' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          核销凭据码
        </button>
        <button
          type="button"
          aria-pressed={tab === 'checkins'}
          onClick={() => setTab('checkins')}
          className={`min-h-11 rounded-[11px] px-3 text-[13px] font-bold transition ${
            tab === 'checkins' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          参与者签到
        </button>
        <button
          type="button"
          aria-pressed={tab === 'draw'}
          onClick={() => setTab('draw')}
          className={`min-h-11 rounded-[11px] px-2 text-[12px] font-bold transition ${
            tab === 'draw' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          抽奖核销
        </button>
      </div>

      {tab === 'redeem' ? (
        <RedeemPanel
          onRedeemed={(result) => {
            selectActivity(result.grant.activityId)
          }}
        />
      ) : tab === 'draw' ? (
        <DrawRedeemPanel
          activities={activityList}
          activityId={activeActivity?.id ?? null}
          onSelectActivity={selectActivity}
        />
      ) : (
        <CheckinPanel
          activities={activities.state}
          onRetryActivities={activities.reload}
          activeActivity={activeActivity}
          onSelectActivity={selectActivity}
        />
      )}

      <div className="mt-5">
        <TextLink to="/workbench/leads">返回我的线索</TextLink>
      </div>
    </div>
  )
}

/* --------------------------------- Redeem --------------------------------- */

function RedeemPanel({ onRedeemed }: { onRedeemed: (result: RewardRedeemResponse) => void }) {
  const { session } = useStaffSession()
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RewardRedeemResponse | null>(null)
  const [failure, setFailure] = useState<{ message: string; code: string | null } | null>(null)

  const normalised = normaliseCredentialCode(code)
  const shaped = isCredentialCodeShaped(normalised)

  const submit = async () => {
    if (busy) return
    setFailure(null)
    setResult(null)
    if (!shaped) {
      setFailure({ message: '请输入 10 位核销码（不含 I、L、O、U）。', code: null })
      return
    }
    const csrfToken = session?.csrfToken
    if (!csrfToken) {
      setFailure({ message: '登录状态已失效，请重新登录。', code: 'unauthorized' })
      return
    }
    setBusy(true)
    try {
      const response = await redeemCredentialCode(
        csrfToken,
        normalised,
        note.trim() ? note.trim() : undefined,
      )
      setResult(response)
      setCode('')
      setNote('')
      onRedeemed(response)
    } catch (cause) {
      setFailure({
        message: cause instanceof Error ? cause.message : '核销未完成，请稍后重试。',
        code: isRewardApiError(cause) ? cause.code : null,
      })
    } finally {
      setBusy(false)
    }
  }

  /** Real failure taxonomy by `error.code`, never by HTTP status alone. */
  const failureHint = (): string => {
    switch (failure?.code) {
      case 'redemption_code_invalid':
        return '该码不存在、已被换新码或已被作废。请让居民在活动页重新查看凭据；撤销签到后的凭据同样返回此提示。'
      case 'redemption_code_expired':
        return '该码已超过有效期，无法核销。'
      case 'reward_already_redeemed':
        return '该凭据已被核销过，不能重复发放。'
      case 'forbidden':
        return '该凭据不属于你被授权的社区，无法核销。该尝试已记录审计。'
      case 'unauthorized':
        return '请先以网格员/运营身份登录工作台。'
      default:
        return '请核对凭据码后重试；若持续失败，请联系运营人员。'
    }
  }

  return (
    <section className="mt-4">
      <div className="rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <p className="flex items-center gap-1.5 text-[15px] font-semibold text-slate-800">
          <TicketCheck size={17} className="shrink-0 text-teal-700" aria-hidden="true" />
          输入居民凭据码
        </p>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">
          凭据码为 10 位（0-9 与 A-Z，不含 I、L、O、U）。核销成功后该码立即失效，不能重复使用。
        </p>

        <Field
          label="核销码"
          htmlFor="redeem-code"
          required
          hint={`已输入 ${normalised.length}/${MAX_CODE_LENGTH} 位`}
        >
          <input
            id="redeem-code"
            name="code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={MAX_CODE_LENGTH + 4}
            placeholder="例如 7K3M9QRXAB"
            aria-describedby="redeem-code-hint"
            className={`${inputClassName} font-mono tracking-[0.2em] uppercase`}
          />
        </Field>

        <Field label="备注" htmlFor="redeem-note" hint="可选，写入核销记录，便于后续核对。">
          <input
            id="redeem-note"
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={200}
            placeholder="例如 现场已交付鸡蛋一盒"
            className={inputClassName}
          />
        </Field>

        <div className="mt-4">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || normalised.length === 0}
            className={primaryButtonClassName}
          >
            <BadgeCheck size={17} aria-hidden="true" />
            {busy ? '核销中…' : '确认核销'}
          </button>
        </div>

        {failure ? (
          <div className="mt-3 space-y-2">
            <StatusNotice tone="error">{failure.message}</StatusNotice>
            <p className="text-[11px] leading-5 text-slate-500">{failureHint()}</p>
          </div>
        ) : null}

        {result ? (
          <div className="mt-3 space-y-2">
            <StatusNotice tone="success">
              {result.redeemed ? '核销成功，奖品已交付。' : '该凭据此前已核销，本次未重复发放。'}
            </StatusNotice>
            <dl className="divide-y divide-slate-100 rounded-[14px] border border-slate-100 bg-white px-3.5">
              <InfoRow label="奖品" value={`${result.grant.prizeName} × ${result.grant.quantity}`} />
              <InfoRow
                label="领取人"
                value={
                  result.grant.recipientRole === 'leader'
                    ? `队长 ${result.grant.recipientDisplayName ?? ''}`
                    : '团队成员共享'
                }
              />
              <InfoRow label="奖励状态" value={grantStatusLabels[result.grant.status]} />
              <InfoRow label="核销时间" value={formatRewardDateTime(result.grant.redeemedAt)} />
              <InfoRow label="凭据尾号" value={<span className="font-mono">{result.credential.maskedCode}</span>} />
            </dl>
          </div>
        ) : null}
      </div>

      <p className="mt-3 text-[11px] leading-[1.7] text-slate-400">
        同一奖励凭据只能核销一次。
      </p>
    </section>
  )
}

/* -------------------------------- Check-ins -------------------------------- */

function CheckinPanel({
  activities,
  onRetryActivities,
  activeActivity,
  onSelectActivity,
}: {
  activities: ReturnType<typeof useAsyncResource<PublicActivitySummary[]>>['state']
  onRetryActivities: () => void
  activeActivity: PublicActivitySummary | null
  onSelectActivity: (activityId: string) => void
}) {
  const activityId = activeActivity?.id ?? null
  const checkins = useAsyncResource<AdminActivityCheckinList | 'no_plan'>(
    activityId ? `checkins:${activityId}` : 'checkins:none',
    async (signal) => {
      if (!activityId) throw new Error('尚未选择活动')
      try {
        return await listActivityCheckins(activityId, signal)
      } catch (cause) {
        // A published activity without a frozen reward plan answers 409 on the
        // overview and has no reward scope at all; that is information, not a
        // crash. Real 401/403/404 still surface as errors.
        if (isRewardApiError(cause) && cause.status === 409) return 'no_plan'
        throw cause
      }
    },
  )

  const overview = useAsyncResource<{ planConfigured: boolean; prizeName: string | null }>(
    activityId ? `overview:${activityId}` : 'overview:none',
    async (signal) => {
      if (!activityId) throw new Error('尚未选择活动')
      try {
        const data = await getAdminRewardOverview(activityId, signal)
        return {
          planConfigured: data.planConfigured,
          prizeName: data.plan?.prizeName ?? null,
        }
      } catch (cause) {
        if (isRewardApiError(cause) && cause.status === 409) {
          return { planConfigured: false, prizeName: null }
        }
        throw cause
      }
    },
  )

  const planName = overview.state.status === 'ready' ? overview.state.data.prizeName : null
  const list = checkins.state.status === 'ready' && checkins.state.data !== 'no_plan'
    ? checkins.state.data
    : null

  return (
    <section className="mt-4">
      <PageSection title="选择活动" note="公开活动列表">
        {activities.status === 'loading' ? <LoadingBlock label="正在读取活动列表…" /> : null}
        {activities.status === 'error' ? (
          <ErrorBlock message={activities.message} onRetry={onRetryActivities} />
        ) : null}
        {activities.status === 'ready' && activities.data.length === 0 ? (
          <EmptyBlock
            title="当前没有已发布活动"
            description="只有已发布活动的签到可以现场核验；活动发布后再回到本页。"
          />
        ) : null}
        {activities.status === 'ready' && activities.data.length > 0 ? (
          <ul className="grid gap-2">
            {activities.data.map((activity) => {
              const selected = activity.id === activityId
              return (
                <li key={activity.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelectActivity(activity.id)}
                    className={`w-full rounded-[16px] border px-3.5 py-3 text-left transition-colors ${
                      selected
                        ? 'border-teal-500 bg-[#f2f9f5]'
                        : 'border-slate-100 bg-white hover:border-teal-200'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-[13px] font-semibold text-slate-800">
                        {activity.title}
                      </span>
                      {selected ? <CrmBadge tone="teal">已选择</CrmBadge> : null}
                    </div>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                      {activity.community.name} · {formatCrmDateTime(activity.startsAt)} 起
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </PageSection>

      {activityId ? (
        <PageSection title="签到核验" note={planName ? `正式奖品：${planName}` : undefined}>
          {checkins.state.status === 'loading' ? (
            <LoadingBlock label="正在读取签到记录…" />
          ) : null}

          {checkins.state.status === 'error' ? (
            <ErrorBlock
              message={checkins.state.message}
              onRetry={checkins.reload}
              title="签到记录读取失败"
            />
          ) : null}

          {checkins.state.status === 'ready' && checkins.state.data === 'no_plan' ? (
            <EmptyBlock
              title="该活动未配置正式奖励计划"
              description="没有冻结的奖励规则时不存在奖励资格，也无需核验签到。请运营人员先在管理台配置 rewardPlan。"
            />
          ) : null}

          {list && list.items.length === 0 ? (
            <EmptyBlock
              title="还没有签到记录"
              description="居民在活动页签到后这里会出现记录，状态为「待核验」；到场的请当场核验。"
            />
          ) : null}

          {list && list.items.length > 0 ? (
            <>
              <div className="mb-3 grid grid-cols-3 gap-2">
                <Stat label="有效" value={list.counts.valid} tone="teal" />
                <Stat label="已核验" value={list.counts.verified} tone="mint" />
                <Stat label="待核验" value={list.counts.pendingVerification} tone="amber" />
              </div>
              <ul className="grid gap-2.5">
                {list.items.map((checkin) => (
                  <CheckinRow
                    key={checkin.id}
                    checkin={checkin}
                    activityId={activityId}
                    onChanged={() => {
                      checkins.reload()
                      overview.reload()
                    }}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </PageSection>
      ) : null}
    </section>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'teal' | 'mint' | 'amber' }) {
  const toneClass =
    tone === 'mint'
      ? 'border-teal-100 bg-[#f2f9f5] text-[#225c4c]'
      : tone === 'amber'
        ? 'border-[#f2dcc0] bg-[#fffaf2] text-[#8a6132]'
        : 'border-slate-100 bg-white text-slate-700'
  return (
    <div className={`rounded-[14px] border px-2 py-2.5 text-center ${toneClass}`}>
      <p className="text-[18px] font-semibold leading-none">{value}</p>
      <p className="mt-1 text-[11px] font-medium">{label}</p>
    </div>
  )
}

function CheckinRow({
  checkin,
  activityId,
  onChanged,
}: {
  checkin: ActivityCheckin
  activityId: string
  onChanged: () => void
}) {
  const { session } = useStaffSession()
  const [busy, setBusy] = useState<'verify' | 'revoke' | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const needsVerification = checkin.status === 'valid' && checkin.verifiedAt === null
  const revoked = checkin.status === 'revoked'

  const run = useCallback(
    async (action: 'verify' | 'revoke', revokeReason?: string) => {
      const csrfToken = session?.csrfToken
      if (!csrfToken) {
        setNotice({ tone: 'error', text: '登录状态已失效，请重新登录。' })
        return
      }
      setBusy(action)
      setNotice(null)
      try {
        if (action === 'verify') {
          await verifyCheckin(csrfToken, activityId, checkin.id)
          setNotice({ tone: 'success', text: '已核验，该签到现在计入团队奖励进度。' })
        } else {
          await revokeCheckin(csrfToken, activityId, checkin.id, revokeReason ?? '')
          setNotice({ tone: 'success', text: '已撤销该签到，不再计入奖励进度。' })
          setRevoking(false)
          setReason('')
        }
        onChanged()
      } catch (cause) {
        setNotice({
          tone: 'error',
          text: cause instanceof Error ? cause.message : '操作未完成，请稍后重试。',
        })
      } finally {
        setBusy(null)
      }
    },
    [activityId, checkin.id, onChanged, session?.csrfToken],
  )

  const reasonValid = reason.trim().length >= 2

  return (
    <li className="rounded-[16px] border border-slate-100 bg-white p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-slate-800">
            {checkin.displayName}
            {checkin.seatNo !== null ? (
              <span className="ml-1 text-[11px] font-medium text-slate-400">
                {checkin.seatNo} 号位
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            签到 {formatCrmDateTime(checkin.checkedInAt)}
            {checkin.verifiedAt ? ` · 核验 ${formatCrmDateTime(checkin.verifiedAt)}` : ''}
          </p>
        </div>
        {revoked ? (
          <CrmBadge tone="rose">已撤销</CrmBadge>
        ) : needsVerification ? (
          <CrmBadge tone="amber">待核验</CrmBadge>
        ) : (
          <CrmBadge tone="mint">已核验</CrmBadge>
        )}
      </div>

      {revoked ? (
        <p className="mt-2 rounded-[10px] bg-rose-50 px-2.5 py-2 text-[11px] leading-[18px] text-rose-700">
          撤销原因：{checkin.revokeReason ?? '未填写'}
        </p>
      ) : null}

      {needsVerification ? (
        <p className="mt-2 text-[11px] leading-[18px] text-[#8a6132]">
          居民自助签到尚未核验，<span className="font-semibold">不计入</span>团队奖励进度。请在确认本人在场后核验。
        </p>
      ) : null}

      {!revoked ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {needsVerification ? (
            <button
              type="button"
              onClick={() => void run('verify')}
              disabled={busy !== null}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[#138b79] px-4 text-[13px] font-semibold text-white disabled:opacity-50"
            >
              <BadgeCheck size={16} aria-hidden="true" />
              {busy === 'verify' ? '核验中…' : '现场核验'}
            </button>
          ) : (
            <span className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[#f2f9f5] px-3 text-[12px] font-semibold text-[#225c4c]">
              <BadgeCheck size={16} aria-hidden="true" />
              已计入奖励进度
            </span>
          )}
          {revoking ? null : (
            <button
              type="button"
              onClick={() => {
                setRevoking(true)
                setNotice(null)
              }}
              disabled={busy !== null}
              className={`${secondaryButtonClassName} min-h-11`}
            >
              <CircleSlash size={15} aria-hidden="true" />
              撤销签到
            </button>
          )}
        </div>
      ) : null}

      {revoking ? (
        <div className="mt-2.5 rounded-[12px] bg-slate-50 p-3">
          <Field label="撤销原因" htmlFor={`revoke-${checkin.id}`} required hint="2-200 字，会写入审计记录。">
            <input
              id={`revoke-${checkin.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
              placeholder="例如 本人未到场，由他人代签"
              className={inputClassName}
            />
          </Field>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => void run('revoke', reason.trim())}
              disabled={!reasonValid || busy !== null}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-4 text-[13px] font-semibold text-white disabled:opacity-50"
            >
              {busy === 'revoke' ? '撤销中…' : '确认撤销'}
            </button>
            <button
              type="button"
              onClick={() => {
                setRevoking(false)
                setReason('')
              }}
              disabled={busy !== null}
              className={`${secondaryButtonClassName} min-h-11`}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="mt-2.5">
          <StatusNotice tone={notice.tone}>{notice.text}</StatusNotice>
        </div>
      ) : null}
    </li>
  )
}
