import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
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
  ArrowRight, CalendarDays, CalendarX, ChevronDown, ChevronRight,
  CircleAlert, Clock3, LocateFixed, MapPin, Search, X,
} from 'lucide-react'
import { CommunityLocationError, createCommunityLocationRequester } from '../lib/communityGeolocation'
import { communityLocationSheetCopy, type CommunityLocationStatus } from '../lib/communityLocationCopy'
import type { Gcj02Point } from '../lib/communityCoordinates'
import { activityDetailHref, SELECTED_COMMUNITY_KEY } from '../lib/communityHomeRoute'

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

  return (
    <div className="mx-auto min-h-[70vh] w-full max-w-[480px] bg-[#f5f7f7] text-[#172d28]">
      <header className="flex items-start justify-between gap-3 px-5 pb-2 pt-5 max-[359px]:px-4">
        <div>
          <h1 className="text-[24px] font-bold tracking-tight text-[#0b4a42]">本地生活</h1>
          <p className="mt-0.5 text-[14px] text-[#5b6c67]">社区活动与便民服务</p>
        </div>
        <button type="button" onClick={startLocation}
          disabled={locationStatus === 'locating'}
          className="flex min-h-11 shrink-0 items-center gap-1 rounded-full border border-[#dce6e2] bg-white px-3 text-[13px] font-semibold text-[#116d63]">
          <MapPin size={17} aria-hidden="true" />
          {locationStatus === 'success' ? '已定位 · 重新定位' :
            locationStatus === 'locating' ? '定位中…' : locationStatus === 'error' ? '定位失败 · 重试' : '定位附近'}
        </button>
      </header>

      <div className="px-5 pb-7 pt-5 max-[359px]:px-4">
        <section aria-labelledby="home-community-title">
          {community ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[14px] font-semibold text-[#116d63]">当前浏览社区</p>
                <button type="button" data-switch-community
                  className="min-h-11 text-[14px] font-semibold text-[#116d63]"
                  onClick={(e) => openSheet(null, e.currentTarget)}>切换社区 <ChevronDown size={15} className="inline" /></button>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#e8f6f0] text-[#116d63]">
                  <MapPin size={21}/></span>
                <div className="min-w-0">
                  <h2 id="home-community-title" className="text-[23px] font-bold leading-8">{community.name}</h2>
                  <p className="text-[14px] text-[#5b6c67]">{community.address || '社区服务点地址暂未录入'}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-[14px] font-semibold text-[#116d63]">
                {locationStatus === 'success' ? '已定位' : locationStatus === 'locating' ? '正在定位' : '附近社区'}
              </p>
              <h2 id="home-community-title" className="mt-2 text-[24px] font-bold leading-8">
                {locationStatus === 'success' && nearby.length === 0 && directory.status === 'ready' ? '附近暂未找到社区' :
                  locationStatus === 'success' && nearby.length ? '选择你所在的社区' :
                  locationStatus === 'locating' ? '正在获取你的位置' : locationStatus === 'error' ? '暂时无法获取位置' :
                  '先选择你所在的社区'}
              </h2>
              <p className="mt-2 text-[15px] leading-7 text-[#5b6c67]">
                {locationStatus === 'success' ? '我们按照社区服务点的位置推荐附近社区，你可以自行确认。' :
                  '定位后可以查看附近社区，也可以直接搜索社区名称。'}
              </p>
              {locationStatus === 'error' && locationError && (
                <p className="mt-2 text-[13px] text-[#a15c38]" role="status">{locationError}</p>
              )}
              {directory.status === 'error' && (
                <div className="mt-3 rounded-xl border border-[#edd1c9] bg-[#fff7f0] p-3 text-[14px] text-[#934a35]" role="alert">
                  {directory.message}
                  <button className="ml-2 underline" onClick={() => refreshDirectory((n)=>n+1)}>重试</button>
                </div>
              )}
              {locationStatus === 'success' && nearby.length > 0 && (
                <div className="mt-4 divide-y divide-[#dce6e2] border-y border-[#dce6e2]">
                  {nearby.slice(0, 2).map((item) => (
                    <button type="button" key={item.id}
                      className="flex min-h-[70px] w-full items-center gap-3 py-3 text-left"
                      onClick={(event) => openSheet(item.id, event.currentTarget)}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e8f6f0] text-[#116d63]"><MapPin size={19}/></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[16px] font-semibold">{item.name}</span>
                        <span className="block text-[13px] text-[#5b6c67]">{distanceText(item.distanceMeters)}</span>
                      </span>
                      <ChevronRight size={18} className="text-[#138b79]"/>
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-5 grid grid-cols-2 gap-2 max-[359px]:grid-cols-1">
                <button type="button" className={primary} disabled={locationStatus === 'locating'}
                  onClick={startLocation}>
                  <LocateFixed size={18}/> {locationStatus === 'locating' ? '定位中…' : locationStatus === 'success' ? '重新定位' : '定位附近社区'}
                </button>
                <button type="button" className={secondary}
                  onClick={(e) => openSheet(null, e.currentTarget)}>
                  手动选择社区
                </button>
              </div>
            </>
          )}
        </section>

        <section className="mt-9" aria-labelledby="community-activities-title">
          <h2 id="community-activities-title" className="text-[21px] font-bold">社区活动</h2>
          <p className="mt-1 text-[14px] leading-6 text-[#5b6c67]">
            {community ? `${community.name} · 已公开发布的活动` : '选择社区后查看活动'}
          </p>
          {!community ? (
            <div className="mt-3 flex items-start gap-3 rounded-2xl border border-[#dce6e2] bg-white p-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e8f6f0] text-[#116d63]"><CalendarDays size={21}/></span>
              <div>
                <h3 className="text-[16px] font-semibold">选择社区后查看活动</h3>
                <p className="mt-1 text-[14px] leading-6 text-[#5b6c67]">不会混入其他社区的活动，也无需提前登录。</p>
              </div>
            </div>
          ) : activities.status === 'loading' ? (
            <p className="mt-3 rounded-2xl bg-white p-5 text-[14px] text-[#5b6c67]" role="status">正在读取已发布活动…</p>
          ) : activities.status === 'error' ? (
            <div className="mt-3 rounded-2xl border border-[#edd1c9] bg-[#fff7f0] p-4" role="alert">
              <p className="text-[14px] text-[#934a35]">{activities.message}</p>
              <button className="mt-2 min-h-11 text-[14px] font-semibold text-[#116d63]" onClick={() => refreshActivities(n=>n+1)}>重新读取活动</button>
            </div>
          ) : activities.items.length === 0 ? (
            <div className="mt-3 flex flex-col items-center rounded-2xl border border-[#dce6e2] bg-white p-6 text-center">
              <CalendarX size={28} className="text-[#138b79]"/>
              <h3 className="mt-2 text-[16px] font-semibold">这个社区暂无已发布活动</h3>
              <p className="mt-1 text-[14px] text-[#5b6c67]">可以切换其他社区看看，或稍后再来。</p>
              <button type="button" className={`${secondary} mt-4`} onClick={(e)=>openSheet(null,e.currentTarget)}>切换社区</button>
            </div>
          ) : (
            <div className="mt-3 grid gap-3">
              {activities.items.map((activity) => (
                <article key={activity.id} className="rounded-2xl border border-[#dce6e2] bg-white p-5 shadow-[0_2px_16px_rgba(17,109,99,.05)] max-[359px]:p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e8f6f0] text-[#116d63]"><CalendarDays size={20}/></span>
                    <span className="rounded-full bg-[#e8f6f0] px-3 py-1 text-[13px] font-semibold text-[#116d63]">{activityStatus(activity)}</span>
                  </div>
                  <h3 className="mt-3 text-[18px] font-bold">{activity.title}</h3>
                  <p className="mt-2 flex items-center gap-1.5 text-[14px] text-[#5b6c67]"><Clock3 size={15}/>{formatTime(activity.startsAt)} 至 {formatTime(activity.endsAt)}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-[14px] text-[#5b6c67]"><MapPin size={15}/>{activity.location}</p>
                  {activity.summary && <p className="mt-2 line-clamp-2 text-[15px] leading-6 text-[#3b4f49]">{activity.summary}</p>}
                  <div className="mt-3 flex justify-end border-t border-[#edf2f0] pt-2">
                    <Link to={activityDetailHref(activity.id)} className="flex min-h-11 items-center gap-1 text-[15px] font-semibold text-[#116d63]">
                      查看活动 <ArrowRight size={17}/></Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        <p className="mt-8 text-center text-[13px] leading-5 text-[#5b6c67]">社区与活动信息以实际发布为准</p>
      </div>

      {sheetOpen && createPortal(
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" role="presentation">
          <div className="absolute inset-0 bg-[#09201a]/45" onClick={closeSheet} aria-hidden="true"/>
          <section ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="community-sheet-heading"
            className="relative z-10 flex max-h-[90dvh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-[24px] bg-[#f5f7f7] shadow-xl sm:max-h-[85dvh] sm:rounded-[24px]">
            <div className="flex justify-center pt-2 sm:hidden"><span className="h-1.5 w-10 rounded-full bg-[#d6e3de]"/></div>
            <div className="flex items-center justify-between px-5 pb-3 pt-3">
              <h2 id="community-sheet-heading" className="text-[20px] font-bold">选择社区</h2>
              <button type="button" aria-label="关闭社区选择" onClick={closeSheet}
                className="grid h-11 w-11 place-items-center rounded-full text-[#5b6c67]"><X size={21}/></button>
            </div>
            <div className="px-5">
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
                确认选择社区
              </button>
            </div>
          </section>
        </div>, document.body)}
    </div>
  )
}
