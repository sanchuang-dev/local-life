import { Users } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { DemoNote } from '../components/DemoNote'
import { cultureCategories, cultureCourses } from '../mocks/community'

const statusStyles = {
  open: 'bg-teal-50 text-teal-700',
  plain: 'bg-slate-100 text-slate-500',
  warn: 'bg-[#fdf0e4] text-[#a96b2f]',
} as const

const ALL = '全部'

export function CommunityCulturePage() {
  const [category, setCategory] = useState(ALL)
  const visible =
    category === ALL
      ? cultureCourses
      : cultureCourses.filter((course) => course.category === category)

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/community"
        backLabel="返回社区"
        icon={Users}
        title="党群文化中心"
        subtitle="课程排期 · 演示报名状态"
      />

      <DemoNote>
        本页为固定入口，课程与场次均来自 V0.3 演示排期；报名状态仅供演示参考。
      </DemoNote>

      <div className="mt-4 flex flex-wrap gap-2">
        {cultureCategories.map((item) => {
          const selected = item === category
          return (
            <button
              key={item}
              type="button"
              aria-pressed={selected}
              onClick={() => setCategory(item)}
              className={`min-h-[36px] rounded-full border px-3.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
                selected
                  ? 'border-teal-600 bg-teal-600 text-white'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-teal-200 hover:text-teal-700'
              }`}
            >
              {item}
            </button>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 rounded-[18px] border border-dashed border-slate-200 bg-white px-4 py-10 text-center">
          <p className="text-[13px] font-semibold text-slate-500">该门类暂无排期</p>
          <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
            演示数据尚未提供「{category}」课程，其余门类将分批开放。
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          {visible.map(({ id, title, schedule, organiser, status, statusTone, icon: Icon }) => (
            <article
              key={id}
              className="rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#e8f6f0] text-[#388b77]"
                  aria-hidden="true"
                >
                  <Icon size={22} strokeWidth={1.7} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold leading-5 text-slate-800">{title}</h2>
                  <p className="mt-1 text-[12px] leading-5 text-slate-500">{schedule}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{organiser}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusStyles[statusTone]}`}
                >
                  {status}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="mt-4">
        <DemoNote tone="warn">
          象棋、广场舞、摄影、手工、兴趣课堂等其余门类将分批开放，当前为筹备中；课程报名不会产生真实结果。
        </DemoNote>
      </div>
    </div>
  )
}
