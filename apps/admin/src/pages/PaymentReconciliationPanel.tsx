import {
  Alert, App as AntdApp, Button, Card, Descriptions, Drawer, Input, Select,
  Space, Table, Tag, Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useState } from 'react'
import type {
  PaymentDifference, PaymentDifferenceReason, PaymentDifferencesQuery,
} from '@sanchuang-dev/local-life-contracts'
import { OrderPaymentSection } from '../components/OrderPaymentSection'
import { describeLocalError } from '../services/localApi'
import {
  downloadPaymentReconciliation, getPaymentReconciliationDetail,
  listPaymentReconciliation, type PaymentDifferenceDetail,
} from '../services/payment-reconciliation'
import { formatCents } from '../services/ledger'
import { communityOptionsOf, useAdminFilterOptions } from './useAdminFilterOptions'

const REASONS: Record<PaymentDifferenceReason, string> = {
  local_consistent: '本地支付/完成/账本事实一致',
  awaiting_payment: '尚未完成支付',
  confirmation_timeout: '支付确认超时待查',
  provider_exception: '渠道证据或订单处理异常',
  duplicate_provider_event: '重复渠道事件待核对',
  manual_online_conflict: '人工与在线实收冲突',
  amount_mismatch: '金额或模拟属性不一致',
  channel_evidence_missing: '缺少渠道成功凭据',
  paid_not_projected: '已支付未形成订单完成',
  ledger_missing: '已完成但缺少线上账本',
  order_state_conflict: '订单与支付状态冲突',
  outbound_uncertain: '渠道预下单结果不确定',
}

const INITIAL: PaymentDifferencesQuery = {
  page: 1, pageSize: 20, source: 'all', status: 'difference',
}

function amount(value: number | null): string {
  return value === null ? '未产生事实' : formatCents(value)
}

