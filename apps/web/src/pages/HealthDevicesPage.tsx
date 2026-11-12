import { Plus, Watch } from 'lucide-react'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { useBackTarget } from '../hooks/useBackTarget'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  addDeviceNotice,
  demoHealthDevices,
  supportedHealthDevices,
} from '../mocks/health'

export function HealthDevicesPage() {
  const { message, show, dismiss } = usePendingNotice()
  const { backTo, backLabel } = useBackTarget('/me', '返回我的')

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={Watch}
        title="我的设备"
        subtitle="设备能力演示 · 未绑定真实硬件"
      />

      <DemoNote>
        当前为设备能力演示，列表中设备均为示例，未绑定任何真实硬件，也不会同步测量数据。
      </DemoNote>

      <div className="mt-4 grid gap-3">
        {demoHealthDevices.map(({ id, name, meta, icon: Icon, state, actionLabel, pendingNotice }) => (
          <article
            key={id}
            className="flex items-center gap-3 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm"
          >
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#e8f6f0] text-[#388b77]"
              aria-hidden="true"
            >
              <Icon size={22} strokeWidth={1.7} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold leading-5 text-slate-800">{name}</h2>
              <p className="mt-1 text-[11px] leading-4 text-slate-400">{meta}</p>
            </div>
            {actionLabel && pendingNotice ? (
              <button
                type="button"
                onClick={() => show(pendingNotice)}
                className="min-h-[44px] shrink-0 rounded-xl border border-slate-200 px-3 text-[12px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                {actionLabel}
              </button>
            ) : (
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                {state}
              </span>
            )}
          </article>
        ))}
      </div>

      <button
        type="button"
        onClick={() => show(addDeviceNotice)}
        className="mt-4 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        <Plus size={16} aria-hidden="true" />
        添加家庭健康设备 · 演示
      </button>

      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-800">可接入的设备类型</h2>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {supportedHealthDevices.map((type) => (
            <span
              key={type}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500"
            >
              {type}
            </span>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
          采用能力化设计，不绑定单一硬件品牌与型号；上述类型仅为方向说明。
        </p>
      </section>

      <DemoNote tone="warn">
        设备绑定、同步与数据查看均未接入，本页不读取、不上传也不保存任何个人健康信息。
      </DemoNote>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
