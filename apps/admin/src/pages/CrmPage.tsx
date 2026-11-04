import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Result,
  Space,
  Spin,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AdminCrmFilterOptionsResponse,
  CrmBusinessType,
  CrmFollowUp,
  CrmLeadDetail,
  CrmLeadEvent,
  CrmLeadSourceType,
  CrmLeadStatus,
  CrmLeadSummary,
  CrmOrderDetail,
  CrmOrderEvent,
  CrmOrderReviewDecision,
  CrmOrderSummary,
  CrmServiceOrderStatus,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import {
  DataPanel,
  type PanelColumn,
  type PanelFilter,
  type PanelQuery,
} from '../shared/components/DataPanel'
import {
  CrmApiError,
  getAdminCrmFilterOptions,
  getAdminCrmLead,
  getAdminCrmOrder,
  isCrmApiError,
  listAdminCrmLeadAudit,
  listAdminCrmLeads,
  listAdminCrmOrders,
  listCrmLeadFollowUps,
  reviewAdminCrmOrder,
} from '../services/crm'
import type { AuthenticatedSession } from '../services/auth'
import './crm.css'

/**
 * Back-office CRM console.
 *
 * Leads and service orders are two real lists backed by `/admin/crm/*`; every
 * row, filter option, event and review result comes from the server. The only
 * path from "submitted acceptance order" to "confirmed deal" is an explicit
 * operator verification; no screen here claims carrier activation.
 */

type CrmTab = 'leads' | 'orders'

const LEAD_STATUS_META: Record<CrmLeadStatus, { label: string; color: string }> = {
  new: { label: '新线索', color: 'blue' },
  contacting: { label: '跟进中', color: 'gold' },
  converted: { label: '已成交', color: 'green' },
  invalid: { label: '无效线索', color: 'default' },
}

const LEAD_SOURCE_META: Record<CrmLeadSourceType, string> = {
  activity: '活动来源',
  grid_promotion: '网格推广',
  walk_in: '到访登记',
  resident_referral: '居民转介',
}

const BUSINESS_TYPE_META: Record<CrmBusinessType, string> = {
  gd_mobile: '广电手机卡',
  gd_tv: '广电电视',
}

/**
 * `confirmed` is written only after a human operator verifies the acceptance
 * record. The label deliberately never says 已开通 / 已激活.
 */
const ORDER_STATUS_META: Record<CrmServiceOrderStatus, { label: string; color: string }> = {
  submitted: { label: '已提交受理', color: 'blue' },
  processing: { label: '处理中', color: 'gold' },
  pending_verification: { label: '待核验', color: 'orange' },
  confirmed: { label: '有效成交（人工核验）', color: 'green' },
  failed: { label: '未通过', color: 'red' },
  cancelled: { label: '已取消', color: 'default' },
}

const LEAD_EVENT_LABELS: Record<string, string> = {
  'lead.created': '创建线索',
  'lead.status_changed': '线索状态变更',
  'lead.transferred': '转移归属',
  'lead.follow_up_added': '新增跟进',
}

const ORDER_EVENT_LABELS: Record<string, string> = {
  'order.created': '创建受理单',
  'order.status_changed': '受理状态变更',
  'order.reviewed': '人工核验审核',
}

const LEAD_STATUS_OPTIONS = (Object.keys(LEAD_STATUS_META) as CrmLeadStatus[]).map((status) => ({
  label: LEAD_STATUS_META[status].label,
  value: status,
}))

const LEAD_SOURCE_OPTIONS = (Object.keys(LEAD_SOURCE_META) as CrmLeadSourceType[]).map((value) => ({
  label: LEAD_SOURCE_META[value],
  value,
}))

const ORDER_STATUS_OPTIONS = (
  Object.keys(ORDER_STATUS_META) as CrmServiceOrderStatus[]
).map((status) => ({ label: ORDER_STATUS_META[status].label, value: status }))

const BUSINESS_TYPE_OPTIONS = (Object.keys(BUSINESS_TYPE_META) as CrmBusinessType[]).map(
  (value) => ({ label: BUSINESS_TYPE_META[value], value }),
)

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return DATE_TIME_FORMATTER.format(date).replace(/\//g, '-')
}

function staffName(staff: { displayName: string | null } | null | undefined): string {
  return staff?.displayName?.trim() || '未命名人员'
}

function leadSourceText(lead: CrmLeadSummary): string {
  if (lead.sourceType === 'activity' && lead.sourceActivity) {
    return `活动 · ${lead.sourceActivity.title}`
  }
  if (lead.sourceType === 'grid_promotion' && lead.promotionStaff) {
    return `网格推广 · ${staffName(lead.promotionStaff)}`
  }
  return LEAD_SOURCE_META[lead.sourceType]
}