/** This panel augments the existing reconciliation page; it never changes its ledger batches. */
export function PaymentReconciliationPanel() {
  const { message } = AntdApp.useApp()
  const { communities, error: scopeError, retry: retryScope } = useAdminFilterOptions()
  const [query, setQuery] = useState<PaymentDifferencesQuery>(INITIAL)
  const [items, setItems] = useState<PaymentDifference[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PaymentDifferenceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    listPaymentReconciliation(query, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setItems(result.items)
        setTotal(result.total)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setItems([])
        setTotal(0)
        setError(describeLocalError(cause, '支付差异查询失败'))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query, refresh])

  useEffect(() => {
    if (!detailId) { setDetail(null); return }
    const controller = new AbortController()
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    getPaymentReconciliationDetail(detailId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setDetail(value) })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDetailError(describeLocalError(cause, '无法读取支付差异详情'))
      })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [detailId])

  function update(patch: Partial<PaymentDifferencesQuery>) {
    setQuery((prior) => ({ ...prior, ...patch, page: 1 }))
  }

  async function exportCurrent() {
    setExporting(true)
    try {
      const result = await downloadPaymentReconciliation(query)
      message.success('已下载 ' + result.filename + '，本地核查结果 ' + (result.rows ?? '未知') + ' 行')
    } catch (cause) {
      message.error(describeLocalError(cause, '支付差异导出失败'))
    } finally {
      setExporting(false)
    }
  }

  const columns: ColumnsType<PaymentDifference> = [
    {
      title: '订单 / 商户单号',
      key: 'order', width: 220,
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text>{row.merchantOrderNo}</Typography.Text>
          <Typography.Text type="secondary">{row.businessDate} · {row.orderId.slice(0, 8)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '核查结论', key: 'reason', width: 215,
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Tag color={row.status === 'difference' ? 'orange' : row.status === 'consistent' ? 'green' : 'default'}>
            {REASONS[row.reason]}
          </Tag>
          <Typography.Text type="secondary">
            {row.source === 'zero_amount' ? '零元券单，无渠道现金' : row.simulated ? 'Mock · 仅测试' : '微信 JSAPI · 渠道账单未核对'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '金额（元）', key: 'amount', width: 180,
      render: (_value, row) => (
        <Space orientation="vertical" size={1}>
          <span>应付 {amount(row.netAmountCents)}</span>
          <Typography.Text type="secondary">完成 {amount(row.completionAmountCents)}</Typography.Text>
          <Typography.Text type="secondary">线上账本 {amount(row.ledgerAmountCents)}</Typography.Text>
        </Space>
      ),
    },
    { title: '银行', key: 'bank', width: 85, render: () => <Tag>未核实</Tag> },
    {
      title: '操作', key: 'action', width: 95,
      render: (_value, row) => <Button size="small" onClick={() => setDetailId(row.intentId)}>核查详情</Button>,
    },
  ]

  return (
    <>
      <Card
        size="small"
        title="支付异常核查 · 本地事实"
        extra={<Space wrap><Button onClick={() => setRefresh((v) => v + 1)}>刷新</Button><Button loading={exporting} onClick={() => void exportCurrent()}>导出当前筛选 CSV</Button></Space>}
      >
        <Alert
          type="info"
          showIcon
          title="本地对账不等于微信渠道或银行账单核对"
          description="仅对比支付单、订单完成、渠道证据与既有经营账本；Mock 永不计为真实收款。没有微信渠道账单时，即使本地一致也不得称为微信对账通过。日期筛选按北京时间的支付单创建日计算。"
          style={{ marginBottom: 12 }}
        />
        <Space wrap size={8} style={{ marginBottom: 12 }}>
          <Select<PaymentDifferencesQuery['status']>
            aria-label="核查状态"
            value={query.status}
            style={{ width: 140 }}
            options={[
              { label: '仅异常', value: 'difference' },
              { label: '全部', value: 'all' },
              { label: '本地一致', value: 'consistent' },
              { label: '待支付', value: 'awaiting' },
            ]}
            onChange={(status) => update({ status })}
          />
          <Select<PaymentDifferencesQuery['source']>
            aria-label="支付来源"
            value={query.source}
            style={{ width: 150 }}
            options={[
              { label: '全部来源', value: 'all' },
              { label: '模拟 Mock', value: 'mock' },
              { label: '微信 JSAPI', value: 'wechat_jsapi' },
              { label: '零元券单', value: 'zero_amount' },
            ]}
            onChange={(source) => update({ source })}
          />
          <Select<PaymentDifferenceReason>
            aria-label="差异类型"
            allowClear
            placeholder="全部差异类型"
            value={query.reason}
            style={{ width: 215 }}
            options={Object.entries(REASONS).map(([value, label]) => ({ value, label }))}
            onChange={(reason) => update({ reason })}
          />
          <Select<string>
            aria-label="社区"
            allowClear
            placeholder="全部授权社区"
            style={{ width: 160 }}
            value={query.communityId}
            options={communityOptionsOf(communities)}
            onChange={(communityId?: string) => update({ communityId })}
          />
          <Input
            aria-label="开始业务日"
            type="date" style={{ width: 158 }}
            value={query.from ?? ''}
            onChange={(event) => update({ from: event.target.value || undefined })}
          />
          <Input
            aria-label="结束业务日"
            type="date" style={{ width: 158 }}
            value={query.to ?? ''}
            onChange={(event) => update({ to: event.target.value || undefined })}
          />
        </Space>
        {scopeError && <Alert type="warning" description={scopeError} action={<Button onClick={retryScope}>重试社区加载</Button>} style={{ marginBottom: 12 }}/>}
        {error && <Alert type="error" description={error} action={<Button onClick={() => setRefresh((v) => v + 1)}>重试</Button>} style={{ marginBottom: 12 }}/>}
        <Table<PaymentDifference>
          rowKey="intentId"
          size="small"
          columns={columns}
          dataSource={items}
          loading={loading}
          scroll={{ x: 830 }}
          pagination={{
            current: query.page, pageSize: query.pageSize, total,
            showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
            showTotal: (value) => '本地核查记录 ' + value + ' 笔',
            onChange: (page, pageSize) => setQuery((prior) => ({ ...prior, page, pageSize })),
          }}
          locale={{ emptyText: '当前条件没有支付差异记录' }}
        />
      </Card>
      <Drawer
        title="支付差异定位（只读）"
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        size={640}
        destroyOnHidden
      >
        {detailLoading && <Typography.Text>核查中…</Typography.Text>}
        {detailError && <Alert type="error" description={detailError}/>}
        {detail && (
          <Space orientation="vertical" style={{ width: '100%' }} size={12}>
            <Alert
              type={detail.status === 'difference' ? 'warning' : 'info'}
              title={REASONS[detail.reason]}
              description="只能查看原始事实、定位支付单并交由人工核查；此处不能修账、补单、制造渠道成功或推断银行到账。"
            />
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="支付单">{detail.intentId}</Descriptions.Item>
              <Descriptions.Item label="订单">{detail.orderId}</Descriptions.Item>
              <Descriptions.Item label="来源">{detail.source} {detail.simulated ? '（仅测试）' : ''}</Descriptions.Item>
              <Descriptions.Item label="本地金额">{amount(detail.netAmountCents)} / {amount(detail.completionAmountCents)} / {amount(detail.ledgerAmountCents)}</Descriptions.Item>
              <Descriptions.Item label="渠道账单">未接入，不可判定匹配</Descriptions.Item>
              <Descriptions.Item label="银行结算">未核实</Descriptions.Item>
            </Descriptions>
            <OrderPaymentSection order={detail.order}/>
          </Space>
        )}
      </Drawer>
    </>
  )
}
