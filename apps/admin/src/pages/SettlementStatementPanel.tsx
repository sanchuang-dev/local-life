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
import { useEffect, useState } from 'react'
import type {
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
  SETTLEMENT_PAYMENT_STATE_LABELS,
  SETTLEMENT_STATEMENT_STATUS_LABELS,
  createSettlementStatement,
  downloadSettlementCsv,
  getSettlementStatement,
  listSettlementStatements,
  lockSettlementStatement,
  reviewSettlementStatement,
} from '../services/settlement'
import './ledger.css'

/**
 * 分成结算单 · 结算单列表、草案生成与只读明细（LL-SET-011A / Issue #223）。
 *
 * 本卡只做「快照的生成与查看」，不提前提供后续卡的能力：
 *
 * - 结算单是某一时刻的快照；**生成草案 ≠ 锁定 ≠ 付款**。本视图没有复核、锁单、
 *   导出 CSV 或登记付款按钮（#224/#225/#226 才提供），也没有任何本地金额计算。
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

  const openDetail = (row: SettlementStatement) => {
    setDetailRow(row)
    setDetailId(row.id)
    setDetailTab('lines')
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
      <Alert
        type="info"
        showIcon
        title="结算单是快照 · 生成草案 ≠ 锁定 ≠ 付款"
        description="结算单是快照；生成草案 ≠ 锁定 ≠ 付款。状态与金额全部来自服务端。锁定由后续卡提供，本视图不提供锁单、复核、导出或登记付款按钮。"
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
        <Alert
          type="info"
          showIcon
          title="草案不是锁定，也不是付款"
          description="草案按所选业务期间生成快照；生成后仍可能需要复核与锁定（后续卡），本页不会自动锁定或登记付款。"
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
            <StatementDetail detail={detail} tab={detailTab} onTabChange={setDetailTab} />
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
            <Alert
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
}: {
  detail: SettlementStatementDetail
  tab: string
  onTabChange: (key: string) => void
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
      <Alert
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
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}
