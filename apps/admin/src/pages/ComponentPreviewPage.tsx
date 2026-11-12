import { Alert, App as AntdApp, Segmented, Space, Tag, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import {
  DataPanel,
  type PanelColumn,
  type PanelFilter,
  type PanelQuery,
} from '../shared/components/DataPanel'

type DemoStatus = 'active' | 'paused' | 'archived'
type DemoCategory = 'community' | 'merchant' | 'grid'

interface DemoRow {
  id: string
  name: string
  category: DemoCategory
  status: DemoStatus
  amount: number
  updatedAt: string
}

interface DemoFilters {
  keyword: string
  status?: DemoStatus
  category?: DemoCategory
  amount: { min?: number; max?: number }
  updated: { start?: string; end?: string }
}

type DemoSortKey = 'name' | 'amount' | 'updatedAt'
type PreviewMode = 'ready' | 'loading' | 'error'

const INITIAL_FILTERS: DemoFilters = {
  keyword: '',
  status: undefined,
  category: undefined,
  amount: {},
  updated: {},
}

const STATUS_LABELS: Record<DemoStatus, { label: string; color: string }> = {
  active: { label: '启用', color: 'green' },
  paused: { label: '暂停', color: 'gold' },
  archived: { label: '归档', color: 'default' },
}

const CATEGORY_LABELS: Record<DemoCategory, string> = {
  community: '社区',
  merchant: '商户',
  grid: '网格',
}

/**
 * Component-verification samples. These are deliberately NOT residents,
 * orders or any real business records: the page exists so reviewers can
 * exercise DataPanel before a business list is wired to a real API.
 */
const DEMO_ROWS: readonly DemoRow[] = Array.from({ length: 14 }, (_, index) => {
  const number = index + 1
  const categories: DemoCategory[] = ['community', 'merchant', 'grid']
  const statuses: DemoStatus[] = ['active', 'active', 'paused', 'archived']
  return {
    id: `sample-${String(number).padStart(2, '0')}`,
    name: `示例条目 ${String(number).padStart(2, '0')}`,
    category: categories[index % categories.length] ?? 'community',
    status: statuses[index % statuses.length] ?? 'active',
    amount: 120 + number * 37,
    updatedAt: `2026-10-${String(18 + (index % 10)).padStart(2, '0')}`,
  }
})

const FILTERS: readonly PanelFilter<DemoFilters>[] = [
  {
    key: 'keyword',
    kind: 'text',
    label: '关键词',
    placeholder: '搜索示例名称',
    width: 220,
  },
  {
    key: 'status',
    kind: 'status',
    label: '状态',
    options: [
      { label: '启用', value: 'active' },
      { label: '暂停', value: 'paused' },
      { label: '归档', value: 'archived' },
    ],
  },
  {
    key: 'category',
    kind: 'select',
    label: '分类',
    options: [
      { label: '社区', value: 'community' },
      { label: '商户', value: 'merchant' },
      { label: '网格', value: 'grid' },
    ],
  },
  { key: 'amount', kind: 'numberRange', label: '金额', advanced: true, min: 0 },
  { key: 'updated', kind: 'dateRange', label: '更新日期', advanced: true },
]

const COLUMNS: readonly PanelColumn<DemoRow, DemoSortKey>[] = [
  { key: 'name', title: '名称', dataIndex: 'name', sortKey: 'name', hideable: false },
  {
    key: 'category',
    title: '分类',
    dataIndex: 'category',
    render: (value: DemoCategory) => CATEGORY_LABELS[value],
  },
  {
    key: 'status',
    title: '状态',
    dataIndex: 'status',
    render: (value: DemoStatus) => (
      <Tag color={STATUS_LABELS[value].color}>{STATUS_LABELS[value].label}</Tag>
    ),
  },
  {
    key: 'amount',
    title: '金额',
    dataIndex: 'amount',
    sortKey: 'amount',
    align: 'right',
    render: (value: number) => `¥${value.toFixed(2)}`,
  },
  {
    key: 'updatedAt',
    title: '更新日期',
    dataIndex: 'updatedAt',
    sortKey: 'updatedAt',
  },
]

/**
 * Applies the controlled query inside this preview page only. A real business
 * page would send the same fields to its API; DataPanel never fetches.
 */
function deriveRows(query: PanelQuery<DemoFilters, DemoSortKey>): DemoRow[] {
  const { keyword, status, category, amount, updated } = query.filters
  const normalizedKeyword = keyword.trim()
  const filtered = DEMO_ROWS.filter((row) => {
    if (normalizedKeyword && !row.name.includes(normalizedKeyword)) return false
    if (status && row.status !== status) return false
    if (category && row.category !== category) return false
    if (amount.min !== undefined && row.amount < amount.min) return false
    if (amount.max !== undefined && row.amount > amount.max) return false
    // Calendar-date comparison on the page's own field; no timezone math is
    // invented here. A real API defines its own inclusive boundary semantics.
    if (updated.start && row.updatedAt < updated.start) return false
    if (updated.end && row.updatedAt > updated.end) return false
    return true
  })

  const sorted = [...filtered]
  if (query.sort) {
    const { key, order } = query.sort
    const factor = order === 'asc' ? 1 : -1
    sorted.sort((left, right) => {
      if (key === 'amount') return (left.amount - right.amount) * factor
      return left[key].localeCompare(right[key], 'zh-CN') * factor
    })
  }
  return sorted
}

export function ComponentPreviewPage() {
  const { message } = AntdApp.useApp()
  const [query, setQuery] = useState<PanelQuery<DemoFilters, DemoSortKey>>({
    filters: INITIAL_FILTERS,
    page: 1,
    pageSize: 10,
  })
  const [mode, setMode] = useState<PreviewMode>('ready')

  const filteredRows = useMemo(() => deriveRows(query), [query])
  const pageRows = useMemo(() => {
    const start = (query.page - 1) * query.pageSize
    return filteredRows.slice(start, start + query.pageSize)
  }, [filteredRows, query.page, query.pageSize])

  const applyQuery = (next: PanelQuery<DemoFilters, DemoSortKey>) => {
    const { min, max } = next.filters.amount
    if (min !== undefined && max !== undefined && min > max) return false
    const { start, end } = next.filters.updated
    if (start && end && start > end) return false
    setQuery(next)
    return true
  }

  return (
    <div className="page">
      <PageHeader
        title="界面组件验收"
        description="DataPanel 通用数据面板的开发预览：行内筛选、可折叠条件、高级检索弹窗、服务端排序/分页契约、列配置、密度与表格/卡片视图。"
        status={<Tag color="gold">开发预览</Tag>}
        extra={
          <Space size={8}>
            <Typography.Text type="secondary">组件状态</Typography.Text>
            <Segmented
              aria-label="组件状态预览"
              value={mode}
              onChange={(value) => setMode(value as PreviewMode)}
              options={[
                { label: '正常', value: 'ready' },
                { label: '加载中', value: 'loading' },
                { label: '请求失败', value: 'error' },
              ]}
            />
          </Space>
        }
      />

      <div className="page-stack">
        <Alert
          type="warning"
          showIcon
          title="本页数据仅用于组件验收，不是真实业务记录"
          description="14 条本地样例数据只用来验证列表交互；本页不发起任何 API 请求，也不代表居民、网格、订单或业绩数据。筛选/排序/分页在此页面内计算，DataPanel 只消费受控 query —— 服务端分页契约尚未接入真实业务接口。"
        />

        <DataPanel<DemoRow, DemoFilters, DemoSortKey>
          id="component-preview"
          label="DataPanel 组件验收"
          rowKey={(row) => row.id}
          query={query}
          onQueryChange={applyQuery}
          initialFilters={INITIAL_FILTERS}
          data={{
            rows: pageRows,
            total: filteredRows.length,
            loading: mode === 'loading',
            error:
              mode === 'error'
                ? new Error('预览：模拟的请求失败，用于验证错误与重试交互')
                : undefined,
          }}
          filters={FILTERS}
          inlineFilterLimit={2}
          columns={COLUMNS}
          onRefresh={mode === 'error' ? () => setMode('ready') : undefined}
          renderCard={(row) => (
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text strong>{row.name}</Typography.Text>
                <Tag color={STATUS_LABELS[row.status].color}>
                  {STATUS_LABELS[row.status].label}
                </Tag>
              </Space>
              <Typography.Text type="secondary">
                {CATEGORY_LABELS[row.category]} · ¥{row.amount.toFixed(2)} · {row.updatedAt}
              </Typography.Text>
            </Space>
          )}
          rowActions={(row) => [
            {
              key: 'inspect',
              label: '查看',
              onClick: () => {
                // Preview-only feedback: no business action is implied.
                message.info(`组件验收样例：${row.name}（不写入任何业务数据）`)
              },
            },
          ]}
        />

        <Alert
          type="info"
          showIcon
          title="本卡的能力边界"
          description="列显示/顺序、密度与表格/卡片偏好按 panel id 保存到 localStorage；查询状态、服务端分页与缓存由业务页面/LL-UI-003 负责，DataPanel 不发起请求、不修改业务实体。"
        />
      </div>
    </div>
  )
}
