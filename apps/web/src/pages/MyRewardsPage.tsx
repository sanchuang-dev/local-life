import { useState } from 'react'
import {
  AlertTriangle,
  Gift,
  RefreshCw,
  Ticket,
  Wallet,
} from 'lucide-react'
import { Link } from 'react-router'
import type {
  CouponEffectiveStatus,
  CouponWalletItem,
} from '@sanchuang-dev/local-life-contracts'
import { PageHeader } from '../components/PageHeader'
import {
  credentialExpiryText,
  formatCents,
  formatRewardDateTime,
  grantRecipientText,
  grantStatusLabels,
  rewardBucketClasses,
  rewardBucketDetail,
  rewardBucketLabels,
  type RewardBucket,
} from '../components/activity/rewardLabels'
import {
  couponStatusLabels,
  couponStatusView,
} from '../components/activity/purchaseRewardUi'
import { FilterChipRow } from '../components/crm/FilterChips'
import { useBackTarget } from '../hooks/useBackTarget'
import { useCouponWallet } from '../hooks/useCouponWallet'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { buildResidentLoginHref } from '../components/auth/residentLogin'
import { useRewardWallet, type RewardWalletEntry } from '../hooks/useRewardWallet'
import { DrawWalletSection } from '../components/activity/DrawWalletSection'
import { shortTeamId } from '../components/life/localOrderAttribution'

const BUCKET_ORDER: RewardBucket[] = ['claimable', 'pending', 'redeemed', 'disputed', 'void']

const bucketOptions = BUCKET_ORDER.map((bucket) => ({
  value: bucket,
  label: rewardBucketLabels[bucket],
}))

const COUPON_STATUS_ORDER: CouponEffectiveStatus[] = [
  'available',
  'reserved',
  'redeemed',
  'void',
  'expired',
]

const couponOptions = COUPON_STATUS_ORDER.map((status) => ({
  value: status,
  label: couponStatusLabels[status],
}))

const couponToneClasses = {
  slate: 'bg-slate-100 text-slate-500',
  orange: 'bg-[#fff3e6] text-[#a96b2f]',
  teal: 'bg-[#e8f6f0] text-teal-700',
  rose: 'bg-rose-50 text-rose-600',
} as const

/**
 * 我的奖励 — the resident activity wallet.
 *
 * Team check-in rewards are composed from the published activity list and each
 * activity's team-reward state. Consumption coupons are read from their own
 * global wallet endpoint, so a coupon can never disappear merely because its
 * activity is outside a shortened activity list. The plaintext check-in code is
 * never stored client-side; it is only shown once at claim time.
 */
