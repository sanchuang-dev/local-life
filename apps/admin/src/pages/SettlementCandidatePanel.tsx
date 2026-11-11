import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useState } from 'react'
import type {
  SettlementCandidate,
  SettlementCandidateListResponse,
  SettlementCandidateReason,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { isLocalApiError } from '../services/localApi'
import {
  LEDGER_ATTRIBUTION_BASIS_LABELS,
  LEDGER_ATTRIBUTION_STATE_LABELS,
  LEDGER_EVIDENCE_KIND_LABELS,
  LEDGER_RECONCILIATION_STATE_LABELS,
  formatCents,
  formatDateTime,
  listSettlementCandidates,
} from '../services/ledger'
import './ledger.css'

/**
 * 分成结算单 · 只读候选看板（LL-SET-008 / Issue #188, contract #184).
 *
 * What this panel deliberately does **not** do:
 *
 * - It does not compute a payable / share / fee / difference. There is no
 *   approved settlement rule in this MVP, so `settlementAmountStatus` is always
 *   `pending_rule` and `payableAmountCents` is always `null`; the panel renders
 *   待核定 instead of inventing a number.
 * - It does not add `registeredAmountCents` to `receipt.amountCents` or present
 *   one as the other. 登记金额 and 凭据实收 are separated in the list and the
 *   drawer, exactly as the server returns them.
 * - It does not treat the page summary as a period total: `summaryScope` is
 *   `'page'`, so every KPI is labelled 「仅当前页」.
 * - It does not infer a merchant, a grid-worker name or a legal entity name. The
 *   DTO returns ids only, so the list shows a state and the drawer shows the
 *   copyable UUID plus an explicit "服务端未返回姓名".
 * - It has no edit / lock / payment / CSV entry point: those belong to later
 *   slices (#189–#192), and a disabled fake button would be worse than none.
 *
 * Error handling keeps the server's real status: 401 asks the operator to log in
 * again, 403 states the role is not allowed (and renders no table at all), and
 * any other failure is an Alert with a genuine retry.
 */

/* -------------------------------------------------------------------------- */
/* Readable copy for contracted enum values                                   */
/* -------------------------------------------------------------------------- */

const SELLER_STATUS_META = {
  missing_seller: { label: '未指定实际销售商户', color: 'red' },
  incomplete_parties: { label: '主体待补齐', color: 'orange' },
  verified: { label: '已确认主体', color: 'green' },
} as const

const ORDER_STATUS_LABELS: Record<string, string> = {
  registered: '已登记',
  processing: '办理中',
  pending_review: '待核验',
  verified: '已人工核验（不代表收款）',
  cancelled: '已取消',
  rejected: '已拒绝',
}

const PERIOD_SOURCE_LABELS = {
  linked_receipt: '按关联收款凭据的到账时间归期',
  order_registration: '按订单登记时间归期',
} as const

/**
 * Each blocking reason is already returned as a server-written message; this map
 * only adds the readable label and the concrete next step. It never derives a
 * financial result from the reason.
 */
const REASON_META: Record<SettlementCandidateReason, { label: string; nextStep: string }> = {
  order_not_verified: {
    label: '订单业务未核验',
    nextStep: '由运营人员核验订单业务事实；核验不等于收款，也不等于可结算。',
  },
  missing_receipt: {
    label: '缺少收款凭据',
    nextStep: '登记真实、可追溯的人工收款凭据，并与订单建立明确关联。',
  },
  receipt_reversed: {
    label: '原收款已冲正',
    nextStep: '核对冲正记录；全额冲正的收据不得产生应分金额。',
  },
  amount_mismatch: {
    label: '登记金额与实收不符',
    nextStep: '人工核对收据与订单登记金额；部分退款或合并收款当前不支持自动拆分。',
  },
  attribution_pending: {
    label: '网格员归属待确认',
    nextStep: '确认实际推广贡献的网格员，并补充归属确认依据。',
  },
  receipt_unreconciled: {
    label: '实收未进入锁定对账',
    nextStep: '将实收所在流水纳入经营对账，并锁定对应业务期间。',
  },
  receipt_late_recorded: {
    label: '收款凭据为锁后补录',
    nextStep: '按锁后补录流程核对；已锁定的账目不能被回写。',
  },
  order_fact_unreconciled: {
    label: '订单核验事实未锁定',
    nextStep: '将订单核验事实纳入已锁定的经营对账批次。',
  },
  unresolved_anomaly: {
    label: '关联流水存在未解决异常',
    nextStep: '先处理关联流水的未解决异常，再重新核对候选。',
  },
  missing_seller: {
    label: '未指定实际销售商户',
    nextStep: '登记实际销售商户主体并确认订单主体快照。',
  },
  counterparty_incomplete: {
    label: '三创或广电主体待补齐',
    nextStep: '补齐三创与广电法律主体及协议依据。',
  },
  missing_approved_rule: {
    label: '缺少已核准分成规则',
    nextStep: '登记并核准分成合同规则；在规则核准前，系统不推算应分金额。',
  },
}

function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

export function SettlementCandidatePanel() {
  const { session } = useAdminAuth()
  // The session's assignments are the only community options. The page never
  // invents a community name and never widens the server's authorization: the
  // server scopes every response to these same assignments.
  const authorizedCommunities = session.staff.communities

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [communityId, setCommunityId] = useState<string | undefined>(undefined)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [keywordDraft, setKeywordDraft] = useState('')
  const [fromDraft, setFromDraft] = useState('')
  const [toDraft, setToDraft] = useState('')
  const [filterError, setFilterError] = useState<string | null>(null)

  const [response, setResponse] = useState<SettlementCandidateListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [detail, setDetail] = useState<SettlementCandidate | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    // A new query must not keep showing the previous page's rows/KPIs: the
    // summary is page-scoped, so stale rows would silently re-label it.
    setResponse(null)
    setDetail(null)
    listSettlementCandidates(
      {
        page,
        pageSize,
        communityId,
        keyword: keyword || undefined,
        from: from || undefined,
        to: to || undefined,
      },
      controller.signal,
    )
      .then((result) => {
        if (active) setResponse(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setResponse(null)
        setError(cause instanceof Error ? cause : new Error('分成结算候选加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [page, pageSize, keyword, communityId, from, to, reloadToken])

  const applyFilters = () => {
    const nextFrom = fromDraft.trim()
    const nextTo = toDraft.trim()
    if (nextFrom && nextTo && nextFrom > nextTo) {
      setFilterError('开始日期不能晚于结束日期。')
      return
    }
    setFilterError(null)
    setKeyword(keywordDraft.trim())
    setFrom(nextFrom)
    setTo(nextTo)
    // Any filter change starts again at page 1: asking for page 4 of a narrower
    // result set would show an empty page the operator cannot explain.
    setPage(1)
    setReloadToken((value) => value + 1)
  }

  const resetFilters = () => {
    setKeywordDraft('')
    setFromDraft('')
    setToDraft('')
    setFilterError(null)
    setKeyword('')
    setCommunityId(undefined)
    setFrom('')
    setTo('')
    setPage(1)
    setReloadToken((value) => value + 1)
  }

  /**
   * Community is the one narrowing that applies immediately: it comes from the
   * authenticated session, is bounded by the server's authorization, and an
   * operator expects a single-select change to re-read the page.
   */
  const changeCommunity = (value: string | undefined) => {
    setCommunityId(value)
    setPage(1)
    setReloadToken((current) => current + 1)
  }

  const refresh = () => setReloadToken((value) => value + 1)

  const unauthorized = isLocalApiError(error) && error.status === 401
  const forbidden = isLocalApiError(error) && error.status === 403
  const filtersActive =
    keyword !== '' || communityId !== undefined || from !== '' || to !== ''

  const columns: ColumnsType<SettlementCandidate> = [
    {
      title: '订单号 / 商品',
      key: 'order',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong className="ledger-cell-mono">
            {row.orderDisplayNo}
          </Typography.Text>
          <Typography.Text type="secondary">{row.productName}</Typography.Text>
          <Typography.Text type="secondary">
            订单状态：{orderStatusLabel(row.orderStatus)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '主体状态',
      key: 'seller',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Tag color={SELLER_STATUS_META[row.sellerStatus].color}>
            {SELLER_STATUS_META[row.sellerStatus].label}
          </Tag>
          <Typography.Text type="secondary">
            {row.orderParty ? '主体快照见详情' : '无主体快照'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '登记金额（非实收）',
      key: 'registered',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>{formatCents(row.registeredAmountCents)}</span>
          <Typography.Text type="secondary">订单登记金额，不是收款凭据</Typography.Text>
        </Space>
      ),
    },
    {
      title: '实收（凭据）',
      key: 'receipt',
      render: (_value, row) =>
        row.receipt ? (
          <Space orientation="vertical" size={2}>
            <span>{formatCents(row.receipt.amountCents)}</span>
            <Typography.Text type="secondary">
              {LEDGER_EVIDENCE_KIND_LABELS[row.receipt.evidenceKind]}
            </Typography.Text>
            {row.receipt.reversedEntryId ? (
              <Tag color="red">原收款已冲正</Tag>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">无收款凭据</Typography.Text>
        ),
    },
    {
      title: '网格员归属',
      key: 'attribution',
      render: (_value, row) => {
        if (!row.receipt) {
          return <Typography.Text type="secondary">无凭据可归属</Typography.Text>
        }
        const state = row.receipt.attribution.state
        return (
          <Tag color={state === 'attributed' ? 'green' : 'gold'}>
            {LEDGER_ATTRIBUTION_STATE_LABELS[state]}
          </Tag>
        )
      },
    },
    {
      title: '规则状态',
      key: 'rule',
      render: () => (
        <Space orientation="vertical" size={2}>
          <Tag color="orange">待核定</Tag>
          <Typography.Text type="secondary">尚无已核准分成规则</Typography.Text>
        </Space>
      ),
    },
    {
      title: '阻塞原因',
      key: 'blocking',
      render: (_value, row) =>
        row.blockingMessages.length === 0 ? (
          <Typography.Text type="secondary">服务端未返回阻塞原因</Typography.Text>
        ) : (
          <Space orientation="vertical" size={2}>
            <Typography.Text>{row.blockingMessages[0]}</Typography.Text>
            {row.blockingMessages.length > 1 ? (
              <Typography.Text type="secondary">
                另有 {row.blockingMessages.length - 1} 条，完整原因见详情
              </Typography.Text>
            ) : null}
          </Space>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_value, row) => (
        <Button type="link" size="small" onClick={() => setDetail(row)}>
          查看详情
        </Button>
      ),
    },
  ]

  const emptyText =
    page > 1 && response !== null && response.total > 0 ? (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本页没有候选，页码可能已过期">
        <Button size="small" onClick={() => setPage(1)}>
          回到第 1 页
        </Button>
      </Empty>
    ) : filtersActive ? (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选条件下没有结算候选">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          已应用的筛选不会放宽服务端授权范围；可以清除筛选后查看全部候选。
        </Typography.Paragraph>
        <Button size="small" onClick={resetFilters}>
          清除筛选
        </Button>
      </Empty>
    ) : (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选期间没有结算候选">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          候选只来自已登记订单与人工收款凭据；没有订单或凭据时，也没有可核对的结算候选。
        </Typography.Paragraph>
      </Empty>
    )

  return (
    <section aria-label="分成结算候选看板">
      <Alert
        type="info"
        showIcon
        title="只读候选 · 不产生应付金额"
        description="本看板只展示服务端返回的订单、凭据与阻塞原因。有凭据实收毛额、冲正与不可结算单数都只统计当前返回页，不代表整个期间。应分金额固定为「待核定」：尚无已核准合同规则，系统不推算分成比例、手续费或应付款。列表与页内汇总始终受服务端授权社区范围约束；前端筛选不能扩大权限。"
      />

      {unauthorized ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="登录状态已失效"
          description="服务端返回 401：请重新登录管理后台后再查看分成结算候选。刷新页面会重新校验会话并显示登录页。当前页面没有加载任何候选数据，也不会用空表冒充无数据。"
          action={
            <Button size="small" onClick={() => window.location.reload()}>
              刷新并重新登录
            </Button>
          }
        />
      ) : forbidden ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          title="没有分成结算候选权限"
          description={`当前账号无权查看机构分成结算候选。${error?.message ?? ''} 请使用管理员或运营员账号；网格员只能在自己的工作台查看授权社区的经营流水。`}
        />
      ) : (
        <>
          {response ? <CandidateKpis response={response} /> : null}

          <Card
            size="small"
            style={{ marginTop: 12 }}
            title="结算候选（只读）"
            extra={
              <Space wrap size={8}>
                {response ? (
                  <Typography.Text type="secondary">
                    数据截至 {formatDateTime(response.asOf)}（Asia/Shanghai）
                  </Typography.Text>
                ) : null}
                <Button size="small" onClick={refresh} loading={loading}>
                  刷新
                </Button>
              </Space>
            }
          >
            <Space wrap size={12} align="end" style={{ marginBottom: 12 }}>
              <div className="ledger-filter-field">
                <label htmlFor="settlement-candidate-keyword">订单号或商品关键字</label>
                <Input
                  id="settlement-candidate-keyword"
                  allowClear
                  maxLength={80}
                  style={{ width: 220 }}
                  placeholder="订单号或商品名称（最多 80 字）"
                  value={keywordDraft}
                  onChange={(event) => setKeywordDraft(event.target.value)}
                />
                <span className="ledger-filter-hint">服务端最多接受 80 个字符</span>
              </div>
              {authorizedCommunities.length > 0 ? (
                <div className="ledger-filter-field">
                  <label htmlFor="settlement-candidate-community">授权社区</label>
                  <Select<string>
                    id="settlement-candidate-community"
                    allowClear
                    placeholder="全部授权社区"
                    style={{ minWidth: 180 }}
                    value={communityId}
                    onChange={(value) => changeCommunity(value)}
                    options={authorizedCommunities.map((community) => ({
                      value: community.id,
                      label: community.name,
                    }))}
                  />
                </div>
              ) : null}
              <div className="ledger-filter-field">
                <label htmlFor="settlement-candidate-from">业务日期从（含）</label>
                <Input
                  id="settlement-candidate-from"
                  type="date"
                  placeholder="YYYY-MM-DD"
                  value={fromDraft}
                  onChange={(event) => setFromDraft(event.target.value)}
                />
              </div>
              <div className="ledger-filter-field">
                <label htmlFor="settlement-candidate-to">业务日期至（含）</label>
                <Input
                  id="settlement-candidate-to"
                  type="date"
                  placeholder="YYYY-MM-DD"
                  value={toDraft}
                  onChange={(event) => setToDraft(event.target.value)}
                />
              </div>
              <Button type="primary" onClick={applyFilters}>
                应用筛选
              </Button>
              <Button onClick={resetFilters}>重置</Button>
            </Space>

            {filterError ? (
              <Alert
                style={{ marginBottom: 12 }}
                type="error"
                showIcon
                title="筛选条件不正确"
                description={filterError}
              />
            ) : null}

            {error ? (
              <Alert
                type="error"
                showIcon
                title="结算候选加载失败"
                description={error.message}
                action={
                  <Button size="small" onClick={refresh}>
                    重试
                  </Button>
                }
              />
            ) : response === null ? (
              <div className="ledger-candidate-loading" aria-live="polite">
                <Spin />
                <Typography.Text type="secondary">正在读取结算候选…</Typography.Text>
              </div>
            ) : (
              <Table<SettlementCandidate>
                rowKey={(row) => row.orderId}
                columns={columns}
                dataSource={response.items}
                loading={loading}
                size="small"
                scroll={{ x: 'max-content' }}
                pagination={{
                  current: page,
                  pageSize,
                  total: response.total,
                  showSizeChanger: true,
                  pageSizeOptions: [10, 20, 50, 100],
                  showTotal: (total) => `共 ${total} 单（服务端分页）`,
                }}
                onChange={(pagination) => {
                  const nextPage = pagination.current ?? 1
                  const nextSize = pagination.pageSize ?? pageSize
                  if (nextSize !== pageSize) {
                    // A page-size change starts again at page 1, like every other
                    // server-paged list in the console.
                    setPageSize(nextSize)
                    setPage(1)
                    return
                  }
                  setPage(nextPage)
                }}
                locale={{ emptyText }}
              />
            )}
          </Card>
        </>
      )}

      <Drawer
        title={detail ? `结算候选 · ${detail.orderDisplayNo}` : '结算候选'}
        size={720}
        open={detail !== null}
        onClose={() => setDetail(null)}
        rootClassName="local-drawer"
        destroyOnHidden
      >
        {detail ? <CandidateDetail row={detail} /> : null}
      </Drawer>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* KPI block — every number is the server's page-scoped summary                */
/* -------------------------------------------------------------------------- */

function CandidateKpis({ response }: { response: SettlementCandidateListResponse }) {
  const { summary } = response
  return (
    <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
      <Col xs={24} sm={12} xl={6}>
        <Card size="small" className="ledger-kpi" data-testid="candidate-kpi-receipt">
          <Typography.Text type="secondary">有凭据实收毛额（仅当前页）</Typography.Text>
          <div className="ledger-candidate-kpi-value">
            {summary.recordedReceiptGrossCents > 0
              ? formatCents(summary.recordedReceiptGrossCents)
              : '当前页无凭据实收'}
          </div>
          <div className="ledger-kpi-secondary">
            收款冲正（单独列出，不净额、不相加）：
            {summary.reversedReceiptCents > 0
              ? formatCents(summary.reversedReceiptCents)
              : '当前页无冲正'}
          </div>
          <span className="ledger-kpi-note">
            含已全额冲正的原始收款；冲正单独列出，不在此处抵扣。只统计当前返回页{' '}
            {summary.visibleItems} 单候选，不代表整个期间；实收只来自人工收款凭据。
          </span>
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card size="small" className="ledger-kpi" data-testid="candidate-kpi-blocked">
          <Typography.Text type="secondary">不可结算单数（仅当前页）</Typography.Text>
          <div className="ledger-candidate-kpi-value">{summary.blockedItems} 单</div>
          <span className="ledger-kpi-note">
            {/* No rule is approved, so the server marks every candidate on this
                page as blocked. The number is not a "some settle / some do not"
                ratio and is never rewritten by comparing it to visibleItems. */}
            当前没有已核准规则，服务端会把本页每个候选都标为不可结算；该数字通常等于本页候选数，
            不代表部分可结、部分不可结。
          </span>
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card size="small" className="ledger-kpi" data-testid="candidate-kpi-payable">
          <Typography.Text type="secondary">应分金额</Typography.Text>
          <div className="ledger-candidate-kpi-value" data-tone="pending">
            <Tag color="orange">待核定</Tag>
          </div>
          <span className="ledger-kpi-note">
            尚无已核准的合同规则，系统不推算分成金额；没有规则时不会显示任何应付数字。
          </span>
        </Card>
      </Col>
      <Col xs={24} sm={12} xl={6}>
        <Card size="small" className="ledger-kpi" data-testid="candidate-kpi-payment">
          <Typography.Text type="secondary">已登记付款</Typography.Text>
          <div className="ledger-candidate-kpi-value" data-tone="muted">
            尚无登记或确认记录
          </div>
          <span className="ledger-kpi-note">
            本看板未接入付款登记；未来即使有登记，也只有服务端核验通过的付款确认才算核销；
            当前不能认为款项已经付出。
          </span>
        </Card>
      </Col>
    </Row>
  )
}

/* -------------------------------------------------------------------------- */
/* Drawer: evidence, parties and blocking reasons for one candidate           */
/* -------------------------------------------------------------------------- */

function CandidateDetail({ row }: { row: SettlementCandidate }) {
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <section className="local-section" aria-label="候选订单">
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="订单号">
            <Space wrap size={8}>
              <Typography.Text className="ledger-cell-mono">
                {row.orderDisplayNo}
              </Typography.Text>
              <Typography.Text type="secondary">订单内部 ID（服务端返回）</Typography.Text>
              <Typography.Text className="ledger-cell-mono" copyable={{ text: row.orderId }}>
                {row.orderId}
              </Typography.Text>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="商品">{row.productName}</Descriptions.Item>
          <Descriptions.Item label="订单状态">
            {orderStatusLabel(row.orderStatus)}
          </Descriptions.Item>
          <Descriptions.Item label="归期时点">
            {formatDateTime(row.periodAt)} · {PERIOD_SOURCE_LABELS[row.periodSource]}
          </Descriptions.Item>
          <Descriptions.Item label="社区 ID">
            <Typography.Text className="ledger-cell-mono" copyable={{ text: row.communityId }}>
              {row.communityId}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      </section>

      <section className="local-section" aria-label="登记金额与凭据实收">
        <Typography.Text strong>登记金额 vs 凭据实收</Typography.Text>
        <div className="ledger-diff-grid">
          <div className="ledger-diff-block" data-tone="todo">
            <div className="ledger-diff-block-title">
              <Typography.Text strong>登记金额（非实收）</Typography.Text>
            </div>
            <span className="ledger-diff-number-label">订单登记金额</span>
            <span className="ledger-diff-number-value">
              {formatCents(row.registeredAmountCents)}
            </span>
            <p className="ledger-diff-hint">
              下单时登记的账面金额；不是收款凭据，也不代表业务已办理或款项已经收到。
            </p>
          </div>
          <div className="ledger-diff-block" data-tone="fact">
            <div className="ledger-diff-block-title">
              <Typography.Text strong>凭据实收</Typography.Text>
              {row.receipt?.reversedEntryId ? <Tag color="red">原收款已冲正</Tag> : null}
            </div>
            {row.receipt ? (
              <>
                <span className="ledger-diff-number-label">人工收款凭据金额</span>
                <span className="ledger-diff-number-value">
                  {formatCents(row.receipt.amountCents)}
                </span>
                <p className="ledger-diff-hint">
                  线下人工登记、有可核对凭据的实收；不是银行接口回执，也没有经过在线支付。
                </p>
              </>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="无收款凭据"
                style={{ margin: '8px 0 0' }}
              />
            )}
          </div>
        </div>
        <p className="ledger-diff-hint">
          两栏并列展示服务端返回值：本页不做差额计算，也不把登记金额当实收，更不用冲正静默抵扣实收。
        </p>
      </section>

      {row.receipt ? (
        <>
          <section className="local-section" aria-label="收款凭据">
            <Typography.Text strong>收款凭据</Typography.Text>
            <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
              <Descriptions.Item label="凭据类型">
                {LEDGER_EVIDENCE_KIND_LABELS[row.receipt.evidenceKind]}
              </Descriptions.Item>
              <Descriptions.Item label="凭据编号">
                <Typography.Text className="ledger-cell-mono" copyable={{ text: row.receipt.evidenceRef }}>
                  {row.receipt.evidenceRef}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="到账时间">
                {formatDateTime(row.receipt.receivedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="经办人员（staffId）">
                <Space wrap size={8}>
                  <Typography.Text
                    className="ledger-cell-mono"
                    copyable={{ text: row.receipt.recordedByStaffId }}
                  >
                    {row.receipt.recordedByStaffId}
                  </Typography.Text>
                  <Typography.Text type="secondary">服务端未返回姓名</Typography.Text>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="收款流水编号">
                <Typography.Text
                  className="ledger-cell-mono"
                  copyable={{ text: row.receipt.entryId }}
                >
                  {row.receipt.entryId}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="对账状态">
                {row.receiptReconciliationState
                  ? LEDGER_RECONCILIATION_STATE_LABELS[row.receiptReconciliationState]
                  : '服务端未返回对账状态'}
              </Descriptions.Item>
              <Descriptions.Item label="复核确认">
                {row.receipt.confirmation
                  ? `${row.receipt.confirmation.reviewedByName ?? '服务端未返回复核人姓名'} · ${formatDateTime(
                      row.receipt.confirmation.confirmedAt,
                    )}${row.receipt.confirmation.note ? ` · ${row.receipt.confirmation.note}` : ''}`
                  : '尚无复核确认记录'}
              </Descriptions.Item>
              <Descriptions.Item label="冲正">
                {row.receipt.reversedEntryId ? (
                  <Space orientation="vertical" size={2}>
                    <Typography.Text>原收款已全额冲正；冲正单独成行，不从实收静默抵扣。</Typography.Text>
                    <Typography.Text
                      className="ledger-cell-mono"
                      copyable={{ text: row.receipt.reversedEntryId }}
                    >
                      {row.receipt.reversedEntryId}
                    </Typography.Text>
                  </Space>
                ) : (
                  '未被冲正'
                )}
              </Descriptions.Item>
            </Descriptions>
          </section>

          <section className="local-section" aria-label="网格员归属">
            <Typography.Text strong>网格员归属</Typography.Text>
            <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
              <Descriptions.Item label="归属状态">
                <Tag
                  color={row.receipt.attribution.state === 'attributed' ? 'green' : 'gold'}
                >
                  {LEDGER_ATTRIBUTION_STATE_LABELS[row.receipt.attribution.state]}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="归属依据">
                {LEDGER_ATTRIBUTION_BASIS_LABELS[row.receipt.attribution.basis]}
              </Descriptions.Item>
              <Descriptions.Item label="网格员 staffId">
                {row.receipt.attribution.staffId ? (
                  <Space wrap size={8}>
                    <Typography.Text
                      className="ledger-cell-mono"
                      copyable={{ text: row.receipt.attribution.staffId }}
                    >
                      {row.receipt.attribution.staffId}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      服务端未返回网格员姓名，本页不编造姓名
                    </Typography.Text>
                  </Space>
                ) : (
                  '待归属：未指定网格员'
                )}
              </Descriptions.Item>
            </Descriptions>
            <p className="ledger-diff-hint">
              归属只表示推广业绩归属，不代表应付对象或打款对象；应付主体与金额以已核准规则为准（当前待核定）。
            </p>
          </section>
        </>
      ) : (
        <Alert
          type="warning"
          showIcon
          title="该候选没有收款凭据"
          description="没有关联的人工收款凭据，因此不存在可确认的实收或归属；不能把订单登记金额当成实收。"
        />
      )}

      <section className="local-section" aria-label="主体快照">
        <Typography.Text strong>主体快照</Typography.Text>
        <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
          <Descriptions.Item label="主体状态">
            <Tag color={SELLER_STATUS_META[row.sellerStatus].color}>
              {SELLER_STATUS_META[row.sellerStatus].label}
            </Tag>
          </Descriptions.Item>
          {row.orderParty ? (
            <>
              <Descriptions.Item label="协议引用">
                <Typography.Text copyable={{ text: row.orderParty.agreementRef }}>
                  {row.orderParty.agreementRef}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="确认引用">
                <Typography.Text copyable={{ text: row.orderParty.confirmationRef }}>
                  {row.orderParty.confirmationRef}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="销售商户主体 ID">
                <Typography.Text
                  className="ledger-cell-mono"
                  copyable={{ text: row.orderParty.sellerPartyId }}
                >
                  {row.orderParty.sellerPartyId}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="三创主体 ID">
                {row.orderParty.sanchuangPartyId ? (
                  <Typography.Text
                    className="ledger-cell-mono"
                    copyable={{ text: row.orderParty.sanchuangPartyId }}
                  >
                    {row.orderParty.sanchuangPartyId}
                  </Typography.Text>
                ) : (
                  '未登记'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="广电主体 ID">
                {row.orderParty.guangdianPartyId ? (
                  <Typography.Text
                    className="ledger-cell-mono"
                    copyable={{ text: row.orderParty.guangdianPartyId }}
                  >
                    {row.orderParty.guangdianPartyId}
                  </Typography.Text>
                ) : (
                  '未登记'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="映射 ID">
                <Typography.Text
                  className="ledger-cell-mono"
                  copyable={{ text: row.orderParty.mappingId }}
                >
                  {row.orderParty.mappingId}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="确认人 / 时间">
                {formatDateTime(row.orderParty.confirmedAt)} · 确认人用户 ID：
                <Typography.Text
                  className="ledger-cell-mono"
                  copyable={{ text: row.orderParty.confirmedByUserId }}
                >
                  {row.orderParty.confirmedByUserId}
                </Typography.Text>
              </Descriptions.Item>
            </>
          ) : (
            <Descriptions.Item label="主体快照">
              服务端未返回主体快照：当前未指定实际销售商户，不能推断为社区或平台。
            </Descriptions.Item>
          )}
        </Descriptions>
        <p className="ledger-diff-hint">
          服务端只返回主体 UUID 与协议引用，不返回法人名称；UUID 仅在本详情展示并可复制，不占列表主表。
        </p>
      </section>

      <section className="local-section" aria-label="为什么不能结算">
        <Typography.Text strong>为什么不能结算</Typography.Text>
        {row.blockingReasons.length === 0 ? (
          <Alert
            style={{ marginTop: 8 }}
            type="info"
            showIcon
            title="服务端未返回阻塞原因"
            description="即使没有阻塞原因，仍需已核准的合同规则才能计算应分金额；当前规则状态固定为待核定。"
          />
        ) : (
          <ol className="ledger-candidate-blocking">
            {row.blockingReasons.map((reason, index) => (
              <li key={`${reason}-${index}`}>
                <Tag color="orange">{REASON_META[reason].label}</Tag>
                <div className="ledger-candidate-blocking-message">
                  {row.blockingMessages[index] ?? '服务端未返回该原因的说明。'}
                </div>
                <div className="ledger-candidate-blocking-next">
                  下一步应补：{REASON_META[reason].nextStep}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="local-section" aria-label="规则与付款">
        <Typography.Text strong>规则与付款</Typography.Text>
        <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
          <Descriptions.Item label="规则状态">
            <Tag color="orange">待核定</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="应分金额">
            待核定：尚无已核准的合同规则，系统不推算分成金额。
          </Descriptions.Item>
          <Descriptions.Item label="已登记付款">
            尚无登记或确认记录；本看板未接入付款登记；
            未来即使有登记，也只有服务端核验通过的付款确认才算核销；当前不能认为款项已经付出。
          </Descriptions.Item>
        </Descriptions>
        <p className="ledger-diff-hint">
          本详情只读：不提供编辑主体、编辑合同、锁定结算单或登记付款的入口；这些能力属于后续任务。
        </p>
      </section>
    </Space>
  )
}
