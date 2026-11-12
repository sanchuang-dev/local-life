import { useEffect, useMemo, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  MapPin,
  ShieldAlert,
} from 'lucide-react'
import { Link } from 'react-router'
import {
  PUBLIC_COMMUNITY_ROUTE,
  publicCommunityListSchema,
  type PublicCommunity,
} from '@sanchuang-dev/local-life-contracts'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useResidentCommunity } from '../hooks/useResidentCommunity'
import { buildResidentLoginHref } from '../components/auth/residentLogin'
import { parseInviteParam } from '../components/activity/share'
import { confirmResidentCommunity } from '../services/residentCommunity'
import { isLocalApiError } from '../services/localApi'
import {
  PERMANENT_BINDING_NOTICE,
  RESIDENT_COMMUNITY_PAGE,
  confirmationErrorMessage,
  canOfferConfirmation,
  formatResidentCommunityDate,
  irreversibleWarning,
  readConfirmCommunityId,
  residentCommunitySummary,
} from '../lib/residentCommunity'

type CommunityLookup =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; community: PublicCommunity | null }

const primaryButton =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#138b79] px-4 text-[15px] font-semibold text-white transition-colors hover:bg-[#116d63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116d63] disabled:opacity-50'
const secondaryButton =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-[#cfe8de] bg-white px-4 text-[14px] font-semibold text-[#116d63]'

/**
 * Explicit first confirmation of the permanent community (#171 LL-IDENTITY-001).
 *
 * The page is reachable only with a real `communityId` naming the community the
 * resident is looking at. It shows the community name and service-point address
 * from the API, states irreversibility in a prominent way, and requires two
 * separate intentional actions:
 *
 *   1. 「我已了解，继续」 — reveals the final step;
 *   2. tick the acknowledgement, then press 「确认绑定为常驻社区」.
 *
 * Nothing here can switch, unbind or rebind: a confirmed resident is told so and
 * offered only reading. The confirm request body is `{ communityId }` built by the
 * shared service; the browsing choice in `localStorage` is never sent.
 *
 * Loading, unauthenticated, not-found, network error, closed confirmation
 * (already confirmed / pending review / conflict) all render real copy with a
 * return path back to browsing.
 */
export function ResidentCommunityConfirmPage() {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const auth = useResidentAuth()
  const residentCommunity = useResidentCommunity({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const communityId = useMemo(() => readConfirmCommunityId(searchParams.toString()), [searchParams])
  const invite = useMemo(() => parseInviteParam(searchParams.get('invite')), [searchParams])
  const activityId = searchParams.get('activityId')

  const [lookup, setLookup] = useState<CommunityLookup>({ status: 'loading' })
  const [lookupToken, setLookupToken] = useState(0)
  const [step, setStep] = useState<'review' | 'final'>('review')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirmedName, setConfirmedName] = useState<string | null>(null)

  // The community name/address come from the public directory: that is the same
  // row the API re-reads when it validates the confirmation, and it needs no
  // identity claim from the browser.
  useEffect(() => {
    if (!communityId) {
      setLookup({ status: 'ready', community: null })
      return
    }
    const controller = new AbortController()
    setLookup({ status: 'loading' })
    fetch(`/api${PUBLIC_COMMUNITY_ROUTE}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`社区信息加载失败（HTTP ${response.status}）`)
        const parsed = publicCommunityListSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('社区数据格式异常，无法安全展示')
        if (controller.signal.aborted) return
        const found = parsed.data.items.find((item) => item.id === communityId) ?? null
        setLookup({ status: 'ready', community: found })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setLookup({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取社区信息',
        })
      })
    return () => controller.abort()
  }, [communityId, lookupToken])

  const status = residentCommunity.state
  const statusData = status.status === 'ready' ? status.data : null

  // A resident who already confirmed another community must not be offered a
  // second confirmation; the reason is shown from the real status payload.
  const alreadyBoundElsewhere =
    statusData !== null &&
    statusData.binding !== null &&
    communityId !== null &&
    statusData.binding.community.id !== communityId
  const confirmationOpen = statusData !== null && canOfferConfirmation(statusData) && communityId !== null

  const returnTo = `${location.pathname}${location.search}`
  const loginHref = buildResidentLoginHref(returnTo, {
    activityId,
    inviteCode: invite.code,
    inviteInvalid: invite.invalid,
  })

  async function submit() {
    if (!communityId || !auth.session || !confirmationOpen || submitting) return
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await confirmResidentCommunity(communityId, auth.session.csrfToken)
      setConfirmedName(result.binding.community.name)
      residentCommunity.reload()
    } catch (cause) {
      const shaped = isLocalApiError(cause)
        ? { code: cause.code, status: cause.status, message: cause.message }
        : { code: null, status: 0, message: cause instanceof Error ? cause.message : '确认失败' }
      setFailure(confirmationErrorMessage(shaped))
      // A conflict or a completed binding changes what the resident may do next.
      residentCommunity.reload()
    } finally {
      setSubmitting(false)
    }
  }

  const backLink = (
    <Link to={RESIDENT_COMMUNITY_PAGE} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-[#5b6c67]">
      <ArrowLeft size={16} aria-hidden="true" />
      返回我的常驻社区
    </Link>
  )

  const browserShelter = (
    <p className="mt-3 text-[12px] leading-5 text-[#5b6c67]">
      浏览其他社区不受影响：切换浏览社区不会改变常驻社区。
      <Link to="/" className="ml-1 font-semibold text-[#116d63] underline">返回社区浏览</Link>
    </p>
  )

  if (!communityId) {
    return (
      <div className="mx-auto w-full max-w-[480px] px-4 pb-8 pt-3 text-[#172d28]">
        {backLink}
        <h1 className="mt-1 text-[22px] font-bold">确认常驻社区</h1>
        <div className="mt-4 rounded-2xl border border-[#f0d5bd] bg-[#fff7f0] p-4" role="alert">
          <p className="text-[14px] font-semibold text-[#7a4a2c]">没有可确认的社区</p>
          <p className="mt-1 text-[13px] leading-6 text-[#7a4a2c]">
            请先回到社区首页选择你要确认的社区，再进入本页确认。本页不会猜测或默认替你选择社区。
          </p>
          <Link to="/" className={`${secondaryButton} mt-3`}>返回社区浏览</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[480px] px-4 pb-8 pt-3 text-[#172d28]">
      {backLink}
      <h1 className="mt-1 text-[22px] font-bold">确认常驻社区</h1>
      <p className="mt-1 text-[13px] leading-6 text-[#5b6c67]">
        常驻社区需要你本人首次主动确认，无法由浏览、定位或历史登录自动产生。
      </p>

      {confirmedName ? (
        <section className="mt-4 rounded-2xl border border-[#cfe8de] bg-[#f0f8f4] p-4" role="status">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-[#116d63]">
            <CheckCircle2 size={19} aria-hidden="true" />
            已确认常驻社区：{confirmedName}
          </p>
          <p className="mt-2 text-[13px] leading-6 text-[#3b4f49]">
            你的常驻社区已固定。{PERMANENT_BINDING_NOTICE}
          </p>
          <Link to={RESIDENT_COMMUNITY_PAGE} className={`${primaryButton} mt-3`}>查看我的常驻社区</Link>
        </section>
      ) : null}

      {!auth.session && !auth.loading ? (
        <section className="mt-4 rounded-2xl border border-[#dce6e2] bg-white p-4">
          <p className="text-[14px] font-semibold">先登录，再确认</p>
          <p className="mt-1 text-[13px] leading-6 text-[#5b6c67]">
            确认常驻社区需要绑定到你的居民账户，请先完成统一登录；登录后会回到本页并保留当前社区。
          </p>
          <Link to={loginHref} className={`${primaryButton} mt-3`}>前往统一登录</Link>
        </section>
      ) : null}

      {auth.session && status.status === 'error' ? (
        <section className="mt-4 rounded-2xl border border-[#f0d5bd] bg-[#fff7f0] p-4" role="alert">
          <p className="text-[14px] font-semibold text-[#7a4a2c]">暂时无法读取常驻社区状态</p>
          <p className="mt-1 text-[13px] leading-6 text-[#7a4a2c]">{status.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" onClick={residentCommunity.reload} className="min-h-11 text-[13px] font-semibold text-[#116d63] underline">
              重新读取
            </button>
            <Link to="/" className="min-h-11 text-[13px] font-semibold text-[#116d63]">返回社区浏览</Link>
          </div>
        </section>
      ) : null}

      {auth.session && (status.status === 'idle' || status.status === 'loading' || lookup.status === 'loading') ? (
        <p className="mt-4 flex items-center gap-2 rounded-2xl bg-white p-4 text-[13px] text-[#5b6c67]" role="status">
          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
          正在读取社区与常驻社区状态…
        </p>
      ) : null}

      {statusData && alreadyBoundElsewhere && statusData.binding ? (
        <section className="mt-4 rounded-2xl border border-[#edd1c9] bg-[#fff7f0] p-4" role="alert">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-[#934a35]">
            <ShieldAlert size={18} aria-hidden="true" />
            你已确认常驻社区，无法修改
          </p>
          <p className="mt-2 text-[13px] leading-6 text-[#934a35]">
            你的常驻社区是「{statusData.binding.community.name}」，确认日期
            {` ${formatResidentCommunityDate(statusData.binding.confirmedAt)}`}。这个社区不能改为「
            {lookup.status === 'ready' && lookup.community ? lookup.community.name : '当前社区'}」。
          </p>
          <Link to={RESIDENT_COMMUNITY_PAGE} className={`${secondaryButton} mt-3`}>查看我的常驻社区</Link>
          {browserShelter}
        </section>
      ) : null}

      {statusData && !alreadyBoundElsewhere && !confirmationOpen &&
      (statusData.status !== 'unbound' || statusData.confirmBlockedReason !== null) ? (
        <section className="mt-4 rounded-2xl border border-[#f0d5bd] bg-[#fff7f0] p-4" role="alert">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-[#7a4a2c]">
            <CircleAlert size={18} aria-hidden="true" />
            当前无法确认常驻社区
          </p>
          <p className="mt-2 text-[13px] leading-6 text-[#7a4a2c]">{residentCommunitySummary(statusData).detail}</p>
          <Link to={RESIDENT_COMMUNITY_PAGE} className={`${secondaryButton} mt-3`}>查看我的常驻社区</Link>
        </section>
      ) : null}

      {statusData && !alreadyBoundElsewhere && confirmationOpen && lookup.status === 'error' ? (
        <section className="mt-4 rounded-2xl border border-[#f0d5bd] bg-[#fff7f0] p-4" role="alert">
          <p className="text-[14px] font-semibold text-[#7a4a2c]">社区信息加载失败</p>
          <p className="mt-1 text-[13px] leading-6 text-[#7a4a2c]">{lookup.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setLookupToken((token) => token + 1)} className="min-h-11 text-[13px] font-semibold text-[#116d63] underline">
              重试
            </button>
            <Link to="/" className="min-h-11 text-[13px] font-semibold text-[#116d63]">返回社区浏览</Link>
          </div>
        </section>
      ) : null}

      {statusData && !alreadyBoundElsewhere && confirmationOpen && lookup.status === 'ready' && !lookup.community ? (
        <section className="mt-4 rounded-2xl border border-[#f0d5bd] bg-[#fff7f0] p-4" role="alert">
          <p className="text-[14px] font-semibold text-[#7a4a2c]">这个社区已不存在或已下线</p>
          <p className="mt-1 text-[13px] leading-6 text-[#7a4a2c]">
            无法确认一个不可用的社区。请返回社区列表重新选择。
          </p>
          <Link to="/" className={`${secondaryButton} mt-3`}>返回社区浏览</Link>
        </section>
      ) : null}

      {statusData && !confirmedName && confirmationOpen && lookup.status === 'ready' && lookup.community && auth.session ? (
        <section className="mt-4 rounded-2xl border border-[#dce6e2] bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#e8f6f0] text-[#116d63]">
              <MapPin size={21} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[19px] font-bold leading-7">{lookup.community.name}</h2>
              <p className="mt-0.5 break-words text-[13px] leading-5 text-[#5b6c67]">
                {lookup.community.address || '社区服务点地址暂未录入'}
              </p>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-[#e7b8a8] bg-[#fff1ee] p-3" role="alert">
            <p className="flex items-center gap-1.5 text-[13px] font-bold text-[#b23c2e]">
              <CircleAlert size={16} aria-hidden="true" />
              绑定后不可修改
            </p>
            <p className="mt-1 text-[12px] leading-5 text-[#934a35]">
              {irreversibleWarning(lookup.community.name, lookup.community.address)}
              {PERMANENT_BINDING_NOTICE}
            </p>
          </div>

          {failure ? (
            <p className="mt-3 rounded-xl bg-[#fff1ee] px-3 py-2 text-[12px] leading-5 text-[#b23c2e]" role="alert">
              {failure}
            </p>
          ) : null}

          {step === 'review' ? (
            <>
              <button
                type="button"
                className={`${primaryButton} mt-3`}
                onClick={() => {
                  setFailure(null)
                  setStep('final')
                }}
              >
                我已了解，继续确认
              </button>
              <p className="mt-2 text-[11px] leading-5 text-[#5b6c67]">
                这一步不会提交任何绑定；下一步还需要勾选确认并再次点击按钮。
              </p>
            </>
          ) : (
            <>
              <label className="mt-3 flex items-start gap-2 rounded-xl bg-[#f5f7f7] p-3 text-[12px] leading-5 text-[#3b4f49]">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-[#138b79]"
                />
                <span>
                  我已确认这是我的常驻社区「{lookup.community.name}」，并理解确认后居民端无法修改。
                </span>
              </label>
              <button
                type="button"
                className={`${primaryButton} mt-3`}
                disabled={!acknowledged || submitting}
                onClick={() => void submit()}
              >
                {submitting ? '正在提交确认…' : '确认绑定为常驻社区'}
              </button>
              <button
                type="button"
                className="mt-2 min-h-11 w-full text-[13px] font-semibold text-[#5b6c67] underline"
                onClick={() => {
                  setAcknowledged(false)
                  setFailure(null)
                  setStep('review')
                }}
              >
                返回上一步
              </button>
            </>
          )}
          {browserShelter}
        </section>
      ) : null}
    </div>
  )
}
