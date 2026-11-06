import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Input,
  Result,
  Space,
  Spin,
  Tag,
  Timeline,
  Typography,
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LOCAL_ORDER_STATUS_TRANSITIONS,
  type LocalOrderDetail,
  type LocalOrderEvent,
  type LocalOrderStatus,
  type LocalOrderSummary,
  type LocalOrderTransitionStatus,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import {
  DataPanel,
  type PanelColumn,
  type PanelFilter,
  type PanelQuery,
} from '../shared/components/DataPanel'
import { listAdminCommunities } from '../services/activities'
import type { AuthenticatedSession } from '../services/auth'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import {
  getAdminLocalOrder,
  listAdminLocalOrders,
  updateAdminLocalOrderStatus,
  verifyAdminLocalOrder,
} from '../services/localOrders'
import './local-console.css'

/**
 * 订单管理 — resident order registration console (#109).
 *
 * The list, the detail, the handling timeline, the status machine and the manual
 * verification result all come from `/admin/local-orders*`. The copy is
 * deliberate: `verified` means 运营人工核验通过 — a human fact check, never a
 * payment or activation claim. The contract has no such field at all.
 */

const ORDER_STATUS_META: Record<LocalOrderStatus, { label: string; color: string }> = {
  registered: { label: '已登记', color: 'blue' },
  processing: { label: '处理中', color: 'gold' },
  pending_review: { label: '待人工核验', color: 'orange' },
  verified: { label: '人工核验通过', color: 'green' },
  cancelled: { label: '已取消', color: 'default' },
  rejected: { label: '未通过', color: 'red' },
}

const STATUS_OPTIONS = (Object.keys(ORDER_STATUS_META) as LocalOrderStatus[]).map((status) => ({
  label: ORDER_STATUS_META[status].label,
  value: status,
}))

/** Structural shape of `authCommunitySchema`; the contracts package exports schemas only. */
type CommunityRef = { id: string; name: string }

const RECORD_SOURCE_META = {
  resident: '居民自助登记',
  staff_on_behalf: '工作人员代录',
} as const

const EVENT_LABELS: Record<string, string> = {
  'order.registered': '居民登记订单',
  'order.created_on_behalf': '工作人员代录订单',
  'order.status_changed': '处理状态变更',
  'order.verified': '运营人工核验通过',
  'order.rejected': '审核未通过',
}

/**
 * Status changes a staff member may request. `verified` is missing on purpose:
 * only the operations verification box can produce it.
 */
const TRANSITION_ACTIONS: { status: LocalOrderTransitionStatus; label: string; danger?: boolean }[] =
  [
    { status: 'processing', label: '开始处理' },
    { status: 'pending_review', label: '提交核验' },
    { status: 'cancelled', label: '取消订单', danger: true },
    { status: 'rejected', label: '标记未通过', danger: true },
  ]

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

function formatPrice(cents: number): string {
  return `¥${(Math.round(cents) / 100).toFixed(2)}`
}

function personName(person: { displayName: string | null } | null | undefined): string {
  return person?.displayName?.trim() || '未命名人员'
}

function listErrorTitle(error: Error | null): string {
  if (isLocalApiError(error)) {
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return '没有订单管理权限'
  }
  return '订单列表加载失败'
}

interface OrderFilters {
  keyword?: string
  communityId?: string
  status?: LocalOrderStatus
}

type OrderSortKey = never

const initialFilters: OrderFilters = {
  keyword: '',
  communityId: undefined,
  status: undefined,
}

export function OrdersPage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="订单管理"
          description="后台订单查询与人工核验仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有后台订单核验权限"
            subTitle="后台 /admin/local-orders 拒绝网格员；即使直接访问该地址，服务端同样返回 403。请使用移动端工作台处理你授权社区内的订单。"
          />
        </div>
      </div>
    )
  }

  return <OrderConsole session={session} />
}

