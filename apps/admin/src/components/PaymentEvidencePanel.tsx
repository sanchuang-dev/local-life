import {
  Alert,
  Button,
  Card,
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
import type {
  LedgerOrderEvidence,
  LocalOrderSummary,
} from '@sanchuang-dev/local-life-contracts'
import { listAdminLocalOrders } from '../services/localOrders'
import { describeLocalError } from '../services/localApi'
import {
  confirmLedgerPaymentAttribution,
  formatCents,
  formatDateTime,
  getLedgerOrderEvidence,
  recordLedgerOrderReceipt,
} from '../services/ledger'

type StaffOption = { label: string; value: string }

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
 * Human-readable workflow on the EXISTING performance page, not a new console.
 * Server checks community access, verified order, unique evidence and locked
 * reconciliation even when the UI is bypassed.
 */
export function PaymentEvidencePanel({
  csrfToken,
  communityId,
  defaultStaffId,
  staffOptions,
  gridStaffOptions,
  onUpdated,
}: {
  csrfToken: string
  communityId?: string
  defaultStaffId: string
  staffOptions: StaffOption[]
  gridStaffOptions: StaffOption[]
  onUpdated: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [orders, setOrders] = useState<LocalOrderSummary[]>([])
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<LedgerOrderEvidence | null>(null)
  const [loadingEvidence, setLoadingEvidence] = useState(false)
  const [evidenceError, setEvidenceError] = useState<string | null>(null)
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
    if (!expanded) return
    let active = true
    const controller = new AbortController()
    setLoadingOrders(true)
    setOrderError(null)
    listAdminLocalOrders({
      page: 1,
      pageSize: 30,
      communityId,
      keyword: keyword || undefined,
    }, controller.signal)
      .then((result) => { if (active) setOrders(result.items) })
      .catch((cause: unknown) => {
        if (active && !controller.signal.aborted) {
          setOrders([])
          setOrderError(describeLocalError(cause, '无法检索本地订单'))
        }
      })
      .finally(() => { if (active) setLoadingOrders(false) })
    return () => { active = false; controller.abort() }
  }, [expanded, communityId, keyword, revision])

  useEffect(() => {
    if (!expanded || !orderId) {
      setEvidence(null)
      return
    }
    let active = true
    const controller = new AbortController()
    setLoadingEvidence(true)
    setEvidenceError(null)
    getLedgerOrderEvidence(orderId, controller.signal)
      .then((result) => {
        if (!active) return
        setEvidence(result)
        setAmountYuan(result.netPayableCents / 100)
        setConfirmationStaffId(result.payment?.attribution.staffId ?? undefined)
      })
      .catch((cause: unknown) => {
        if (active && !controller.signal.aborted) {
          setEvidence(null)
          setEvidenceError(describeLocalError(cause, '订单证据读取失败'))
        }
      })
      .finally(() => { if (active) setLoadingEvidence(false) })
    return () => { active = false; controller.abort() }
  }, [expanded, orderId, revision])

  const refresh = () => {
    setRevision((value) => value + 1)
    onUpdated()
  }

  const record = async () => {
    setActionError(null)
    setSuccess(null)
    if (!evidence?.canRecord || !orderId) return
    const amountCents = amountYuan === null ? NaN : Math.round(amountYuan * 100)
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 ||
        !reference.trim() || !handlingStaffId || !receivedAt) {
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
      refresh()
    } catch (cause) {
      setActionError(describeLocalError(cause, '登记收款凭据失败'))
    } finally {
      setSaving(false)
    }
  }

  const confirmAttribution = async () => {
    setActionError(null)
    setSuccess(null)
    if (!evidence?.payment || !confirmationStaffId ||
        confirmationNote.trim().length < 2) {
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
      refresh()
    } catch (cause) {
      setActionError(describeLocalError(cause, '业绩归属确认失败'))
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Card
      size="small"
      title="订单实收凭据与业绩归属"
      extra={
        <Button onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起核查' : '检索订单 / 登记凭据'}
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: expanded ? 16 : 0 }}>
        订单登记额、业务核验、人工收款与网格员归属分别核对。
        只有真实凭据才能登记实收；人工登记不等于银行确认或完成结算。
      </Typography.Paragraph>
      {expanded ? (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Input.Search
            allowClear
            placeholder="按商品名称、订单内容或订单编号检索"
            onSearch={(value) => setKeyword(value.trim())}
            enterButton="查找订单"
          />
          {orderError ? <Alert type="error" showIcon title={orderError} /> : null}
          <Select
            style={{ width: '100%' }}
            showSearch
            optionFilterProp="label"
            loading={loadingOrders}
            placeholder="选择要核查的业务订单"
            value={orderId}
            onChange={(value: string) => {
              setOrderId(value)
              setActionError(null)
              setSuccess(null)
            }}
            options={orders.map((order) => ({
              value: order.id,
              label: `${order.id.slice(0, 8).toUpperCase()} · ${order.snapshot.productName} · ${formatCents(order.snapshot.totalCents)} · ${order.status === 'verified' ? '已核验' : '未核验'}`,
            }))}
            notFoundContent={loadingOrders ? <Spin size="small" /> : '没有符合条件的订单'}
          />
          {loadingEvidence ? <Spin tip="读取订单收款证据…" /> : null}
          {evidenceError ? <Alert type="error" showIcon title={evidenceError} /> : null}
          {evidence ? (
            <>
              <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
                <Descriptions.Item label="业务单号">{evidence.orderDisplayNo}</Descriptions.Item>
                <Descriptions.Item label="商品">{evidence.productName}</Descriptions.Item>
                <Descriptions.Item label="商品毛额">{formatCents(evidence.registeredAmountCents)}（非实收）</Descriptions.Item>
                <Descriptions.Item label="消费券补贴">{formatCents(evidence.couponDiscountCents)}</Descriptions.Item>
                <Descriptions.Item label="净应付现金">{formatCents(evidence.netPayableCents)}</Descriptions.Item>
                <Descriptions.Item label="业务核验">{evidence.orderStatus === 'verified' ? '已人工核验（不代表收钱）' : '待核验'}</Descriptions.Item>
                <Descriptions.Item label="收款证据状态" span={2}>
                  <Tag color={evidence.status === 'evidence_recorded' ? 'green' : 'orange'}>
                    {statusLabel(evidence.status)}
                  </Tag>
                </Descriptions.Item>
              </Descriptions>
              {evidence.blockingReasons.length > 0 ? (
                <Alert type="warning" showIcon title="仍需处理"
                  description={evidence.blockingReasons.join('；')} />
              ) : <Alert type="info" showIcon title="凭据和归属已有记录"
                  description="仍须依据合同、实际银行证据和后续结算审核决定是否可付款，本页不计算应付款。" />}
              {evidence.payment ? (
                <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
                  <Descriptions.Item label="已登记实收">{formatCents(evidence.payment.amountCents)}</Descriptions.Item>
                  <Descriptions.Item label="到账时间">{formatDateTime(evidence.payment.receivedAt)}</Descriptions.Item>
                  <Descriptions.Item label="凭据编号">{evidence.payment.evidenceRef}</Descriptions.Item>
                  <Descriptions.Item label="凭据类型">{evidence.payment.evidenceKind === 'bank_transfer' ? '银行转账' : '人工收据'}</Descriptions.Item>
                  <Descriptions.Item label="经办人员">{staffOptions.find((s) => s.value === evidence.payment?.recordedByStaffId)?.label ?? '已记录（人员不在当前列表）'}</Descriptions.Item>
                  <Descriptions.Item label="业绩归属">
                    {evidence.payment.attribution.state === 'attributed'
                      ? staffOptions.find((s) => s.value === evidence.payment?.attribution.staffId)?.label ?? '已确认归属'
                      : '业绩待确认'}
                  </Descriptions.Item>
                  <Descriptions.Item label="归属审核" span={2}>
                    {evidence.payment.confirmation
                      ? `${evidence.payment.confirmation.reviewedByName ?? '已记录审核人'} · ${formatDateTime(evidence.payment.confirmation.confirmedAt)}`
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
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={evidence.status === 'coupon_only_verified' ? '本单全额用券、实收现金0元，已通过业务核验' : '该订单没有关联的实收凭据，不能视为已付款'} />}

              {evidence.canRecord ? (
                <section aria-label="登记真实收款凭据">
                  <Typography.Title level={5}>登记真实收款凭据</Typography.Title>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <InputNumber
                      style={{ width: '100%' }} min={0.01} precision={2}
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
                    />
                    <label>
                      <Typography.Text>实际到账时间</Typography.Text>
                      <Input
                        type="datetime-local"
                        value={receivedAt}
                        onChange={(event) => setReceivedAt(event.target.value)}
                      />
                    </label>
                    <Select
                      style={{ width: '100%' }}
                      value={handlingStaffId}
                      onChange={setHandlingStaffId}
                      options={staffOptions}
                      placeholder="选择实际经办人员"
                    />
                    <Button type="primary" loading={saving} onClick={record}>
                      记录凭据（不代表结算）
                    </Button>
                  </Space>
                </section>
              ) : null}

              {evidence.payment && evidence.payment.attribution.state === 'pending' &&
                !evidence.payment.reversedEntryId ? (
                <section aria-label="确认业绩归属">
                  <Typography.Title level={5}>确认业绩归属</Typography.Title>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Select style={{ width: '100%' }}
                      value={confirmationStaffId}
                      onChange={setConfirmationStaffId}
                      options={gridStaffOptions}
                      placeholder="实际推广贡献网格员（不是订单创建人）"
                    />
                    <Input.TextArea
                      value={confirmationNote}
                      onChange={(event) => setConfirmationNote(event.target.value)}
                      placeholder="说明推广证据、核验依据；无法证明就保持待确认"
                      maxLength={500}
                      rows={2}
                    />
                    <Button loading={confirming} onClick={confirmAttribution}>
                      追加确认记录
                    </Button>
                  </Space>
                </section>
              ) : null}
            </>
          ) : null}
          {actionError ? <Alert type="error" showIcon title={actionError} /> : null}
          {success ? <Alert type="success" showIcon title={success} /> : null}
        </Space>
      ) : null}
    </Card>
  )
}