function leadSourceAttribution(lead: CrmLeadDetail): string {
  if (lead.sourceType === 'activity') {
    return lead.sourceActivity ? `活动「${lead.sourceActivity.title}」` : '活动来源（未记录活动）'
  }
  if (lead.sourceType === 'grid_promotion') {
    return lead.promotionStaff
      ? `网格推广，推广网格员：${staffName(lead.promotionStaff)}`
      : '网格推广（未记录推广网格员）'
  }
  return LEAD_SOURCE_META[lead.sourceType]
}

function describeError(cause: unknown, fallback: string): string {
  if (isCrmApiError(cause)) {
    switch (cause.status) {
      case 401:
        return `登录状态已失效：${cause.message}。请重新登录后重试。`
      case 403:
        return `没有权限：${cause.message}`
      case 409:
        return `数据已被更新，请刷新后重试：${cause.message}`
      case 400:
        return `请求不合法：${cause.message}`
      default:
        return cause.message || fallback
    }
  }
  return cause instanceof Error ? cause.message : fallback
}

function listErrorTitle(error: Error | null, noun: string): string {
  if (error instanceof CrmApiError) {
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return `没有${noun}权限`
  }
  return `${noun}加载失败`
}

/** The grid worker is a mobile-only role: never issue a back-office request. */
export function CrmPage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="客户与业务单"
          description="客户线索与业务单审核仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有后台 CRM 审核权限"
            subTitle="该入口仅对管理员与运营员开放；即使直接访问该地址，服务端同样会拒绝网格员的后台 CRM 请求。移动端客户与跟进请使用网格员 H5 工作台。"
          />
        </div>
      </div>
    )
  }

  return <CrmConsole session={session} />
}

