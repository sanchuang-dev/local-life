// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { resetPanelPreferences } from '../lib/data-panel-prefs'
import { DataPanel, type PanelColumn, type PanelFilter, type PanelQuery } from './DataPanel'

type Row = { id: string; name: string; price: number; updated: string }
type Filters = {
  keyword: string
  state?: string
  price: { min?: number; max?: number }
  updated: { start?: string; end?: string }
}
type SortKey = 'name' | 'price'

const ROWS: Row[] = [
  { id: 'b', name: 'B 条目', price: 100, updated: '2026-10-02' },
  { id: 'a', name: 'A 条目', price: 500, updated: '2026-10-03' },
]
const FILTERS: Filters = { keyword: '', state: undefined, price: {}, updated: {} }
const FIELDS: PanelFilter<Filters>[] = [
  { key: 'keyword', kind: 'text', label: '名称', placeholder: '条目名称' },
  {
    key: 'state',
    kind: 'status',
    label: '状态',
    options: [
      { label: '启用', value: 'active' },
      { label: '暂停', value: 'paused' },
    ],
  },
  { key: 'price', kind: 'numberRange', label: '金额', advanced: true },
  { key: 'updated', kind: 'dateRange', label: '更新日期', advanced: true },
]
const COLUMNS: PanelColumn<Row, SortKey>[] = [
  { key: 'name', title: '名称', dataIndex: 'name', sortKey: 'name' },
  { key: 'price', title: '金额', dataIndex: 'price', sortKey: 'price' },
  { key: 'updated', title: '更新时间', dataIndex: 'updated' },
]

const changes = vi.fn<(query: PanelQuery<Filters, SortKey>) => void>()
const refreshed = vi.fn()
const selected = vi.fn<(row: Row) => void>()

function Fixture({
  id = 'fixture-a',
  withCards = true,
  error,
  rows = ROWS,
  total = 45,
  loading = false,
  readonly = false,
  inlineLimit = 3,
  rejectAdvanced = false,
}: {
  id?: string
  withCards?: boolean
  error?: Error
  rows?: Row[]
  total?: number
  loading?: boolean
  readonly?: boolean
  inlineLimit?: number
  rejectAdvanced?: boolean
}) {
  const [query, setQuery] = useState<PanelQuery<Filters, SortKey>>({
    filters: FILTERS,
    page: 3,
    pageSize: 20,
  })
  return (
    <DataPanel<Row, Filters, SortKey>
      id={id}
      label="演示数据"
      rowKey={(row) => row.id}
      query={query}
      onQueryChange={(next) => {
        changes(next)
        if (rejectAdvanced && next.filters.price.min === 100) return false
        setQuery(next)
        return true
      }}
      initialFilters={FILTERS}
      data={{ rows, total, loading, error }}
      filters={FIELDS}
      inlineFilterLimit={inlineLimit}
      columns={COLUMNS}
      renderCard={withCards ? (row) => <div>{row.name}</div> : undefined}
      rowActions={
        readonly
          ? undefined
          : (row) => [
              { key: 'view', label: '查看', onClick: selected },
              ...(row.id === 'b'
                ? [{ key: 'disabled', label: '编辑', disabled: true, onClick: selected }]
                : []),
            ]
      }
      onRefresh={refreshed}
    />
  )
}

afterEach(() => {
  cleanup()
  resetPanelPreferences()
  changes.mockReset()
  refreshed.mockReset()
  selected.mockReset()
})

