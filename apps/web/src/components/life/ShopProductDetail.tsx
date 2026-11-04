import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  LogIn,
  ShieldCheck,
  ShoppingBag,
  Store,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import {
  CRMEB_PURCHASE_WARNINGS,
  CRMEB_ROUTES,
  apiErrorSchema,
  crmebPurchaseLinkRequestSchema,
  crmebPurchaseLinkResponseSchema,
  type CrmebPurchaseLinkResponse,
} from '@sanchuang-dev/local-life-contracts'
import { useBackTarget } from '../../hooks/useBackTarget'
import { useResidentAuth } from '../../hooks/useResidentAuth'
import { useActivitySource, useShopProduct } from '../../hooks/useShopProducts'
import { PageHeader } from '../PageHeader'
import { ActivitySourceNote } from './ActivitySourceNote'
import { ShopProductImage } from './ShopProductImage'
import { ShopStateCard } from './ShopStateCard'
import {
  activityStatusLabel,
  categoryLabel,
  formatPriceCents,
  plainTextFromHtml,
} from './shop'

const API_PREFIX = '/api'
const MAX_CRMEB_PRODUCT_ID = 2_147_483_647

interface PurchaseFailure {
  title: string
  message: string
  code?: string
}

type PurchaseResult = {
  url: string
  claim: CrmebPurchaseLinkResponse['claim']
  warnings: string[]
}

function parseCrmebProductId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_CRMEB_PRODUCT_ID
    ? value
    : null
}

async function readApiFailure(response: Response): Promise<{ code: string; message: string }> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(payload)
  if (parsed.success) return parsed.data.error
  return { code: 'unknown', message: `请求失败（HTTP ${response.status}）` }
}

function describePurchaseFailure(
  status: number,
  failure: { code: string; message: string },
  hadActivity: boolean,
): PurchaseFailure {
  if (status === 401 || failure.code === 'unauthorized') {
    return {
      title: '登录状态已失效',
      message: '请重新登录居民账户后再试。',
      code: failure.code,
    }
  }
  if (failure.code === 'not_configured') {
    return {
      title: '商城未配置',
      message: '服务端未配置 CRMEB 商城凭证，暂时无法生成购买跳转。',
      code: failure.code,
    }
  }
  if (status === 404) {
    const activityRelated = hadActivity && failure.message.includes('活动')
    return {
      title: activityRelated ? '活动来源已失效' : '商品当前不可购买',
      message: failure.message,
      code: failure.code,
    }
  }
  if (status === 403) {
    const hint = failure.message.includes('CSRF')
      ? '请刷新页面后重试。'
      : '请确认活动来源与本人所在社区是否一致。'
    return {
      title: '无法提交购买来源',
      message: `${failure.message} ${hint}`,
      code: failure.code,
    }
  }
  if (status === 503) {
    return { title: '商城暂时不可用', message: failure.message, code: failure.code }
  }
  return { title: '购买跳转失败', message: failure.message, code: failure.code }
}

function claimDescription(claim: CrmebPurchaseLinkResponse['claim']): string {
  if (claim.claimState === 'claimed') {
    return '来源已记录为本社区网格员认领；这是弱关联，需后续对账核实，平台不会把它当作已确认成交。'
  }
  return '来源已记录为未确认：未提供有效推荐码，或推荐码不属于本社区在职网格员。'
}

/**
 * Real CRMEB product detail plus the only permitted purchase path:
 *
 * 1. the resident must have a real session (no fake login);
 * 2. the browser asks the server for an attributed CRMEB H5 link;
 * 3. the server decides the source (`activityId` is only forwarded from a
 *    trusted deep link, `referralCode` only from `?ref=`);
 * 4. the returned URL is opened for real, and the response warnings are shown.
 *
 * The request body never contains `gridWorkerId`, `confirmed`, `claimState` or a
 * CRMEB uid. No order is created and no payment happens on the platform.
 */
