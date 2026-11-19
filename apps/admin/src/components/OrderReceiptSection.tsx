import { PageInfoAlert } from './PageInfoHelp'
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useState } from 'react'
import type { LedgerOrderEvidence } from '@sanchuang-dev/local-life-contracts'
import { describeLocalError } from '../services/localApi'
import {
  confirmLedgerPaymentAttribution,
  formatCents,
  formatDateTime,
  getLedgerOrderEvidence,
  recordLedgerOrderReceipt,
} from '../services/ledger'

export type ReceiptStaffOption = { label: string; value: string }

function localDatetimeNow(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16)
}

function statusLabel(state: LedgerOrderEvidence['status']): string {
  switch (state) {
    case 'no_evidence': return '尚无实收证明'
    case 'coupon_only_verified': return '消费券全额抵扣（无现金收款）'
    case 'pending_order_review': return '订单已登记，待业务核验'
    case 'locked_period': return '已锁定，不可补记'
    case 'amount_mismatch': return '金额不一致，待核对'
    case 'reversed': return '收款已冲正'
    case 'pending_attribution': return '凭据已登记，业绩待确认'
    case 'evidence_recorded': return '收款证据已登记（非银行核验）'
  }
}

/**
 * Receipt evidence for ONE order, embedded in the existing 订单详情 drawer.
 *
 * The order is already chosen by the list, so this section never searches for
 * an order again. The server still checks community access, verified status,
 * unique evidence and locked reconciliation; the UI only submits the request.
 */
