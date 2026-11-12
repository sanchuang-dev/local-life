import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './CommunityDiscoveryPage.css'
import { Link, useLocation } from 'react-router'
import {
  ACTIVITY_ROUTES,
  PUBLIC_COMMUNITY_ROUTE,
  apiErrorSchema,
  publicActivityListResponseSchema,
  publicCommunityListSchema,
  type PublicActivitySummary,
  type PublicCommunity,
} from '@sanchuang-dev/local-life-contracts'
import {
  CalendarDays, CalendarX, ChevronRight,
  CircleAlert, LocateFixed, MapPin, Search, X,
} from 'lucide-react'
import { CommunityLocationError, createCommunityLocationRequester } from '../lib/communityGeolocation'
import { communityLocationSheetCopy, type CommunityLocationStatus } from '../lib/communityLocationCopy'
import type { Gcj02Point } from '../lib/communityCoordinates'
import { activityDetailHref, SELECTED_COMMUNITY_KEY } from '../lib/communityHomeRoute'
import {
  BROWSE_ONLY_NOTICE,
  residentCommunityConfirmHrefWithContext,
} from '../lib/residentCommunity'
import { ResidentCommunityCard } from '../components/community/ResidentCommunityCard'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useResidentCommunity } from '../hooks/useResidentCommunity'
import { buildResidentLoginHref } from '../components/auth/residentLogin'

type AsyncList<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T[] }

const actionClass = 'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116d63]'
const primary = `${actionClass} bg-[#138b79] text-white hover:bg-[#116d63]`
const secondary = `${actionClass} border border-[#cfe8de] bg-white text-[#116d63] hover:bg-[#e8f6f0]`

function savedCommunityId(): string | null {
  try { return window.localStorage.getItem(SELECTED_COMMUNITY_KEY) }
  catch { return null }
}
function persistCommunityId(id: string) {
  try { window.localStorage.setItem(SELECTED_COMMUNITY_KEY, id) }
  catch { /* Storage can be blocked; selection still works for this page session. */ }
}
function readableError(response: Response, fallback: string): Promise<string> {
  return response.json().catch(() => null).then((body: unknown) => {
    const parsed = apiErrorSchema.safeParse(body)
    return parsed.success ? parsed.data.error.message : `${fallback}（HTTP ${response.status}）`
  })
}
function distanceText(distance: number | null): string | null {
  if (distance === null) return null
  return distance < 1000
    ? `距社区服务点 ${distance} 米`
    : `距社区服务点 ${(distance / 1000).toFixed(1)} 公里`
}
function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))
}
function activityStatus(activity: PublicActivitySummary): string {
  if (activity.status === 'ended' || Date.parse(activity.endsAt) < Date.now()) return '已结束'
  if (activity.status === 'paused') return '已暂停'
  if (Date.parse(activity.startsAt) > Date.now()) return '即将开始'
  return '进行中'
}

