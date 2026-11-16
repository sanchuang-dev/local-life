import { PageInfoAlert } from '../components/PageInfoHelp'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Rule } from 'antd/es/form'
import { useEffect, useRef, useState } from 'react'
import type {
  SettlementPaymentOverview,
  SettlementStatement,
  SettlementStatementDetail,
  SettlementStatementLine,
  SettlementStatementListResponse,
  SettlementStatementPerformance,
  SettlementStatementSummary,
  SettlementTrialAllocation,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { formatCents, formatDateTime } from '../services/ledger'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import {
  SETTLEMENT_BENEFICIARY_STATE_LABELS,
  SETTLEMENT_PARTY_ROLE_LABELS,
  SETTLEMENT_PAYMENT_RECORD_STATE_LABELS,
  SETTLEMENT_PAYMENT_STATE_LABELS,
  SETTLEMENT_STATEMENT_STATUS_LABELS,
  createSettlementStatement,
  disputeSettlementPayment,
  downloadSettlementCsv,
  getSettlementPaymentOverview,
  getSettlementStatement,
  listSettlementStatements,
  lockSettlementStatement,
  recordSettlementPayment,
  reviewSettlementStatement,
  verifySettlementPayment,
} from '../services/settlement'
import './ledger.css'

/**
 * 分成结算单 · 结算单列表、草案生成与只读明细（LL-SET-011A / Issue #223）。
 *
 * 该页面集成快照创建、独立复核/锁定、双 CSV 导出和线下付款凭据登记/核验：
 *
 * - 结算单是某一时刻的快照；**生成草案 ≠ 锁定 ≠ 付款**。本视图通过服务器权限与状态约束提供复核、锁单、CSV 和付款入口；没有本地金额计算。
 * - 列表与明细的金额全部来自服务端；`summary.eligibleDistributionCents` 为 null
 *   时显示「待核定」，绝不用 ¥0 冒充零应付。
 * - 明细行的 `allocation` 为 null 时同样显示「待核定」；有值时只把 8 个整数分
 *   经 `formatCents` 原样格式化，不做任何加减乘除。
 * - 列表是服务端分页；404/401/403/400/网络错误都按真实状态展示，不用空列表或
 *   空明细冒充「没有数据」。
 * - 草案允许管理员与运营员发起（草案不是付款）；若服务端返回 403/409，页面如实
 *   展示服务端 message。
 */

interface DraftFormValues {
  communityId?: string
  periodFrom?: string
  periodTo?: string
}

interface ActionFormValues {
  evidenceRef?: string
}

interface PaymentFormValues {
  beneficiaryPartyId?: string
  amountCents?: number
  paidAt?: string
  proofRefMasked?: string
}

/** A stable UUID for one registration intent; regenerated only on success or reset. */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`
}

/** The contract refuses 12+ consecutive digits; the page mirrors that message. */
const LONG_DIGIT_MESSAGE = '不得填写完整银行卡号、账号或其他长数字凭据'
function hasLongDigitRun(value: string): boolean {
  return /\d{12,}/u.test(value.normalize('NFKC'))
}

/** Contract-trimmed evidence reference: required, 2-200 characters. */
function evidenceRule(label: string): Rule[] {
  return [
    { required: true, whitespace: true, message: `请填写${label}` },
    {
      validator: (_rule: unknown, value: unknown): Promise<void> => {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text === '') return Promise.resolve()
        if (text.length < 2 || text.length > 200) {
          return Promise.reject(new Error(`${label}需 2-200 个字符`))
        }
        return Promise.resolve()
      },
    },
  ]
}

/** Contracts export the event schema but not its inferred type. */
type SettlementStatementEvent = SettlementStatementDetail['events'][number]

const STATEMENT_STATUS_COLOR = {
  draft: 'gold',
  reviewed: 'blue',
  locked: 'green',
  superseded: 'default',
} as const

const LINE_STATE_LABELS = {
  calculated: '可计算',
  blocked: '阻塞',
} as const

const EVENT_KIND_LABELS = {
  created: '创建',
  reviewed: '复核',
  locked: '锁定',
  superseded: '被替代',
} as const

const DRAFT_PERIOD_MESSAGE = '业务期间终止日不能早于起始日'

export function SettlementStatementPanel() {
  const { session } = useAdminAuth()
  const { message } = AntdApp.useApp()
  const authorizedCommunities = session.staff.communities
  const isAdmin = session.staff.role === 'admin'
  // The server allows entity CSV for admin/operator and performance CSV for
  // admin/operator/grid_worker; this panel is not a grid-worker surface, so both
  // CSV entries are shown to every role that can reach it. Only review/lock are
  // admin-only.
  const canExport = session.staff.role !== 'grid_worker'
  const hasAuthorizedScope = isAdmin || authorizedCommunities.length > 0

  /* --------------------------------- list ---------------------------------- */

  const [communityId, setCommunityId] = useState<string | undefined>(
    isAdmin ? undefined : authorizedCommunities[0]?.id,
  )
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [response, setResponse] = useState<SettlementStatementListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!hasAuthorizedScope) {
      setResponse(null)
      setLoading(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setResponse(null)
    listSettlementStatements({ communityId, page, pageSize }, controller.signal)
      .then((result) => {
        if (active) setResponse(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setResponse(null)
        setError(cause instanceof Error ? cause : new Error('结算单列表加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [communityId, page, pageSize, reloadToken, hasAuthorizedScope])

  const refresh = () => setReloadToken((value) => value + 1)

  const changeCommunity = (value: string | undefined) => {
    setCommunityId(value ?? undefined)
    setPage(1)
  }

  /* ------------------------------ create draft ----------------------------- */

  const [draftOpen, setDraftOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [draftForm] = Form.useForm<DraftFormValues>()

  const openDraft = () => {
    draftForm.resetFields()
    setCreateError(null)
    setDraftOpen(true)
  }

  const closeDraft = () => {
    if (creating) return
    setDraftOpen(false)
    setCreateError(null)
    draftForm.resetFields()
  }

  const submitDraft = async (values: DraftFormValues) => {
    if (creating) return
    const from = (values.periodFrom ?? '').trim()
    const to = (values.periodTo ?? '').trim()
    if (!values.communityId || !from || !to) return
    if (to < from) {
      setCreateError(DRAFT_PERIOD_MESSAGE)
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const created = await createSettlementStatement(session.csrfToken, {
        communityId: values.communityId,
        periodFrom: from,
        periodTo: to,
      })
      setDraftOpen(false)
      draftForm.resetFields()
      message.success(
        `已生成结算单草案 ${created.statementNo}（${created.periodFrom} ~ ${created.periodTo}）。草案只是快照，生成草案不等于锁定，也不产生付款。`,
      )
      // Re-read page 1 rather than inserting the draft locally.
      setPage(1)
      setReloadToken((value) => value + 1)
    } catch (cause: unknown) {
      setCreateError(describeLocalError(cause, '生成结算单草案失败'))
    } finally {
      setCreating(false)
    }
  }

  /* -------------------------------- detail --------------------------------- */

  const [detailRow, setDetailRow] = useState<SettlementStatement | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SettlementStatementDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<Error | null>(null)
  const [detailToken, setDetailToken] = useState(0)
  const [detailTab, setDetailTab] = useState('lines')

  useEffect(() => {
    if (detailId === null) return
    let active = true
    const controller = new AbortController()
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    getSettlementStatement(detailId, controller.signal)
      .then((result) => {
        if (active) setDetail(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setDetail(null)
        setDetailError(cause instanceof Error ? cause : new Error('结算单明细加载失败'))
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [detailId, detailToken])

  /* ------------------------- offline payment overview ---------------------- */

  const [paymentOverview, setPaymentOverview] = useState<SettlementPaymentOverview | null>(null)
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [paymentError, setPaymentError] = useState<Error | null>(null)
  const [paymentToken, setPaymentToken] = useState(0)
  const [paymentTabOpened, setPaymentTabOpened] = useState(false)
  // Tracks the (statement, token) pair already requested so opening the tab or
  // re-rendering the Drawer cannot silently re-fetch the same overview.
  const paymentRequestRef = useRef<{ detailId: string | null; token: number }>({
    detailId: null,
    token: -1,
  })

  useEffect(() => {
    if (detailId === null) return
    const statementLocked = detail?.statement.status === 'locked'
    if (!paymentTabOpened && !statementLocked) return
    const requested = paymentRequestRef.current
    if (
      requested.detailId === detailId &&
      requested.token === paymentToken &&
      paymentOverview !== null
    ) {
      return
    }
    paymentRequestRef.current = { detailId, token: paymentToken }
    let active = true
    const controller = new AbortController()
    setPaymentLoading(true)
    setPaymentError(null)
    getSettlementPaymentOverview(detailId, controller.signal)
      .then((result) => {
        if (active) setPaymentOverview(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setPaymentOverview(null)
        setPaymentError(cause instanceof Error ? cause : new Error('付款凭据总览加载失败'))
      })
      .finally(() => {
        if (active) setPaymentLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
    // paymentOverview is intentionally not a dependency: the ref guard reads the
    // current value, and re-running on every fetch result would be pointless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId, paymentToken, paymentTabOpened, detail?.statement.status])

  const openDetail = (row: SettlementStatement) => {
    setDetailRow(row)
    setDetailId(row.id)
    setDetailTab('lines')
    setPaymentError(null)
    setPaymentTabOpened(false)
  }

  const closeDetail = () => {
    setDetailId(null)
    setDetailRow(null)
    setDetail(null)
    setDetailError(null)
    setActionKind(null)
    setActionStatement(null)
    setActionError(null)
    setExportError(null)
    setPaymentOverview(null)
    setPaymentError(null)
    setPaymentTabOpened(false)
  }

  /* ---------------------- independent review / one-way lock ---------------- */

  const [actionKind, setActionKind] = useState<'review' | 'lock' | null>(null)
  const [actionStatement, setActionStatement] = useState<SettlementStatement | null>(null)
  const [actionSubmitting, setActionSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionForm] = Form.useForm<ActionFormValues>()

  const openAction = (kind: 'review' | 'lock', statement: SettlementStatement) => {
    setActionKind(kind)
    setActionStatement(statement)
    setActionError(null)
    actionForm.resetFields()
  }

  const closeAction = () => {
    if (actionSubmitting) return
    setActionKind(null)
    setActionStatement(null)
    setActionError(null)
    actionForm.resetFields()
  }

  const submitAction = async (values: ActionFormValues) => {
    if (!actionKind || !actionStatement || actionSubmitting) return
    const evidenceRef = (values.evidenceRef ?? '').trim()
    if (evidenceRef.length < 2 || evidenceRef.length > 200) return
    setActionSubmitting(true)
    setActionError(null)
    try {
      const updated =
        actionKind === 'review'
          ? await reviewSettlementStatement(session.csrfToken, actionStatement.id, {
              expectedRevision: actionStatement.revision,
              evidenceRef,
            })
          : await lockSettlementStatement(session.csrfToken, actionStatement.id, {
              expectedRevision: actionStatement.revision,
              evidenceRef,
            })
      // Re-render from the server's detail: the page never flips draft → reviewed
      // or reviewed → locked locally.
      setDetail(updated)
      setDetailRow(updated.statement)
      setActionKind(null)
      setActionStatement(null)
      actionForm.resetFields()
      message.success(
        actionKind === 'review'
          ? '复核已提交：快照未被锁定，也不代表已付款。'
          : '结算单已锁定：快照已冻结，锁定不等于已付款。',
      )
      // A lock changes whether payment evidence may be registered, so the
      // payment overview is re-read from the server as well.
      setPaymentToken((value) => value + 1)
      setReloadToken((value) => value + 1)
    } catch (cause: unknown) {
      setActionError(
        describeLocalError(cause, actionKind === 'review' ? '复核未完成' : '锁单未完成'),
      )
    } finally {
      setActionSubmitting(false)
    }
  }

  /* ------------------------------ CSV export ------------------------------- */

  const [exporting, setExporting] = useState<'entity' | 'performance' | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const exportCsv = async (kind: 'entity' | 'performance') => {
    if (!detail || exporting !== null) return
    setExporting(kind)
    setExportError(null)
    try {
      const result = await downloadSettlementCsv(detail.statement.id, kind)
      message.success(`已导出 ${result.filename}（${result.byteLength} 字节）`)
    } catch (cause: unknown) {
      // A failed download is never reported as a success/filename.
      setExportError(describeLocalError(cause, '结算单 CSV 导出失败'))
    } finally {
      setExporting(null)
    }
  }

  /* -------------------------------- columns -------------------------------- */

  const unauthorized = isLocalApiError(error) && error.status === 401
  const forbidden = isLocalApiError(error) && error.status === 403
  const errorText = error ? describeLocalError(error, '结算单列表加载失败') : null

  const columns: ColumnsType<SettlementStatement> = [
    {
      title: '单据号',
      key: 'statementNo',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong className="ledger-cell-mono">
            {row.statementNo}
          </Typography.Text>
          <Typography.Text type="secondary">社区 {shortId(row.communityId)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '业务期间',
      key: 'period',
      render: (_value, row) => (
        <span className="ledger-batch-period">
          {row.periodFrom} ~ {row.periodTo}
        </span>
      ),
    },
    {
      title: '生成 / 修订',
      key: 'generation',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>第 {row.generation} 次生成</span>
          <Typography.Text type="secondary">修订 {row.revision}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_value, row) => (
        <Tag color={STATEMENT_STATUS_COLOR[row.status]}>
          {SETTLEMENT_STATEMENT_STATUS_LABELS[row.status]}
        </Tag>
      ),
    },
    {
      title: '行数 / 可计算 / 阻塞',
      key: 'counts',
      render: (_value, row) => (
        <span>
          {row.summary.lineCount} / {row.summary.calculatedCount} / {row.summary.blockedCount}
        </span>
      ),
    },
    {
      title: '凭据实收毛额',
      key: 'eligibleGross',
      render: (_value, row) => formatCents(row.summary.eligibleGrossCents),
    },
    {
      title: '手续费',
      key: 'fee',
      render: (_value, row) => formatCents(row.summary.feeCents),
    },
    {
      title: '三方净额（销 / 三 / 广）',
      key: 'nets',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>{formatCents(row.summary.sellerNetCents)}</span>
          <Typography.Text type="secondary">
            三创 {formatCents(row.summary.sanchuangNetCents)} · 广电{' '}
            {formatCents(row.summary.guangdianNetCents)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '可分配合计',
      key: 'eligibleDistribution',
      render: (_value, row) =>
        row.summary.eligibleDistributionCents === null ? (
          <Tag color="orange">待核定</Tag>
        ) : (
          formatCents(row.summary.eligibleDistributionCents)
        ),
    },
    {
      title: '付款状态',
      key: 'paymentState',
      render: (_value, row) => SETTLEMENT_PAYMENT_STATE_LABELS[row.paymentState],
    },
    {
      title: '数据截至',
      key: 'asOf',
      render: (_value, row) => formatDateTime(row.asOf),
    },
    {
      title: '创建时间',
      key: 'createdAt',
      render: (_value, row) => formatDateTime(row.createdAt),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_value, row) => (
        <Button type="link" size="small" onClick={() => openDetail(row)}>
          查看明细
        </Button>
      ),
    },
  ]

  const emptyText = (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无结算单">
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        结算单是某一时刻的快照。生成草案不等于锁定，也不产生付款；没有草案时本页不会显示任何金额。
      </Typography.Paragraph>
    </Empty>
  )

  return (
    <section aria-label="结算单">
      <PageInfoAlert
        type="info"
        showIcon
        title="结算单是快照 · 生成草案 ≠ 锁定 ≠ 付款"
        description="结算单是快照；生成草案 ≠ 锁定 ≠ 付款。状态与金额全部来自服务端。管理员可按服务器权限和状态执行复核、锁定及线下付款凭据登记；复核与核销均有独立操作，锁定从不代表已付款。"
      />

      {!hasAuthorizedScope ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="当前账号没有可用的社区范围"
          description="运营员与网格员必须由管理员分配至少一个社区后，才能查看或生成结算单。本视图没有发起任何请求，也不会用空列表冒充「尚无结算单」。"
        />
      ) : unauthorized ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          title="登录状态已失效"
          description={`服务端返回 401：请重新登录管理后台后再查看结算单。${errorText ?? ''}`}
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
          title="没有查看结算单的权限"
          description={`${errorText ?? ''} 网格员没有结算单权限；服务端直接返回 403。`}
          action={
            <Button size="small" onClick={refresh}>
              重试
            </Button>
          }
        />
      ) : (
        <Card
          size="small"
          style={{ marginTop: 12 }}
          title="结算单（快照 · 只读）"
          extra={
            <Space wrap size={8}>
              <Button size="small" onClick={refresh} loading={loading}>
                刷新
              </Button>
              <Button size="small" type="primary" onClick={openDraft}>
                新建草案
              </Button>
            </Space>
          }
        >
          {authorizedCommunities.length > 0 ? (
            <div className="ledger-filter-field" style={{ marginBottom: 12 }}>
              <label htmlFor="settlement-statement-community">社区范围</label>
              <Select<string>
                id="settlement-statement-community"
                allowClear={isAdmin}
                style={{ maxWidth: 260 }}
                placeholder={isAdmin ? '全部社区' : '请选择授权社区'}
                value={communityId}
                onChange={(value) => changeCommunity(value)}
                options={authorizedCommunities.map((community) => ({
                  value: community.id,
                  label: community.name,
                }))}
              />
              <span className="ledger-filter-hint">
                {isAdmin
                  ? '不选具体社区时，服务端返回其全部社区范围'
                  : '运营员必须指定一个自己已被分配的社区（服务端要求 communityId）'}
              </span>
            </div>
          ) : (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              当前管理员账号未被分配具体社区，列表按服务端全部社区范围返回；生成草案需要在表单中选择社区。
            </Typography.Paragraph>
          )}

          {error ? (
            <Alert
              type="error"
              showIcon
              title="结算单列表加载失败"
              description={errorText ?? undefined}
              action={
                <Button size="small" onClick={refresh}>
                  重试
                </Button>
              }
            />
          ) : response === null ? (
            <div className="ledger-candidate-loading" aria-live="polite">
              <Spin />
              <Typography.Text type="secondary">正在读取结算单…</Typography.Text>
            </div>
          ) : (
            <Table<SettlementStatement>
              rowKey={(row) => row.id}
              columns={columns}
              dataSource={response.items}
              loading={loading}
              size="small"
              scroll={{ x: 'max-content' }}
              pagination={{
                current: response.page,
                pageSize: response.pageSize,
                total: response.total,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50, 100],
                showTotal: (total) => `共 ${total} 张结算单（服务端分页）`,
              }}
              onChange={(pagination) => {
                const nextPage = pagination.current ?? 1
                const nextSize = pagination.pageSize ?? pageSize
                if (nextSize !== pageSize) {
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
      )}

      {/* ------------------------------ draft modal ----------------------------- */}
      <Modal
        title="新建结算单草案"
        open={draftOpen}
        onCancel={closeDraft}
        onOk={() => draftForm.submit()}
        okText="生成草案"
        cancelText="取消"
        confirmLoading={creating}
        destroyOnHidden
      >
        <PageInfoAlert inline
          type="info"
          showIcon
          title="草案不是锁定，也不是付款"
          description="草案按所选业务期间生成快照；生成后仍需人工复核与锁定；本页不会自动锁定，也不会自动登记付款。"
          style={{ marginBottom: 12 }}
        />
        <Form<DraftFormValues>
          form={draftForm}
          layout="vertical"
          onFinish={(values) => void submitDraft(values)}
        >
          {createError ? (
            <Alert
              type="error"
              showIcon
              title="草案未生成"
              description={createError}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Form.Item
            name="communityId"
            label="社区"
            rules={[{ required: true, message: '请选择社区' }]}
          >
            <Select
              placeholder="请选择社区"
              options={authorizedCommunities.map((community) => ({
                value: community.id,
                label: community.name,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="periodFrom"
            label="业务期间开始（含）"
            rules={[{ required: true, whitespace: true, message: '请填写业务期间开始' }]}
          >
            <Input maxLength={10} placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item
            name="periodTo"
            label="业务期间结束（含）"
            dependencies={['periodFrom']}
            rules={[
              { required: true, whitespace: true, message: '请填写业务期间结束' },
              {
                validator: (): Promise<void> => {
                  const from = draftForm.getFieldValue('periodFrom') as string | undefined
                  const to = draftForm.getFieldValue('periodTo') as string | undefined
                  if (!from?.trim() || !to?.trim()) return Promise.resolve()
                  if (to.trim() < from.trim()) {
                    return Promise.reject(new Error(DRAFT_PERIOD_MESSAGE))
                  }
                  return Promise.resolve()
                },
              },
            ]}
          >
            <Input maxLength={10} placeholder="YYYY-MM-DD" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------ detail drawer --------------------------- */}
      <Drawer
        title={detailRow ? `结算单明细 · ${detailRow.statementNo}` : '结算单明细'}
        size={860}
        open={detailId !== null}
        onClose={closeDetail}
        rootClassName="local-drawer"
        destroyOnHidden
      >
        {detailError ? (
          <Alert
            type="error"
            showIcon
            title={
              isLocalApiError(detailError) && detailError.status === 404
                ? '结算单不存在'
                : '结算单明细加载失败'
            }
            description={describeLocalError(detailError, '结算单明细加载失败')}
            action={
              <Button size="small" onClick={() => setDetailToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : detailLoading || detail === null ? (
          <div className="ledger-candidate-loading" aria-live="polite">
            <Spin />
            <Typography.Text type="secondary">正在读取结算单明细…</Typography.Text>
          </div>
        ) : (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            {isAdmin ? (
              <StatementActionBar
                statement={detail.statement}
                onReview={() => openAction('review', detail.statement)}
                onLock={() => openAction('lock', detail.statement)}
              />
            ) : null}
            {canExport ? (
              <StatementExportBar
                statement={detail.statement}
                exporting={exporting}
                error={exportError}
                onExport={(kind) => void exportCsv(kind)}
              />
            ) : null}
            <StatementDetail
              detail={detail}
              tab={detailTab}
              onTabChange={(key) => {
                setDetailTab(key)
                if (key === 'payments') setPaymentTabOpened(true)
              }}
              paymentOverview={paymentOverview}
              paymentLoading={paymentLoading}
              paymentError={paymentError}
              onPaymentRetry={() => setPaymentToken((value) => value + 1)}
              isAdmin={isAdmin}
              csrfToken={session.csrfToken}
              onPaymentRecorded={(updated) => {
                setPaymentOverview(updated)
                setReloadToken((value) => value + 1)
              }}
            />
          </Space>
        )}
      </Drawer>

      {/* --------------------- review / lock confirmation ------------------------ */}
      {isAdmin ? (
        <Modal
          title={actionKind === 'review' ? '复核结算单（人工确认快照）' : '锁单（不可逆）'}
          open={actionKind !== null}
          onCancel={closeAction}
          onOk={() => actionForm.submit()}
          okText={actionKind === 'review' ? '提交复核' : '确认锁单'}
          cancelText="取消"
          confirmLoading={actionSubmitting}
          destroyOnHidden
        >
          {actionStatement ? (
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="单据号">
                <Typography.Text className="ledger-cell-mono">
                  {actionStatement.statementNo}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="当前修订">第 {actionStatement.revision} 次</Descriptions.Item>
              <Descriptions.Item label="当前状态">
                {SETTLEMENT_STATEMENT_STATUS_LABELS[actionStatement.status]}
              </Descriptions.Item>
              <Descriptions.Item label="付款状态">
                {SETTLEMENT_PAYMENT_STATE_LABELS[actionStatement.paymentState]}（锁定后仍以服务端为准）
              </Descriptions.Item>
            </Descriptions>
          ) : null}

          {actionKind === 'review' ? (
            <PageInfoAlert inline
              type="info"
              showIcon
              title="复核只是人工确认快照内容，不锁定、不代表已付款"
              description="复核由服务端强制独立：制单人不能复核自己的草案，管理员之间也必须满足服务端规则。复核依据必须人工填写，页面不预填。"
              style={{ marginBottom: 12 }}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              title="锁定不可逆"
              description={
                <>
                  <p style={{ marginBottom: 4 }}>
                    确认后该结算单快照立即冻结，锁定不可逆，不能撤销或回到 reviewed。
                  </p>
                  <p style={{ marginBottom: 4 }}>锁定 ≠ 已付款：锁定只冻结快照，不登记任何付款。</p>
                  <p style={{ marginBottom: 0 }}>
                    后续付款必须由线下凭据单独登记与复核；页面不会把锁单当作已结清。
                  </p>
                </>
              }
              style={{ marginBottom: 12 }}
            />
          )}

          {actionError ? (
            <Alert
              type="error"
              showIcon
              title={actionKind === 'review' ? '复核未完成' : '锁单未完成'}
              description={actionError}
              style={{ marginBottom: 12 }}
            />
          ) : null}

          <Form<ActionFormValues>
            form={actionForm}
            layout="vertical"
            onFinish={(values) => void submitAction(values)}
          >
            <Form.Item
              name="evidenceRef"
              label={actionKind === 'review' ? '复核依据' : '锁单依据'}
              rules={evidenceRule(actionKind === 'review' ? '复核依据' : '锁单依据')}
              tooltip="人工填写的可核对依据（2-200 字），页面不预填。"
            >
              <Input maxLength={200} placeholder="人工填写依据，不预填" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Drawer action bar: independent review + one-way lock (#224, admin only)     */
/* -------------------------------------------------------------------------- */

function StatementActionBar({
  statement,
  onReview,
  onLock,
}: {
  statement: SettlementStatement
  onReview: () => void
  onLock: () => void
}) {
  return (
    <section className="local-section" aria-label="复核与锁单">
      <Space wrap size={8}>
        <Typography.Text strong>动作</Typography.Text>
        {statement.status === 'draft' ? (
          <Button type="primary" onClick={onReview}>
            复核
          </Button>
        ) : null}
        {statement.status === 'reviewed' ? (
          <Button type="primary" danger onClick={onLock}>
            锁单
          </Button>
        ) : null}
        {statement.status !== 'draft' && statement.status !== 'reviewed' ? (
          <Typography.Text type="secondary">
            该状态没有可用的复核或锁单入口；锁定后的快照不能再被写回。
          </Typography.Text>
        ) : null}
      </Space>
      <p className="ledger-diff-hint">
        复核与锁单都是人工动作，都不等于付款；状态与付款信息始终以服务端返回为准。
      </p>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* CSV export: entity statement + grid-worker performance appendix             */
/* -------------------------------------------------------------------------- */

function StatementExportBar({
  statement,
  exporting,
  error,
  onExport,
}: {
  statement: SettlementStatement
  exporting: 'entity' | 'performance' | null
  error: string | null
  onExport: (kind: 'entity' | 'performance') => void
}) {
  return (
    <section className="local-section" aria-label="导出 CSV">
      <Space wrap size={8}>
        <Typography.Text strong>导出</Typography.Text>
        <Button
          onClick={() => onExport('entity')}
          loading={exporting === 'entity'}
          disabled={exporting !== null}
        >
          导出机构结算明细（CSV）
        </Button>
        <Button
          onClick={() => onExport('performance')}
          loading={exporting === 'performance'}
          disabled={exporting !== null}
        >
          导出网格员业绩附表（CSV）
        </Button>
      </Space>
      {statement.status === 'draft' ? (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          title="草案/未复核：导出仅供核对，不是已结清单据"
          description="该结算单尚未复核，导出的文件只用于核对快照内容，不能作为已结清或已付款凭证。"
        />
      ) : null}
      <p className="ledger-diff-hint">
        业绩附表是广电网格员的工作量，不是应付给个人的佣金。导出的两个 CSV 都只是快照明细，不代表付款或结清。
      </p>
      {error ? (
        <Alert
          style={{ marginTop: 8 }}
          type="error"
          showIcon
          title="CSV 导出失败"
          description={error}
        />
      ) : null}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Detail drawer contents                                                     */
/* -------------------------------------------------------------------------- */

function StatementDetail({
  detail,
  tab,
  onTabChange,
  paymentOverview,
  paymentLoading,
  paymentError,
  onPaymentRetry,
  isAdmin,
  csrfToken,
  onPaymentRecorded,
}: {
  detail: SettlementStatementDetail
  tab: string
  onTabChange: (key: string) => void
  paymentOverview: SettlementPaymentOverview | null
  paymentLoading: boolean
  paymentError: Error | null
  onPaymentRetry: () => void
  isAdmin: boolean
  csrfToken: string
  onPaymentRecorded: (overview: SettlementPaymentOverview) => void
}) {
  const { statement } = detail
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <section className="local-section" aria-label="结算单摘要">
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="单据号">
            <Space wrap size={8}>
              <Typography.Text className="ledger-cell-mono">{statement.statementNo}</Typography.Text>
              <Tag color={STATEMENT_STATUS_COLOR[statement.status]}>
                {SETTLEMENT_STATEMENT_STATUS_LABELS[statement.status]}
              </Tag>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="业务期间">
            {statement.periodFrom} ~ {statement.periodTo}（第 {statement.generation} 次生成 · 修订{' '}
            {statement.revision}）
          </Descriptions.Item>
          <Descriptions.Item label="快照摘要">
            <StatementSummaryBlock summary={statement.summary} />
          </Descriptions.Item>
          <Descriptions.Item label="付款状态">
            {SETTLEMENT_PAYMENT_STATE_LABELS[statement.paymentState]}
          </Descriptions.Item>
          <Descriptions.Item label="数据截至">
            {formatDateTime(statement.asOf)}
          </Descriptions.Item>
        </Descriptions>
      </section>

      <Tabs
        size="small"
        activeKey={tab}
        onChange={onTabChange}
        items={[
          {
            key: 'lines',
            label: `明细行（${detail.lines.length}）`,
            children:
              detail.lines.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该结算单没有明细行" />
              ) : (
                <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                  {detail.lines.map((line) => (
                    <StatementLineCard key={line.id} line={line} />
                  ))}
                </Space>
              ),
          },
          {
            key: 'performance',
            label: `业绩（${detail.performance.length}）`,
            children: <PerformanceList rows={detail.performance} />,
          },
          {
            key: 'events',
            label: `事件（${detail.events.length}）`,
            children: <EventList rows={detail.events} />,
          },
          {
            key: 'disputes',
            label: `锁后争议（${detail.postLockDisputes.length}）`,
            children: <DisputeList disputes={detail.postLockDisputes} />,
          },
          {
            key: 'payments',
            label: `付款凭据（${paymentOverview?.records.length ?? 0}）`,
            children: (
              <PaymentTab
                statement={statement}
                overview={paymentOverview}
                loading={paymentLoading}
                error={paymentError}
                onRetry={onPaymentRetry}
                isAdmin={isAdmin}
                csrfToken={csrfToken}
                onRecorded={onPaymentRecorded}
              />
            ),
          },
        ]}
      />
    </Space>
  )
}

function StatementSummaryBlock({ summary }: { summary: SettlementStatementSummary }) {
  return (
    <Space orientation="vertical" size={2}>
      <span>
        行数 {summary.lineCount} · 可计算 {summary.calculatedCount} · 阻塞 {summary.blockedCount}
      </span>
      <span>
        凭据实收毛额 {formatCents(summary.eligibleGrossCents)} · 手续费{' '}
        {formatCents(summary.feeCents)}
      </span>
      <span>
        三方净额：销 {formatCents(summary.sellerNetCents)} · 三{' '}
        {formatCents(summary.sanchuangNetCents)} · 广 {formatCents(summary.guangdianNetCents)}
      </span>
      <span>
        可分配合计：
        {summary.eligibleDistributionCents === null ? (
          <Tag color="orange">待核定</Tag>
        ) : (
          formatCents(summary.eligibleDistributionCents)
        )}
      </span>
    </Space>
  )
}

function StatementLineCard({ line }: { line: SettlementStatementLine }) {
  return (
    <section className="local-section" aria-label={`明细行 ${line.orderDisplayNo}`}>
      <Descriptions size="small" column={1} bordered title={line.orderDisplayNo}>
        <Descriptions.Item label="订单">
          <Space wrap size={8}>
            <Typography.Text className="ledger-cell-mono">{line.orderDisplayNo}</Typography.Text>
            <Typography.Text type="secondary" className="ledger-cell-mono">
              {line.orderId}
            </Typography.Text>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="商品">{line.productName}</Descriptions.Item>
        <Descriptions.Item label="归属期间">{formatDateTime(line.periodAt)}</Descriptions.Item>
        <Descriptions.Item label="登记金额">
          {formatCents(line.registeredAmountCents)}
        </Descriptions.Item>
        <Descriptions.Item label="优惠券抵扣">
          {formatCents(line.couponDiscountCents)}
        </Descriptions.Item>
        <Descriptions.Item label="订单净应付">
          {formatCents(line.netPayableCents)}
        </Descriptions.Item>
        <Descriptions.Item label="收款凭据">
          {line.receiptEvidenceRef === null ? (
            '未关联收款凭据'
          ) : (
            <Space wrap size={8}>
              <Typography.Text className="ledger-cell-mono">
                {line.receiptEvidenceRef}
              </Typography.Text>
              <span>
                {line.receiptAmountCents === null
                  ? '服务端未返回金额'
                  : formatCents(line.receiptAmountCents)}
              </span>
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="网格员">
          {line.gridStaffId === null ? '服务端未返回' : line.gridStaffId}
        </Descriptions.Item>
        <Descriptions.Item label="映射 / 销售商户">
          <Space wrap size={8}>
            <Typography.Text className="ledger-cell-mono">
              {line.mappingId === null ? '服务端未返回' : line.mappingId}
            </Typography.Text>
            <Typography.Text type="secondary" className="ledger-cell-mono">
              {line.sellerPartyId === null ? '服务端未返回' : line.sellerPartyId}
            </Typography.Text>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="规则版本">
          {line.ruleId === null || line.ruleVersion === null ? (
            '无已核准规则'
          ) : (
            <Space wrap size={8}>
              <Tag color="blue">v{line.ruleVersion}</Tag>
              <Typography.Text className="ledger-cell-mono">{line.ruleId}</Typography.Text>
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="行状态">
          <Tag color={line.state === 'calculated' ? 'green' : 'red'}>
            {LINE_STATE_LABELS[line.state]}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="阻塞原因">
          {line.blockingReasons.length === 0 ? (
            '无阻塞原因'
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {line.blockingReasons.map((reason, index) => (
                <li key={`${reason}-${index}`}>{reason}</li>
              ))}
            </ul>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="试算分配">
          {line.allocation === null ? (
            <Tag color="orange">待核定</Tag>
          ) : (
            <AllocationBlock allocation={line.allocation} />
          )}
        </Descriptions.Item>
      </Descriptions>
      <p className="ledger-diff-hint">
        本行数字全部来自服务端快照；本页不做任何加减乘除，也不把试算分配称为应付金额。
      </p>
    </section>
  )
}

function AllocationBlock({ allocation }: { allocation: SettlementTrialAllocation }) {
  return (
    <Space orientation="vertical" size={2}>
      <span>凭据实收毛额 {formatCents(allocation.grossReceivedCents)}</span>
      <span>手续费 {formatCents(allocation.processorFeeCents)}</span>
      <span>销售商户净额 {formatCents(allocation.sellerNetCents)}</span>
      <span>三创净额 {formatCents(allocation.sanchuangNetCents)}</span>
      <span>广电净额 {formatCents(allocation.guangdianNetCents)}</span>
      <span>三方合计净额 {formatCents(allocation.totalNetCents)}</span>
      <span>守恒校验合计 {formatCents(allocation.conservedTotalCents)}</span>
      <span>舍入余数 {formatCents(allocation.roundingResidualCents)}</span>
    </Space>
  )
}

function PerformanceList({ rows }: { rows: SettlementStatementPerformance[] }) {
  if (rows.length === 0) {
    return (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无已确认业绩" />
    )
  }
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <PageInfoAlert
        type="info"
        showIcon
        title="已确认业绩不含金额，不是应付给个人的佣金"
        description="业绩记录只证明业务事实与确认人，不代表任何个人应收、佣金或付款。"
      />
      {rows.map((row) => (
        <Descriptions
          key={row.id}
          size="small"
          column={1}
          bordered
          title={row.sourceDisplayNo}
        >
          <Descriptions.Item label="来源单号">
            <Typography.Text className="ledger-cell-mono">
              {row.sourceDisplayNo}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="网格员">
            {row.staffId}
          </Descriptions.Item>
          <Descriptions.Item label="确认时间">
            {formatDateTime(row.confirmedAt)}
          </Descriptions.Item>
          <Descriptions.Item label="确认依据">
            {row.evidenceRef === null ? '服务端未返回' : row.evidenceRef}
          </Descriptions.Item>
        </Descriptions>
      ))}
    </Space>
  )
}

function EventList({ rows }: { rows: SettlementStatementEvent[] }) {
  if (rows.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无事件记录" />
  }
  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      {rows.map((row) => (
        <div key={row.id} className="ledger-diff-finding">
          <Tag>{EVENT_KIND_LABELS[row.kind]}</Tag>
          <span>修订 {row.revision}</span>
          <Typography.Text className="ledger-cell-mono">{row.actorUserId}</Typography.Text>
          <span className="ledger-diff-finding-detail">
            {row.evidenceRef === null ? '服务端未返回依据' : row.evidenceRef} ·{' '}
            {formatDateTime(row.createdAt)}
          </span>
        </div>
      ))}
    </Space>
  )
}

function DisputeList({
  disputes,
}: {
  disputes: SettlementStatementDetail['postLockDisputes']
}) {
  if (disputes.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无锁后争议" />
  }
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        title="锁后争议是既成事实，不回写已冻结明细"
        description="以下订单在锁定之后出现冲正或异常，逐条列出供人工处理；本视图不修改任何明细。"
      />
      {disputes.map((dispute) => (
        <section
          key={dispute.orderId}
          className="local-section"
          aria-label={`锁后争议 ${dispute.orderId}`}
        >
          <Typography.Text strong className="ledger-cell-mono">
            {dispute.orderId}
          </Typography.Text>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {dispute.reasons.map((reason, index) => (
              <li key={`${reason}-${index}`}>{reason}</li>
            ))}
          </ul>
        </section>
      ))}
    </Space>
  )
}

/* -------------------------------------------------------------------------- */
/* Payment evidence: overview + offline proof registration (#225)              */
/* -------------------------------------------------------------------------- */

const PAYMENT_EVENT_KIND_LABELS = {
  recorded: '登记',
  verified: '核验',
  disputed: '争议',
} as const

const beneficiaryColumns: ColumnsType<SettlementPaymentOverview['beneficiaries'][number]> = [
  {
    title: '受款人',
    key: 'legalName',
    render: (_value, row) => <Typography.Text strong>{row.legalName}</Typography.Text>,
  },
  {
    title: '角色',
    key: 'role',
    render: (_value, row) => SETTLEMENT_PARTY_ROLE_LABELS[row.role],
  },
  {
    title: '登记号',
    key: 'registryRef',
    render: (_value, row) => (
      <Typography.Text className="ledger-cell-mono">{row.registryRef}</Typography.Text>
    ),
  },
  {
    title: '核验依据',
    key: 'verificationRef',
    render: (_value, row) => row.verificationRef ?? '未提供',
  },
  {
    title: '应付（服务端）',
    key: 'payableCents',
    render: (_value, row) => formatCents(row.payableCents),
  },
  {
    title: '已登记（服务端）',
    key: 'recordedCents',
    render: (_value, row) => formatCents(row.recordedCents),
  },
  {
    title: '核销（服务端）',
    key: 'verifiedCents',
    render: (_value, row) => formatCents(row.verifiedCents),
  },
  {
    title: '状态',
    key: 'state',
    render: (_value, row) => SETTLEMENT_BENEFICIARY_STATE_LABELS[row.state],
  },
]

const paymentRecordColumns: ColumnsType<SettlementPaymentOverview['records'][number]> = [
  {
    title: '金额',
    key: 'amountCents',
    render: (_value, row) => formatCents(row.amountCents),
  },
  {
    title: '付款时间',
    key: 'paidAt',
    render: (_value, row) => formatDateTime(row.paidAt),
  },
  {
    title: '脱敏凭据引用',
    key: 'proofRefMasked',
    render: (_value, row) => (
      <Typography.Text className="ledger-cell-mono">{row.proofRefMasked}</Typography.Text>
    ),
  },
  {
    title: '状态',
    key: 'state',
    render: (_value, row) => SETTLEMENT_PAYMENT_RECORD_STATE_LABELS[row.state],
  },
  {
    title: '登记人',
    key: 'recorderUserId',
    render: (_value, row) => (
      <Typography.Text className="ledger-cell-mono" style={{ fontSize: 12 }}>
        {row.recorderUserId}
      </Typography.Text>
    ),
  },
  {
    title: '登记时间',
    key: 'recordedAt',
    render: (_value, row) => formatDateTime(row.recordedAt),
  },
]

function PaymentTab({
  statement,
  overview,
  loading,
  error,
  onRetry,
  isAdmin,
  csrfToken,
  onRecorded,
}: {
  statement: SettlementStatement
  overview: SettlementPaymentOverview | null
  loading: boolean
  error: Error | null
  onRetry: () => void
  isAdmin: boolean
  csrfToken: string
  onRecorded: (overview: SettlementPaymentOverview) => void
}) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm<PaymentFormValues>()
  // One UUID per registration intent. It survives failed submits and is only
  // replaced after a success or an explicit 「新建凭据」.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey())
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const startNewIntent = () => {
    if (submitting) return
    setIdempotencyKey(newIdempotencyKey())
    form.resetFields()
    setSubmitError(null)
  }

  const submit = async (values: PaymentFormValues) => {
    if (submitting || !isAdmin || statement.status !== 'locked') return
    const beneficiaryPartyId = values.beneficiaryPartyId
    const amountCents = values.amountCents
    const paidAtRaw = (values.paidAt ?? '').trim()
    const proofRefMasked = (values.proofRefMasked ?? '').trim()
    if (!beneficiaryPartyId || amountCents === undefined || !paidAtRaw || !proofRefMasked) {
      return
    }
    const paidAt = new Date(paidAtRaw)
    if (Number.isNaN(paidAt.getTime())) {
      setSubmitError('付款时间格式不正确')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const updated = await recordSettlementPayment(csrfToken, statement.id, {
        beneficiaryPartyId,
        amountCents,
        paidAt: paidAt.toISOString(),
        proofRefMasked,
        idempotencyKey,
      })
      // The server returns the whole overview: refresh from it and only now
      // start a new intent (new idempotency key + cleared form). The record is
      // NOT marked verified locally.
      onRecorded(updated)
      setIdempotencyKey(newIdempotencyKey())
      form.resetFields()
      message.success('已登记，待复核：登记付款凭据 ≠ 复核核销，也不触发任何转账。')
    } catch (cause: unknown) {
      // Keep the same key and the entered values for an identical retry.
      setSubmitError(describeLocalError(cause, '登记付款凭据失败'))
    } finally {
      setSubmitting(false)
    }
  }

  /* ---------------------- independent verify / dispute --------------------- */

  type PaymentActionKind = 'verify' | 'dispute'
  type PaymentRecord = SettlementPaymentOverview['records'][number]

  const [actionKind, setActionKind] = useState<PaymentActionKind | null>(null)
  const [actionRecord, setActionRecord] = useState<PaymentRecord | null>(null)
  // One event idempotency key per logical action: generated when the human opens
  // the action dialog, kept across failed retries, replaced only by a new action.
  const [actionKey, setActionKey] = useState<string>(() => newIdempotencyKey())
  const [actionSubmitting, setActionSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionForm] = Form.useForm<ActionFormValues>()

  const openAction = (kind: PaymentActionKind, record: PaymentRecord) => {
    setActionKind(kind)
    setActionRecord(record)
    setActionKey(newIdempotencyKey())
    setActionError(null)
    actionForm.resetFields()
  }

  const closeAction = () => {
    if (actionSubmitting) return
    setActionKind(null)
    setActionRecord(null)
    setActionError(null)
    actionForm.resetFields()
  }

  const submitAction = async (values: ActionFormValues) => {
    if (!actionKind || !actionRecord || actionSubmitting) return
    const evidenceRef = (values.evidenceRef ?? '').trim()
    if (evidenceRef.length < 2 || evidenceRef.length > 200) return
    const kind = actionKind
    setActionSubmitting(true)
    setActionError(null)
    try {
      const updated =
        kind === 'verify'
          ? await verifySettlementPayment(csrfToken, statement.id, actionRecord.id, {
              eventIdempotencyKey: actionKey,
              evidenceRef,
            })
          : await disputeSettlementPayment(csrfToken, statement.id, actionRecord.id, {
              eventIdempotencyKey: actionKey,
              evidenceRef,
            })
      // Re-render the whole payment section from the server's overview; the page
      // never flips a record to 已核销/争议 locally.
      onRecorded(updated)
      setActionKind(null)
      setActionRecord(null)
      actionForm.resetFields()
      message.success(
        kind === 'verify'
          ? '付款凭据已核验：状态与核销金额以服务端返回为准，核验不发起任何转账。'
          : '付款凭据已标记争议：状态与总览以服务端返回为准，不会发起任何转账。',
      )
    } catch (cause: unknown) {
      setActionError(
        describeLocalError(cause, kind === 'verify' ? '核验付款凭据失败' : '标记付款争议失败'),
      )
      // A 409 means the server's truth changed (already reviewed / not locked /
      // key reused): refresh from the server instead of guessing a rollback.
      if (isLocalApiError(cause) && cause.status === 409) onRetry()
    } finally {
      setActionSubmitting(false)
    }
  }

  const recordColumns: ColumnsType<PaymentRecord> = isAdmin
    ? [
        ...paymentRecordColumns,
        {
          title: '操作',
          key: 'actions',
          render: (_value, row) =>
            row.state === 'pending_review' ? (
              <Space size={0} wrap>
                <Button type="link" size="small" onClick={() => openAction('verify', row)}>
                  核验
                </Button>
                <Button
                  type="link"
                  size="small"
                  danger
                  onClick={() => openAction('dispute', row)}
                >
                  标记争议
                </Button>
              </Space>
            ) : (
              <Typography.Text type="secondary">无可用操作</Typography.Text>
            ),
        },
      ]
    : paymentRecordColumns

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <PageInfoAlert
        type="info"
        showIcon
        title="登记付款凭据 ≠ 复核核销"
        description="登记只录入真实线下付款凭据，不触发任何转账；锁定 ≠ 已付，凭据登记 ≠ 已核销。核验与标记争议仅由管理员在凭据列表逐条执行，二次确认后也只会改变该凭据的付款状态，绝不发起任何转账。金额与受款人必须来自真实线下付款凭据。"
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          title="付款凭据总览加载失败"
          description={describeLocalError(error, '付款凭据总览加载失败')}
          action={
            <Button size="small" onClick={onRetry}>
              重试
            </Button>
          }
        />
      ) : loading || overview === null ? (
        <div className="ledger-candidate-loading" aria-live="polite">
          <Spin />
          <Typography.Text type="secondary">正在读取付款凭据总览…</Typography.Text>
        </div>
      ) : (
        <>
          <section className="local-section" aria-label="付款总览">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="总览状态">
                {SETTLEMENT_PAYMENT_STATE_LABELS[overview.state]}
              </Descriptions.Item>
              <Descriptions.Item label="应付（服务端）">
                {formatCents(overview.payableCents)}
              </Descriptions.Item>
              <Descriptions.Item label="已登记（服务端）">
                {formatCents(overview.recordedCents)}
              </Descriptions.Item>
              <Descriptions.Item label="核销（服务端）">
                {formatCents(overview.verifiedCents)}
              </Descriptions.Item>
            </Descriptions>
          </section>

          <section className="local-section" aria-label="受款人">
            <Typography.Text strong>受款人（真实登记主体）</Typography.Text>
            <Table
              rowKey="partyId"
              size="small"
              pagination={false}
              scroll={{ x: 'max-content' }}
              dataSource={overview.beneficiaries}
              columns={beneficiaryColumns}
              style={{ marginTop: 8 }}
              locale={{
                emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无受款人" />,
              }}
            />
          </section>

          <section className="local-section" aria-label="付款凭据记录">
            <Typography.Text strong>已登记付款凭据</Typography.Text>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              scroll={{ x: 'max-content' }}
              dataSource={overview.records}
              columns={recordColumns}
              style={{ marginTop: 8 }}
              locale={{
                emptyText: (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未登记付款凭据" />
                ),
              }}
            />
          </section>

          <section className="local-section" aria-label="付款事件">
            <Typography.Text strong>付款事件（按 sequence 只读）</Typography.Text>
            {overview.events.length === 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                暂无付款事件。
              </Typography.Paragraph>
            ) : (
              <Space orientation="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                {[...overview.events]
                  .sort((left, right) => left.sequence - right.sequence)
                  .map((event) => (
                    <div key={event.id} className="ledger-diff-finding">
                      <Tag>{PAYMENT_EVENT_KIND_LABELS[event.kind]}</Tag>
                      <span>sequence {event.sequence}</span>
                      <Typography.Text className="ledger-cell-mono">
                        {event.actorUserId}
                      </Typography.Text>
                      <span className="ledger-diff-finding-detail">
                        {event.evidenceRef ?? '服务端未返回依据'} ·{' '}
                        {SETTLEMENT_PAYMENT_RECORD_STATE_LABELS[event.state]} ·{' '}
                        {formatDateTime(event.createdAt)}
                      </span>
                    </div>
                  ))}
              </Space>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              历史事件只读：记录谁在什么时候做了什么（sequence / actorUserId / evidenceRef / 时间），本视图不提供编辑或删除。
            </Typography.Paragraph>
          </section>

          {!isAdmin ? (
            <PageInfoAlert
              type="info"
              showIcon
              title="运营员只读"
              description="登记线下付款凭据仅管理员可用；服务端按角色强制校验，本视图不提供登记、核验或争议入口。"
            />
          ) : statement.status !== 'locked' ? (
            <Alert
              type="warning"
              showIcon
              title="只有已锁定的结算单才能登记线下付款凭据"
              description="草案或已复核但未锁定的结算单只能查看付款总览；锁定后快照冻结，才允许登记线下凭据。"
            />
          ) : (
            <section className="local-section" aria-label="登记付款凭据">
              <Typography.Text strong>登记线下付款凭据（仅管理员）</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                这里只登记真实线下付款凭据，不发起转账；登记后记录为「待复核」，需由独立管理员核验，页面不会把登记显示成已核销。
              </Typography.Paragraph>
              {submitError ? (
                <Alert
                  type="error"
                  showIcon
                  title="凭据未登记"
                  description={submitError}
                  style={{ marginBottom: 12 }}
                />
              ) : null}
              <Form<PaymentFormValues>
                form={form}
                layout="vertical"
                onFinish={(values) => void submit(values)}
              >
                <Form.Item
                  name="beneficiaryPartyId"
                  label="受款人"
                  rules={[{ required: true, message: '请选择受款人' }]}
                >
                  <Select
                    placeholder="请选择受款人"
                    options={overview.beneficiaries.map((beneficiary) => ({
                      value: beneficiary.partyId,
                      label: `${beneficiary.legalName} · ${SETTLEMENT_PARTY_ROLE_LABELS[beneficiary.role]}`,
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  name="amountCents"
                  label="付款金额（整数分）"
                  rules={[
                    { required: true, message: '请填写付款金额（整数分）' },
                    {
                      validator: (_rule: unknown, value: unknown): Promise<void> => {
                        if (value === undefined || value === null) return Promise.resolve()
                        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
                          return Promise.reject(new Error('金额必须是大于 0 的整数分'))
                        }
                        return Promise.resolve()
                      },
                    },
                  ]}
                  tooltip="1 元 = 100 分，只填整数分；页面不做元/分浮点换算。"
                >
                  <InputNumber
                    min={1}
                    precision={0}
                    style={{ width: '100%' }}
                    placeholder="整数分（1 元 = 100 分）"
                  />
                </Form.Item>
                <Form.Item
                  name="paidAt"
                  label="付款时间"
                  rules={[{ required: true, whitespace: true, message: '请填写付款时间' }]}
                  tooltip="按浏览器本地时区选择；提交时转换为带时区的 ISO 时间字符串。"
                >
                  <Input type="datetime-local" />
                </Form.Item>
                <Form.Item
                  name="proofRefMasked"
                  label="脱敏付款凭据引用"
                  rules={[
                    { required: true, whitespace: true, message: '请填写脱敏凭据引用' },
                    {
                      validator: (_rule: unknown, value: unknown): Promise<void> => {
                        const text = typeof value === 'string' ? value.trim() : ''
                        if (text === '') return Promise.resolve()
                        if (text.length < 4 || text.length > 160) {
                          return Promise.reject(new Error('脱敏凭据引用需 4-160 个字符'))
                        }
                        if (hasLongDigitRun(text)) {
                          return Promise.reject(new Error(LONG_DIGIT_MESSAGE))
                        }
                        return Promise.resolve()
                      },
                    },
                  ]}
                  tooltip="只填写脱敏引用（如凭据编号/流水尾号），不得填写完整银行卡号、账号或任何 12 位以上连续数字。"
                >
                  <Input maxLength={160} placeholder="例如 BANK-20261101-001（脱敏引用）" />
                </Form.Item>
              </Form>
              <Space wrap size={8}>
                <Button
                  type="primary"
                  loading={submitting}
                  disabled={submitting}
                  onClick={() => void form.submit()}
                >
                  登记付款凭据
                </Button>
                <Button onClick={startNewIntent} disabled={submitting}>
                  新建凭据
                </Button>
              </Space>
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                本次幂等键：
                <span className="ledger-cell-mono" data-testid="payment-idempotency-key">
                  {idempotencyKey}
                </span>
                （重试失败提交会复用同一键；只有登记成功或点「新建凭据」才更换）
              </Typography.Paragraph>
            </section>
          )}

          {isAdmin ? (
            <Modal
              title={
                actionKind === 'verify' ? '核验付款凭据（人工核验）' : '标记付款争议'
              }
              open={actionKind !== null}
              onCancel={closeAction}
              onOk={() => actionForm.submit()}
              okText={actionKind === 'verify' ? '确认核验' : '确认标记争议'}
              cancelText="取消"
              confirmLoading={actionSubmitting}
              destroyOnHidden
            >
              {actionRecord ? (
                <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
                  <Descriptions.Item label="凭据金额">
                    {formatCents(actionRecord.amountCents)}
                  </Descriptions.Item>
                  <Descriptions.Item label="付款时间">
                    {formatDateTime(actionRecord.paidAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="脱敏凭据引用">
                    {actionRecord.proofRefMasked}
                  </Descriptions.Item>
                  <Descriptions.Item label="当前状态">
                    {SETTLEMENT_PAYMENT_RECORD_STATE_LABELS[actionRecord.state]}
                  </Descriptions.Item>
                  <Descriptions.Item label="登记人">
                    <Typography.Text className="ledger-cell-mono" style={{ fontSize: 12 }}>
                      {actionRecord.recorderUserId}
                    </Typography.Text>
                  </Descriptions.Item>
                </Descriptions>
              ) : null}

              {actionKind === 'verify' ? (
                <PageInfoAlert inline
                  type="info"
                  showIcon
                  title="核验会改变这条凭据的付款状态并计入核销统计"
                  description="确认后该凭据从待复核变为已核销，进入核销金额统计；这不发起任何转账，也不是付款动作。登记人不能核验自己登记的凭据，独立性由服务端强制。"
                  style={{ marginBottom: 12 }}
                />
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  title="标记争议会改变该凭据状态并影响总览"
                  description="确认后该凭据置为争议，并影响付款总览的已登记/核销统计；不会发起任何转账，也不会改写历史事件。"
                  style={{ marginBottom: 12 }}
                />
              )}

              {actionError ? (
                <Alert
                  type="error"
                  showIcon
                  title={actionKind === 'verify' ? '核验未完成' : '争议未标记'}
                  description={actionError}
                  style={{ marginBottom: 12 }}
                />
              ) : null}

              <Form<ActionFormValues>
                form={actionForm}
                layout="vertical"
                onFinish={(values) => void submitAction(values)}
              >
                <Form.Item
                  name="evidenceRef"
                  label={actionKind === 'verify' ? '核验依据' : '争议依据'}
                  rules={evidenceRule(actionKind === 'verify' ? '核验依据' : '争议依据')}
                  tooltip="人工填写的可核对依据（2-200 字），页面不预填。"
                >
                  <Input maxLength={200} placeholder="人工填写依据，不预填" />
                </Form.Item>
              </Form>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                本次事件幂等键：
                <span className="ledger-cell-mono" data-testid="payment-action-idempotency-key">
                  {actionKey}
                </span>
                （失败重试复用同一键；成功后重新操作才生成新键）
              </Typography.Paragraph>
            </Modal>
          ) : null}
        </>
      )}
    </Space>
  )
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}
