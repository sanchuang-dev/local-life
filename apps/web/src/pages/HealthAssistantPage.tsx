import { Send, Sparkles } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { useBackTarget } from '../hooks/useBackTarget'
import { usePendingNotice } from '../hooks/usePendingNotice'
import { healthAssistant } from '../mocks/health'

export function HealthAssistantPage() {
  const { message, show, dismiss } = usePendingNotice()
  const { backTo, backLabel } = useBackTarget('/health', '返回健康服务')
  const [draft, setDraft] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    show(
      draft.trim()
        ? healthAssistant.sendNotice
        : '演示：请先输入一个问题；当前不会发送或保存任何内容。',
    )
  }

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={Sparkles}
        title="社区助手"
        subtitle="演示对话 · 未接入真实 AI"
      />

      <DemoNote>{healthAssistant.disclaimer}</DemoNote>

      <section
        aria-label="演示对话记录"
        className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold text-slate-700">演示对话记录</h2>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
            固定样例 · 不生成新回答
          </span>
        </div>

        <div className="space-y-3">
          {healthAssistant.sampleMessages.map((item) => {
            const isVisitor = item.from === 'visitor'
            return (
              <div
                key={item.id}
                className={`flex ${isVisitor ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[86%] rounded-[16px] px-3.5 py-2.5 text-[12px] leading-5 ${
                    isVisitor
                      ? 'rounded-br-md bg-teal-700 text-white'
                      : 'rounded-bl-md bg-slate-100 text-slate-600'
                  }`}
                >
                  <span className="sr-only">{isVisitor ? '访客：' : '社区助手：'}</span>
                  {item.lines.map((line, index) => (
                    <p key={`${item.id}-${index}`} className={index > 0 ? 'mt-1.5' : undefined}>
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="mt-4">
        <h2 className="text-[12px] font-medium text-slate-400">快捷提问 · 演示</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {healthAssistant.quickQuestions.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() =>
                show(`演示：快捷提问「${question}」尚未接入，不会产生真实回复或健康建议。`)
              }
              className="min-h-[36px] rounded-full border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-500 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              {question}
            </button>
          ))}
        </div>
      </section>

      <form
        onSubmit={handleSubmit}
        className="mt-4 rounded-[18px] border border-slate-100 bg-white p-3 shadow-sm"
      >
        <label htmlFor="assistant-input" className="sr-only">
          向社区助手提问
        </label>
        <div className="flex items-center gap-2">
          <input
            id="assistant-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={healthAssistant.inputPlaceholder}
            autoComplete="off"
            className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-[13px] text-slate-700 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
          />
          <button
            type="submit"
            className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <Send size={15} aria-hidden="true" />
            发送
          </button>
        </div>
      </form>

      <DemoNote>{healthAssistant.privacyNote}</DemoNote>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
