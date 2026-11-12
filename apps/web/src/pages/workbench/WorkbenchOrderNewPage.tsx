import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ClipboardPlus, Info, ShieldAlert } from 'lucide-react'
import type { CrmBusinessType, CrmLeadDetail } from '@sanchuang-dev/local-life-contracts'
import { useCrmApi } from '../../hooks/useCrmApi'
import { useAsyncResource } from '../../hooks/useAsyncResource'
import { StaffGate } from '../../components/crm/StaffGate'
import {
  ErrorBlock,
  Field,
  LoadingBlock,
  StatusNotice,
  inputClassName,
  primaryButtonClassName,
} from '../../components/crm/WorkbenchUi'
import {
  businessTypeLabels,
  businessTypeOptions,
  formatCrmDateTime,
  leadStatusLabels,
} from '../../components/crm/crmLabels'

function CreateOrderForm({ lead }: { lead: CrmLeadDetail }) {
  const api = useCrmApi()
  const navigate = useNavigate()

  const [orderNo, setOrderNo] = useState('')
  const [businessType, setBusinessType] = useState<CrmBusinessType>('gd_mobile')
  const [customerName, setCustomerName] = useState(lead.contactName)
  const [contactPhone, setContactPhone] = useState(lead.contactPhone)
  const [evidenceRef, setEvidenceRef] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setError(null)

    if (!/^[A-Za-z0-9_-]{4,64}$/.test(orderNo.trim())) {
      setError('受理单号需为 4-64 位字母、数字、下划线或短横线')
      return
    }

    setBusy(true)
    try {
      const order = await api.createOrder({
        leadId: lead.id,
        orderNo: orderNo.trim(),
        businessType,
        customerName: customerName.trim(),
        contactPhone: contactPhone.trim(),
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      navigate(`/workbench/orders/${order.id}`, {
        replace: true,
        state: { from: '/workbench/orders' },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建受理单失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 pb-8 pt-4">
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#fff3e6] text-[#c6925c]"
          aria-hidden="true"
        >
          <ClipboardPlus size={21} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">新建广电受理单</h1>
          <p className="mt-0.5 text-[11px] text-slate-400">线索：{lead.contactName}</p>
        </div>
      </div>

      <div className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <p className="text-[11px] text-slate-400">当前线索</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-[14px] font-semibold text-slate-800">
            {lead.contactName} · {lead.contactPhone}
          </p>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {leadStatusLabels[lead.status]}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          {lead.community.name} · 归属 {lead.ownerStaff.displayName ?? '网格员'} · 最近更新{' '}
          {formatCrmDateTime(lead.updatedAt)}
        </p>
      </div>

      {lead.status === 'converted' ? (
        <div className="mt-3">
          <StatusNotice tone="info">
            该线索已有运营核验的有效成交。仍可登记新的受理单，但只有运营人工核验才会产生成交。
          </StatusNotice>
        </div>
      ) : null}

      <div className="mt-3 flex items-start gap-2 rounded-[14px] border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-2.5 text-[11px] leading-5 text-[#8a6132]">
        <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>
          创建后状态为“已提交受理”，需继续提交处理并送运营核验，不表示运营商侧业务已完成。
        </p>
      </div>

      <form className="mt-4" onSubmit={(event) => void submit(event)}>
        <section className="rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <Field
            label="受理单号"
            htmlFor="order-no"
            hint="填写广电受理单号，4-64 位字母、数字、下划线或短横线；同一社区不可重复。"
            required
          >
            <input
              id="order-no"
              type="text"
              required
              maxLength={64}
              pattern="[A-Za-z0-9_\-]{4,64}"
              value={orderNo}
              onChange={(event) => setOrderNo(event.target.value)}
              className={inputClassName}
              placeholder="例如 GD20261104001"
              autoCapitalize="characters"
              autoCorrect="off"
            />
          </Field>

          <Field label="业务类型" htmlFor="order-business-type" required>
            <select
              id="order-business-type"
              required
              value={businessType}
              onChange={(event) => setBusinessType(event.target.value as CrmBusinessType)}
              className={inputClassName}
            >
              {businessTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="客户称呼" htmlFor="order-customer-name" required>
            <input
              id="order-customer-name"
              type="text"
              required
              maxLength={40}
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
              className={inputClassName}
            />
          </Field>

          <Field label="联系电话" htmlFor="order-contact-phone" required>
            <input
              id="order-contact-phone"
              type="tel"
              inputMode="tel"
              required
              pattern="[0-9+\-() ]{5,20}"
              value={contactPhone}
              onChange={(event) => setContactPhone(event.target.value)}
              className={inputClassName}
            />
          </Field>
        </section>

        <section className="mt-4 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <Field
            label="脱敏凭据引用"
            htmlFor="order-evidence-ref"
            hint="例如“工单截图 2026-11-04 #3”。禁止填写身份证号、银行卡号、密码或完整证件照片。"
          >
            <input
              id="order-evidence-ref"
              type="text"
              maxLength={200}
              value={evidenceRef}
              onChange={(event) => setEvidenceRef(event.target.value)}
              className={inputClassName}
              placeholder="脱敏的核验凭据引用（可选）"
            />
          </Field>

          <Field label="备注" htmlFor="order-notes">
            <textarea
              id="order-notes"
              rows={3}
              maxLength={500}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className={`${inputClassName} resize-none py-2.5`}
              placeholder="例如：居民选择电视业务，预约上门安装时间待定。"
            />
          </Field>
        </section>

        {error ? (
          <div className="mt-3">
            <StatusNotice tone="error">{error}</StatusNotice>
          </div>
        ) : null}

        <button type="submit" disabled={busy} className={`${primaryButtonClassName} mt-4`}>
          <ClipboardPlus size={16} aria-hidden="true" />
          {busy ? '提交中…' : '创建受理单'}
        </button>
        <p className="mt-2 flex items-start gap-1.5 text-center text-[11px] leading-5 text-slate-400">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {businessTypeLabels[businessType]}受理单创建后只代表已提交受理，是否有效成交以运营人工核验为准。
          </span>
        </p>
      </form>
    </div>
  )
}

function NewOrderView({ leadId }: { leadId: string }) {
  const api = useCrmApi()
  const resource = useAsyncResource(`lead:${leadId}`, (signal) => api.getLead(leadId, signal))

  return (
    <>
      {resource.state.status === 'loading' ? (
        <div className="px-4 pt-4">
          <LoadingBlock label="正在加载线索…" />
        </div>
      ) : null}
      {resource.state.status === 'error' ? (
        <div className="px-4 pt-4">
          <ErrorBlock message={resource.state.message} onRetry={resource.reload} />
        </div>
      ) : null}
      {resource.state.status === 'ready' ? <CreateOrderForm lead={resource.state.data} /> : null}
    </>
  )
}

export function WorkbenchOrderNewPage() {
  const { leadId } = useParams<{ leadId: string }>()
  return (
    <StaffGate>
      {leadId ? (
        <NewOrderView leadId={leadId} />
      ) : (
        <div className="px-4 pt-4">
          <ErrorBlock title="缺少线索" message="请先在线索详情中发起受理单创建。" />
        </div>
      )}
    </StaffGate>
  )
}