function CrmConsole({ session }: { session: AuthenticatedSession }) {
  const [tab, setTab] = useState<CrmTab>('leads')
  const [filterOptions, setFilterOptions] = useState<AdminCrmFilterOptionsResponse | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [optionsToken, setOptionsToken] = useState(0)
  const role = session.staff.role

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setOptionsError(null)
    getAdminCrmFilterOptions(controller.signal)
      .then((result) => {
        if (active) setFilterOptions(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setFilterOptions(null)
        setOptionsError(describeError(cause, '无法读取社区与网格员筛选选项'))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [optionsToken])

  return (
    <div className="page">
      <PageHeader
        title="客户与业务单"
        description="按授权社区与网格员查询客户线索、跟进与广电业务受理单；人工核验后才记为有效成交。"
        status={<Tag color="green">真实数据</Tag>}
      />

      <div className="page-stack">
        {role === 'operator' ? (
          <Alert
            type="info"
            showIcon
            title="运营员视图"
            description={
              session.staff.communities.length > 0
                ? `仅能查看与审核管理员分配的社区（${session.staff.communities
                    .map((item) => item.name)
                    .join('、')}）；筛选选项与列表均由服务端按社区范围过滤。`
                : '当前账号尚未被分配社区，暂时无法查看线索或审核业务单，请联系管理员。'
            }
          />
        ) : null}

        {optionsError ? (
          <Alert
            type="warning"
            showIcon
            title="筛选选项加载失败"
            description={`${optionsError} 列表本身仍会按服务端授权范围读取；社区/网格员筛选在选项恢复前不可用。`}
            action={
              <Button size="small" onClick={() => setOptionsToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null}

        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key === 'orders' ? 'orders' : 'leads')}
          items={[
            {
              key: 'leads',
              label: '客户线索',
              children: (
                <LeadPanel session={session} filterOptions={filterOptions} />
              ),
            },
            {
              key: 'orders',
              label: '业务受理单',
              children: (
                <OrderPanel session={session} filterOptions={filterOptions} />
              ),
            },
          ]}
        />
      </div>
    </div>
  )
}

/* ---------------------------------- Leads --------------------------------- */

interface LeadFilters {
  keyword: string
  communityId?: string
  staffId?: string
  sourceType?: CrmLeadSourceType
  status?: CrmLeadStatus
}

type CrmSortKey = 'updatedAt'

interface PanelOptionsProps {
  session: AuthenticatedSession
  filterOptions: AdminCrmFilterOptionsResponse | null
}

function LeadPanel({ filterOptions }: PanelOptionsProps) {
  const initialFilters = useMemo<LeadFilters>(
    () => ({ keyword: '', communityId: undefined, staffId: undefined, sourceType: undefined, status: undefined }),
    [],
  )
  const [query, setQuery] = useState<PanelQuery<LeadFilters, CrmSortKey>>(() => ({
    filters: { keyword: '' },
    page: 1,
    pageSize: 20,
  }))
  const [rows, setRows] = useState<CrmLeadSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [listToken, setListToken] = useState(0)

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<CrmLeadDetail | null>(null)
  const [followUps, setFollowUps] = useState<CrmFollowUp[]>([])
  const [events, setEvents] = useState<CrmLeadEvent[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLeadId, setDetailLeadId] = useState<string | null>(null)
  const detailRequestRef = useRef(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    listAdminCrmLeads(
      {
        page: query.page,
        pageSize: query.pageSize,
        communityId: query.filters.communityId,
        staffId: query.filters.staffId,
        status: query.filters.status,
        sourceType: query.filters.sourceType,
        keyword: query.filters.keyword,
      },
      controller.signal,
    )
      .then((result) => {
        if (!active) return
        setRows(result.items)
        setTotal(result.total)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setRows([])
        setTotal(0)
        setError(cause instanceof Error ? cause : new Error('客户线索加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [query, listToken])

  const refreshList = () => setListToken((value) => value + 1)

  const filters = useMemo<readonly PanelFilter<LeadFilters>[]>(
    () => [
      {
        key: 'keyword',
        kind: 'text',
        label: '关键词',
        placeholder: '搜索联系人 / 脱敏手机号',
        width: 220,
      },
      {
        key: 'communityId',
        kind: 'select',
        label: '社区',
        width: 190,
        options: (filterOptions?.communities ?? []).map((community) => ({
          label: community.name,
          value: community.id,
        })),
      },
      { key: 'status', kind: 'status', label: '线索状态', options: LEAD_STATUS_OPTIONS },
      {
        key: 'staffId',
        kind: 'select',
        label: '归属网格员',
        width: 190,
        options: (filterOptions?.staff ?? []).map((member) => ({
          label: `${staffName(member)}（${member.role === 'grid_worker' ? '网格员' : '运营员'}）`,
          value: member.id,
        })),
      },
      {
        key: 'sourceType',
        kind: 'select',
        label: '来源',
        width: 160,
        options: LEAD_SOURCE_OPTIONS,
      },
    ],
    [filterOptions],
  )

  const columns = useMemo<readonly PanelColumn<CrmLeadSummary, CrmSortKey>[]>(
    () => [
      {
        key: 'contactName',
        title: '联系人',
        dataIndex: 'contactName',
        hideable: false,
        render: (value: string, row) => (
          <Space orientation="vertical" size={0}>
            <Typography.Text strong>{value}</Typography.Text>
            <Typography.Text type="secondary">{row.contactPhoneMasked}</Typography.Text>
          </Space>
        ),
      },
      { key: 'community', title: '社区', render: (_value, row) => row.community.name },
      {
        key: 'ownerStaff',
        title: '归属网格员',
        render: (_value, row) => staffName(row.ownerStaff),
      },
      {
        key: 'source',
        title: '来源',
        render: (_value, row) => leadSourceText(row),
      },
      {
        key: 'status',
        title: '状态',
        dataIndex: 'status',
        render: (status: CrmLeadStatus) => (
          <Tag color={LEAD_STATUS_META[status].color}>{LEAD_STATUS_META[status].label}</Tag>
        ),
      },
      {
        key: 'nextContactAt',
        title: '下次联系',
        dataIndex: 'nextContactAt',
        render: (value: string | null) => formatDateTime(value),
      },
      {
        key: 'followUpCount',
        title: '跟进次数',
        dataIndex: 'followUpCount',
      },
      {
        key: 'updatedAt',
        title: '更新时间',
        dataIndex: 'updatedAt',
        render: (value: string) => formatDateTime(value),
      },
    ],
    [],
  )

  function openDetail(leadId: string) {
    setDetailOpen(true)
    setDetail(null)
    setFollowUps([])
    setEvents([])
    setDetailLeadId(leadId)
    void loadDetail(leadId)
  }

  async function loadDetail(leadId: string) {
    const request = detailRequestRef.current + 1
    detailRequestRef.current = request
    setDetailLoading(true)
    setDetailError(null)
    try {
      const [leadResult, followUpResult, auditResult] = await Promise.all([
        getAdminCrmLead(leadId),
        listCrmLeadFollowUps(leadId),
        listAdminCrmLeadAudit(leadId),
      ])
      if (detailRequestRef.current !== request) return
      setDetail(leadResult)
      setFollowUps(followUpResult.items)
      setEvents(auditResult.items)
    } catch (cause: unknown) {
      if (detailRequestRef.current !== request) return
      setDetailError(describeError(cause, '无法读取客户线索详情与跟进记录'))
    } finally {
      if (detailRequestRef.current === request) setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    detailRequestRef.current += 1
    setDetailOpen(false)
    setDetailLoading(false)
    setDetailLeadId(null)
  }

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <DataPanel<CrmLeadSummary, LeadFilters, CrmSortKey>
        id="crm-leads"
        label="客户线索列表"
        rowKey={(row) => row.id}
        query={query}
        onQueryChange={(next) => {
          setQuery(next)
          return true
        }}
        initialFilters={initialFilters}
        data={{ rows, total, loading, error: error ?? undefined }}
        filters={filters}
        columns={columns}
        onRefresh={refreshList}
        errorTitle={listErrorTitle(error, '客户线索')}
        rowActions={(row) => [
          { key: 'detail', label: '详情', onClick: () => openDetail(row.id) },
        ]}
        renderCard={(row) => (
          <Space orientation="vertical" size={4} style={{ width: '100%' }}>
            <Space wrap>
              <Typography.Text strong>{row.contactName}</Typography.Text>
              <Tag color={LEAD_STATUS_META[row.status].color}>
                {LEAD_STATUS_META[row.status].label}
              </Tag>
            </Space>
            <Typography.Text type="secondary">
              {row.community.name} · 归属 {staffName(row.ownerStaff)}
            </Typography.Text>
            <Typography.Text type="secondary">
              {leadSourceText(row)} · 下次联系 {formatDateTime(row.nextContactAt)}
            </Typography.Text>
            <Typography.Text type="secondary">
              跟进 {row.followUpCount} 次 · 更新 {formatDateTime(row.updatedAt)}
            </Typography.Text>
          </Space>
        )}
      />

      <Drawer
        title={detail ? `客户线索 · ${detail.contactName}` : '客户线索详情'}
        size={620}
        open={detailOpen}
        onClose={closeDetail}
        rootClassName="crm-drawer"
      >
        {detailLoading ? (
          <div className="crm-drawer-loading">
            <Spin description="正在读取线索详情与跟进记录…" />
          </div>
        ) : detailError ? (
          <Alert
            type="error"
            showIcon
            title="客户线索详情加载失败"
            description={detailError}
            action={
              <Button
                size="small"
                disabled={!detailLeadId}
                onClick={() => {
                  if (detailLeadId) void loadDetail(detailLeadId)
                }}
              >
                重试
              </Button>
            }
          />
        ) : detail ? (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="社区">{detail.community.name}</Descriptions.Item>
              <Descriptions.Item label="归属网格员">
                {staffName(detail.ownerStaff)}
              </Descriptions.Item>
              <Descriptions.Item label="创建人">
                {staffName(detail.createdByStaff)}
              </Descriptions.Item>
              <Descriptions.Item label="联系人">{detail.contactName}</Descriptions.Item>
              <Descriptions.Item label="联系电话">{detail.contactPhone}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={LEAD_STATUS_META[detail.status].color}>
                  {LEAD_STATUS_META[detail.status].label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="来源类型">
                {LEAD_SOURCE_META[detail.sourceType]}
              </Descriptions.Item>
              <Descriptions.Item label="来源归属">
                {leadSourceAttribution(detail)}
              </Descriptions.Item>
              <Descriptions.Item label="下次联系">
                {formatDateTime(detail.nextContactAt)}
              </Descriptions.Item>
              <Descriptions.Item label="最近联系">
                {formatDateTime(detail.lastContactedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="跟进次数">{detail.followUpCount}</Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {formatDateTime(detail.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="更新时间">
                {formatDateTime(detail.updatedAt)}
              </Descriptions.Item>
            </Descriptions>

            <section className="crm-timeline-section" aria-label="跟进记录">
              <Typography.Title level={5}>跟进记录</Typography.Title>
              {followUps.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无跟进记录" />
              ) : (
                <Timeline
                  items={followUps.map((followUp) => ({
                    key: followUp.id,
                    content: (
                      <div className="crm-timeline-entry">
                        <Space wrap>
                          <Typography.Text strong>{staffName(followUp.staff)}</Typography.Text>
                          <Typography.Text type="secondary">
                            {formatDateTime(followUp.createdAt)}
                          </Typography.Text>
                        </Space>
                        <Typography.Paragraph className="crm-timeline-note">
                          {followUp.content}
                        </Typography.Paragraph>
                        <Typography.Text type="secondary">
                          下次联系：{formatDateTime(followUp.nextContactAt)}
                        </Typography.Text>
                      </div>
                    ),
                  }))}
                />
              )}
            </section>

            <section className="crm-timeline-section" aria-label="线索审计时间线">
              <Typography.Title level={5}>线索审计时间线</Typography.Title>
              {events.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无审计事件" />
              ) : (
                <Timeline
                  items={events.map((event) => ({
                    key: event.id,
                    color:
                      event.event === 'lead.created'
                        ? 'green'
                        : event.event === 'lead.transferred'
                          ? 'gold'
                          : 'blue',
                    content: <LeadEventContent event={event} />,
                  }))}
                />
              )}
            </section>
          </Space>
        ) : null}
      </Drawer>
    </Space>
  )
}

function LeadEventContent({ event }: { event: CrmLeadEvent }) {
  const transition =
    event.fromStatus || event.toStatus
      ? `${event.fromStatus ? LEAD_STATUS_META[event.fromStatus].label : '—'} → ${
          event.toStatus ? LEAD_STATUS_META[event.toStatus].label : '—'
        }`
      : null
  return (
    <div className="crm-timeline-entry">
      <Space wrap>
        <Typography.Text strong>{LEAD_EVENT_LABELS[event.event] ?? event.event}</Typography.Text>
        <Typography.Text type="secondary">{formatDateTime(event.createdAt)}</Typography.Text>
      </Space>
      <div>
        <Typography.Text type="secondary">
          操作者：{event.actor ? staffName(event.actor) : '系统/未知操作者'}
        </Typography.Text>
      </div>
      {transition ? (
        <div>
          <Typography.Text type="secondary">状态：{transition}</Typography.Text>
        </div>
      ) : null}
      {event.event === 'lead.transferred' ? (
        <div>
          <Typography.Text type="secondary">
            归属：{event.fromOwnerStaff ? staffName(event.fromOwnerStaff) : '—'} →{' '}
            {event.toOwnerStaff ? staffName(event.toOwnerStaff) : '—'}
          </Typography.Text>
        </div>
      ) : null}
      {event.note ? (
        <Typography.Paragraph className="crm-timeline-note">{event.note}</Typography.Paragraph>
      ) : null}
    </div>
  )
}

/* --------------------------------- Orders --------------------------------- */

interface OrderFilters {
  keyword: string
  communityId?: string
  staffId?: string
  businessType?: CrmBusinessType
  status?: CrmServiceOrderStatus
}

function OrderPanel({ session, filterOptions }: PanelOptionsProps) {
  const { message, modal } = AntdApp.useApp()
  const initialFilters = useMemo<OrderFilters>(
    () => ({ keyword: '', communityId: undefined, staffId: undefined, businessType: undefined, status: undefined }),
    [],
  )
  const [query, setQuery] = useState<PanelQuery<OrderFilters, CrmSortKey>>(() => ({
    filters: { keyword: '' },
    page: 1,
    pageSize: 20,
  }))
  const [rows, setRows] = useState<CrmOrderSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [listToken, setListToken] = useState(0)

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<CrmOrderDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const detailRequestRef = useRef(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    listAdminCrmOrders(
      {
        page: query.page,
        pageSize: query.pageSize,
        communityId: query.filters.communityId,
        staffId: query.filters.staffId,
        businessType: query.filters.businessType,
        status: query.filters.status,
        keyword: query.filters.keyword,
      },
      controller.signal,
    )
      .then((result) => {
        if (!active) return
        setRows(result.items)
        setTotal(result.total)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setRows([])
        setTotal(0)
        setError(cause instanceof Error ? cause : new Error('业务受理单加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [query, listToken])

  const refreshList = () => setListToken((value) => value + 1)

  const filters = useMemo<readonly PanelFilter<OrderFilters>[]>(
    () => [
      {
        key: 'keyword',
        kind: 'text',
        label: '关键词',
        placeholder: '搜索受理单号 / 客户',
        width: 220,
      },
      {
        key: 'communityId',
        kind: 'select',
        label: '社区',
        width: 190,
        options: (filterOptions?.communities ?? []).map((community) => ({
          label: community.name,
          value: community.id,
        })),
      },
      { key: 'status', kind: 'status', label: '业务状态', options: ORDER_STATUS_OPTIONS },
      {
        key: 'staffId',
        kind: 'select',
        label: '归属网格员',
        width: 190,
        options: (filterOptions?.staff ?? []).map((member) => ({
          label: `${staffName(member)}（${member.role === 'grid_worker' ? '网格员' : '运营员'}）`,
          value: member.id,
        })),
      },
      {
        key: 'businessType',
        kind: 'select',
        label: '业务类型',
        width: 160,
        options: BUSINESS_TYPE_OPTIONS,
      },
    ],
    [filterOptions],
  )

  const columns = useMemo<readonly PanelColumn<CrmOrderSummary, CrmSortKey>[]>(
    () => [
      {
        key: 'orderNo',
        title: '受理单号',
        dataIndex: 'orderNo',
        hideable: false,
        render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
      },
      { key: 'community', title: '社区', render: (_value, row) => row.community.name },
      {
        key: 'businessType',
        title: '业务类型',
        dataIndex: 'businessType',
        render: (value: CrmBusinessType) => BUSINESS_TYPE_META[value],
      },
      {
        key: 'customerName',
        title: '客户',
        render: (_value, row) => (
          <Space orientation="vertical" size={0}>
            <Typography.Text>{row.customerName}</Typography.Text>
            <Typography.Text type="secondary">{row.contactPhoneMasked}</Typography.Text>
          </Space>
        ),
      },
      {
        key: 'attributedStaff',
        title: '归属网格员',
        render: (_value, row) => staffName(row.attributedStaff),
      },
      {
        key: 'status',
        title: '状态',
        dataIndex: 'status',
        render: (status: CrmServiceOrderStatus) => (
          <Tag color={ORDER_STATUS_META[status].color}>{ORDER_STATUS_META[status].label}</Tag>
        ),
      },
      {
        key: 'createdAt',
        title: '提交时间',
        dataIndex: 'createdAt',
        render: (value: string) => formatDateTime(value),
      },
      {
        key: 'confirmedBy',
        title: '审核人',
        render: (_value, row) => (row.confirmedBy ? staffName(row.confirmedBy) : '—'),
      },
      {
        key: 'confirmedAt',
        title: '核验时间',
        dataIndex: 'confirmedAt',
        render: (value: string | null) => formatDateTime(value),
      },
    ],
    [],
  )

  function openDetail(orderId: string) {
    setDetailOpen(true)
    setDetail(null)
    setDetailOrderId(orderId)
    setReviewError(null)
    setReviewNote('')
    void loadDetail(orderId)
  }

  async function loadDetail(orderId: string, preserveNote = false) {
    const request = detailRequestRef.current + 1
    detailRequestRef.current = request
    setDetailLoading(true)
    setDetailError(null)
    if (!preserveNote) setReviewError(null)
    try {
      const result = await getAdminCrmOrder(orderId)
      if (detailRequestRef.current !== request) return
      setDetail(result)
    } catch (cause: unknown) {
      if (detailRequestRef.current !== request) return
      setDetailError(describeError(cause, '无法读取业务受理单详情'))
    } finally {
      if (detailRequestRef.current === request) setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    detailRequestRef.current += 1
    setDetailOpen(false)
    setDetailLoading(false)
    setDetailOrderId(null)
    setReviewNote('')
    setReviewError(null)
  }

  function requestReview(decision: CrmOrderReviewDecision) {
    if (!detail) return
    const note = reviewNote.trim()
    if (note.length < 2) {
      setReviewError('核验备注必填（至少 2 个字符）；驳回时必须写明原因。')
      return
    }
    const current = detail
    modal.confirm({
      title: decision === 'confirm' ? '确认有效成交（人工核验）' : '驳回该业务受理单',
      content: (
        <div className="crm-review-confirm">
          <p>
            受理单号：<Typography.Text strong>{current.orderNo}</Typography.Text>
          </p>
          <p>客户：{current.customerName}</p>
          <p>业务类型：{BUSINESS_TYPE_META[current.businessType]}</p>
          <p>
            {decision === 'confirm'
              ? '确认后状态将变为「有效成交（人工核验）」；这是人工核验结论，不代表运营商业务已办理完成。'
              : '驳回后状态将变为「未通过」，核验备注会作为失败原因保留。'}
          </p>
          <p>核验备注：{note}</p>
        </div>
      ),
      okText: '确认提交核验',
      cancelText: '取消',
      okButtonProps: decision === 'reject' ? { danger: true } : undefined,
      onOk: () => performReview(decision, note),
    })
  }

  async function performReview(decision: CrmOrderReviewDecision, note: string) {
    if (!detail) return
    const current = detail
    setReviewing(true)
    setReviewError(null)
    try {
      const updated = await reviewAdminCrmOrder(session.csrfToken, current.id, {
        expectedUpdatedAt: current.updatedAt,
        decision,
        note,
      })
      setDetail(updated)
      setReviewNote('')
      message.success(
        decision === 'confirm'
          ? '已确认为有效成交（人工核验）。'
          : '已驳回该业务受理单。',
      )
      refreshList()
    } catch (cause: unknown) {
      setReviewError(describeError(cause, '业务受理单审核失败'))
      if (isCrmApiError(cause) && cause.status === 409) {
        // Keep the operator's note; reload the server state so the next attempt
        // carries the current expectedUpdatedAt token.
        refreshList()
        void loadDetail(current.id, true)
      }
    } finally {
      setReviewing(false)
    }
  }

  const canReview = detail?.status === 'pending_verification'

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <DataPanel<CrmOrderSummary, OrderFilters, CrmSortKey>
        id="crm-orders"
        label="业务受理单列表"
        rowKey={(row) => row.id}
        query={query}
        onQueryChange={(next) => {
          setQuery(next)
          return true
        }}
        initialFilters={initialFilters}
        data={{ rows, total, loading, error: error ?? undefined }}
        filters={filters}
        columns={columns}
        onRefresh={refreshList}
        errorTitle={listErrorTitle(error, '业务受理单')}
        rowActions={(row) => [
          { key: 'detail', label: '详情', onClick: () => openDetail(row.id) },
          ...(row.status === 'pending_verification'
            ? [{ key: 'review', label: '审核', onClick: () => openDetail(row.id) }]
            : []),
        ]}
        renderCard={(row) => (
          <Space orientation="vertical" size={4} style={{ width: '100%' }}>
            <Space wrap>
              <Typography.Text strong>{row.orderNo}</Typography.Text>
              <Tag color={ORDER_STATUS_META[row.status].color}>
                {ORDER_STATUS_META[row.status].label}
              </Tag>
            </Space>
            <Typography.Text type="secondary">
              {row.community.name} · {BUSINESS_TYPE_META[row.businessType]} · {row.customerName}
            </Typography.Text>
            <Typography.Text type="secondary">
              归属 {staffName(row.attributedStaff)} · 提交 {formatDateTime(row.createdAt)}
            </Typography.Text>
            <Typography.Text type="secondary">
              审核人 {row.confirmedBy ? staffName(row.confirmedBy) : '—'} · 核验{' '}
              {formatDateTime(row.confirmedAt)}
            </Typography.Text>
          </Space>
        )}
      />

      <Drawer
        title={detail ? `业务受理单 · ${detail.orderNo}` : '业务受理单详情'}
        size={680}
        open={detailOpen}
        onClose={closeDetail}
        rootClassName="crm-drawer"
      >
        {detailLoading ? (
          <div className="crm-drawer-loading">
            <Spin description="正在读取业务受理单详情…" />
          </div>
        ) : detailError ? (
          <Alert
            type="error"
            showIcon
            title="业务受理单详情加载失败"
            description={detailError}
            action={
              <Button
                size="small"
                disabled={!detailOrderId}
                onClick={() => {
                  if (detailOrderId) void loadDetail(detailOrderId)
                }}
              >
                重试
              </Button>
            }
          />
        ) : detail ? (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="受理单号">{detail.orderNo}</Descriptions.Item>
              <Descriptions.Item label="社区">{detail.community.name}</Descriptions.Item>
              <Descriptions.Item label="业务类型">
                {BUSINESS_TYPE_META[detail.businessType]}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={ORDER_STATUS_META[detail.status].color}>
                  {ORDER_STATUS_META[detail.status].label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="客户姓名">{detail.customerName}</Descriptions.Item>
              <Descriptions.Item label="联系电话">{detail.contactPhone}</Descriptions.Item>
              <Descriptions.Item label="创建人">
                {staffName(detail.createdByStaff)}
              </Descriptions.Item>
              <Descriptions.Item label="提交时间">
                {formatDateTime(detail.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="更新时间">
                {formatDateTime(detail.updatedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="凭据引用">
                {detail.evidenceRef ?? '未登记'}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.notes ?? '—'}</Descriptions.Item>
              {detail.failureReason ? (
                <Descriptions.Item label="失败原因">{detail.failureReason}</Descriptions.Item>
              ) : null}
            </Descriptions>

            <section className="crm-attribution" aria-label="成交归属快照">
              <Typography.Title level={5}>成交归属快照</Typography.Title>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="归属网格员（创建时冻结）">
                  {staffName(detail.attributedStaff)}
                </Descriptions.Item>
                <Descriptions.Item label="来源活动">
                  {detail.sourceActivity ? detail.sourceActivity.title : '无'}
                </Descriptions.Item>
                <Descriptions.Item label="推广网格员">
                  {detail.promotionStaff ? staffName(detail.promotionStaff) : '无'}
                </Descriptions.Item>
              </Descriptions>
            </section>

            {detail.confirmation ? (
              <section className="crm-confirmation" aria-label="人工核验信息">
                <Typography.Title level={5}>人工核验信息</Typography.Title>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="核验结论">
                    <Tag color="green">{ORDER_STATUS_META.confirmed.label}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="审核人">
                    {detail.confirmation.confirmedBy
                      ? staffName(detail.confirmation.confirmedBy)
                      : '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="核验时间">
                    {formatDateTime(detail.confirmation.confirmedAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="核验备注">
                    {detail.confirmation.note ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="成交来源">
                    {detail.activationSource === 'manual_verification'
                      ? '人工核验（manual_verification）'
                      : '—'}
                  </Descriptions.Item>
                </Descriptions>
              </section>
            ) : null}

            <section className="crm-timeline-section" aria-label="业务受理单事件时间线">
              <Typography.Title level={5}>事件时间线</Typography.Title>
              {detail.events.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无审核事件" />
              ) : (
                <Timeline
                  items={detail.events.map((event) => ({
                    key: event.id,
                    color:
                      event.toStatus === 'confirmed'
                        ? 'green'
                        : event.toStatus === 'failed'
                          ? 'red'
                          : 'blue',
                    content: <OrderEventContent event={event} />,
                  }))}
                />
              )}
            </section>

            {canReview ? (
              <section className="crm-review-box" aria-label="人工核验审核">
                <Typography.Title level={5}>人工核验审核</Typography.Title>
                <Typography.Paragraph type="secondary">
                  只有人工核验通过才会记为「有效成交（人工核验）」；本系统没有运营商业务开通接口，
                  不展示开通或激活状态。核验备注必填（2-500 字），驳回时作为失败原因保留。
                </Typography.Paragraph>
                <Input.TextArea
                  aria-label="核验备注"
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  rows={3}
                  maxLength={500}
                  showCount
                  placeholder="填写人工核验依据，例如：已电话确认并核对受理单截图"
                  disabled={reviewing}
                />
                {reviewError ? (
                  <Alert
                    className="crm-review-error"
                    type="error"
                    showIcon
                    title="审核未完成"
                    description={reviewError}
                  />
                ) : null}
                <Space wrap className="crm-review-actions">
                  <Button
                    type="primary"
                    loading={reviewing}
                    onClick={() => requestReview('confirm')}
                  >
                    确认有效成交
                  </Button>
                  <Button danger loading={reviewing} onClick={() => requestReview('reject')}>
                    驳回
                  </Button>
                  <Button
                    onClick={() => {
                      setReviewNote('')
                      setReviewError(null)
                    }}
                    disabled={reviewing}
                  >
                    清空备注
                  </Button>
                </Space>
              </section>
            ) : (
              <Alert
                type="info"
                showIcon
                title="当前状态不可审核"
                description={
                  detail.status === 'confirmed'
                    ? '该受理单已由运营人工核验为有效成交，不可再次审核。'
                    : detail.status === 'failed'
                      ? '该受理单已驳回或标记失败，不可再次审核。'
                      : detail.status === 'cancelled'
                        ? '该受理单已取消，不可审核。'
                        : '仅「待核验」状态的受理单可由运营确认有效成交或驳回。'
                }
              />
            )}
          </Space>
        ) : null}
      </Drawer>
    </Space>
  )
}

function OrderEventContent({ event }: { event: CrmOrderEvent }) {
  const transition =
    event.fromStatus || event.toStatus
      ? `${event.fromStatus ? ORDER_STATUS_META[event.fromStatus].label : '—'} → ${
          event.toStatus ? ORDER_STATUS_META[event.toStatus].label : '—'
        }`
      : null
  return (
    <div className="crm-timeline-entry">
      <Space wrap>
        <Typography.Text strong>{ORDER_EVENT_LABELS[event.event] ?? event.event}</Typography.Text>
        <Typography.Text type="secondary">{formatDateTime(event.createdAt)}</Typography.Text>
      </Space>
      <div>
        <Typography.Text type="secondary">
          操作者：{event.actor ? staffName(event.actor) : '系统/未知操作者'}
        </Typography.Text>
      </div>
      {transition ? (
        <div>
          <Typography.Text type="secondary">状态：{transition}</Typography.Text>
        </div>
      ) : null}
      {event.note ? (
        <Typography.Paragraph className="crm-timeline-note">{event.note}</Typography.Paragraph>
      ) : null}
    </div>
  )
}
