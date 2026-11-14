import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  MoreOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
} from 'antd'
import type { ColumnType, TableProps } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  moveColumn,
  resolvePanelPreference,
  type DataPanelPreference,
  type PanelDensity,
  type PanelView,
} from '../lib/data-panel-state'
import { setPanelPreference, usePanelPreference } from '../lib/data-panel-prefs'
import './DataPanel.css'

export type PanelSortOrder = 'asc' | 'desc'

export interface PanelSort<SortKey extends string> {
  key: SortKey
  order: PanelSortOrder
}

/** Everything the page owns about a list query; the panel only edits it. */
export interface PanelQuery<Filters, SortKey extends string> {
  filters: Filters
  page: number
  pageSize: number
  sort?: PanelSort<SortKey>
}

/** Rows and server paging metadata supplied by the page. */
export interface PanelData<Row> {
  rows: Row[]
  total: number
  loading: boolean
  error?: Error
}

/**
 * Calendar-date boundaries for `dateRange` filters, formatted `YYYY-MM-DD`.
 * The page decides how to translate them into API timezone semantics; the panel
 * never guesses an instance's time zone or invents an inclusive/exclusive rule.
 */
export interface DateRangeValue {
  start?: string
  end?: string
}

type FilterKey<Filters> = Extract<keyof Filters, string>

export type PanelFilter<Filters> = {
  key: FilterKey<Filters>
  label: string
  /** Advanced filters only appear inside the 高级检索 dialog. */
  advanced?: boolean
  width?: number
} & (
  | { kind: 'text'; placeholder?: string }
  | {
      kind: 'select'
      options: ReadonlyArray<{ label: string; value: string | number }>
    }
  | { kind: 'status'; options: ReadonlyArray<{ label: string; value: string }> }
  | { kind: 'numberRange'; min?: number; max?: number }
  | { kind: 'dateRange'; format?: string }
)

/** Sort keys are server API fields; column keys are stable UI preference keys. */
export type PanelColumn<Row, SortKey extends string> = Omit<
  ColumnType<Row>,
  'key' | 'sorter' | 'sortOrder' | 'defaultSortOrder' | 'filters' | 'onFilter'
> & {
  key: string
  sortKey?: SortKey
  hideable?: boolean
}

export interface PanelAction<Row> {
  key: string
  label: string
  onClick: (row: Row) => void
  disabled?: boolean
  danger?: boolean
  /** Override the default primary-action selection for this row operation. */
  primary?: boolean
}

export interface DataPanelProps<
  Row extends object,
  Filters extends object,
  SortKey extends string,
> {
  /** Stable per-list key for isolated column/density/view preferences. */
  id: string
  label: string
  rowKey: (row: Row) => string
  query: PanelQuery<Filters, SortKey>
  /** Return false when domain validation rejects a submission; keep the dialog open. */
  onQueryChange: (next: PanelQuery<Filters, SortKey>) => void | boolean
  initialFilters: Filters
  data: PanelData<Row>
  filters: readonly PanelFilter<Filters>[]
  /** First N regular fields stay in the compact quick row; the rest collapse. */
  inlineFilterLimit?: number
  columns: readonly PanelColumn<Row, SortKey>[]
  onRefresh?: () => void
  renderCard?: (row: Row) => ReactNode
  rowActions?: (row: Row) => readonly PanelAction<Row>[]
  /** Compact by default. Expanded mode is reserved for specialized lists. */
  rowActionMode?: 'expanded' | 'compact'
  toolbarExtra?: ReactNode
  emptyText?: ReactNode
  /** Page-owned copy for a failed read; the retry action stays on the panel. */
  errorTitle?: string
  pageSizeOptions?: number[]
  /** Disable paging for complete, small datasets such as a registry list. */
  pagination?: boolean
  /** Fill the workspace by default for paged lists; composite pages can opt out. */
  fillRemainingHeight?: boolean
}

interface DateRangeControlProps {
  value?: DateRangeValue
  onChange?: (value: DateRangeValue) => void
  format?: string
  label: string
}

/** RangePicker stores Dayjs values; the filter contract keeps plain strings. */
function DateRangeControl({
  value,
  onChange,
  format = 'YYYY-MM-DD',
  label,
}: DateRangeControlProps) {
  const range: [Dayjs | null, Dayjs | null] = [
    value?.start ? dayjs(value.start) : null,
    value?.end ? dayjs(value.end) : null,
  ]
  return (
    <DatePicker.RangePicker
      value={range}
      format={format}
      allowEmpty={[true, true]}
      placeholder={['开始日期', '结束日期']}
      aria-label={`${label}日期区间`}
      onChange={(dates) =>
        onChange?.({
          start: dates?.[0]?.format(format) ?? undefined,
          end: dates?.[1]?.format(format) ?? undefined,
        })
      }
    />
  )
}