export function CommunityDiscoveryPage() {
  const [locationStatus, setLocationStatus] = useState<CommunityLocationStatus>('idle')
  const [position, setPosition] = useState<Gcj02Point | null>(null)
  const [locationRequester] = useState(createCommunityLocationRequester)
  const [directory, setDirectory] = useState<AsyncList<PublicCommunity>>({ status: 'loading' })
  const [directoryToken, refreshDirectory] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(savedCommunityId)
  const [activities, setActivities] = useState<AsyncList<PublicActivitySummary>>({ status: 'ready', items: [] })
  const [activityToken, refreshActivities] = useState(0)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<AsyncList<PublicCommunity> | null>(null)
  const [locationError, setLocationError] = useState('')
  const mountedRef = useRef(true)
  const lastTrigger = useRef<HTMLElement | null>(null)
  const modalRef = useRef<HTMLElement | null>(null)

  // Permanent community is a separate, account-level fact (#171 LL-IDENTITY-001).
  // `selectedId` above stays a *browsing* choice in localStorage and is never sent
  // as an identity claim; this read only decides which read-only banner/link the
  // current community shows.
  const auth = useResidentAuth()
  const residentCommunity = useResidentCommunity({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const residentStatus = residentCommunity.state.status === 'ready' ? residentCommunity.state.data : null
  // Only an explicit logged-out visitor gets the login-first path; a session
  // failure must never be presented as "please log in".
  const needsLogin = !auth.loading && auth.sessionStatus === 'unauthenticated'

  useEffect(() => {
    const controller = new AbortController()
    setDirectory({ status: 'loading' })
    const query = new URLSearchParams()
    if (position) {
      query.set('latitude', position.latitude.toFixed(3))
      query.set('longitude', position.longitude.toFixed(3))
    }
    const suffix = query.toString()
    const url = `/api${PUBLIC_COMMUNITY_ROUTE}${suffix ? `?${suffix}` : ''}`
    fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readableError(response, '社区列表加载失败'))
        const parsed = publicCommunityListSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('社区列表数据格式异常')
        if (!controller.signal.aborted) {
          setDirectory({ status: 'ready', items: parsed.data.items })
        }
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setDirectory({
          status: 'error',
          message: cause instanceof Error ? cause.message : '无法读取社区',
        })
      })
    return () => controller.abort()
  }, [position, directoryToken])

  const community = directory.status === 'ready'
    ? directory.items.find((item) => item.id === selectedId) ?? null
    : null
  const nearby = directory.status === 'ready' && locationStatus === 'success'
    ? directory.items.filter((item) => item.nearby)
    : []

  useEffect(() => {
    if (directory.status !== 'ready' || !selectedId) return
    if (!directory.items.some((item) => item.id === selectedId)) {
      // A removed community must not be passed off as an active selection.
      setSelectedId(null)
      try { window.localStorage.removeItem(SELECTED_COMMUNITY_KEY) } catch { /* ignored */ }
    }
  }, [directory, selectedId])

  useEffect(() => {
    if (!selectedId || !community) {
      setActivities({ status: 'ready', items: [] })
      return
    }
    const controller = new AbortController()
    setActivities({ status: 'loading' })
    const url = `/api${ACTIVITY_ROUTES.publicList}?communityId=${encodeURIComponent(selectedId)}&limit=50`
    fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readableError(response, '活动加载失败'))
        const parsed = publicActivityListResponseSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('活动列表数据格式异常')
        if (!controller.signal.aborted) {
          setActivities({ status: 'ready', items: parsed.data.items })
        }
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setActivities({
          status: 'error',
          message: cause instanceof Error ? cause.message : '无法读取活动',
        })
      })
    return () => controller.abort()
  }, [selectedId, community?.id, activityToken])

  useEffect(() => {
    if (!sheetOpen || !search.trim()) {
      setSearchResults(null)
      return
    }
    const controller = new AbortController()
    setSearchResults({ status: 'loading' })
    const timer = window.setTimeout(() => {
      fetch(`/api${PUBLIC_COMMUNITY_ROUTE}?q=${encodeURIComponent(search.trim())}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error(await readableError(response, '社区搜索失败'))
        const parsed = publicCommunityListSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('社区搜索结果数据异常')
        if (!controller.signal.aborted) setSearchResults({ status: 'ready', items: parsed.data.items })
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setSearchResults({
          status: 'error', message: cause instanceof Error ? cause.message : '社区搜索失败',
        })
      })
    }, 180)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [sheetOpen, search])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      locationRequester.cancel()
    }
  }, [locationRequester])

  const startLocation = useCallback(() => {
    // Rapid double taps share one request instead of stacking prompts/timeouts.
    if (locationRequester.pending) return
    setLocationStatus('locating')
    setLocationError('')
    locationRequester.request().then((coordinates) => {
      if (!mountedRef.current) return
      setPosition(coordinates)
      setLocationStatus('success')
    }).catch((cause: unknown) => {
      // Unmount cancellation must not surface as a resident-facing error.
      if (!mountedRef.current) return
      if (cause instanceof CommunityLocationError && cause.reason === 'cancelled') return
      setLocationStatus('error')
      setLocationError(cause instanceof Error ? cause.message : '定位失败，请手动选择社区')
    })
  }, [locationRequester])

  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    setSearch('')
    window.setTimeout(() => lastTrigger.current?.focus({ preventScroll: true }), 0)
  }, [])
  const openSheet = useCallback((preselected: string | null = null, trigger?: HTMLElement) => {
    lastTrigger.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setDraftId(preselected ?? selectedId)
    setSearch('')
    setSheetOpen(true)
  }, [selectedId])

  useEffect(() => {
    if (!sheetOpen) return
    const oldOverflow = document.body.style.overflow
    const main = document.getElementById('main-content')
    main?.setAttribute('inert', '')
    document.body.style.overflow = 'hidden'
    // Focus the dialog container, not the search input: opening a mobile sheet must not summon the keyboard.
    const focusTimer = window.setTimeout(() => modalRef.current?.focus({ preventScroll: true }), 0)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeSheet() }
      if (event.key !== 'Tab' || !modalRef.current) return
      const controls = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),a[href]',
      ))
      if (!controls.length) return
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      main?.removeAttribute('inert')
      document.body.style.overflow = oldOverflow
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', keydown)
    }
  }, [sheetOpen, closeSheet])

  const confirmSelection = () => {
    const list = search.trim() ? (searchResults?.status === 'ready' ? searchResults.items : [])
      : directory.status === 'ready' ? directory.items : []
    const selected = list.find((item) => item.id === draftId)
      ?? (directory.status === 'ready' ? directory.items.find((item) => item.id === draftId) : null)
    if (!selected) return
    persistCommunityId(selected.id)
    setSelectedId(selected.id)
    closeSheet()
  }

  const shown = search.trim()
    ? searchResults
    : directory.status === 'ready' && locationStatus === 'success'
      ? { status: 'ready' as const, items: directory.items.filter((item) => item.nearby) }
      : directory
  const listHeading = search.trim() ? '搜索结果' : locationStatus === 'success' ? '附近社区' : '全部社区'
  const showAllManual = !search.trim() && locationStatus === 'success' && nearby.length === 0 && directory.status === 'ready'
  const displayed = showAllManual ? directory : shown
  const locationCopy = communityLocationSheetCopy(locationStatus, locationError)

  // The explicit first-confirmation target for the community currently being
  // browsed. The query carries the browsing community id only; the API re-reads
  // that row. `activityId`/`invite` are forwarded so a login round trip keeps the
  // original invitation context and returns to this confirmation. The search
  // comes from the router (not `window.location`) so the Pages HashRouter build
  // resolves the same query as the clean-path build.
  const routeSearch = useLocation().search
  const confirmReturnTo = community
    ? residentCommunityConfirmHrefWithContext(community.id, routeSearch)
    : null
  const loginHref = confirmReturnTo
    ? buildResidentLoginHref(confirmReturnTo, {
        activityId: new URLSearchParams(routeSearch).get('activityId'),
        inviteCode: new URLSearchParams(routeSearch).get('invite'),
        inviteInvalid: new URLSearchParams(routeSearch).get('inviteInvalid') === '1',
      })
    : null

  return (
    <div className="community-home">
      <header className="community-home__banner">
        <img
          className="community-home__art"
          src={import.meta.env.BASE_URL + 'images/community-home-park.webp'}
          alt=""
          aria-hidden="true"
        />
        <div className="community-home__banner-title">
          <h1>本地生活</h1>
          <p>社区活动与便民服务</p>
        </div>
        <button type="button" className="community-home__locate-pill"
          onClick={startLocation} disabled={locationStatus === 'locating'}>
          <MapPin size={16} aria-hidden="true" />
          {locationStatus === 'success' ? '重新定位'
            : locationStatus === 'locating' ? '定位中…'
              : locationStatus === 'error' ? '定位重试' : '定位附近'}
        </button>
      </header>

      <div className="community-home__body">
        <section className="community-home__chooser" aria-labelledby="home-community-title">
          <h2 id="home-community-title" className="sr-only">选择社区</h2>
          <div className="community-home__actions">
            <button type="button" className={primary} disabled={locationStatus === 'locating'}
              onClick={startLocation}>
              <LocateFixed size={18} aria-hidden="true" />
              {locationStatus === 'locating' ? '定位中…'
                : locationStatus === 'success' ? '重新定位' : '定位附近社区'}
            </button>
            <button type="button" className={secondary}
              onClick={(e) => openSheet(null, e.currentTarget)}>
              选择社区
            </button>
          </div>

          {locationStatus === 'error' && locationError && (
            <p className="community-home__notice" role="status">{locationError}</p>
          )}
          {directory.status === 'error' && (
            <div className="community-home__notice community-home__notice--error" role="alert">
              {directory.message}
              <button type="button" onClick={() => refreshDirectory((n) => n + 1)}>重试</button>
            </div>
          )}

          {community ? (
            <div className="community-home__current">
              <span className="community-home__current-icon" aria-hidden="true"><MapPin size={20} /></span>
              <div>
                <span>当前浏览社区</span>
                <strong>{community.name}</strong>
                <small>{community.address || '社区服务点地址暂未录入'}</small>
              </div>
            </div>
          ) : locationStatus === 'success' && nearby.length > 0 ? (
            <div className="community-home__nearby" aria-label="附近社区推荐">
              {nearby.slice(0, 2).map((item) => (
                <button key={item.id} type="button"
                  onClick={(e) => openSheet(item.id, e.currentTarget)}>
                  <MapPin size={18} aria-hidden="true" />
                  <span><strong>{item.name}</strong><small>{distanceText(item.distanceMeters)}</small></span>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="community-home__activities" aria-labelledby="community-activities-title">
          <div className="community-home__section-heading">
            <h2 id="community-activities-title">社区活动</h2>
            <p>{community ? community.name + ' · 已公开发布的活动' : '选择社区后查看活动'}</p>
          </div>

          {!community ? (
            <div className="community-home__activity-empty">
              <span className="community-home__empty-icon" aria-hidden="true"><CalendarDays size={27}/></span>
              <div>
                <h3>选择社区后查看活动</h3>
                <p>选择想浏览的社区，看看那里正在发生什么。</p>
              </div>
            </div>
          ) : activities.status === 'loading' ? (
            <p className="community-home__status" role="status">正在读取已发布活动…</p>
          ) : activities.status === 'error' ? (
            <div className="community-home__status community-home__status--error" role="alert">
              <p>{activities.message}</p>
              <button type="button" onClick={() => refreshActivities((n) => n + 1)}>重新读取活动</button>
            </div>
          ) : activities.items.length === 0 ? (
            <div className="community-home__activity-empty">
              <span className="community-home__empty-icon" aria-hidden="true"><CalendarX size={27}/></span>
              <div>
                <h3>这个社区暂无已发布活动</h3>
                <p>可以稍后再来，或者看看其他社区。</p>
                <button type="button" onClick={(e) => openSheet(null, e.currentTarget)}>选择其他社区</button>
              </div>
            </div>
          ) : (
            <div className="community-home__activity-list">
              {activities.items.map((activity) => (
                <Link key={activity.id} to={activityDetailHref(activity.id)} className="community-home__activity-card">
                  <span className="community-home__thumbnail" aria-hidden="true">
                    <CalendarDays size={38} strokeWidth={1.35} />
                  </span>
                  <span className="community-home__activity-info">
                    <span className="community-home__activity-top">
                      <span className="community-home__status-tag">{activityStatus(activity)}</span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </span>
                    <strong>{activity.title}</strong>
                    {activity.summary && <span className="community-home__summary">{activity.summary}</span>}
                    <span className="community-home__meta">
                      <CalendarDays size={14} aria-hidden="true" />
                      {formatTime(activity.startsAt)} 至 {formatTime(activity.endsAt)}
                    </span>
                    <span className="community-home__meta">
                      <MapPin size={14} aria-hidden="true" />
                      {activity.location}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {community && (
          <div className="community-home__residence">
            <ResidentCommunityCard
              state={residentCommunity.state}
              onReload={residentCommunity.reload}
              browsingCommunity={{ id: community.id, name: community.name }}
              confirmHref={residentStatus?.canConfirm ? confirmReturnTo : null}
              loginHref={needsLogin ? loginHref : null}
              chooseCommunityHref="/"
            />
          </div>
        )}

        <p className="community-home__footnote">社区与活动信息以实际发布为准</p>
      </div>

      {sheetOpen && createPortal(
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" role="presentation">
          <div className="absolute inset-0 bg-[#09201a]/45" onClick={closeSheet} aria-hidden="true"/>
          <section ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="community-sheet-heading"
            className="relative z-10 flex max-h-[90dvh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-[24px] bg-[#f5f7f7] shadow-xl sm:max-h-[85dvh] sm:rounded-[24px]">
            <div className="flex justify-center pt-2 sm:hidden"><span className="h-1.5 w-10 rounded-full bg-[#d6e3de]"/></div>
            <div className="flex items-center justify-between px-5 pb-3 pt-3">
              <h2 id="community-sheet-heading" className="text-[20px] font-bold">选择要浏览的社区</h2>
              <button type="button" aria-label="关闭社区选择" onClick={closeSheet}
                className="grid h-11 w-11 place-items-center rounded-full text-[#5b6c67]"><X size={21}/></button>
            </div>
            <div className="px-5">
              <p className="mb-3 rounded-lg bg-[#f0f5f3] px-3 py-2 text-[12px] leading-5 text-[#5b6c67]">
                {BROWSE_ONLY_NOTICE}
              </p>
              <div className="flex items-center justify-between gap-3 rounded-xl bg-[#e8f6f0] p-3">
                <div className="flex min-w-0 items-start gap-2">
                  <LocateFixed size={19} className="mt-0.5 shrink-0 text-[#138b79]"/>
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold">{locationCopy.title}</p>
                    <p
                      className={`mt-0.5 text-[12px] leading-5 ${locationStatus === 'error' ? 'text-[#934a35]' : 'text-[#5b6c67]'}`}
                      role={locationStatus === 'error' ? 'alert' : 'status'}
                    >
                      {locationCopy.detail}
                    </p>
                  </div>
                </div>
                <button type="button" className="min-h-11 shrink-0 px-1 text-[13px] font-semibold text-[#116d63]" disabled={locationStatus === 'locating'}
                  onClick={startLocation}>{locationCopy.action}</button>
              </div>
              <label className="mt-4 flex min-h-12 items-center gap-2 rounded-xl border border-[#dce6e2] bg-white px-3">
                <Search size={19} className="text-[#5b6c67]"/>
                <span className="sr-only">搜索社区名称或地址</span>
                <input type="search" value={search} onChange={(e)=>setSearch(e.target.value)}
                  maxLength={60} placeholder="搜索社区名称或地址"
                  className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[#82918c]"/>
              </label>
              <div className="mt-4 flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">{showAllManual ? '全部社区' : listHeading}</h3>
                <span className="text-[12px] text-[#5b6c67]">
                  {!search.trim() && locationStatus === 'success' ? '按社区服务点距离推荐' : '自主选择'}
                </span>
              </div>
              {showAllManual && <p className="mt-2 text-[13px] text-[#5b6c67]">附近暂未找到已录入位置的社区，请手动搜索或选择。</p>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
              {!displayed || displayed.status === 'loading' ? <p className="py-6 text-[14px] text-[#5b6c67]" role="status">正在读取社区…</p> :
                displayed.status === 'error' ? (
                  <div className="py-5 text-[14px] text-[#934a35]" role="alert">
                    <CircleAlert size={18} className="mr-1 inline"/>{displayed.message}
                    <button type="button" className="ml-2 underline" onClick={()=>refreshDirectory(n=>n+1)}>重试</button>
                  </div>
                ) : displayed.items.length === 0 ? (
                  <p className="py-7 text-[14px] text-[#5b6c67]">没有匹配的社区，换个名称试试。</p>
                ) : displayed.items.map((item) => (
                  <label key={item.id} className="flex min-h-[72px] cursor-pointer items-center gap-3 border-b border-[#dce6e2] py-3">
                    <input type="radio" name="community-choice" value={item.id} checked={draftId === item.id}
                      onChange={()=>setDraftId(item.id)} className="h-5 w-5 accent-[#138b79]"/>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-semibold">{item.name}</span>
                      <span className="block text-[13px] leading-5 text-[#5b6c67]">
                        {distanceText(item.distanceMeters) || item.address || '位置待补录'}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
            <div className="border-t border-[#dce6e2] bg-white p-4 pb-[max(env(safe-area-inset-bottom),16px)]">
              <button type="button" className={`${primary} w-full`}
                disabled={!draftId || !(
                  directory.status === 'ready' && directory.items.some((item)=>item.id === draftId) ||
                  searchResults?.status === 'ready' && searchResults.items.some((item)=>item.id===draftId)
                )}
                onClick={confirmSelection}>
                确认浏览这个社区
              </button>
              <p className="mt-2 text-center text-[11px] leading-4 text-[#5b6c67]">
                这里只改变浏览的社区，不会确认或改变你的常驻社区。
              </p>
            </div>
          </section>
        </div>, document.body)}
    </div>
  )
}