export function MyRewardsPage() {
  const { backTo, backLabel } = useBackTarget('/me', '返回我的')
  const auth = useResidentAuth()
  const wallet = useRewardWallet({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const couponWallet = useCouponWallet({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const [bucket, setBucket] = useState<RewardBucket | ''>('')
  const [couponStatus, setCouponStatus] = useState<CouponEffectiveStatus | ''>('')

  const entries = wallet.state.status === 'ready' ? wallet.state.entries : []
  const drawEntries = wallet.state.status === 'ready' ? wallet.state.drawEntries : []
  const couponItems = couponWallet.state.status === 'ready' ? couponWallet.state.items : []
  const walletLoading = wallet.state.status === 'loading' || auth.loading
  const couponLoading = couponWallet.state.status === 'loading'
  const visible = bucket === '' ? entries : entries.filter((item) => item.bucket === bucket)
  const visibleCoupons =
    couponStatus === ''
      ? couponItems
      : couponItems.filter((item) => item.status === couponStatus)
  const counts = BUCKET_ORDER.reduce<Record<string, number>>((accumulator, key) => {
    accumulator[key] = entries.filter((item) => item.bucket === key).length
    return accumulator
  }, {})
  const couponCounts = COUPON_STATUS_ORDER.reduce<Record<string, number>>((accumulator, key) => {
    accumulator[key] = couponItems.filter((item) => item.status === key).length
    return accumulator
  }, {})
  const noRewards =
    wallet.state.status === 'ready' &&
    entries.length === 0 &&
    drawEntries.length === 0 &&
    couponWallet.state.status === 'ready' &&
    couponItems.length === 0

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={Wallet}
        title="我的奖励"
        subtitle="奖励 · 领取凭据 · 消费券状态"
      />

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

      {walletLoading ? (
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

      {noRewards ? (
        <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <p className="flex items-center gap-1.5 text-[14px] font-bold text-slate-800">
            <Gift size={16} className="shrink-0 text-teal-700" aria-hidden="true" />
            暂无活动奖励
          </p>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            暂时没有团队奖励、消费券或抽奖中奖。参与社区活动后，可以在这里查看自己的真实奖励与核销凭据。
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

      <DrawWalletSection entries={drawEntries} />

      {couponLoading ? (
        <p
          className="mt-5 flex items-center justify-center gap-2 text-[12px] font-medium text-slate-500"
          role="status"
          aria-live="polite"
        >
          <span
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
            aria-hidden="true"
          />
          正在读取消费券包…
        </p>
      ) : null}

      {couponWallet.state.status === 'error' ? (
        <section className="mt-5 rounded-[18px] border border-[#f0d5bd] bg-[#fff7f0] p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-[#7a4a2c]">
            <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
            消费券包读取失败
          </p>
          <p className="mt-1 break-words text-[12px] leading-5 text-[#7a4a2c]">
            {couponWallet.state.message}
          </p>
          <button
            type="button"
            onClick={couponWallet.reload}
            className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white"
          >
            <RefreshCw size={14} aria-hidden="true" />
            重新读取券包
          </button>
        </section>
      ) : null}

      {couponWallet.state.status === 'ready' && couponItems.length > 0 ? (
        <section className="mt-5" aria-labelledby="coupon-wallet-heading">
          <h2 id="coupon-wallet-heading" className="mb-3 text-[17px] font-bold text-slate-900">
            消费团奖励券
          </h2>
          <FilterChipRow
            label="消费券状态"
            value={couponStatus}
            options={couponOptions.map((option) => ({
              ...option,
              label: `${option.label} ${couponCounts[option.value] ?? 0}`,
            }))}
            onChange={(value) => setCouponStatus(value as CouponEffectiveStatus | '')}
            allLabel={`全部 ${couponItems.length}`}
          />
          {visibleCoupons.length === 0 ? (
            <p className="mt-3 rounded-[16px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-[12px] leading-5 text-slate-500">
              当前筛选下没有消费券。
            </p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {visibleCoupons.map((coupon) => (
                <CouponWalletCard key={coupon.id} coupon={coupon} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {visible.length > 0 ? (
        <section className="mt-5" aria-labelledby="team-wallet-heading">
          <h2 id="team-wallet-heading" className="mb-3 text-[17px] font-bold text-slate-900">团队签到奖励</h2>
          <ul className="grid gap-3">
          {visible.map((entry) => (
            <RewardWalletCard key={entry.activityId} entry={entry} />
          ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-5 text-[11px] leading-[1.7] text-slate-400">
        团队签到奖励凭据请在领取时保存；抽奖中奖的有效核销码可在本页查看；消费券状态来自全量券包，请勿公开分享兑换信息。
      </p>
    </div>
  )
}

function CouponWalletCard({ coupon }: { coupon: CouponWalletItem }) {
  const status = couponStatusView(coupon)
  return (
    <li className="rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[14px] font-bold text-slate-900">
            <Ticket size={15} className="shrink-0 text-[#a96b2f]" aria-hidden="true" />
            消费团奖励券
          </p>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">
            团号 {shortTeamId(coupon.teamId)} · 发放于 {formatRewardDateTime(coupon.issuedAt)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
            couponToneClasses[status.tone]
          }`}
        >
          {status.label}
        </span>
      </div>

      <p className="mt-2 text-[24px] font-bold leading-none text-[#a96b2f]">
        {formatCents(coupon.faceValueCents)}
      </p>
      <p className="mt-1.5 break-words text-[12px] leading-5 text-slate-500">{status.detail}</p>
      <p className="mt-1 text-[11px] leading-5 text-slate-400">{status.expiresText}</p>

      <Link
        to={`/community/activity/silver-neighborhood?activityId=${coupon.activityId}`}
        state={{ from: '/me/rewards' }}
        className="mt-3 flex min-h-[44px] items-center justify-center rounded-[13px] bg-[#f2f7f4] px-3 text-[13px] font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        查看活动与消费团进度
      </Link>
    </li>
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
