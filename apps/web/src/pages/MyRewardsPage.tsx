import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Gift,
  RefreshCw,
  Ticket,
  Wallet,
} from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '../components/PageHeader'
import {
  credentialExpiryText,
  formatRewardDateTime,
  grantRecipientText,
  grantStatusLabels,
  rewardBucketClasses,
  rewardBucketDetail,
  rewardBucketLabels,
  type RewardBucket,
} from '../components/activity/rewardLabels'
import { FilterChipRow } from '../components/crm/FilterChips'
import { useBackTarget } from '../hooks/useBackTarget'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { buildResidentLoginHref } from '../components/auth/residentLogin'
import { useRewardWallet, type RewardWalletEntry } from '../hooks/useRewardWallet'

const BUCKET_ORDER: RewardBucket[] = ['claimable', 'pending', 'redeemed', 'disputed', 'void']

const bucketOptions = BUCKET_ORDER.map((bucket) => ({
  value: bucket,
  label: rewardBucketLabels[bucket],
}))

/**
 * 我的奖励 — the resident activity wallet.
 *
 * There is no cross-activity wallet endpoint in the contracts, so the page
 * composes real ones: the published activity list, then each activity's
 * team-reward state (which carries the grant and the *masked* credential).
 * The plaintext code is never stored client-side; it is only shown once at claim
 * time on the campaign page, so this page can honestly say it shows the last four
 * characters only.
 */