function OrderConsole({ session }: { session: AuthenticatedSession }) {
  const { message, modal } = AntdApp.useApp()
  const isAdmin = session.staff.role === 'admin'
  const assigned = session.staff.communities

  const [communities, setCommunities] = useState<readonly CommunityRef[]>([])
  const [communitiesError, setCommunitiesError] = useState<string | null>(null)
  const [communitiesToken, setCommunitiesToken] = useState(0)

  const [query, setQuery] = useState<PanelQuery<OrderFilters, OrderSortKey>>(() => ({
    filters: { ...initialFilters, communityId: isAdmin ? undefined : assigned[0]?.id },
    page: 1,
    pageSize: 20,
  }))
  const [rows, setRows] = useState<LocalOrderSummary[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<Error | null>(null)
  const [listToken, setListToken] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<LocalOrderDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [rejectError, setRejectError] = useState<string | null>(null)
  const detailRequestRef = useRef(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setCommunitiesError(null)
    listAdminCommunities(controller.signal)
      .then((items) => {
        if (active) setCommunities(items)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setCommunities([])
        setCommunitiesError(describeLocalError(cause, '无法读取社区列表'))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [communitiesToken])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setListLoading(true)
    setListError(null)
    listAdminLocalOrders(
      {
        page: query.page,
        pageSize: query.pageSize,
        communityId: query.filters.communityId,
        status: query.filters.status,
        keyword: query.filters.keyword?.trim() || undefined,
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
        setListError(cause instanceof Error ? cause : new Error('订单列表加载失败'))
      })
      .finally(() => {
        if (active) setListLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [query, listToken])

  const communityOptions = useMemo(
    () => communities.map((item) => ({ label: item.name, value: item.id })),
    [communities],
  )

  const refreshList = () => setListToken((value) => value + 1)

  const applyQuery = (next: PanelQuery<OrderFilters, OrderSortKey>): boolean => {
    const communityId = next.filters.communityId
    if (communityId && !isAdmin && !assigned.some((item) => item.id === communityId)) {
      message.error('只能查看管理员分配给当前账号的社区。')
      return false
    }
    setQuery(next)
    return true
  }

  const loadDetail = async (orderId: string, keepNote = false) => {
    const requestId = detailRequestRef.current + 1
    detailRequestRef.current = requestId
    setDetailOrderId(orderId)
    setDetailOpen(true)
    setDetailLoading(true)
    setDetailError(null)
    if (!keepNote) {
      setReviewNote('')
      setReviewError(null)
      setRejectOpen(false)
      setRejectNote('')
      setRejectError(null)
    }
    try {
      const result = await getAdminLocalOrder(orderId)
      if (detailRequestRef.current !== requestId) return
      setDetail(result)
    } catch (cause: unknown) {
      if (detailRequestRef.current !== requestId) return
      setDetail(null)
      setDetailError(describeLocalError(cause, '无法读取订单详情'))
    } finally {
      if (detailRequestRef.current === requestId) setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    detailRequestRef.current += 1
    setDetailOpen(false)
    setDetail(null)
    setDetailError(null)
    setReviewError(null)
    setReviewNote('')
    setRejectOpen(false)
    setRejectNote('')
    setRejectError(null)
  }

  const allowedTransitions = detail
    ? LOCAL_ORDER_STATUS_TRANSITIONS[detail.status].filter(
        (status): status is LocalOrderTransitionStatus => status !== 'verified',
      )
    : []

  const performTransition = async (status: LocalOrderTransitionStatus, note?: string) => {
    if (!detail) return
    setTransitioning(true)
    setActionError(null)
    try {
      const updated = await updateAdminLocalOrderStatus(
        session.csrfToken,
        detail.id,
        detail.updatedAt,
        status,
        note,
      )
      setDetail(updated)
      message.success(`订单状态已更新为「${ORDER_STATUS_META[updated.status].label}」。`)
      refreshList()
    } catch (cause: unknown) {
      setActionError(describeLocalError(cause, '订单状态更新失败'))
      if (isLocalApiError(cause) && cause.status === 409) {
        refreshList()
        void loadDetail(detail.id, true)
      }
    } finally {
      setTransitioning(false)
    }
  }

  const requestTransition = (status: LocalOrderTransitionStatus) => {
    if (!detail) return
    if (status === 'rejected') {
      // A rejection needs a written reason, so it gets an inline box in the
      // drawer instead of a confirm dialog: the field and the submit button are
      // the same form, and an empty note is a local validation error rather than
      // a rejected dialog promise (which antd would report as unhandled).
      setRejectOpen(true)
      setRejectNote('')
      setRejectError(null)
      return
    }
    const current = detail
    modal.confirm({
      title: `将订单状态改为「${ORDER_STATUS_META[status].label}」？`,
      content: (
        <div className="local-confirm-body">
          <p>商品：{current.snapshot.productName}</p>
          <p>居民：{personName(current.resident)}</p>
          {status === 'pending_review' ? (
            <p>
              提交后由运营员在后台做人工核验；核验通过只代表订单事实被人工确认，不代表收款或业务办理已完成。
            </p>
          ) : null}
        </div>
      ),
      okText: '确认提交',
      cancelText: '取消',
      okButtonProps: status === 'cancelled' ? { danger: true } : undefined,
      onOk: () => performTransition(status),
    })
  }

  const submitRejection = async () => {
    const note = rejectNote.trim()
    if (note.length === 0) {
      setRejectError('标记未通过必须填写原因。')
      return
    }
    await performTransition('rejected', note)
  }

  const performReview = async (decision: 'verify' | 'reject') => {
    if (!detail) return
    const note = reviewNote.trim()
    if (note.length < 2) {
      setReviewError('核验备注必填（至少 2 个字符）；驳回时必须写明原因。')
      return
    }
    const current = detail
    setReviewing(true)
    setReviewError(null)
    try {
      const updated = await verifyAdminLocalOrder(session.csrfToken, current.id, {
        expectedUpdatedAt: current.updatedAt,
        decision,
        note,
      })
      setDetail(updated)
      setReviewNote('')
      message.success(
        decision === 'verify'
          ? '已完成运营人工核验：订单状态为「人工核验通过」。这不代表收款或业务办理已完成。'
          : '已驳回该订单。',
      )
      refreshList()
    } catch (cause: unknown) {
      setReviewError(describeLocalError(cause, '人工核验失败'))
      if (isLocalApiError(cause) && cause.status === 409) {
        refreshList()
        void loadDetail(current.id, true)
      }
    } finally {
      setReviewing(false)
    }
  }

  const columns: readonly PanelColumn<LocalOrderSummary, OrderSortKey>[] = [
    {
      key: 'productName',
      title: '商品',
      hideable: false,
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong>{row.snapshot.productName}</Typography.Text>
          <Typography.Text type="secondary">登记编号 {row.id.slice(0, 8)}</Typography.Text>
        </Space>
      ),
    },
    {
      key: 'community',
      title: '社区',
      render: (_value, row) => row.community.name,
    },
    {
      key: 'resident',
      title: '居民',
      render: (_value, row) => personName(row.resident),
    },
    {
      key: 'snapshot',
      title: '登记快照',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>
            {row.snapshot.quantity} 件 × {formatPrice(row.snapshot.unitPriceCents)}
          </span>
          <Typography.Text type="secondary">
            合计 {formatPrice(row.snapshot.totalCents)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'status',
      title: '状态',
      render: (_value, row) => (
        <Tag color={ORDER_STATUS_META[row.status].color}>
          {ORDER_STATUS_META[row.status].label}
        </Tag>
      ),
    },
    {
      key: 'source',
      title: '登记来源',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>{RECORD_SOURCE_META[row.recordSource]}</span>
          {row.createdByStaff ? (
            <Typography.Text type="secondary">{personName(row.createdByStaff)}</Typography.Text>
          ) : null}
          {row.attributedStaff ? (
            <Typography.Text type="secondary">
              归属 {personName(row.attributedStaff)}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      key: 'createdAt',
      title: '登记时间',
      render: (_value, row) => formatDateTime(row.createdAt),
    },
  ]

  const filters: readonly PanelFilter<OrderFilters>[] = [
    { key: 'keyword', label: '关键词', kind: 'text', placeholder: '商品名称或备注' },
    { key: 'communityId', label: '社区', kind: 'select', options: communityOptions },
    { key: 'status', label: '状态', kind: 'status', options: STATUS_OPTIONS },
  ]

  const canReview = detail?.status === 'pending_review'

  return (
    <div className="page">
      <PageHeader
        title="订单管理"
        description="查询居民登记的本地商品订单、处理状态并做运营人工核验。价格与商品名称以登记时冻结的快照为准；「人工核验通过」只是运营员对订单事实的人工确认，不代表收款或业务办理已完成。"
        status={<Tag color="green">真实数据</Tag>}
      />

      <div className="page-stack">
        {!isAdmin ? (
          <Alert
            type="info"
            showIcon
            title="运营员视图"
            description={
              assigned.length > 0
                ? `仅能查看与处理管理员分配的社区（${assigned
                    .map((item) => item.name)
                    .join('、')}）订单；服务端同样会校验社区范围。`
                : '当前账号尚未被分配社区，暂时无法查看订单，请联系管理员。'
            }
          />
        ) : null}

        {communitiesError ? (
          <Alert
            type="warning"
            showIcon
            title="社区列表加载失败"
            description={communitiesError}
            action={
              <Button size="small" onClick={() => setCommunitiesToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null}

        {actionError ? (
          <Alert
            type="error"
            showIcon
            closable
            title="操作未成功"
            description={actionError}
            onClose={() => setActionError(null)}
          />
        ) : null}

        <DataPanel<LocalOrderSummary, OrderFilters, OrderSortKey>
          id="local-orders"
          label="本地订单列表"
          rowKey={(row) => row.id}
          query={query}
          onQueryChange={applyQuery}
          initialFilters={initialFilters}
          data={{ rows, total, loading: listLoading, error: listError ?? undefined }}
          filters={filters}
          columns={columns}
          onRefresh={refreshList}
          errorTitle={listErrorTitle(listError)}
          emptyText={
            <div className="local-empty">
              <p>当前筛选条件下没有居民登记订单。</p>
              <p className="local-empty-hint">
                居民在 H5「惠生活」提交办理意向后，订单会出现在这里。
              </p>
            </div>
          }
          rowActions={(row) => [
            { key: 'detail', label: '详情', onClick: () => void loadDetail(row.id) },
            ...(row.status === 'pending_review'
              ? [{ key: 'review', label: '人工核验', onClick: () => void loadDetail(row.id) }]
              : []),
          ]}
          renderCard={(row) => (
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text strong>{row.snapshot.productName}</Typography.Text>
                <Tag color={ORDER_STATUS_META[row.status].color}>
                  {ORDER_STATUS_META[row.status].label}
                </Tag>
              </Space>
              <Typography.Text type="secondary">
                {row.community.name} · {personName(row.resident)}
              </Typography.Text>
              <Typography.Text type="secondary">
                {row.snapshot.quantity} 件 × {formatPrice(row.snapshot.unitPriceCents)} ={' '}
                {formatPrice(row.snapshot.totalCents)}
              </Typography.Text>
              <Typography.Text type="secondary">
                {RECORD_SOURCE_META[row.recordSource]} · {formatDateTime(row.createdAt)}
              </Typography.Text>
            </Space>
          )}
        />
      </div>

      <Drawer
        title={detail ? `订单详情 · ${detail.snapshot.productName}` : '订单详情'}
        size={600}
        open={detailOpen}
        onClose={closeDetail}
        rootClassName="local-drawer"
        destroyOnHidden
      >
        {detailLoading ? (
          <div className="local-drawer-loading">
            <Spin />
          </div>
        ) : detailError ? (
          <Alert
            type="error"
            showIcon
            title="订单详情加载失败"
            description={detailError}
            action={
              detailOrderId ? (
                <Button size="small" onClick={() => void loadDetail(detailOrderId)}>
                  重试
                </Button>
              ) : null
            }
          />
        ) : detail ? (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <section className="local-section" aria-label="订单基本信息">
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="状态">
                  <Tag color={ORDER_STATUS_META[detail.status].color}>
                    {ORDER_STATUS_META[detail.status].label}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="商品快照">
                  <div className="local-snapshot">
                    <span className="local-snapshot-item">
                      <span className="local-snapshot-item-label">名称</span>
                      <span className="local-snapshot-item-value">
                        {detail.snapshot.productName}
                      </span>
                    </span>
                    <span className="local-snapshot-item">
                      <span className="local-snapshot-item-label">单价</span>
                      <span className="local-snapshot-item-value">
                        {formatPrice(detail.snapshot.unitPriceCents)}
                      </span>
                    </span>
                    <span className="local-snapshot-item">
                      <span className="local-snapshot-item-label">数量</span>
                      <span className="local-snapshot-item-value">{detail.snapshot.quantity}</span>
                    </span>
                    <span className="local-snapshot-item">
                      <span className="local-snapshot-item-label">合计</span>
                      <span className="local-snapshot-item-value">
                        {formatPrice(detail.snapshot.totalCents)}
                      </span>
                    </span>
                  </div>
                </Descriptions.Item>
                <Descriptions.Item label="社区">{detail.community.name}</Descriptions.Item>
                <Descriptions.Item label="居民">{personName(detail.resident)}</Descriptions.Item>
                <Descriptions.Item label="登记来源">
                  {RECORD_SOURCE_META[detail.recordSource]}
                </Descriptions.Item>
                <Descriptions.Item label="代录工作人员">
                  {detail.createdByStaff ? personName(detail.createdByStaff) : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="归属网格员">
                  {detail.attributedStaff ? personName(detail.attributedStaff) : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="来源活动">
                  {detail.sourceActivity ? detail.sourceActivity.title : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="居民备注">{detail.note ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="最近处理备注">
                  {detail.statusNote ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label="登记时间">
                  {formatDateTime(detail.createdAt)}
                </Descriptions.Item>
                <Descriptions.Item label="最后更新">
                  {formatDateTime(detail.updatedAt)}
                </Descriptions.Item>
              </Descriptions>

              <Alert
                style={{ marginTop: 12 }}
                type="info"
                showIcon
                title="本订单只登记办理意向"
                description="本平台不收款、不代办业务；「人工核验通过」是运营员对订单事实的人工确认。"
              />
            </section>

            {allowedTransitions.length > 0 ? (
              <section className="local-section" aria-label="订单状态处理">
                <Typography.Title level={5}>处理状态</Typography.Title>
                <Space wrap>
                  {TRANSITION_ACTIONS.filter((action) =>
                    allowedTransitions.includes(action.status),
                  ).map((action) => (
                    <Button
                      key={action.status}
                      danger={action.danger}
                      disabled={transitioning || reviewing}
                      onClick={() => requestTransition(action.status)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </Space>

                {rejectOpen ? (
                  <div className="local-reject-box">
                    <Input.TextArea
                      rows={3}
                      maxLength={500}
                      showCount
                      aria-label="未通过原因"
                      value={rejectNote}
                      placeholder="请填写未通过原因（必填，会保留在订单时间线中）"
                      onChange={(event) => {
                        setRejectNote(event.target.value)
                        setRejectError(null)
                      }}
                    />
                    {rejectError ? (
                      <Alert type="error" showIcon title="未提交" description={rejectError} />
                    ) : null}
                    <div className="local-review-actions">
                      <Button
                        danger
                        type="primary"
                        loading={transitioning}
                        onClick={() => void submitRejection()}
                      >
                        确认标记未通过
                      </Button>
                      <Button onClick={() => setRejectOpen(false)}>取消</Button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            {detail.verification ? (
              <section className="local-section" aria-label="人工核验结果">
                <Typography.Title level={5}>人工核验结果</Typography.Title>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="核验人">
                    {detail.verification.verifiedBy
                      ? personName(detail.verification.verifiedBy)
                      : '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="核验时间">
                    {formatDateTime(detail.verification.verifiedAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="核验备注">
                    {detail.verification.note}
                  </Descriptions.Item>
                </Descriptions>
                <Typography.Text type="secondary">
                  该结论仅为人工事实核验，不代表收款、成交或业务办理已完成。
                </Typography.Text>
              </section>
            ) : null}

            {canReview ? (
              <section className="local-section local-review-box" aria-label="运营人工核验">
                <Typography.Title level={5}>运营人工核验</Typography.Title>
                <Typography.Text type="secondary">
                  核验通过后订单进入「人工核验通过」；驳回会保留备注原因。两者都会写入订单时间线。
                </Typography.Text>
                <Input.TextArea
                  rows={3}
                  maxLength={500}
                  showCount
                  aria-label="核验备注"
                  value={reviewNote}
                  placeholder="请填写核验备注（必填，至少 2 个字符）"
                  onChange={(event) => {
                    setReviewNote(event.target.value)
                    setReviewError(null)
                  }}
                />
                {reviewError ? (
                  <Alert type="error" showIcon title="核验未提交" description={reviewError} />
                ) : null}
                <div className="local-review-actions">
                  <Button
                    type="primary"
                    loading={reviewing}
                    disabled={transitioning}
                    onClick={() => void performReview('verify')}
                  >
                    确认人工核验通过
                  </Button>
                  <Button
                    danger
                    loading={reviewing}
                    disabled={transitioning}
                    onClick={() => void performReview('reject')}
                  >
                    驳回
                  </Button>
                </div>
              </section>
            ) : null}

            <section className="local-section" aria-label="订单时间线">
              <Typography.Title level={5}>订单时间线</Typography.Title>
              {detail.events.length === 0 ? (
                <Typography.Text type="secondary">暂无事件记录。</Typography.Text>
              ) : (
                <Timeline
                  items={detail.events.map((event: LocalOrderEvent) => ({
                    key: event.id,
                    color: event.event === 'order.verified' ? 'green' : 'blue',
                    content: (
                      <div className="local-timeline-entry">
                        <Space wrap size={6}>
                          <Typography.Text strong>
                            {EVENT_LABELS[event.event] ?? event.event}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {formatDateTime(event.createdAt)}
                          </Typography.Text>
                        </Space>
                        {event.fromStatus || event.toStatus ? (
                          <Typography.Text type="secondary">
                            {event.fromStatus ? ORDER_STATUS_META[event.fromStatus].label : '—'} →{' '}
                            {event.toStatus ? ORDER_STATUS_META[event.toStatus].label : '—'}
                          </Typography.Text>
                        ) : null}
                        <Typography.Text type="secondary">
                          操作者：
                          {event.actorStaff
                            ? personName(event.actorStaff)
                            : event.actor
                              ? personName(event.actor)
                              : '系统'}
                        </Typography.Text>
                        {event.note ? <p className="local-timeline-note">{event.note}</p> : null}
                      </div>
                    ),
                  }))}
                />
              )}
            </section>
          </Space>
        ) : null}
      </Drawer>
    </div>
  )
}
