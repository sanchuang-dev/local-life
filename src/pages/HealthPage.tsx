import { ChevronRight, HeartPulse } from 'lucide-react'
import { Link } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { SectionHeading } from '../components/home/SectionHeading'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  healthArchiveNote,
  healthAssistantEntry,
  healthDeviceEntries,
  healthLecturePreview,
  healthMetrics,
} from '../mocks/health'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

export function HealthPage() {
  const { message, show, dismiss } = usePendingNotice()
  const AssistantIcon = healthAssistantEntry.icon

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/"
        backLabel="返回首页"
        icon={HeartPulse}
        title="健康服务"
        subtitle="社区助手 · 家庭设备 · 健康讲堂"
      />

      <DemoNote>
        本页依据 V0.3 健康页迁移，设备、数值与讲堂内容均为演示；不采集个人健康信息，也不提供医疗建议。
      </DemoNote>

      <article className="mt-5 rounded-[20px] border border-teal-300/60 bg-[#eef7f2] p-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-white text-teal-700"
            aria-hidden="true"
          >
            <AssistantIcon size={24} strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold tracking-tight text-slate-900">
              {healthAssistantEntry.title}
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-[#52786c]">
              {healthAssistantEntry.subtitle}
            </p>
          </div>
        </div>
        <Link
          to={healthAssistantEntry.to}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          {healthAssistantEntry.actionLabel}
        </Link>
      </article>

      <section className="mt-6">
        <SectionHeading title="家庭健康设备" note="能力化接入" />
        <div className="grid grid-cols-4 gap-2.5">
          {healthDeviceEntries.map(({ id, label, icon: Icon, tone, pendingNotice }) => (
            <button
              key={id}
              type="button"
              onClick={() => show(pendingNotice)}
              className="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-[18px] border border-slate-100 bg-white px-1 py-3 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-[14px] ${toneStyles[tone]}`}
                aria-hidden="true"
              >
                <Icon size={21} strokeWidth={1.7} />
              </span>
              <span className="text-[12px] font-medium text-slate-700">{label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
          平台不绑定单一硬件；体脂秤、摄像头、睡眠设备等将按同一能力模型接入。
        </p>
      </section>

      <section className="mt-6">
        <SectionHeading
          title="健康档案"
          actionLabel="我的设备"
          actionTo="/me/devices"
          actionState={{ from: '/health' }}
        />
        <article className="rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-2 gap-3">
            {healthMetrics.map((metric) => (
              <div key={metric.id}>
                <p className="text-[26px] font-semibold leading-none tracking-tight text-slate-800">
                  {metric.value}
                  <span className="ml-1 text-[12px] font-normal text-slate-400">{metric.unit}</span>
                </p>
                <p className="mt-1.5 text-[11px] leading-4 text-slate-500">{metric.label}</p>
                <span className="mt-1 inline-block rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                  {metric.note}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-400">{healthArchiveNote}</p>
          <Link
            to="/health/device"
            className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            查看魔镜健康终端
          </Link>
        </article>
      </section>

      <section className="mt-6">
        <SectionHeading title="健康讲堂" actionLabel="全部内容" actionTo="/health/lecture" />
        <div className="grid gap-3">
          {healthLecturePreview.map(({ id, title, categories, format, meta, icon: Icon, tone }) => (
            <Link
              key={id}
              to="/health/lecture"
              className="flex w-full items-center gap-3 rounded-[18px] border border-slate-100 bg-white p-4 text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <span
                className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px] ${toneStyles[tone]}`}
                aria-hidden="true"
              >
                <Icon size={23} strokeWidth={1.6} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  {categories.map((category) => (
                    <span
                      key={category}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
                    >
                      {category}
                    </span>
                  ))}
                  <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                    {format}
                  </span>
                </span>
                <span className="mt-1.5 block text-[15px] font-semibold leading-5 text-slate-800">
                  {title}
                </span>
                <span className="mt-1 block text-[11px] leading-4 text-slate-400">{meta}</span>
              </span>
              <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section>

      <div className="mt-6">
        <DemoNote tone="warn">
          所有入口均为原型演示：不会绑定设备、不会读取或保存健康数据、不会播放音视频，也不会发放积分或产生预约。
        </DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
