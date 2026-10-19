import { ChevronDown, Info, Megaphone, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '../components/PageHeader'
import { DemoNote } from '../components/DemoNote'
import {
  communityBroadcasts,
  type CommunityBroadcastPeriod,
} from '../mocks/community'

const periods: { id: CommunityBroadcastPeriod; label: string }[] = [
  { id: 'current', label: '当前广播' },
  { id: 'today', label: '今日广播' },
  { id: 'history', label: '历史广播' },
]

const emergencyBroadcast = communityBroadcasts.find((item) => item.emergency)

export function CommunityBroadcastPage() {
  const [period, setPeriod] = useState<CommunityBroadcastPeriod>('current')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const visible = communityBroadcasts.filter((item) => item.period === period)

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/community"
        backLabel="返回社区"
        icon={Megaphone}
        title="社区广播"
        subtitle="应急通知 · 活动广播 · 广播信息回看"
      />

      <DemoNote>
        演示：本页未接入社区喇叭、电视大屏或应急广播体系，也没有音频资源，因此不提供真实播放能力。
      </DemoNote>

      {emergencyBroadcast ? (
        <article className="mt-4 rounded-[18px] border border-[#f2dcc0] bg-[#fff7ec] p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-[#fbe3dc] px-2 py-0.5 text-[11px] font-semibold text-[#9b3a2e]">
              <ShieldAlert size={13} aria-hidden="true" />
              应急广播（演示）
            </span>
            <span className="text-[11px] text-[#a96b2f]">{emergencyBroadcast.time}</span>
          </div>
          <h2 className="mt-2 text-[15px] font-semibold leading-5 text-[#7a4a1f]">
            {emergencyBroadcast.title}
          </h2>
          <p className="mt-1.5 text-[11px] leading-5 text-[#8a6132]">
            应急通道独立于商业与活动信息，任何积分任务都不会出现在此处。
          </p>
        </article>
      ) : null}

      <div
        role="tablist"
        aria-label="广播时段"
        className="mt-5 flex rounded-full border border-slate-200 bg-white p-1"
      >
        {periods.map((item) => {
          const selected = item.id === period
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setPeriod(item.id)
                setExpandedId(null)
              }}
              className={`min-h-[38px] flex-1 rounded-full text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
                selected ? 'bg-teal-600 text-white' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {item.label}
            </button>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 rounded-[18px] border border-dashed border-slate-200 bg-white px-4 py-10 text-center">
          <p className="text-[13px] font-semibold text-slate-500">暂无历史广播记录</p>
          <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
            演示数据只提供当前广播与今日广播，历史广播待接入。
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {visible.map((item, index) => {
            const Icon = item.icon
            const expanded = expandedId === item.id
            return (
              <div key={item.id} className={index > 0 ? 'border-t border-slate-100' : ''}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : item.id)}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600"
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                      item.emergency
                        ? 'bg-[#fdf0e4] text-[#b97b3e]'
                        : 'bg-[#e8f6f0] text-[#388b77]'
                    }`}
                    aria-hidden="true"
                  >
                    <Icon size={18} strokeWidth={1.7} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold leading-5 text-slate-700">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">
                      {item.time} · {item.kind}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] font-medium text-slate-400">信息详情</span>
                  <ChevronDown
                    size={16}
                    className={`shrink-0 text-slate-300 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    aria-hidden="true"
                  />
                </button>

                {expanded ? (
                  <div className="px-4 pb-4">
                    <dl className="divide-y divide-slate-100 rounded-[14px] bg-slate-50/70 px-3.5 py-1">
                      <div className="flex items-center justify-between gap-3 py-2.5">
                        <dt className="text-[11px] text-slate-400">广播类别</dt>
                        <dd className="text-right text-[12px] font-medium text-slate-600">{item.kind}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-2.5">
                        <dt className="text-[11px] text-slate-400">触发来源</dt>
                        <dd className="text-right text-[12px] font-medium text-slate-600">
                          演示来源（未接入真实广播体系）
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-2.5">
                        <dt className="text-[11px] text-slate-400">播放渠道</dt>
                        <dd className="text-right text-[12px] font-medium text-slate-600">{item.channel}</dd>
                      </div>
                    </dl>
                    <p className="mt-2.5 text-[11px] leading-5 text-slate-500">{item.summary}</p>
                    <div className="mt-2.5 flex items-center gap-2 rounded-[12px] bg-slate-50 px-3 py-2 text-[11px] text-slate-400">
                      <Info size={14} className="shrink-0" aria-hidden="true" />
                      无音频资源，暂不能重听；文字信息以上述内容为准。
                    </div>
                    {item.activityTo ? (
                      <Link
                        to={item.activityTo}
                        className="mt-2.5 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-teal-200/80 bg-teal-50/60 text-[13px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                      >
                        查看广播对应活动
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-6">
        <DemoNote>
          广播内容与电视大屏、社区喇叭的联动为规划能力，尚未接入应急广播体系；播报来源均为演示数据，不代表任何真实社区或公职部门。
        </DemoNote>
      </div>
    </div>
  )
}