export function ShopProductDetail({ rawProductId }: { rawProductId: string }) {
  const crmebProductId = parseCrmebProductId(rawProductId)
  const { state, retry } = useShopProduct(crmebProductId)
  const { backTo, backLabel } = useBackTarget('/life?tab=deals', '返回惠生活')
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const auth = useResidentAuth()

  const activityId = searchParams.get('activityId')?.trim() || null
  const activitySource = useActivitySource(activityId)
  const referralRaw = searchParams.get('ref')?.trim() || ''
  const referralCode = referralRaw.length > 0 && referralRaw.length <= 64 ? referralRaw : null
  const referralIgnored = referralRaw.length > 64

  const [purchaseState, setPurchaseState] = useState<'idle' | 'busy'>('idle')
  const [purchaseError, setPurchaseError] = useState<PurchaseFailure | null>(null)
  const [purchaseResult, setPurchaseResult] = useState<PurchaseResult | null>(null)
  const popupRef = useRef<Window | null>(null)

  const product = state.status === 'ready' ? state.product : null
  const activityPending = Boolean(activityId) && activitySource.state.status === 'loading'
  const activityBlocked =
    Boolean(activityId) &&
    (activitySource.state.status === 'invalid' ||
      activitySource.state.status === 'error' ||
      (activitySource.state.status === 'ready' &&
        activitySource.state.activity.status !== 'published'))
  const canPurchase =
    Boolean(auth.session) && Boolean(product) && !activityPending && !activityBlocked

  const naturalParams = new URLSearchParams()
  if (referralCode) naturalParams.set('ref', referralCode)
  const naturalSearch = naturalParams.toString()
  const naturalTo = {
    pathname: location.pathname,
    search: naturalSearch ? `?${naturalSearch}` : '',
  }

  const handlePurchase = async () => {
    if (!product || !auth.session || purchaseState === 'busy') return
    if (activityPending || activityBlocked) return

    // Open a placeholder synchronously so the user gesture is not lost while the
    // server creates the attribution record. If the browser blocks it, fall back
    // to same-window navigation after success.
    const popup = window.open('', '_blank')
    popupRef.current = popup
    if (popup) popup.opener = null

    const closePopup = () => {
      const current = popupRef.current
      popupRef.current = null
      if (current && !current.closed) current.close()
    }

    setPurchaseState('busy')
    setPurchaseError(null)
    setPurchaseResult(null)

    const body: { crmebProductId: number; activityId?: string; referralCode?: string } = {
      crmebProductId: product.crmebProductId,
    }
    if (activityId && activitySource.state.status === 'ready') {
      body.activityId = activityId
    }
    if (referralCode) body.referralCode = referralCode

    try {
      // The shared strict schema rejects `gridWorkerId`, `confirmed`,
      // `claimState`, `crmebUid` and any other browser-chosen ownership field.
      const requestCheck = crmebPurchaseLinkRequestSchema.safeParse(body)
      if (!requestCheck.success) {
        closePopup()
        setPurchaseError({
          title: '购买来源参数不正确',
          message: '请从活动页面重新进入，或忽略活动来源后按普通商品购买。',
        })
        return
      }

      const response = await fetch(`${API_PREFIX}${CRMEB_ROUTES.purchaseLink}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': auth.session.csrfToken,
        },
        body: JSON.stringify(requestCheck.data),
      })

      if (!response.ok) {
        const failure = await readApiFailure(response)
        closePopup()
        setPurchaseError(
          describePurchaseFailure(response.status, failure, Boolean(body.activityId)),
        )
        return
      }

      const parsed = crmebPurchaseLinkResponseSchema.safeParse(
        await response.json().catch(() => null),
      )
      if (!parsed.success) {
        closePopup()
        setPurchaseError({
          title: '购买跳转数据异常',
          message: '服务端返回的商城链接格式与契约不一致，无法安全跳转。',
          code: 'crmeb_contract_mismatch',
        })
        return
      }

      setPurchaseResult({
        url: parsed.data.url,
        claim: parsed.data.claim,
        warnings: parsed.data.warnings,
      })

      const target = popupRef.current
      popupRef.current = null
      if (target && !target.closed) {
        target.location.href = parsed.data.url
      } else {
        window.location.assign(parsed.data.url)
      }
    } catch (cause) {
      closePopup()
      setPurchaseError({
        title: '购买跳转失败',
        message:
          cause instanceof Error
            ? cause.message
            : '暂时无法连接购买服务，请稍后重试。',
      })
    } finally {
      setPurchaseState('idle')
    }
  }

  const header = (
    <PageHeader
      backTo={backTo}
      backLabel={backLabel}
      icon={ShoppingBag}
      title="商品详情"
      subtitle="真实 CRMEB 商城 · 价格与库存以商城为准"
    />
  )

  if (state.status === 'loading') {
    return (
      <div className="px-4 pb-7 pt-3">
        {header}
        <div role="status" aria-live="polite" className="mt-4">
          <div className="h-[300px] animate-pulse rounded-[20px] border border-slate-100 bg-white" />
          <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
            正在读取商城商品详情…
          </p>
        </div>
      </div>
    )
  }

  if (state.status === 'not_configured') {
    return (
      <div className="px-4 pb-7 pt-3">
        {header}
        <div className="mt-4">
          <ShopStateCard
            icon={Store}
            tone="warn"
            title="商城未配置"
            description={`${state.message} 配置完成前，这里不会展示模拟商品，也不提供模拟购买。`}
            onRetry={retry}
            retryLabel="检查配置后重试"
          />
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    const isInvalidId = state.code === 'invalid_request'
    const isNotFound = state.code === 'not_found'
    return (
      <div className="px-4 pb-7 pt-3">
        {header}
        <div className="mt-4">
          <ShopStateCard
            icon={AlertTriangle}
            tone="error"
            title={isInvalidId ? '商品 id 无效' : isNotFound ? '商品不存在或已下架' : '商品详情加载失败'}
            description={state.message}
            code={state.code}
            onRetry={isInvalidId ? undefined : retry}
          >
            <Link
              to={backTo}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700"
            >
              {backLabel}
            </Link>
          </ShopStateCard>
        </div>
      </div>
    )
  }

  if (!product) return null

  const detailText = plainTextFromHtml(product.detailHtml)
  const showSkus =
    product.skus.length > 0 &&
    (product.specType === 1 || product.skus.some((sku) => Boolean(sku.specText)))

  return (
    <div className="px-4 pb-7 pt-3">
      {header}

      <article className="mt-4 overflow-hidden rounded-[20px] border border-slate-100 bg-white shadow-sm">
        <ShopProductImage
          src={product.images[0]}
          alt={product.name}
          className="aspect-[4/3] w-full object-cover"
        />
        <div className="p-4">
          <div className="flex flex-wrap gap-1.5">
            {product.categoryNames.length > 0 ? (
              product.categoryNames.map((name) => (
                <span
                  key={name}
                  className="max-w-full truncate rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
                >
                  {name}
                </span>
              ))
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                未分类
              </span>
            )}
            <span className="rounded-full bg-[#eef7f2] px-2 py-0.5 text-[10px] font-medium text-teal-700">
              CRMEB 商城
            </span>
          </div>

          <h1 className="mt-2.5 break-words text-[21px] font-semibold leading-[1.35] tracking-tight text-slate-900">
            {product.name}
          </h1>
          <p className="mt-1.5 break-words text-[12px] leading-6 text-slate-500">
            {product.summary || '商城未提供商品简介。'}
          </p>

          <div className="mt-3 flex flex-wrap items-baseline gap-2">
            <span className="text-[28px] font-semibold leading-none tracking-tight text-[#8a6132]">
              {formatPriceCents(product.priceCents)}
            </span>
            {product.originalPriceCents !== null &&
            product.originalPriceCents > product.priceCents ? (
              <span className="text-[12px] text-slate-400 line-through">
                {formatPriceCents(product.originalPriceCents)}
              </span>
            ) : null}
            <span className="text-[11px] text-slate-400">价格单位为商城标价</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
            库存与可售状态以商城为准：平台接口不返回库存，因此无法判断是否售罄。
          </p>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">
            分类：{categoryLabel(product.categoryNames)}
          </p>
        </div>
      </article>

      {showSkus ? (
        <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <h2 className="text-[16px] font-semibold text-slate-800">规格与价格</h2>
          <ul className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
            {product.skus.map((sku) => (
              <li
                key={sku.skuKey}
                className="flex items-start justify-between gap-3 py-2.5"
              >
                <span className="min-w-0 break-words text-[12px] leading-5 text-slate-600">
                  {sku.specText ?? '商城未提供规格名'}
                </span>
                <span className="shrink-0 text-[12px] font-semibold text-[#8a6132]">
                  {formatPriceCents(sku.priceCents)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            规格库存同样以商城为准。
          </p>
        </section>
      ) : null}

      {detailText ? (
        <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <h2 className="text-[16px] font-semibold text-slate-800">商品详情</h2>
          <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-6 text-slate-600">
            {detailText}
          </p>
          <p className="mt-3 text-[11px] leading-5 text-slate-400">
            以上为商城商品详情的文字内容；图片与富文本请以商城页面为准。
          </p>
        </section>
      ) : null}

      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-800">购买与来源</h2>

        <dl className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
          <div className="flex items-start justify-between gap-3 py-2.5">
            <dt className="shrink-0 text-[12px] text-slate-400">购买方式</dt>
            <dd className="text-right text-[12px] font-medium leading-5 text-slate-600">
              跳转 CRMEB 商城 H5，由商城完成登录、下单与支付
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3 py-2.5">
            <dt className="shrink-0 text-[12px] text-slate-400">活动来源</dt>
            <dd className="text-right text-[12px] font-medium leading-5 text-slate-600">
              {activityId ? '深链携带，提交前核验' : '未携带（普通商品购买）'}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3 py-2.5">
            <dt className="shrink-0 text-[12px] text-slate-400">推荐码</dt>
            <dd className="text-right text-[12px] font-medium leading-5 text-slate-600">
              {referralCode
                ? '深链携带，由服务端解析归属'
                : referralIgnored
                  ? '深链格式无效，未提交'
                  : '未携带'}
            </dd>
          </div>
        </dl>

        <ActivitySourceNote
          activityId={activityId}
          state={activitySource.state}
          onRetry={activitySource.retry}
        />

        {activityBlocked ? (
          <div
            role="alert"
            className="mt-3 rounded-[14px] border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-3 text-[11px] leading-5 text-[#8a6132]"
          >
            <p className="flex items-start gap-1.5 font-semibold">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">
                {activitySource.state.status === 'ready'
                  ? `来源活动当前${activityStatusLabel(activitySource.state.activity.status)}，不能作为购买来源。`
                  : '当前深链携带的活动来源不可用，购买前需要修正或忽略它。'}
              </span>
            </p>
            <Link
              to={naturalTo}
              replace
              className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-[#d9b98f] bg-white px-4 text-[12px] font-semibold text-[#8a6132]"
            >
              忽略活动来源，按普通商品购买
            </Link>
          </div>
        ) : null}

        {!auth.session ? (
          <div className="mt-3 rounded-[14px] bg-[#f4f8f6] p-3.5">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
              <LogIn size={15} aria-hidden="true" />
              购买需先登录居民账户
            </p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">
              登录只用于记录本次点击来源与校验社区归属。平台不代下单、不代支付，也不会伪造登录成功。
            </p>

            {auth.loading ? (
              <p className="mt-3 text-[11px] text-slate-400">正在确认登录状态…</p>
            ) : auth.error ? (
              <p role="alert" className="mt-3 break-words text-[11px] leading-5 text-rose-600">
                {auth.error}
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {auth.methods?.wechat ? (
                  <button
                    type="button"
                    onClick={auth.startWechatLogin}
                    className="min-h-[44px] rounded-full bg-[#138b79] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#116d63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                  >
                    微信授权登录
                  </button>
                ) : null}
                {auth.methods?.developmentResidentLogin ? (
                  <button
                    type="button"
                    disabled={auth.busy}
                    onClick={() => void auth.developmentLogin()}
                    className="min-h-[44px] rounded-full border border-teal-200 bg-white px-4 text-[12px] font-semibold text-teal-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                  >
                    {auth.busy ? '登录中…' : '开发测试登录'}
                  </button>
                ) : null}
                {auth.methods && !auth.methods.wechat && !auth.methods.developmentResidentLogin ? (
                  <span className="break-words text-[11px] leading-5 text-slate-500">
                    微信网页授权尚未配置，当前无法登录。
                  </span>
                ) : null}
              </div>
            )}

            <Link
              to="/me"
              state={{ from: `${location.pathname}${location.search}` }}
              className="mt-3 inline-flex min-h-[36px] items-center text-[12px] font-semibold text-teal-700 underline decoration-teal-300 underline-offset-4"
            >
              打开「我的」账户与登录入口
            </Link>
          </div>
        ) : (
          <>
            <p className="mt-3 break-words text-[11px] leading-5 text-slate-400">
              已登录居民账户：{auth.session.user.displayName}。CSRF 取自当前会话。
            </p>
            {activityPending ? (
              <button
                type="button"
                disabled
                className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-slate-300 text-[13px] font-semibold text-white"
              >
                正在核验活动来源…
              </button>
            ) : activityBlocked ? null : (
              <button
                type="button"
                disabled={!canPurchase || purchaseState === 'busy'}
                onClick={() => void handlePurchase()}
                className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 disabled:bg-slate-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                {purchaseState === 'busy' ? (
                  '正在生成商城跳转…'
                ) : (
                  <>
                    去 CRMEB 商城购买
                    <ExternalLink size={15} aria-hidden="true" />
                  </>
                )}
              </button>
            )}
          </>
        )}

        {purchaseError ? (
          <div
            role="alert"
            className="mt-3 rounded-[14px] border border-rose-200 bg-rose-50/70 px-3.5 py-3 text-[11px] leading-5 text-rose-700"
          >
            <p className="flex items-start gap-1.5 font-semibold">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{purchaseError.title}</span>
            </p>
            <p className="mt-1 break-words">{purchaseError.message}</p>
            {purchaseError.code ? (
              <p className="mt-1 break-all font-mono text-[10px] text-rose-500">
                错误代码：{purchaseError.code}
              </p>
            ) : null}
            {purchaseError.code === 'unauthorized' ? (
              <Link
                to="/me"
                state={{ from: `${location.pathname}${location.search}` }}
                className="mt-2 inline-flex min-h-[36px] items-center text-[12px] font-semibold text-rose-700 underline decoration-rose-300 underline-offset-4"
              >
                重新登录
              </Link>
            ) : null}
          </div>
        ) : null}

        {purchaseResult ? (
          <div
            role="status"
            className="mt-3 rounded-[14px] border border-teal-200/80 bg-[#eef7f2] px-3.5 py-3 text-[11px] leading-5 text-[#376958]"
          >
            <p className="flex items-start gap-1.5 font-semibold">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              已生成商城跳转并记录本次点击
            </p>
            <p className="mt-1 break-words">{claimDescription(purchaseResult.claim)}</p>
            <p className="mt-1 break-words">
              活动来源：
              {purchaseResult.claim.activityId ? '已关联' : '未携带（普通商品购买）'}
            </p>
            <ul className="mt-2 space-y-1">
              {purchaseResult.warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-1.5 break-words">
                  <ShieldCheck size={13} className="mt-1 shrink-0" aria-hidden="true" />
                  {warning}
                </li>
              ))}
            </ul>
            <a
              href={purchaseResult.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 font-semibold text-teal-700 underline decoration-teal-300 underline-offset-4"
            >
              若商城未自动打开，点此进入
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>
        ) : null}

        <div className="mt-3 rounded-[14px] bg-slate-50 px-3.5 py-3">
          <p className="text-[11px] font-semibold text-slate-600">购买前须知</p>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-5 text-slate-500">
            {CRMEB_PURCHASE_WARNINGS.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5 break-words">
                <ShieldCheck size={13} className="mt-1 shrink-0 text-teal-600" aria-hidden="true" />
                {warning}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="mt-4">
        <Link
          to={backTo}
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          {backLabel}
        </Link>
      </div>
    </div>
  )
}
