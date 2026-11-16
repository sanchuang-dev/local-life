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
import { useBackTarget } from '../hooks/useBackTarget'
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
 * from the API, and requires one explicit acknowledgement checkbox before
 * the single binding action. The server still owns eligibility and finality.
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
  const { backTo } = useBackTarget('/', '返回')
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
  // Consent is tied to the exact community being confirmed, not merely the page instance.
  const [acknowledgedCommunityId, setAcknowledgedCommunityId] = useState<string | null>(null)
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
    if (!communityId || !auth.session || !confirmationOpen || acknowledgedCommunityId !== communityId || submitting) return
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
    <Link to={backTo} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-[13px] font-medium text-[#5b6c67] hover:text-[#116d63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700">
      <ArrowLeft size={16} aria-hidden="true" />
      返回
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
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e8f6f0] text-[#116d63]">
              <MapPin size={20} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold leading-6">{lookup.community.name}</h2>
              <p className="mt-0.5 break-words text-[12px] leading-5 text-[#5b6c67]">
                {lookup.community.address || '社区服务点地址暂未录入'}
              </p>
            </div>
          </div>

          <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-2.5 text-[13px] leading-6 text-[#3b4f49]">
            <input
              type="checkbox"
              checked={acknowledgedCommunityId === communityId}
              onChange={(event) => setAcknowledgedCommunityId(event.target.checked ? communityId : null)}
              className="mt-1 h-5 w-5 shrink-0 accent-[#138b79]"
            />
            <span>我确认将「{lookup.community.name}」设为常驻社区，绑定后不可自行修改。</span>
          </label>

          {failure ? (
            <p className="mt-2 text-[12px] leading-5 text-[#b23c2e]" role="alert">
              {failure}
            </p>
          ) : null}

          <button
            type="button"
            className={`${primaryButton} mt-3`}
            disabled={acknowledgedCommunityId !== communityId || submitting}
            onClick={() => void submit()}
          >
            {submitting ? '正在绑定…' : '确认绑定'}
          </button>
        </section>
      ) : null}
    </div>
  )
}
