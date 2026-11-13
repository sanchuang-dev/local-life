import { useCallback, useEffect, useState } from 'react'
import { ProfilePreviewDrawer, type ProfilePreviewData } from '../components/profile/ProfilePreviewDrawer'
import {
  CalendarCheck2, ChevronRight, ClipboardList, Gift, Home,
  MapPin, ShieldCheck, UserRound,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { MeAccountPanel } from '../components/me/MeAccountPanel'
import { residentCommunitySummary } from '../lib/residentCommunity'
import { useResidentCommunity } from '../hooks/useResidentCommunity'
import { buildResidentLoginHref } from '../components/auth/residentLogin'
import { parseInviteParam } from '../components/activity/share'
import { parseActivityLoginResult } from '../components/activity/loginReturn'
import { staffRoleLabels } from '../components/crm/crmLabels'
import { usePublicActivity } from '../hooks/usePublicActivity'
import { useResidentAuth } from '../hooks/useResidentAuth'
import './MePage.css'

const PROFILE_MESSAGES: Record<string, string> = {
  success: '微信头像和昵称已同步。平台昵称不会被覆盖。',
  cancelled: '你已取消微信资料授权，当前登录状态不受影响。',
  authorization_failed: '微信资料授权未完成，当前登录状态不受影响。',
  state_invalid: '本次资料授权已过期或无效，请重新发起。',
  state_replayed: '本次资料授权已使用，请重新发起。',
  session_mismatch: '授权期间登录账户发生变化，未修改任何资料。请在当前账户重新发起。',
  identity_mismatch: '返回的微信身份与当前账户不匹配，未修改资料，也未绑定其他账户。',
  configuration_unavailable: '公众号配置当前不可用，请联系运营人员。',
  provider_unavailable: '微信资料服务暂时不可用，请稍后重试。',
}

/**
 * Resident "我的". Illustration and information architecture follow the reviewed
 * visual direction; every number and account state comes from existing APIs.
 * No illustrative profile, points, coupon count, announcement or settings link.
 */
export function MePage() {
  const auth = useResidentAuth()
  const [profileDrawerOpen, setProfileDrawerOpen] = useState(false)
  const [profilePreview, setProfilePreview] = useState<ProfilePreviewData>({ phone: '', address: '' })
  const [profilePreviewSaved, setProfilePreviewSaved] = useState(false)
  const closeProfileDrawer = useCallback(() => setProfileDrawerOpen(false), [])
  const saveProfilePreview = useCallback((value: ProfilePreviewData) => {
    setProfilePreview(value)
    setProfilePreviewSaved(true)
    setProfileDrawerOpen(false)
  }, [])
  const [searchParams, setSearchParams] = useSearchParams()
  const [profileNotice] = useState(() => {
    const result = searchParams.get('wechat_profile')
    return result ? PROFILE_MESSAGES[result] ?? '微信资料授权流程已结束。' : null
  })

  useEffect(() => {
    if (!searchParams.has('wechat_profile')) return
    const next = new URLSearchParams(searchParams)
    next.delete('wechat_profile')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const requestedActivityId = searchParams.get('activityId')?.trim() || null
  const { state: activityState } = usePublicActivity(requestedActivityId)
  const activity = activityState.status === 'ready' ? activityState.activity : null
  const residentCommunity = useResidentCommunity({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })

  const nickname = auth.wechatProfile?.available && auth.wechatProfile.authorized
    ? auth.wechatProfile.nickname : null
  const avatarUrl = auth.wechatProfile?.available && auth.wechatProfile.authorized
    ? auth.wechatProfile.avatarUrl : null

  const communityState = residentCommunity.state
  const communityData = communityState.status === 'ready' ? communityState.data : null
  const communitySummary = communityData ? residentCommunitySummary(communityData) : null
  const binding = communityData?.binding ?? null
  const communityName = binding?.community.name
    ?? (communityState.status === 'error' ? '社区资料读取失败'
      : communityState.status === 'unauthenticated' ? '登录后查看社区'
      : communitySummary?.title ?? '正在读取常驻社区…')

  const meReturnTo = '/me' + (searchParams.toString() ? '?' + searchParams.toString() : '')
  const invite = parseInviteParam(searchParams.get('invite'))
  const loginResult = parseActivityLoginResult(searchParams.toString())
  const loginHref = buildResidentLoginHref(
    meReturnTo,
    { activityId: activity && requestedActivityId ? activity.id : null,
      inviteCode: invite.code, inviteInvalid: invite.invalid },
    loginResult?.status === 'error' ? loginResult.code : null,
  )

  const services = [
    { key: 'orders', icon: ClipboardList, label: '我的订单', desc: '本地商品登记与处理进度', to: '/me/orders', tone: 'orange' },
    { key: 'rewards', icon: Gift, label: '我的奖励', desc: '领取、核销与奖励记录', to: '/me/rewards', tone: 'pink' },
    { key: 'activity', icon: CalendarCheck2, label: '社区活动', desc: '查看社区活动列表', to: '/', tone: 'mint' },
  ]

  return (
    <div className="me-redesign">
      <header className="me-redesign__hero">
        <img className="me-redesign__landscape" src={import.meta.env.BASE_URL + 'images/me-neighborhood.webp'} alt="" aria-hidden="true" />
        <h1 className="sr-only">我的</h1>
        <div className="me-redesign__identity">
          <div className="me-redesign__avatar" aria-hidden="true">
            {avatarUrl ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : <UserRound size={32} strokeWidth={1.6} />}
          </div>
          <div className="me-redesign__identity-content">
            <div className="me-redesign__name-line">
              <strong>{auth.session?.user.displayName || '居民账户'}</strong>
              <span className="me-redesign__resident-tag">
                <Home size={12} strokeWidth={2} aria-hidden="true" />
                {auth.session?.staff ? staffRoleLabels[auth.session.staff.role] : '社区居民'}
              </span>
            </div>
            {nickname && nickname !== auth.session?.user.displayName && (
              <p className="me-redesign__nickname">微信昵称：{nickname}</p>
            )}
            <Link to="/me/community" className="me-redesign__community-link">
              <MapPin size={15} aria-hidden="true" />
              <span>{communityName}</span>
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
            {communityData?.status === 'confirmed' && binding && (
              <span className="me-redesign__confirmed">已确认常驻社区</span>
            )}
          </div>
        </div>
        {profileNotice && <p className="me-redesign__notice" role="status">{profileNotice}</p>}
        {communityState.status === 'error' && (
          <p className="me-redesign__notice" role="alert">
            {communityState.message}
            <button type="button" onClick={residentCommunity.reload}>重新读取</button>
          </p>
        )}
      </header>

      {!auth.session && (
        <div className="me-redesign__visitor">
          <p>登录后查看你的活动、订单和社区服务。</p>
          {loginResult?.status === 'error' && <p role="alert">{loginResult.message}</p>}
          <Link to={loginHref}><ShieldCheck size={16} aria-hidden="true" />前往统一登录</Link>
        </div>
      )}

      <div className="me-redesign__content">
        <section className="me-redesign__panel" aria-labelledby="me-services">
          <h2 id="me-services" className="me-redesign__section-title">我的服务</h2>
          <div className="me-redesign__service-grid">
            <button
              type="button"
              className="me-redesign__service-tile"
              aria-haspopup="dialog"
              onClick={() => { setProfilePreviewSaved(false); setProfileDrawerOpen(true) }}
            >
              <span className="me-redesign__service-icon me-redesign__icon--green">
                <UserRound size={27} strokeWidth={1.85} aria-hidden="true" />
              </span>
              <span>我的资料</span>
            </button>
            {services.map((item) => (
              <Link
                to={item.to}
                state={{ from: '/me' }}
                key={item.key}
                className="me-redesign__service-tile"
                aria-label={item.label + '：' + item.desc}
              >
                <span className={'me-redesign__service-icon me-redesign__icon--' + item.tone}>
                  <item.icon size={27} strokeWidth={1.85} aria-hidden="true" />
                </span>
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
          {profilePreviewSaved && (
            <p className="me-redesign__preview-feedback" role="status">
              已应用到本次页面预览，未保存至服务器。
            </p>
          )}
        </section>

        <MeAccountPanel auth={auth} />
      </div>
      {profileDrawerOpen && (
        <ProfilePreviewDrawer
          value={profilePreview}
          userId={auth.session?.user.id ?? null}
          onClose={closeProfileDrawer}
          onSave={saveProfilePreview}
        />
      )}
    </div>
  )
}