/**
 * Shared row-action projection, used by both table cells and responsive cards.
 * Compact mode keeps explicit primaries, otherwise the first two ordinary
 * actions. Destructive actions stay in the keyboard-accessible overflow unless
 * explicitly marked primary. No domain action is removed or reinterpreted.
 */
function RowActionControls<Row extends object>({
  row, actions, compact,
}: {
  row: Row
  actions: readonly PanelAction<Row>[]
  compact: boolean
}) {
  const hasExplicitPrimary = actions.some((action) => action.primary === true)
  const isVisible = (action: PanelAction<Row>, index: number) =>
    action.primary === true ||
    (action.primary !== false && !hasExplicitPrimary && index < 2 && !action.danger)
  const visible = compact ? actions.filter(isVisible) : actions
  const overflow = compact ? actions.filter((action, index) => !isVisible(action, index)) : []

  return (
    <Space size={0} wrap={!compact} className={compact ? 'data-panel-compact-actions' : undefined}>
      {visible.map((action) => (
        <Button
          key={action.key}
          type="link"
          size="small"
          danger={action.danger}
          disabled={action.disabled}
          onClick={() => action.onClick(row)}
        >
          {action.label}
        </Button>
      ))}
      {overflow.length > 0 && (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: overflow.map((action) => ({
              key: action.key,
              label: action.label,
              danger: action.danger,
              disabled: action.disabled,
              onClick: () => action.onClick(row),
            })),
          }}
        >
          <Button type="text" size="small" aria-label="更多操作" icon={<MoreOutlined/>}/>
        </Dropdown>
      )}
    </Space>
  )
}

function filtersEqual(left: object, right: object): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function DataPanel<
  Row extends object,
  Filters extends object,
  SortKey extends string,
