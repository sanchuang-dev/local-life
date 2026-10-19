import { ArrowLeft, ChevronRight } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { CommunityHeader } from '../components/community/CommunityHeader'
import { DemoNote } from '../components/community/DemoNote'
import { communityNotices } from '../mocks/community'

export function CommunityNoticePage() {
  const { noticeId } = useParams()
  const notice = communityNotices.find((item) => item.id === noticeId)

  if (!notice) {
    return (
      <div className="px-4 pb-7 pt-3">
        <Link
          to="/community"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-[13px] font-medium text-slate-500 transition-colors hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          返回社区
        </Link>
        <div className="mt-6 rounded-[18px] border border-dashed border-slate-200 bg-white px-4 py-12 text-center">
          <p className="text-[14px] font-semibold text-slate-500">消息不存在</p>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            该消息可能已下线，或链接有误。
          </p>
          <Link
            to="/community"
            className="mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800"
          >
            返回社区
          </Link>
        </div>
      </div>
    )
  }

  const others = communityNotices.filter((item) => item.id !== notice.id)

  return (
    <div className="px-4 pb-7 pt-3">
      <CommunityHeader
        backTo="/community"
        backLabel="返回社区"
        icon={notice.icon}
        title={notice.title}
        subtitle={`${notice.time} · ${notice.source}`}
      />

      <article className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
            notice.tone === 'warn'
              ? 'bg-[#fdf0e4] text-[#a96b2f]'
              : 'bg-slate-100 text-slate-500'
          }`}
        >
          {notice.tag}
        </span>
        <p className="mt-3 text-[13px] leading-6 text-slate-600">{notice.summary}</p>
        <p className="mt-3 rounded-[14px] bg-slate-50 px-3.5 py-3 text-[12px] leading-5 text-slate-500">
          {notice.detailNote}
        </p>
      </article>

      <div className="mt-4">
        <DemoNote>
          演示：本条消息为示例数据，未接入真实社区通知或应急广播服务，也不代表任何真实社区或公职部门发布。
        </DemoNote>
      </div>

      <section className="mt-6">
        <h2 className="mb-3 text-[16px] font-semibold tracking-tight text-slate-900">其他消息</h2>
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {others.map((item, index) => (
            <Link
              key={item.id}
              to={`/community/notice/${item.id}`}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                index > 0 ? 'border-t border-slate-100' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-5 text-slate-700">
                  {item.title}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{item.meta}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-slate-300" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
