import { Link, NavLink, Route, Routes } from 'react-router'

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive
    ? 'rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white'
    : 'rounded-full px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100'

function Home() {
  return (
    <section className="mx-auto max-w-3xl py-12 sm:py-20">
      <span className="inline-flex rounded-full bg-teal-50 px-4 py-2 text-xs font-semibold tracking-wide text-teal-800">
        SANCHUANG · LOCAL LIFE
      </span>
      <h1 className="mt-7 text-4xl font-semibold tracking-tight text-slate-900 sm:text-6xl">
        本地生活，从清晰的产品出发。
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
        独立前端工程已就绪。新一轮产品减法与加法仍在讨论中，
        这里暂不预设导航、模块和业务承诺。
      </p>
      <div className="mt-9 flex flex-wrap gap-3">
        <Link
          to="/about"
          className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          查看工程信息
        </Link>
        <a
          href="https://github.com/sanchuang-dev/local-life"
          className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:border-slate-400"
        >
          GitHub 仓库
        </a>
      </div>
      <div className="mt-14 grid gap-4 sm:grid-cols-2">
        <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold tracking-wide text-teal-700">技术基座</p>
          <h2 className="mt-3 text-xl font-semibold text-slate-900">可持续开发</h2>
          <p className="mt-2 leading-7 text-slate-600">React、Vite、Tailwind CSS、React Router，保留清晰的前端分层。</p>
        </article>
        <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold tracking-wide text-teal-700">产品状态</p>
          <h2 className="mt-3 text-xl font-semibold text-slate-900">等待需求收敛</h2>
          <p className="mt-2 leading-7 text-slate-600">旧版原型作为历史参考，正式页面和功能以新的产品决策为准。</p>
        </article>
      </div>
    </section>
  )
}

function About() {
  return (
    <section className="mx-auto max-w-3xl py-12 sm:py-20">
      <p className="text-sm font-semibold text-teal-700">ENGINEERING BASELINE</p>
      <h1 className="mt-3 text-3xl font-semibold text-slate-900">工程信息</h1>
      <p className="mt-6 leading-8 text-slate-600">
        本站仅是本地生活项目的独立工程底座，不提供真实社区业务、登录、交易或健康服务。
        当前预览属于 dev 环境，不代表生产系统。
      </p>
      <Link className="mt-8 inline-block text-sm font-semibold text-teal-800 underline underline-offset-4" to="/">
        返回首页
      </Link>
    </section>
  )
}

function NotFound() {
  return (
    <section className="mx-auto max-w-3xl py-20">
      <h1 className="text-3xl font-semibold">页面不存在</h1>
      <Link className="mt-5 inline-block text-teal-800 underline" to="/">返回首页</Link>
    </section>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white/90">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-5">
          <Link to="/" className="text-base font-bold tracking-wide">三创 · 本地生活</Link>
          <nav aria-label="工程演示导航" className="flex gap-2">
            <NavLink to="/" end className={navClass}>首页</NavLink>
            <NavLink to="/about" className={navClass}>工程信息</NavLink>
          </nav>
        </div>
      </header>
      <main className="px-5">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="mx-auto max-w-5xl border-t border-slate-200 px-5 py-7 text-sm text-slate-500">
        三创本地生活 · 工程预览 · 非正式业务服务
      </footer>
    </div>
  )
}