>({
  id,
  label,
  rowKey,
  query,
  onQueryChange,
  initialFilters,
  data,
  filters,
  inlineFilterLimit = 3,
  columns,
  onRefresh,
  renderCard,
  rowActions,
  rowActionMode = 'compact',
  toolbarExtra,
  emptyText,
  errorTitle = '数据加载失败',
  pageSizeOptions = [10, 20, 50],
  pagination = true,
  fillRemainingHeight = pagination,
}: DataPanelProps<Row, Filters, SortKey>) {
  // AntD's deep NamePath type cannot prove a runtime schema key is a generic
  // recursive path. Form instances stay unparameterized; the public PanelFilter
  // keys and onFinish values remain typed by DataPanelProps/Filters.
  const [quickForm] = Form.useForm()
  const [advancedForm] = Form.useForm()
  const [extraExpanded, setExtraExpanded] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [quickError, setQuickError] = useState(false)
  const [advancedError, setAdvancedError] = useState(false)
  const regularFilters = filters.filter((filter) => !filter.advanced)
  const quickFilters = regularFilters.slice(0, Math.max(0, inlineFilterLimit))
  const extraFilters = regularFilters.slice(Math.max(0, inlineFilterLimit))
  const hasAdvanced = filters.some((filter) => filter.advanced)
  const saved = usePanelPreference(id)
  const keys = columns.map((column) => column.key)
  const prefs = resolvePanelPreference(saved, keys, Boolean(renderCard))
  const requiredKeys = columns
    .filter((column) => column.hideable === false)
    .map((column) => column.key)
  const visibleKeys = [...new Set([...prefs.visibleKeys, ...requiredKeys])]
  const { rows, total, loading, error } = data

  // Form edits are local drafts. Only an actual applied-query/schema change
  // should resynchronize them, never a presentation-state rerender.
  const lastAppliedQuick = useRef<string | null>(null)
  useEffect(() => {
    const signature = JSON.stringify([
      query.filters,
      regularFilters.map((filter) => String(filter.key)),
    ])
    if (lastAppliedQuick.current === signature) return
    lastAppliedQuick.current = signature
    for (const filter of regularFilters) {
      quickForm.setFieldValue(String(filter.key), query.filters[filter.key])
    }
  })

  const openAdvanced = () => {
    // Initialize only on opening, not on every rerender or failed submit:
    // otherwise validation feedback would discard the user's unsubmitted draft.
    const draft = { ...query.filters } as Record<string, unknown>
    for (const filter of regularFilters) {
      draft[String(filter.key)] = quickForm.getFieldValue(String(filter.key))
    }
    for (const filter of filters) {
      advancedForm.setFieldValue(String(filter.key), draft[String(filter.key)])
    }
    setAdvancedError(false)
    setAdvancedOpen(true)
  }

  const submitQuick = (values: Partial<Filters>) => {
    const accepted = onQueryChange({
      ...query,
      filters: { ...query.filters, ...values },
      page: 1,
    })
    setQuickError(accepted === false)
  }

  const submitAdvanced = (values: Filters) => {
    // An invalid domain-specific filter must remain editable in the dialog.
    const accepted = onQueryChange({ ...query, filters: values, page: 1 })
    setAdvancedError(accepted === false)
    if (accepted !== false) setAdvancedOpen(false)
  }

  const resetAllFilters = () => {
    for (const filter of regularFilters) {
      quickForm.setFieldValue(String(filter.key), initialFilters[filter.key])
    }
    for (const filter of filters) {
      advancedForm.setFieldValue(String(filter.key), initialFilters[filter.key])
    }
    setQuickError(false)
    setAdvancedError(false)
    onQueryChange({ ...query, filters: initialFilters, page: 1 })
  }

  const savePreference = (next: DataPanelPreference) => {
    setPanelPreference(id, { ...prefs, ...next })
  }

  const toggleColumn = (key: string, checked: boolean) => {
    const next = checked
      ? [...visibleKeys, key]
      : visibleKeys.filter((value) => value !== key)
    if (next.length === 0) return
    savePreference({ visibleKeys: next })
  }

  const orderedColumns = prefs.columnOrder
    .map((key) => columns.find((column) => column.key === key))
    .filter((column): column is PanelColumn<Row, SortKey> => Boolean(column))
  const activeColumns: ColumnType<Row>[] = orderedColumns
    .filter((column) => visibleKeys.includes(column.key))
    .map(({ sortKey, hideable: _hideable, ...column }) => {
      void _hideable
      return {
        ...column,
        sorter: sortKey ? true : undefined,
        sortOrder:
          sortKey && query.sort?.key === sortKey
            ? query.sort.order === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
      }
    })

  if (rowActions) {
    activeColumns.push({
      title: '操作',
      key: '__panel_actions',
      fixed: 'right',
      width: rowActionMode === 'compact' ? 164 : 140,
      render: (_value, row) => (
        <RowActionControls row={row} actions={rowActions(row)} compact={rowActionMode === 'compact'}/>
      ),
    })
  }

  const onTableChange: TableProps<Row>['onChange'] = (_pageState, _tableFilters, sorter, extra) => {
    if (extra.action === 'sort') {
      const selected = Array.isArray(sorter) ? sorter[0] : sorter
      const column = columns.find((item) => item.key === selected?.columnKey)
      const sort =
        selected?.order && column?.sortKey
          ? {
              key: column.sortKey,
              order: (selected.order === 'ascend' ? 'asc' : 'desc') as PanelSortOrder,
            }
          : undefined
      // All ordering is server-side; never rearrange the current page locally.
      onQueryChange({ ...query, page: 1, sort })
    }
  }

  const renderFilter = (filter: PanelFilter<Filters>, mode: 'inline' | 'modal') => {
    // Width belongs to the control, NOT the whole labelled Form.Item; fixing the
    // wrapper width pushes inputs beneath labels on narrow screens.
    const controlWidth =
      mode === 'modal' ? '100%' : (filter.width ?? (filter.kind === 'text' ? 230 : 160))
    // AntD uses a field name as its default HTML id. Both forms render at once
    // while the dialog is open, so they need distinct input/label targets.
    const fieldId = `${id}-${mode}-${String(filter.key)}`
    if (filter.kind === 'text') {
      return (
        <Form.Item name={String(filter.key)} label={filter.label} htmlFor={fieldId}>
          <Input
            id={fieldId}
            allowClear
            placeholder={filter.placeholder}
            style={{ width: controlWidth, minWidth: 0 }}
          />
        </Form.Item>
      )
    }
    if (filter.kind === 'select' || filter.kind === 'status') {
      return (
        <Form.Item name={String(filter.key)} label={filter.label} htmlFor={fieldId}>
          <Select
            id={fieldId}
            allowClear
            placeholder={filter.kind === 'status' ? '全部状态' : undefined}
            options={[...filter.options]}
            style={{ width: controlWidth }}
          />
        </Form.Item>
      )
    }
    if (filter.kind === 'dateRange') {
      return (
        <Form.Item name={String(filter.key)} label={filter.label}>
          <DateRangeControl format={filter.format} label={filter.label} />
        </Form.Item>
      )
    }
    return (
      <Form.Item label={filter.label}>
        <Space size={4} wrap={mode === 'modal'}>
          <Form.Item name={[String(filter.key), 'min']} noStyle>
            <InputNumber
              id={`${fieldId}-min`}
              min={filter.min}
              max={filter.max}
              placeholder="最小值"
              aria-label={`${filter.label}最小值`}
              style={{ width: mode === 'modal' ? 136 : 104 }}
            />
          </Form.Item>
          <span aria-hidden="true">—</span>
          <Form.Item name={[String(filter.key), 'max']} noStyle>
            <InputNumber
              id={`${fieldId}-max`}
              min={filter.min}
              max={filter.max}
              placeholder="最大值"
              aria-label={`${filter.label}最大值`}
              style={{ width: mode === 'modal' ? 136 : 104 }}
            />
          </Form.Item>
        </Space>
      </Form.Item>
    )
  }

  const settings = (
    <div className="data-panel-settings">
      <div className="data-panel-settings-title">显示列</div>
      {prefs.columnOrder.map((key, index) => {
        const column = columns.find((item) => item.key === key)
        if (!column) return null
        const columnLabel = typeof column.title === 'string' ? column.title : column.key
        return (
          <div key={key} className="data-panel-settings-row">
            <Checkbox
              checked={visibleKeys.includes(key)}
              disabled={
                column.hideable === false ||
                (visibleKeys.length === 1 && visibleKeys.includes(key))
              }
              onChange={(event) => toggleColumn(key, event.target.checked)}
            >
              {columnLabel}
            </Checkbox>
            <Button
              aria-label={`上移${columnLabel}`}
              size="small"
              type="text"
              disabled={index === 0}
              icon={<ArrowUpOutlined />}
              onClick={() =>
                savePreference({ columnOrder: moveColumn(prefs.columnOrder, key, -1) })
              }
            />
            <Button
              aria-label={`下移${columnLabel}`}
              size="small"
              type="text"
              disabled={index === prefs.columnOrder.length - 1}
              icon={<ArrowDownOutlined />}
              onClick={() =>
                savePreference({ columnOrder: moveColumn(prefs.columnOrder, key, 1) })
              }
            />
          </div>
        )
      })}
      <div className="data-panel-settings-title">表格密度</div>
      <Segmented
        aria-label="表格密度"
        options={[
          { label: '紧凑', value: 'small' },
          { label: '标准', value: 'middle' },
          { label: '宽松', value: 'large' },
        ]}
        value={prefs.density}
        onChange={(value) => savePreference({ density: value as PanelDensity })}
      />
    </div>
  )

  const hasActiveFilters = !filtersEqual(query.filters, initialFilters)
  const stalePage = rows.length === 0 && total > 0 && query.page > 1
  const emptyDescription = stalePage
    ? '当前页没有数据，可能页码已过期'
    : hasActiveFilters
      ? '没有符合筛选条件的记录'
      : '暂无数据'
  const empty =
    emptyText ?? (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription}>
        {stalePage ? (
          <Button size="small" onClick={() => onQueryChange({ ...query, page: 1 })}>
            回到第一页
          </Button>
        ) : hasActiveFilters ? (
          <Button size="small" onClick={resetAllFilters}>
            清除筛选条件
          </Button>
        ) : null}
      </Empty>
    )

  return (
    <section className={'panel-surface data-panel' + (fillRemainingHeight ? ' data-panel--fill' : '')} aria-label={label}>
      <div className="panel-toolbar-row data-panel-toolbar-row">
        <Form<Filters>
          form={quickForm}
          className="panel-toolbar data-panel-form"
          layout="inline"
          initialValues={query.filters}
          onFinish={submitQuick}
        >
          <div className="data-panel-quick-line">
            {quickFilters.map((filter) => (
              <div key={filter.key} className="data-panel-filter">
                {renderFilter(filter, 'inline')}
              </div>
            ))}
            <Form.Item className="data-panel-form-actions">
              <Space size={6} wrap>
                <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
                  查询
                </Button>
                <Button icon={<ReloadOutlined />} onClick={resetAllFilters}>
                  重置
                </Button>
                {hasAdvanced ? (
                  <Button
                    type="link"
                    onClick={openAdvanced}
                  >
                    高级检索
                  </Button>
                ) : null}
                {extraFilters.length > 0 ? (
                  <Button
                    type="link"
                    aria-expanded={extraExpanded}
                    onClick={() => setExtraExpanded((value) => !value)}
                  >
                    {extraExpanded ? '收起条件' : '更多条件'}
                  </Button>
                ) : null}
              </Space>
            </Form.Item>
          </div>
          {extraFilters.length > 0 ? (
            <div className="data-panel-extra-filters" aria-label="更多筛选条件" hidden={!extraExpanded}>
              {extraFilters.map((filter) => (
                <div key={filter.key} className="data-panel-filter">
                  {renderFilter(filter, 'inline')}
                </div>
              ))}
            </div>
          ) : null}
        </Form>
        <div className="panel-action data-panel-tools">
          <Space size={8} wrap>
            {toolbarExtra}
            {onRefresh ? <Button onClick={onRefresh}>刷新</Button> : null}
            {renderCard ? (
              <Segmented
                aria-label="数据视图"
                options={[
                  { label: '表格', value: 'table' },
                  { label: '卡片', value: 'card' },
                ]}
                value={prefs.view}
                onChange={(view) => savePreference({ view: view as PanelView })}
              />
            ) : null}
            <Popover content={settings} trigger="click" placement="bottomRight">
              <Button aria-label="列设置" icon={<SettingOutlined />} />
            </Popover>
          </Space>
        </div>
      </div>

      {quickError ? (
        <div className="panel-feedback">
          <Alert
            type="warning"
            showIcon
            title="筛选条件未被接受"
            description="当前条件不合法或不受支持，请修改后重试。"
          />
        </div>
      ) : null}

      <Modal
          title="高级检索"
          aria-label="高级检索"
          forceRender
          open={hasAdvanced && advancedOpen}
          width={680}
          onCancel={() => {
            setAdvancedError(false)
            setAdvancedOpen(false)
          }}
          onOk={() => advancedForm.submit()}
          okText="查询"
          cancelText="取消"
        >
          <Form<Filters>
            form={advancedForm}
            layout="vertical"
            className="data-panel-advanced-form"
            initialValues={query.filters}
            onFinish={submitAdvanced}
          >
            <div className="data-panel-advanced-grid">
              {filters.map((filter) => (
                <div key={filter.key} className="data-panel-modal-filter">
                  {renderFilter(filter, 'modal')}
                </div>
              ))}
            </div>
            <Button
              onClick={() => {
                for (const filter of filters) {
                  advancedForm.setFieldValue(String(filter.key), initialFilters[filter.key])
                }
                setAdvancedError(false)
              }}
            >
              清空条件
            </Button>
            {advancedError ? (
              <Alert
                className="data-panel-advanced-error"
                type="warning"
                showIcon
                title="筛选条件未被接受"
                description="当前条件不合法或不受支持，请修改后重试。"
              />
            ) : null}
          </Form>
        </Modal>

      <div className="data-panel-body">
        {error ? (
          <div className="panel-feedback">
            <Alert
              type="error"
              showIcon
              title={errorTitle}
              description={error.message}
              action={
                onRefresh ? (
                  <Button size="small" onClick={onRefresh}>
                    重试
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : prefs.view === 'card' && renderCard ? (
          <Spin spinning={loading}>
            <div className="data-panel-cards" role="list" aria-label="数据卡片">
              {rows.length === 0 && !loading
                ? empty
                : rows.map((row) => (
                    <div key={rowKey(row)} className="data-panel-card" role="listitem">
                      {renderCard(row)}
                      {rowActions ? (
                        <RowActionControls
                          row={row}
                          actions={rowActions(row)}
                          compact={rowActionMode === 'compact'}
                        />
                      ) : null}
                    </div>
                  ))}
            </div>
          </Spin>
        ) : (
          <Table<Row>
            rowKey={rowKey}
            columns={activeColumns}
            dataSource={rows}
            loading={loading}
            size={prefs.density}
            locale={{ emptyText: loading ? null : empty }}
            scroll={{ x: 'max-content', ...(fillRemainingHeight ? { y: '100%' } : {}) }}
            pagination={false}
            onChange={onTableChange}
          />
        )}
      </div>

      {pagination && !error && total > 0 ? (
        <footer className="data-panel-footer" aria-label="数据分页">
          <Pagination
            current={query.page}
            pageSize={query.pageSize}
            total={total}
            pageSizeOptions={pageSizeOptions}
            showSizeChanger
            showTotal={(amount) => `共 ${amount} 条`}
            onChange={(page, size) =>
              onQueryChange({
                ...query,
                page: size === query.pageSize ? page : 1,
                pageSize: size,
              })
            }
          />
        </footer>
      ) : null}
    </section>
  )
}
