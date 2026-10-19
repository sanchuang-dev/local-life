import { type ReactNode, useEffect, useRef } from 'react'
import {
  BatteryFull,
  CircleDot,
  Compass,
  Ellipsis,
  House,
  Signal,
  UserRound,
  Wifi,
} from 'lucide-react'
import { Link, useLocation } from 'react-router'

type Tab = {
  path: string
  label: string
  icon: typeof House
}

/**
 * Temporary demo tabs only. The product owner will decide the final
 * navigation before business pages are implemented.
 */
const demoTabs: Tab[] = [
  { path: '/', label: '首页', icon: House },
  { path: '/discover', label: '发现', icon: Compass },
  { path: '/me', label: '我的', icon: UserRound },
]

/**
 * Reachable sub-pages that are not tabs yet. Only their top-bar title is
 * registered here so the shell does not grow a second navigation model.
 */
const subPageTitles: Record<string, string> = {
  '/gd': '广电服务',
  '/community': '社区',
  '/community/broadcast': '社区广播',
  '/community/activity': '活动详情',
  '/community/culture': '党群文化中心',
  '/health': '健康服务',
  '/health/assistant': '社区助手',
  '/health/device': '魔镜健康终端',
  '/health/lecture': '健康讲堂',
  '/life': '惠生活',
  '/life/exchange': '积分兑换',
  '/points': '我的积分',
  '/me/devices': '我的设备',
}

/** Sub-pages keep their parent tab highlighted (the V0.3 behaviour). */
const tabPathFor = (pathname: string) => {
  if (
    pathname === '/gd' ||
    pathname.startsWith('/community') ||
    pathname.startsWith('/health') ||
    pathname.startsWith('/life')
  ) {
    return '/'
  }
  if (pathname === '/points' || pathname.startsWith('/me/')) return '/me'
  return pathname
}

function MiniProgramTopBar() {
  const { pathname } = useLocation()
  const pageTitle =
    subPageTitles[pathname] ??
    (pathname.startsWith('/community/notice/')
      ? '消息详情'
      : pathname.startsWith('/life/product/')
        ? '商品详情'
        : demoTabs.find((item) => item.path === pathname)?.label)

  return (
    <header className="relative z-10 shrink-0 border-b border-slate-100/80 bg-white">
      <div
        className="flex h-[34px] items-center justify-between px-6 text-[12px] font-semibold tracking-tight text-slate-900"
        aria-hidden="true"
      >
        <span>9:41</span>
        <div className="flex items-center gap-1.5">
          <Signal size={15} strokeWidth={2.6} />
          <Wifi size={16} strokeWidth={2.6} />
          <BatteryFull size={19} strokeWidth={2.2} />
        </div>
      </div>
      <div className="relative flex h-[53px] items-center justify-center px-5">
        <div className="absolute left-5 flex items-center gap-2">
          <span className="h-6 w-1 rounded-full bg-teal-600" aria-hidden="true" />
          <span className="text-[16px] font-semibold tracking-tight text-slate-900">
            {pageTitle === '首页' ? '本地生活' : (pageTitle ?? '本地生活')}
          </span>
        </div>
        <div
          className="absolute right-4 flex h-[32px] w-[87px] items-center justify-around rounded-full border border-slate-200 bg-white px-2 text-slate-800"
          aria-hidden="true"
          title="小程序系统胶囊（视觉示意）"
        >
          <Ellipsis size={21} strokeWidth={2.7} />
          <span className="h-[17px] w-px bg-slate-200" />
          <CircleDot size={20} strokeWidth={2.3} />
        </div>
      </div>
    </header>
  )
}

export function MiniProgramShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  const currentTab = tabPathFor(pathname)

  // The shell owns the scroll container, so route changes must reset it here.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [pathname])

  return (
    <div className="min-h-dvh bg-[#e8f1ee] md:flex md:items-center md:justify-center md:p-5">
      <div className="hidden md:pointer-events-none md:fixed md:left-10 md:top-10 md:block">
        <p className="text-xs font-semibold tracking-[0.24em] text-teal-700/70">SANCHUANG</p>
        <p className="mt-2 text-xl font-semibold text-slate-700">本地生活 · 界面框架</p>
        <p className="mt-1 text-sm text-slate-500">移动端原型 / 开发预览</p>
      </div>

      <div className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-[#f5f7f7] shadow-2xl shadow-teal-900/10 md:h-[min(844px,calc(100dvh-40px))] md:max-w-[390px] md:rounded-[28px] md:border md:border-white/80">
        <MiniProgramTopBar />

        <main
          id="main-content"
          ref={mainRef}
          className="mini-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {children}
        </main>

        <nav
          aria-label="示例底部导航"
          className="relative z-10 grid shrink-0 grid-cols-3 border-t border-slate-200/70 bg-white pb-[max(env(safe-area-inset-bottom),8px)] pt-2 shadow-[0_-6px_22px_rgba(15,23,42,0.025)]"
        >
          {demoTabs.map(({ path, label, icon: Icon }) => {
            const isActive = path === currentTab
            return (
              <Link
                key={path}
                to={path}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                  isActive ? 'text-teal-700' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                <span className="relative">
                  <Icon
                    size={23}
                    strokeWidth={isActive ? 2.5 : 1.9}
                    aria-hidden="true"
                  />
                  {isActive && (
                    <span className="absolute -bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-teal-600" />
                  )}
                </span>
                <span className={`text-[11px] leading-none ${isActive ? 'font-semibold' : 'font-medium'}`}>
                  {label}
                  {isActive ? <span className="sr-only">（当前）</span> : null}
                </span>
              </Link>
            )
          })}
        </nav>
      </div>

      <div className="hidden md:pointer-events-none md:fixed md:bottom-10 md:right-10 md:block md:text-right">
        <p className="text-xs text-slate-500">375 × 812 优先 · 页面内容可滚动</p>
        <p className="mt-1 text-xs text-slate-400">底部导航为临时示例，非产品定稿</p>
      </div>
    </div>
  )
}
