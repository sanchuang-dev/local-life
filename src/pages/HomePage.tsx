import {
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  LayoutGrid,
  MapPin,
  Sparkles,
} from 'lucide-react'

// Visual fixtures only. These are slots, not approved product functions.
const entrySlots = ['入口一', '入口二', '入口三', '入口四']

function EntryPlaceholder({ label, index }: { label: string; index: number }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span
        className={`flex h-[52px] w-[52px] items-center justify-center rounded-[18px] ${
          index % 2 === 0 ? 'bg-[#e8f6f0] text-[#388b77]' : 'bg-[#fff3e6] text-[#d29a5a]'
        }`}
        aria-hidden="true"
      >
        <LayoutGrid size={23} strokeWidth={1.65} />
      </span>
      <span className="text-[12px] font-medium text-slate-600">{label}</span>
    </div>
  )
}

export function HomePage() {
  return (
    <div className="pb-6">
      <section className="relative overflow-hidden bg-gradient-to-br from-[#116d63] via-[#138b79] to-[#47ad91] px-5 pb-[74px] pt-6 text-white">
        <div
          className="pointer-events-none absolute -right-10 -top-16 h-52 w-52 rounded-full border-[36px] border-white/10"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-16 right-9 h-40 w-40 rounded-full bg-white/5"
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-1.5 text-[12px] font-medium text-white/80">
          <MapPin size={14} strokeWidth={2} />
          <span>你身边的生活服务</span>
        </div>
        <h1 className="relative mt-5 text-[28px] font-semibold leading-[1.3] tracking-tight">
          发现身边的<br />美好生活
        </h1>
        <p className="relative mt-3 text-[13px] leading-6 text-white/80">
          一个轻巧、好用的社区生活入口
        </p>
        <div className="relative mt-6 inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/15 px-3 py-1.5 text-[11px] font-medium backdrop-blur-sm">
          <Sparkles size={13} />
          界面框架演示 · 业务待定
        </div>
      </section>

      <section className="relative z-[1] mx-4 -mt-[49px] rounded-[20px] border border-slate-100 bg-white px-4 pb-5 pt-5 shadow-[0_12px_36px_rgba(15,52,44,0.08)]">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-slate-800">常用入口</h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-400">
            示意布局
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {entrySlots.map((label, index) => (
            <EntryPlaceholder key={label} label={label} index={index} />
          ))}
        </div>
      </section>

      <section className="mx-4 mt-7">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium tracking-widest text-teal-600">EXPLORE</p>
            <h2 className="mt-1 text-[18px] font-semibold text-slate-900">内容展示区域</h2>
          </div>
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            预留位置 <ChevronRight size={14} aria-hidden="true" />
          </span>
        </div>

        <article className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          <div className="flex min-h-[116px] gap-4 p-4">
            <div
              className="flex w-[104px] shrink-0 items-center justify-center rounded-[13px] bg-gradient-to-br from-[#e3f2ea] to-[#c9e7d9] text-teal-500"
              aria-hidden="true"
            >
              <LayoutGrid size={30} strokeWidth={1.4} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <span className="text-[10px] font-semibold text-teal-700">内容卡片模板</span>
              <h3 className="mt-2 text-[15px] font-semibold text-slate-800">图文列表位置</h3>
              <p className="mt-1 text-[12px] leading-5 text-slate-400">可替换为后续确认的业务内容</p>
              <div className="mt-3 h-1.5 w-20 rounded-full bg-slate-100" aria-hidden="true" />
            </div>
          </div>
        </article>

        <article className="mt-3 flex items-center gap-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#fff3e6] text-[#c6925c]" aria-hidden="true">
            <ArrowUpRight size={23} strokeWidth={1.7} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-slate-800">快捷信息卡片</h3>
            <p className="mt-1 text-[12px] text-slate-400">用于提示、公告或其他轻量信息</p>
          </div>
          <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
        </article>
      </section>

      <div className="mx-4 mt-6 flex gap-3 rounded-[16px] border border-dashed border-teal-300/70 bg-[#eef7f2] p-4 text-[#52786c]">
        <CircleHelp size={19} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-[12px] font-semibold">这里只定义界面结构</p>
          <p className="mt-1 text-[11px] leading-[1.7]">
            入口、导航和业务模块均为占位示例。产品调整确认后，再逐页替换为真实原型。
          </p>
        </div>
      </div>
    </div>
  )
}
