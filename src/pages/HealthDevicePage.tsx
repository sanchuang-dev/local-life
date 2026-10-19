import { Info, ScanFace } from 'lucide-react'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  healthDeviceDisclaimer,
  healthMirror,
  mirrorCapabilities,
} from '../mocks/health'

export function HealthDevicePage() {
  const { message, show, dismiss } = usePendingNotice()

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/health"
        backLabel="返回健康服务"
        icon={ScanFace}
        title="魔镜健康终端"
        subtitle="设备能力展示 · 未绑定真实硬件"
      />

      <DemoNote>
        本页只展示旧版原型中的设备能力方向，不提供设备配对、检测或解读；所有能力均未接入。
      </DemoNote>

      <article className="mt-4 overflow-hidden rounded-[20px] border border-slate-100 bg-white shadow-sm">
        <div
          className="flex h-32 items-center justify-center border-b border-slate-100 bg-gradient-to-br from-[#e3f2ea] to-[#c9e7d9]"
          aria-hidden="true"
        >
          <ScanFace size={46} strokeWidth={1.4} className="text-teal-600/75" />
        </div>
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {healthMirror.tags.map((tag, index) => (
              <span
                key={tag}
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  index === 0
                    ? 'bg-[#fff3e6] text-[#a96b2f]'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {tag}
              </span>
            ))}
          </div>
          <h2 className="mt-2.5 text-[21px] font-semibold leading-7 tracking-tight text-slate-900">
            {healthMirror.title}
          </h2>
          <p className="mt-1.5 text-[12px] leading-5 text-slate-500">{healthMirror.subtitle}</p>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">{healthMirror.description}</p>
          <button
            type="button"
            onClick={() => show(healthMirror.bindNotice)}
            className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            绑定设备 · 演示
          </button>
        </div>
      </article>

      <section className="mt-6">
        <div className="mb-3 flex min-h-[36px] items-center justify-between gap-2">
          <h2 className="text-[17px] font-semibold tracking-tight text-slate-900">潜在能力</h2>
          <span className="shrink-0 rounded-full bg-[#fff3e6] px-2 py-0.5 text-[10px] font-medium text-[#a96b2f]">
            筹备中
          </span>
        </div>
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {mirrorCapabilities.map(({ id, title, meta, icon: Icon }, index) => (
            <div
              key={id}
              className={`flex items-center gap-3 px-4 py-3.5 ${
                index > 0 ? 'border-t border-slate-100' : ''
              }`}
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#e8f6f0] text-[#388b77]"
                aria-hidden="true"
              >
                <Icon size={18} strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-slate-700">{title}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{meta}</span>
              </span>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                示例
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-4 flex items-start gap-2.5 rounded-[16px] border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-3 text-[12px] leading-5 text-[#8a6132]">
        <Info size={16} className="mt-0.5 shrink-0 text-[#b97b3e]" aria-hidden="true" />
        <p>{healthDeviceDisclaimer}</p>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