export function OrderReceiptSection({
  orderId,
  refreshKey,
  csrfToken,
  defaultStaffId,
  staffOptions,
  gridStaffOptions,
}: {
  orderId: string
  /** Re-reads when the order's own state changes (for example after verification). */
  refreshKey: string
  csrfToken: string
  defaultStaffId: string
  staffOptions: ReceiptStaffOption[]
  gridStaffOptions: ReceiptStaffOption[]
}) {
  const [evidence, setEvidence] = useState<LedgerOrderEvidence | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [amountYuan, setAmountYuan] = useState<number | null>(null)
  const [receivedAt, setReceivedAt] = useState(localDatetimeNow)
  const [evidenceKind, setEvidenceKind] = useState<'manual_receipt' | 'bank_transfer'>('bank_transfer')
  const [reference, setReference] = useState('')
  const [handlingStaffId, setHandlingStaffId] = useState(defaultStaffId)
  const [confirmationStaffId, setConfirmationStaffId] = useState<string | undefined>(undefined)
  const [confirmationNote, setConfirmationNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    setEvidence(null)
    setLoadError(null)
    setActionError(null)
    setSuccess(null)
    setReference('')
    setReceivedAt(localDatetimeNow())
    setHandlingStaffId(defaultStaffId)
    setConfirmationStaffId(undefined)
    setConfirmationNote('')
  }, [orderId, defaultStaffId])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    getLedgerOrderEvidence(orderId, controller.signal)
      .then((result) => {
        if (!active) return
        setEvidence(result)
        setAmountYuan(result.netPayableCents / 100)
        setConfirmationStaffId(result.payment?.attribution.staffId ?? undefined)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setEvidence(null)
        setLoadError(describeLocalError(cause, '订单收款凭据读取失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [orderId, refreshKey, revision])

  const reload = () => setRevision((value) => value + 1)

  const record = async () => {
    setActionError(null)
    setSuccess(null)
    if (!evidence?.canRecord) return
    const amountCents = amountYuan === null ? NaN : Math.round(amountYuan * 100)
    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0 ||
      !reference.trim() ||
      !handlingStaffId ||
      !receivedAt
    ) {
      setActionError('请填写到账金额、实际到账时间、凭据编号和经办人员。')
      return
    }
    const received = new Date(receivedAt)
    if (Number.isNaN(received.getTime())) {
      setActionError('到账时间格式不正确')
      return
    }
    setSaving(true)
    try {
      await recordLedgerOrderReceipt(csrfToken, {
        communityId: evidence.communityId,
        orderId,
        amountCents,
        evidenceKind,
        evidenceRef: reference.trim(),
        receivedAt: received.toISOString(),
        staffId: handlingStaffId,
      })
      setSuccess('凭据已登记，仍需核对金额和业绩归属；不代表完成对账或付款。')
      reload()
    } catch (cause) {
      setActionError(describeLocalError(cause, '登记收款凭据失败'))
    } finally {
      setSaving(false)
    }
  }

  const confirmAttribution = async () => {
    setActionError(null)
    setSuccess(null)
    if (!evidence?.payment || !confirmationStaffId || confirmationNote.trim().length < 2) {
      setActionError('请选择实际贡献网格员，并填写至少两个字的核验依据。')
      return
    }
    setConfirming(true)
    try {
      await confirmLedgerPaymentAttribution(csrfToken, {
        entryId: evidence.payment.entryId,
        staffId: confirmationStaffId,
        note: confirmationNote.trim(),
      })
      setSuccess('业绩归属已追加确认记录，不改变原始流水。')
      reload()
    } catch (cause) {
      setActionError(describeLocalError(cause, '业绩归属确认失败'))
    } finally {
      setConfirming(false)
    }
  }

  return (
    <section className="local-section" aria-label="收款凭据与业绩归属">
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap align="center">
          <Typography.Title level={5} style={{ margin: 0 }}>收款凭据与业绩归属</Typography.Title>
          {loading ? <Spin size="small" /> : null}
        </Space>

        {loadError ? (
          <Alert
            type="error"
            showIcon
            title="收款凭据加载失败"
            description={loadError}
            action={<Button size="small" onClick={reload}>重试</Button>}
          />
        ) : evidence ? (
          <>
            <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
              <Descriptions.Item label="业务单号">{evidence.orderDisplayNo}</Descriptions.Item>
              <Descriptions.Item label="商品">{evidence.productName}</Descriptions.Item>
              <Descriptions.Item label="商品毛额">
                {formatCents(evidence.registeredAmountCents)}（非实收）
              </Descriptions.Item>
              <Descriptions.Item label="消费券补贴">
                {formatCents(evidence.couponDiscountCents)}
              </Descriptions.Item>
              <Descriptions.Item label="净应付现金">
                {formatCents(evidence.netPayableCents)}
              </Descriptions.Item>
              <Descriptions.Item label="业务核验">
                {evidence.orderStatus === 'verified' ? '已人工核验（不代表收钱）' : '待核验'}
              </Descriptions.Item>
              <Descriptions.Item label="收款证据状态" span={2}>
                <Tag color={evidence.status === 'evidence_recorded' ? 'green' : 'orange'}>
                  {statusLabel(evidence.status)}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            {evidence.blockingReasons.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                title="仍需处理"
                description={evidence.blockingReasons.join('；')}
              />
            ) : (
              <PageInfoAlert
                inline
                type="info"
                showIcon
                title="凭据和归属已有记录"
                description="仍须依据合同、实际银行证据和后续结算审核决定是否可付款，本页不计算应付款。"
              />
            )}

            {evidence.payment ? (
              <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
                <Descriptions.Item label="已登记实收">
                  {formatCents(evidence.payment.amountCents)}
                </Descriptions.Item>
                <Descriptions.Item label="到账时间">
                  {formatDateTime(evidence.payment.receivedAt)}
                </Descriptions.Item>
                <Descriptions.Item label="凭据编号">
                  {evidence.payment.evidenceRef}
                </Descriptions.Item>
                <Descriptions.Item label="凭据类型">
                  {evidence.payment.evidenceKind === 'bank_transfer' ? '银行转账' : '人工收据'}
                </Descriptions.Item>
                <Descriptions.Item label="经办人员">
                  {staffOptions.find((option) => option.value === evidence.payment?.recordedByStaffId)
                    ?.label ?? '已记录（人员不在当前列表）'}
                </Descriptions.Item>
                <Descriptions.Item label="业绩归属">
                  {evidence.payment.attribution.state === 'attributed'
                    ? staffOptions.find(
                        (option) => option.value === evidence.payment?.attribution.staffId,
                      )?.label ?? '已确认归属'
                    : '业绩待确认'}
                </Descriptions.Item>
                <Descriptions.Item label="归属审核" span={2}>
                  {evidence.payment.confirmation
                    ? `${evidence.payment.confirmation.reviewedByName ?? '已记录审核人'} · ${formatDateTime(
                        evidence.payment.confirmation.confirmedAt,
                      )}`
                    : '尚未核验归属'}
                </Descriptions.Item>
                <Descriptions.Item label="归属确认依据" span={2}>
                  {evidence.payment.confirmation?.note ?? '尚未确认'}
                </Descriptions.Item>
                <Descriptions.Item label="流水编号" span={2}>
                  <Typography.Text copyable={{ text: evidence.payment.entryId }}>
                    {evidence.payment.entryId}
                  </Typography.Text>
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  evidence.status === 'coupon_only_verified'
                    ? '本单全额用券、实收现金 0 元，已通过业务核验'
                    : '该订单没有关联的实收凭据，不能视为已付款'
                }
              />
            )}

            {evidence.canRecord ? (
              <div aria-label="登记真实收款凭据">
                <Typography.Title level={5}>登记真实收款凭据</Typography.Title>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0.01}
                    precision={2}
                    value={amountYuan}
                    onChange={(value) => setAmountYuan(value)}
                    addonBefore="实际到账金额（元）"
                  />
                  <Select
                    value={evidenceKind}
                    onChange={setEvidenceKind}
                    options={[
                      { label: '银行转账凭据', value: 'bank_transfer' },
                      { label: '人工收据', value: 'manual_receipt' },
                    ]}
                  />
                  <Input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="真实凭据编号（不可重复）"
                    maxLength={200}
                    aria-label="凭据编号"
                  />
                  <label>
                    <Typography.Text>实际到账时间</Typography.Text>
                    <Input
                      type="datetime-local"
                      value={receivedAt}
                      onChange={(event) => setReceivedAt(event.target.value)}
                      aria-label="实际到账时间"
                    />
                  </label>
                  <Select
                    style={{ width: '100%' }}
                    value={handlingStaffId}
                    onChange={setHandlingStaffId}
                    options={staffOptions}
                    placeholder="选择实际经办人员"
                    aria-label="实际经办人员"
                  />
                  <Button type="primary" loading={saving} onClick={record}>
                    记录凭据（不代表结算）
                  </Button>
                </Space>
              </div>
            ) : null}

            {evidence.payment &&
            evidence.payment.attribution.state === 'pending' &&
            !evidence.payment.reversedEntryId &&
            !evidence.payment.confirmation ? (
              <div aria-label="确认业绩归属">
                <Typography.Title level={5}>确认业绩归属</Typography.Title>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Select
                    style={{ width: '100%' }}
                    value={confirmationStaffId}
                    onChange={setConfirmationStaffId}
                    options={gridStaffOptions}
                    placeholder="实际推广贡献网格员（不是订单创建人）"
                    aria-label="实际推广贡献网格员"
                  />
                  <Input.TextArea
                    value={confirmationNote}
                    onChange={(event) => setConfirmationNote(event.target.value)}
                    placeholder="说明推广证据、核验依据；无法证明就保持待确认"
                    maxLength={500}
                    rows={2}
                    aria-label="归属核验依据"
                  />
                  <Button loading={confirming} onClick={confirmAttribution}>
                    追加确认记录
                  </Button>
                </Space>
              </div>
            ) : null}
          </>
        ) : null}

        {actionError ? <Alert type="error" showIcon title={actionError} /> : null}
        {success ? <Alert type="success" showIcon title={success} /> : null}
      </Space>
    </section>
  )
}