export function MyRewardsPage() {
  const { backTo, backLabel } = useBackTarget('/me', '返回我的')
  const auth = useResidentAuth()
  const wallet = useRewardWallet({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const [bucket, setBucket] = useState<RewardBucket | ''>('')

  const entries = wallet.state.status === 'ready' ? wallet.state.entries : []
  const visible = bucket === '' ? entries : entries.filter((item) => item.bucket === bucket)
  const counts = BUCKET_ORDER.reduce<Record<string, number>>((accumulator, key) => {
    accumulator[key] = entries.filter((item) => item.bucket === key).length
    return accumulator
  }, {})

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={Wallet}
        title="我的奖励"
        subtitle="真实活动奖励 · 核销凭据 · 核销状态"
      />

      <section
        className="mt-4 rounded-[18px] border border-teal-200/70 bg-[#eef7f2] px-3.5 py-3"
        aria-label="我的奖励数据说明"
      >
        <p className="flex items-center gap-1.5 text-[12px] font-bold text-[#225c4c]">
          <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />
          本页奖励与凭据来自服务端
        </p>
        <p className="mt-1 text-[11px] leading-[1.7] text-[#52786c]">
          仅展示你在已发布活动中真实获得的奖励。抽奖、压轴大奖与社区里程碑不在此列，它们仍在活动页明确标注为演示。
        </p>
      </section>

      {wallet.state.status === 'ready' && entries.length > 0 ? (
        <div className="mt-4">
          <FilterChipRow
            label="奖励状态"
            value={bucket}
            options={bucketOptions.map((option) => ({
              ...option,
              label: `${option.label} ${counts[option.value] ?? 0}`,
            }))}
            onChange={(value) => setBucket(value as RewardBucket | '')}
            allLabel={`全部 ${entries.length}`}
          />
        </div>
      ) : null}

      {wallet.state.status === 'loading' || auth.loading ? (
        <p
          className="mt-6 flex items-center justify-center gap-2 text-[12px] font-medium text-slate-500"
          role="status"
          aria-live="polite"
        >
          <span
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
            aria-hidden="true"
          />
          正在读取你的活动奖励…
        </p>
      ) : null}

      {wallet.state.status === 'unauthenticated' ? (
        <section className="mt-4 rounded-[18px] bg-white p-4">
          <p className="text-[13px] font-medium text-slate-700">登录状态已失效，请重新登录。</p>
          <Link to={buildResidentLoginHref('/me/rewards', { activityId: null, inviteCode: null, inviteInvalid: false })}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white">
            前往统一登录
          </Link>
        </section>
      ) : null}

      {wallet.state.status === 'error' ? (
        <section className="mt-4 rounded-[18px] border border-[#f0d5bd] bg-[#fff7f0] p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-[#7a4a2c]">
            <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
            我的奖励读取失败
          </p>
          <p className="mt-1 break-words text-[12px] leading-5 text-[#7a4a2c]">
            {wallet.state.message}
          </p>
          <button
            type="button"
            onClick={wallet.reload}
            className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white"
          >
            <RefreshCw size={14} aria-hidden="true" />
            重新读取
          </button>
        </section>
      ) : null}

      {wallet.state.status === 'ready' && entries.length === 0 ? (
        <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <p className="flex items-center gap-1.5 text-[14px] font-bold text-slate-800">
            <Gift size={16} className="shrink-0 text-teal-700" aria-hidden="true" />
            暂无活动奖励
          </p>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            你还没有加入任何已发布活动的三人团。参与活动并坐满 3 人、完成 3 次现场核验签到后，可在这里领取奖励凭据。
          </p>
          <Link
            to="/community/activity"
            className="mt-3 flex min-h-[48px] items-center justify-center rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white"
          >
            去看看社区活动
          </Link>
        </section>
      ) : null}

      {wallet.state.status === 'ready' && entries.length > 0 && visible.length === 0 ? (
        <p className="mt-6 rounded-[16px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-[12px] leading-5 text-slate-500">
          当前筛选下没有奖励。
        </p>
      ) : null}

      {visible.length > 0 ? (
        <ul className="mt-3 grid gap-3">
          {visible.map((entry) => (
            <RewardWalletCard key={entry.activityId} entry={entry} />
          ))}
        </ul>
      ) : null}

      <p className="mt-5 text-[11px] leading-[1.7] text-slate-400">
        凭据码明文只在领取当次显示一次，服务端仅保存哈希；本页只显示尾号，便于现场核对。核销记录由工作人员在活动现场写入。
      </p>
    </div>
  )
}

function RewardWalletCard({ entry }: { entry: RewardWalletEntry }) {
  const { reward } = entry
  const credential = reward.credential
  const grant = reward.grant

  return (
    <li className="rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-[14px] font-bold text-slate-900">{entry.activityTitle}</p>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{entry.communityName}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
            rewardBucketClasses[entry.bucket]
          }`}
        >
          {rewardBucketLabels[entry.bucket]}
        </span>
      </div>

      <p className="mt-2 break-words text-[13px] font-semibold text-[#225c4c]">
        {reward.reward?.prizeName ?? '团队奖励'}
        {reward.reward ? ` · 每团 ${reward.reward.prizeQuantityPerTeam} 份` : ''}
      </p>
      <p className="mt-1 text-[12px] leading-5 text-slate-500">{rewardBucketDetail(reward)}</p>

      {credential ? (
        <div className="mt-2.5 rounded-[12px] bg-[#f4f9f6] px-3 py-2.5">
          <p className="flex items-center gap-1.5 font-mono text-[14px] font-bold tracking-[0.12em] text-[#195B4C]">
            <Ticket size={14} className="shrink-0" aria-hidden="true" />
            {credential.maskedCode}
          </p>
          <p className="mt-1 text-[11px] leading-[18px] text-slate-500">
            {credentialExpiryText(credential)}
          </p>
        </div>
      ) : null}

      {grant ? (
        <dl className="mt-2.5 space-y-1 text-[11px] leading-[18px] text-slate-400">
          <div className="flex justify-between gap-3">
            <dt>奖励状态</dt>
            <dd className="text-right font-semibold text-slate-600">
              {grantStatusLabels[grant.status]}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>领取人</dt>
            <dd className="text-right font-semibold text-slate-600">{grantRecipientText(grant)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>发放时间</dt>
            <dd className="text-right font-semibold text-slate-600">
              {formatRewardDateTime(grant.grantedAt)}
            </dd>
          </div>
          {grant.redeemedAt ? (
            <div className="flex justify-between gap-3">
              <dt>核销时间</dt>
              <dd className="text-right font-semibold text-slate-600">
                {formatRewardDateTime(grant.redeemedAt)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <Link
        to={`/community/activity/silver-neighborhood?activityId=${entry.activityId}`}
        state={{ from: '/me/rewards' }}
        className="mt-3 flex min-h-[44px] items-center justify-center rounded-[13px] bg-[#f2f7f4] px-3 text-[13px] font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        查看活动与团队进度
      </Link>
    </li>
  )
}
