import { ArrowLeft, Compass } from 'lucide-react'
import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-5xl font-bold tracking-tight text-slate-200">404</p>
      <h1 className="mt-4 text-xl font-semibold text-slate-800">这个页面还不存在</h1>
      <p className="mt-3 text-sm text-slate-400">路由未配置，请返回小程序首页查看已迁页面。</p>
      <div className="mt-6 flex flex-col items-center gap-3">
        <Link
          to="/"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-teal-700 px-5 text-sm font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <ArrowLeft size={16} aria-hidden="true" /> 返回首页
        </Link>
        <Link
          to="/discover"
          className="inline-flex min-h-[44px] items-center gap-1.5 text-[12px] font-medium text-teal-700 transition-colors hover:text-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Compass size={14} aria-hidden="true" />
          浏览服务导览
        </Link>
      </div>
    </div>
  )
}
