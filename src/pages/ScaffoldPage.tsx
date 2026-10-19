import { ArrowLeft, Compass } from 'lucide-react'
import { Link } from 'react-router'

type Variant = 'discover' | 'not-found'

const examples = {
  discover: {
    title: '发现',
    subtitle: '第二个 Tab 的页面容器已准备好',
    icon: Compass,
  },
}

export function ScaffoldPage({ variant }: { variant: Variant }) {
  if (variant === 'not-found') {
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
        <p className="text-5xl font-bold tracking-tight text-slate-200">404</p>
        <h1 className="mt-4 text-xl font-semibold text-slate-800">这个页面还不存在</h1>
        <p className="mt-3 text-sm text-slate-400">路由未配置，请返回小程序首页查看已迁页面。</p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <Link
            to="/"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-teal-700 px-5 text-sm font-semibold text-white transition-colors hover:bg-teal-800"
          >
            <ArrowLeft size={16} aria-hidden="true" /> 返回首页
          </Link>
          <Link
            to="/me"
            className="inline-flex min-h-[44px] items-center text-[12px] font-medium text-teal-700 transition-colors hover:text-teal-800"
          >
            打开演示导航
          </Link>
        </div>
      </div>
    )
  }

  const { title, subtitle, icon: Icon } = examples[variant]

  return (
    <div className="px-4 pb-7 pt-6">
      <div className="rounded-[22px] bg-white p-6 shadow-sm">
        <div className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#e4f4ed] text-teal-700">
          <Icon size={29} strokeWidth={1.7} aria-hidden="true" />
        </div>
        <h1 className="mt-6 text-2xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">{subtitle}</p>
        <div className="mt-5 inline-flex rounded-full bg-amber-50 px-3 py-1.5 text-[11px] font-medium text-amber-700">
          示例 Tab · 名称与功能待确定
        </div>
      </div>

      <section className="mt-5 rounded-[22px] border border-dashed border-slate-200 bg-white px-5 pb-7 pt-6">
        <h2 className="text-[15px] font-semibold text-slate-700">页面内容占位</h2>
        <p className="mt-1 text-[12px] leading-5 text-slate-400">未来可直接替换为正式业务页面</p>
        <div className="mt-6 space-y-4" aria-hidden="true">
          <div className="h-3 w-2/3 rounded-full bg-slate-100" />
          <div className="h-3 w-full rounded-full bg-slate-100" />
          <div className="h-3 w-4/5 rounded-full bg-slate-100" />
          <div className="mt-5 h-32 rounded-[14px] bg-slate-50" />
        </div>
      </section>
    </div>
  )
}
