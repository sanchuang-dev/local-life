// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { PaymentDifference } from '@sanchuang-dev/local-life-contracts'
import {
  downloadPaymentReconciliation,
  getPaymentReconciliationDetail,
  listPaymentReconciliation,
} from '../services/payment-reconciliation'
import { PaymentReconciliationPanel } from './PaymentReconciliationPanel'

vi.mock('../services/payment-reconciliation', () => ({
  downloadPaymentReconciliation: vi.fn(),
  getPaymentReconciliationDetail: vi.fn(),
  listPaymentReconciliation: vi.fn(),
}))
vi.mock('./useAdminFilterOptions', () => ({
  useAdminFilterOptions: () => ({ communities: [], staff: [], error: null, retry: vi.fn() }),
  communityOptionsOf: () => [],
}))
vi.mock('../components/OrderPaymentSection', () => ({
  OrderPaymentSection: () => <div>原始订单支付详情（只读）</div>,
}))

const ITEM: PaymentDifference = {
  intentId: '123e4567-e89b-42d3-a456-426614174100',
  orderId: '123e4567-e89b-42d3-a456-426614174101',
  merchantOrderNo: 'PAY-ABCDEF0123456789ABCDEF012345',
  communityId: '123e4567-e89b-42d3-a456-426614174102',
  source: 'mock',
  simulated: true,
  paymentStatus: 'paid',
  orderStatus: 'registered',
  reason: 'paid_not_projected',
  status: 'difference',
  businessDate: '2026-11-19',
  createdAt: '2026-11-18T23:00:00.000Z',
  netAmountCents: 3980,
  completionAmountCents: null,
  ledgerAmountCents: null,
  bankSettlement: 'unverified',
  channelBill: 'not_connected',
}

beforeEach(() => {
  vi.mocked(listPaymentReconciliation).mockResolvedValue({
    items: [ITEM], total: 1, page: 1, pageSize: 20,
    asOf: '2026-11-19T00:00:00.000Z',
  })
  vi.mocked(downloadPaymentReconciliation).mockResolvedValue({
    filename: 'payment-reconciliation.csv', rows: 1,
  })
  vi.mocked(getPaymentReconciliationDetail).mockResolvedValue({
    ...ITEM, asOf: '2026-11-19T00:00:00.000Z',
    order: {} as never,
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function show() {
  return render(
    <ConfigProvider locale={zhCN}>
      <AntdApp><PaymentReconciliationPanel /></AntdApp>
    </ConfigProvider>,
  )
}

describe('PAY-09 Admin payment reconciliation panel', () => {
  it('labels simulated money and internal-only discrepancy, without claiming WeChat settlement', async () => {
    show()
    expect(await screen.findByText('PAY-ABCDEF0123456789ABCDEF012345')).toBeTruthy()
    expect(screen.getByText('已支付未形成订单完成')).toBeTruthy()
    expect(screen.getByText('Mock · 仅测试')).toBeTruthy()
    expect(screen.getByText('未核实')).toBeTruthy()
    expect(screen.getByText(/本地对账不等于微信渠道或银行账单核对/)).toBeTruthy()
    expect(vi.mocked(listPaymentReconciliation).mock.calls[0]?.[0]).toMatchObject({
      status: 'difference', source: 'all', page: 1, pageSize: 20,
    })
  })

  it('downloads only the current selected filters and can inspect PAY-08 read-only order facts', async () => {
    show()
    await screen.findByText('已支付未形成订单完成')
    fireEvent.click(screen.getByRole('button', { name: /导出当前筛选 CSV/u }))
    await waitFor(() => expect(downloadPaymentReconciliation).toHaveBeenCalledTimes(1))
    expect(vi.mocked(downloadPaymentReconciliation).mock.calls[0]?.[0]).toMatchObject({
      status: 'difference', source: 'all',
    })
    fireEvent.click(screen.getByRole('button', { name: '核查详情' }))
    expect(await screen.findByText('原始订单支付详情（只读）')).toBeTruthy()
    expect(screen.getByText('未接入，不可判定匹配')).toBeTruthy()
  })
})