describe('DataPanel controlled query contract', () => {
  it('keeps quick fields inline and submits advanced filters through a dialog', async () => {
    render(<Fixture />)
    const section = screen.getByRole('region', { name: '演示数据' })
    expect(within(section).queryByLabelText('金额最小值')).toBeNull()
    expect(within(section).getByRole('textbox', { name: '名称' }).closest('.data-panel-filter')).toBeTruthy()

    fireEvent.change(within(section).getByRole('textbox', { name: '名称' }), { target: { value: '咖啡' } })
    fireEvent.click(within(section).getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(changes).toHaveBeenCalled())
    expect(changes.mock.lastCall?.[0]).toMatchObject({
      page: 1,
      pageSize: 20,
      filters: { keyword: '咖啡', price: {} },
    })

    fireEvent.click(screen.getByRole('button', { name: '高级检索' }))
    const dialog = await screen.findByRole('dialog')
    const modalKeyword = within(dialog).getByRole('textbox', { name: '名称' }) as HTMLInputElement
    const quickKeyword = document.querySelector('.data-panel-quick-line input') as HTMLInputElement
    expect(modalKeyword.id).not.toBe(quickKeyword.id)
    expect(modalKeyword.value).toBe('咖啡')

    fireEvent.change(within(dialog).getByLabelText('金额最小值'), { target: { value: '100' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /查\s*询/ }))
    await waitFor(() =>
      expect(changes.mock.lastCall?.[0]).toMatchObject({
        page: 1,
        filters: { keyword: '咖啡', price: { min: 100 } },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /重\s*置/ }))
    expect(changes.mock.lastCall?.[0]).toEqual({ page: 1, pageSize: 20, filters: FILTERS })
    expect((screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement).value).toBe('')
  })

  it('cancels an advanced draft without applying it and keeps the dialog open after rejection', async () => {
    render(<Fixture rejectAdvanced />)
    fireEvent.click(screen.getByRole('button', { name: '高级检索' }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('金额最小值'), { target: { value: '100' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(changes).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('筛选条件未被接受')).toBeTruthy()
    // Rejected submission triggers a panel rerender. The unsent advanced
    // draft must not be overwritten by the applied query (which is still empty).
    expect((within(dialog).getByLabelText('金额最小值') as HTMLInputElement).value).toBe('100')

    fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '高级检索' }))
    dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('金额最小值') as HTMLInputElement).value).toBe('')
  })

  it('keeps overflow regular filters in a separate collapsible row', () => {
    render(<Fixture inlineLimit={1} />)
    const section = screen.getByRole('region', { name: '演示数据' })
    const extra = within(section).getByLabelText('更多筛选条件')
    expect(extra.hasAttribute('hidden')).toBe(true)

    fireEvent.click(within(section).getByRole('button', { name: '更多条件' }))
    expect(extra.hasAttribute('hidden')).toBe(false)
    expect(within(extra).getByLabelText('状态')).toBeTruthy()

    fireEvent.click(within(section).getByRole('button', { name: '收起条件' }))
    expect(extra.hasAttribute('hidden')).toBe(true)
  })

  it('offers every supported filter shape, including status and date range', async () => {
    render(<Fixture />)
    expect(screen.getAllByText('全部状态').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '高级检索' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByPlaceholderText('开始日期')).toBeTruthy()
    expect(within(dialog).getByPlaceholderText('结束日期')).toBeTruthy()
    expect(within(dialog).getByLabelText('金额最小值')).toBeTruthy()
    // Quick and modal forms render simultaneously; ids must not collide.
    const ids = Array.from(dialog.querySelectorAll('input'))
      .map((input) => input.id)
      .filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('emits a server sort without reordering current page rows locally', async () => {
    render(<Fixture withCards={false} />)
    const before = screen.getAllByRole('row').slice(1).map((el) => el.textContent)
    fireEvent.click(screen.getByRole('columnheader', { name: /金额/ }))
    await waitFor(() => expect(changes).toHaveBeenCalled())
    expect(changes.mock.lastCall?.[0]).toMatchObject({
      page: 1,
      sort: { key: 'price', order: 'asc' },
    })
    const after = screen.getAllByRole('row').slice(1).map((el) => el.textContent)
    expect(after).toEqual(before)
  })

  it('uses the same rows for table and card and does not own requests or write actions', () => {
    render(<Fixture />)
    expect(screen.getByText('B 条目')).toBeTruthy()

    fireEvent.click(screen.getByText('卡片'))
    const cards = screen.getByRole('list', { name: '数据卡片' })
    expect(cards.querySelectorAll('[role="listitem"]')).toHaveLength(ROWS.length)
    expect(changes).not.toHaveBeenCalled()
    expect(refreshed).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: /查\s*看/ })[0])
    expect(selected).toHaveBeenCalledWith(ROWS[0])
  })

  it('isolates column visibility/order/density/view between panels', async () => {
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: '列设置' }))

    const price = await screen.findByRole('checkbox', { name: '金额' })
    fireEvent.click(price)
    fireEvent.click(screen.getByRole('button', { name: '上移金额' }))
    fireEvent.click(screen.getByText('紧凑'))
    expect(screen.queryByRole('columnheader', { name: '金额' })).toBeNull()

    const stored = JSON.parse(
      window.localStorage.getItem('ll:data-panel-prefs') ?? '{}',
    ) as { panels: Record<string, { visibleKeys?: string[]; columnOrder?: string[]; density?: string }> }
    expect(stored.panels['fixture-a']?.visibleKeys).toEqual(['name', 'updated'])
    expect(stored.panels['fixture-a']?.columnOrder).toEqual(['price', 'name', 'updated'])
    expect(stored.panels['fixture-a']?.density).toBe('small')
    expect(stored.panels['other-panel']).toBeUndefined()
    expect(changes).not.toHaveBeenCalled()
  })

  it('supports a read-only fixture, error/retry and unconfigured card view', () => {
    const { rerender } = render(
      <Fixture readonly withCards={false} error={new Error('service unavailable')} />,
    )
    expect(screen.getByText('数据加载失败')).toBeTruthy()
    expect(screen.getByText('service unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(refreshed).toHaveBeenCalledTimes(1)

    rerender(<Fixture readonly withCards={false} rows={[]} total={0} />)
    expect(screen.getByText('暂无数据')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /查\s*看/ })).toBeNull()
    expect(screen.queryByText('卡片')).toBeNull()
  })

  it('does not claim an empty dataset while the first request is loading', () => {
    render(<Fixture loading rows={[]} total={0} withCards={false} />)
    expect(screen.queryByText('暂无数据')).toBeNull()
  })

  it('distinguishes a stale page from a fresh empty result', async () => {
    const { unmount } = render(<Fixture rows={[]} total={45} withCards={false} />)
    expect(screen.getByText('当前页没有数据，可能页码已过期')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回到第一页' }))
    expect(changes.mock.lastCall?.[0]).toMatchObject({ page: 1 })
    unmount()
    resetPanelPreferences()

    render(<Fixture rows={[]} total={0} withCards={false} />)
    expect(screen.getByText('暂无数据')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '无匹配' } })
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    expect(await screen.findByText('没有符合筛选条件的记录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选条件' }))
    expect(changes.mock.lastCall?.[0]).toEqual({ page: 1, pageSize: 20, filters: FILTERS })
  })
})
