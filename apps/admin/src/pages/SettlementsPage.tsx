import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Result,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo, useState } from 'react'
import type {
  LedgerAnomaly,
  LedgerEntry,
  ReconciliationBatch,
  ReconciliationDiff,
  ReconciliationDiffReason,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import type { AuthenticatedSession } from '../services/auth'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import {
  LEDGER_ANOMALY_KIND_LABELS,
  LEDGER_ANOMALY_SEVERITY_LABELS,
  LEDGER_EVIDENCE_KIND_LABELS,
  LEDGER_FACT_KIND_LABELS,
  LEDGER_FACT_KIND_NOTES,
  LEDGER_SOURCE_SYSTEM_LABELS,
  SETTLEMENT_AMOUNT_STATUS_LABELS,
  createReconciliationBatch,
  downloadLedgerCsv,
  formatCents,
  formatDateTime,
  getReconciliationDiff,
  listReconciliationBatchEntries,
  listReconciliationBatches,
  lockReconciliationBatch,
} from '../services/ledger'
import { SettlementCandidatePanel } from './SettlementCandidatePanel'
import { SettlementPartyPanel } from './SettlementPartyPanel'
import './ledger.css'

/**
 * 对账结算 — reconciliation batches, their diff and the CSV export (#64).
 *
 * What this page deliberately does *not* do:
 *
 * - This page adds only a read-only settlement candidate view, never a payable
 *   computation. The candidate DTO reports `pending_rule` / null, irrespective
 *   of contract records elsewhere. A reconciliation batch never pays out.
 * - No client-side arithmetic across the two diff blocks. 未纳入（待办） and
 *   锁后补录（既成事实） are disjoint by construction, and adding them would
 *   produce a number nobody can act on.
 * - No second order system, no online payment, no auto-splitting: the batch is
 *   derived from facts that other cards already wrote.
 *
 * `grid_worker` is rejected by `/admin/reconciliation/*` on the server; the page
 * therefore shows an explicit 403 screen instead of an empty list.
 */

const BATCH_STATUS_META = {
  open: { label: '开放中 · 可继续核对', color: 'gold' },
  locked: { label: '已锁定 · 金额与归属冻结', color: 'green' },
} as const

const DIFF_REASON_META: Record<ReconciliationDiffReason, { label: string; hint: string }> = {
  pending_attribution: {
    label: '待归属',
    hint: '该笔流水没有明确的业绩归属，不能计入任何人的业绩',
  },
  open_anomaly: { label: '未处理异常', hint: '异常仍需人工复核；复核不会修改流水本身' },
  reversal_original_outside_period: {
    label: '跨期冲正',
    hint: '冲正在本期间，被冲正的原流水不在本期间',
  },
  batch_totals_drift: { label: '合计漂移', hint: '批次行冻结的合计与明细复算不一致' },
  late_recorded_after_lock: {
    label: '锁后补录',
    hint: '发生在已锁定期间内，但在锁定之后才补录，未计入批次合计',
  },
  empty_period: { label: '空期间', hint: '该期间没有任何流水，锁定前请确认不是漏记' },
}

const SEVERITY_COLOR = { low: 'default', medium: 'orange', high: 'red' } as const

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

function batchErrorTitle(error: Error | null, fallback: string): string {
  if (isLocalApiError(error)) {
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return '没有对账权限'
  }
  return fallback
}

export function SettlementsPage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="对账结算"
          description="对账批次、差异核对与导出仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有对账结算权限"
            subTitle="后台 /admin/reconciliation/* 拒绝网格员；即使直接访问该地址，服务端同样返回 403。对账与导出是后台动作，网格员只在自己的工作台查看社区流水。"
          />
        </div>
      </div>
    )
  }

  return <SettlementConsole session={session} />
}

function SettlementConsole({ session }: { session: AuthenticatedSession }) {
  const { message, modal } = AntdApp.useApp()

  /* ------------------------------- page tabs ------------------------------- */

  /**
   * Two views of the same page. The state is intentionally local: #188 adds no
   * route, no query parameter and no level-one navigation, so browser back still
   * leaves the page instead of replaying a tab. The candidate panel is mounted
   * lazily on its first activation, which also keeps the reconciliation view's
   * existing requests (and its regression tests) untouched until a human asks
   * for 分成结算单.
   */
  const [tab, setTab] = useState<'reconciliation' | 'candidates'>('reconciliation')
  const [candidatesMounted, setCandidatesMounted] = useState(false)

  const switchTab = (key: string) => {
    const next = key === 'candidates' ? 'candidates' : 'reconciliation'
    if (next === 'candidates') setCandidatesMounted(true)
    setTab(next)
  }

  /**
   * 分成结算单 has its own two views (#219): the read-only candidate board and the
   * real-party directory. `parties` is mounted only after a human selects it, so
   * opening 分成结算单 never issues a party request nobody asked for.
   */
  const [settlementView, setSettlementView] = useState<'candidates' | 'parties'>('candidates')
  const [partiesMounted, setPartiesMounted] = useState(false)

  const switchSettlementView = (key: string) => {
    const next = key === 'parties' ? 'parties' : 'candidates'
    if (next === 'parties') setPartiesMounted(true)
    setSettlementView(next)
  }

  /* ------------------------------- batch list ------------------------------ */

  const [batches, setBatches] = useState<ReconciliationBatch[]>([])
  const [batchesLoading, setBatchesLoading] = useState(true)
  const [batchesError, setBatchesError] = useState<Error | null>(null)
  const [batchesAsOf, setBatchesAsOf] = useState<string | null>(null)
  const [listToken, setListToken] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setBatchesLoading(true)
    setBatchesError(null)
    listReconciliationBatches(controller.signal)
      .then((result) => {
        if (!active) return
        setBatches(result.items)
        setBatchesAsOf(result.asOf)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setBatches([])
        setBatchesAsOf(null)
        setBatchesError(cause instanceof Error ? cause : new Error('对账批次加载失败'))
      })
      .finally(() => {
        if (active) setBatchesLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [listToken])

  const refreshBatches = () => setListToken((value) => value + 1)

  /* ------------------------------ create batch ----------------------------- */

  const [createOpen, setCreateOpen] = useState(false)
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo, setPeriodTo] = useState('')
  const [createNote, setCreateNote] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const openCreate = () => {
    setPeriodFrom('')
    setPeriodTo('')
    setCreateNote('')
    setCreateError(null)
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    const from = periodFrom.trim()
    const to = periodTo.trim()
    if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
      setCreateError('期间必须填写为 YYYY-MM-DD 的业务日期（含首尾两天）。')
      return
    }
    if (to < from) {
      setCreateError('结束日期不能早于开始日期。')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const created = await createReconciliationBatch(session.csrfToken, {
        periodFrom: from,
        periodTo: to,
        ...(createNote.trim() ? { note: createNote.trim() } : {}),
      })
      setCreateOpen(false)
      message.success(
        `已创建开放批次 ${created.batchNo}（${created.periodFrom} ~ ${created.periodTo}，${created.entryCount} 笔）。开放批次仍可继续核对，锁定后金额与归属冻结。`,
      )
      refreshBatches()
    } catch (cause: unknown) {
      const description = describeLocalError(cause, '创建对账批次失败')
      setCreateError(description)
      if (isLocalApiError(cause) && cause.status === 409) {
        // A concurrent operator already opened this period: the list is stale, so
        // refreshing is part of the answer rather than a hidden retry.
        refreshBatches()
      }
    } finally {
      setCreating(false)
    }
  }

  /* --------------------------------- locking ------------------------------- */

  const [lockingId, setLockingId] = useState<string | null>(null)

  const confirmLock = (batch: ReconciliationBatch) => {
    modal.confirm({
      title: `锁定对账批次 ${batch.batchNo}？`,
      content: (
        <div className="local-confirm-body">
          <p>
            期间：{batch.periodFrom} ~ {batch.periodTo}（含首尾两天，按 Asia/Shanghai
            业务日计算）
          </p>
          <p>
            批次行合计：{batch.entryCount} 笔 / {formatCents(batch.totalCents)}（账面登记毛额）
          </p>
          <p>
            锁定后该期间成为冻结账目：合计与归属不再变化，之后补录的流水只能以「锁后补录」出现在差异页。
            锁定不可回退，也不产生任何应付金额——经营对账不负责计算合同分成。
          </p>
        </div>
      ),
      okText: '确认锁定',
      cancelText: '取消',
      onOk: () => performLock(batch),
    })
  }

  const performLock = async (batch: ReconciliationBatch) => {
    setLockingId(batch.batchId)
    try {
      const locked = await lockReconciliationBatch(session.csrfToken, batch.batchId, {
        expectedUpdatedAt: batch.updatedAt,
      })
      message.success(
        `批次 ${locked.batchNo} 已锁定（${formatDateTime(locked.lockedAt)}）。该期间合计已冻结，导出文件只含冻结成员。`,
      )
      refreshBatches()
      if (detailBatch?.batchId === locked.batchId) {
        // The drawer still shows the same batch, but its status / totals / lock
        // stamp just changed: swap in the server's row and force both reads to
        // re-run against the locked period.
        setDetailBatch(locked)
        setDiffToken((value) => value + 1)
        setEntriesToken((value) => value + 1)
      }
    } catch (cause: unknown) {
      if (isLocalApiError(cause)) {
        if (cause.code === 'ledger_batch_locked') {
          message.error(`该批次或期间已锁定：${cause.message}。已刷新批次列表。`)
        } else if (cause.status === 409) {
          message.error(`${cause.message}（数据已被更新，已刷新批次列表，请重新核对后再操作。）`)
        } else {
          message.error(describeLocalError(cause, '锁定对账批次失败'))
        }
        // 409 means somebody else changed the batch; showing a stale row would
        // invite a second blind attempt.
        if (cause.status === 409) refreshBatches()
        return
      }
      message.error(describeLocalError(cause, '锁定对账批次失败'))
    } finally {
      setLockingId(null)
    }
  }

  /* ---------------------------------- detail ------------------------------- */

  const [detailOpen, setDetailOpen] = useState(false)
  const [detailBatch, setDetailBatch] = useState<ReconciliationBatch | null>(null)
  const [diff, setDiff] = useState<ReconciliationDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffToken, setDiffToken] = useState(0)

  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [entriesTotal, setEntriesTotal] = useState(0)
  const [entriesPage, setEntriesPage] = useState(1)
  const [entriesPageSize, setEntriesPageSize] = useState(20)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [entriesError, setEntriesError] = useState<string | null>(null)
  const [entriesToken, setEntriesToken] = useState(0)

  /**
   * Opening the drawer only records which batch is on screen; the two reads below
   * are declared as effects so a retry, a page change and a lock-triggered
   * refresh all go through the same code path instead of three ad-hoc async
   * callbacks that could disagree about ordering.
   */
  const openDetail = (batch: ReconciliationBatch) => {
    setDetailBatch(batch)
    setDetailOpen(true)
    setEntriesPage(1)
  }

  const closeDetail = () => {
    setDetailOpen(false)
    setDetailBatch(null)
    setDiff(null)
    setDiffError(null)
    setEntries([])
    setEntriesTotal(0)
    setEntriesError(null)
  }

  /** The diff of the batch on screen; `null` while no drawer is open. */
  const detailBatchId = detailOpen ? (detailBatch?.batchId ?? null) : null

  useEffect(() => {
    if (detailBatchId === null) return
    let active = true
    const controller = new AbortController()
    setDiffLoading(true)
    setDiffError(null)
    getReconciliationDiff(detailBatchId, controller.signal)
      .then((result) => {
        if (active) setDiff(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setDiff(null)
        setDiffError(describeLocalError(cause, '无法读取对账差异'))
      })
      .finally(() => {
        if (active) setDiffLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [detailBatchId, diffToken])

  /** The batch's **frozen** members, paged. Not "every fact of the period". */
  useEffect(() => {
    if (detailBatchId === null) return
    let active = true
    const controller = new AbortController()
    setEntriesLoading(true)
    setEntriesError(null)
    listReconciliationBatchEntries(
      detailBatchId,
      { page: entriesPage, pageSize: entriesPageSize },
      controller.signal,
    )
      .then((result) => {
        if (!active) return
        setEntries(result.items)
        setEntriesTotal(result.total)
        // Trust the server's echoed paging (it may clamp `pageSize` at 100).
        setEntriesPage(result.page)
        setEntriesPageSize(result.pageSize)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setEntries([])
        setEntriesTotal(0)
        setEntriesError(describeLocalError(cause, '无法读取批次明细'))
      })
      .finally(() => {
        if (active) setEntriesLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [detailBatchId, entriesPage, entriesPageSize, entriesToken])

  /* --------------------------------- export -------------------------------- */

  const [exporting, setExporting] = useState(false)

  const performExport = async (batchId?: string) => {
    setExporting(true)
    try {
      const result = await downloadLedgerCsv(batchId ? { batchId } : {})
      const parts = [`已下载 ${result.filename}（${result.rowCount ?? '—'} 行）`]
      if (result.lateRecordedCount !== null && result.lateRecordedCount > 0) {
        // The frozen statement cannot contain post-lock facts, so a file that
        // silently omitted them would look complete. Say it out loud.
        parts.push(
          `另有 ${result.lateRecordedCount} 笔锁后补录（${
            result.lateRecordedTotalCents === null
              ? '金额未告知'
              : formatCents(result.lateRecordedTotalCents)
          }）不在文件内，请在差异页核对`,
        )
      }
      message.success(parts.join('；'))
    } catch (cause: unknown) {
      message.error(describeLocalError(cause, '导出 CSV 失败'))
    } finally {
      setExporting(false)
    }
  }

  const confirmWholeExport = () => {
    modal.confirm({
      title: '导出全部对账流水？',
      content: (
        <div className="local-confirm-body">
          <p>
            未选择批次时，服务端导出其全量口径文件（不是某一个期间的结算单）。文件是账面登记
            毛额的明细，不含任何应付、分账或打款金额。
          </p>
          <p>每次导出都会写一条导出审计记录。</p>
        </div>
      ),
      okText: '确认导出',
      cancelText: '取消',
      onOk: () => performExport(),
    })
  }

  /* -------------------------------- columns -------------------------------- */

  const batchColumns: ColumnsType<ReconciliationBatch> = [
    {
      title: '批次号',
      dataIndex: 'batchNo',
      key: 'batchNo',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong className="ledger-cell-mono">
            {row.batchNo}
          </Typography.Text>
          <Tag color={BATCH_STATUS_META[row.status].color}>{BATCH_STATUS_META[row.status].label}</Tag>
        </Space>
      ),
    },
    {
      title: '对账期间',
      key: 'period',
      render: (_value, row) => (
        <span className="ledger-batch-period">
          {row.periodFrom} ~ {row.periodTo}
        </span>
      ),
    },
    {
      title: '批次行合计',
      key: 'totals',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>{row.entryCount} 笔</span>
          <Typography.Text type="secondary">{formatCents(row.totalCents)} 账面毛额</Typography.Text>
        </Space>
      ),
    },
    {
      title: '锁定',
      key: 'lock',
      render: (_value, row) =>
        row.status === 'locked' ? (
          <Space orientation="vertical" size={2}>
            <span>{formatDateTime(row.lockedAt)}</span>
            <Typography.Text type="secondary">已冻结，不可回退</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">未锁定</Typography.Text>
        ),
    },
    {
      title: '备注',
      dataIndex: 'note',
      key: 'note',
      render: (_value, row) => row.note ?? '—',
    },
    {
      title: '操作',
      key: 'actions',
      render: (_value, row) => (
        <Space size={0} wrap>
          <Button type="link" size="small" onClick={() => void openDetail(row)}>
            查看差异
          </Button>
          <Button
            type="link"
            size="small"
            loading={exporting}
            onClick={() => void performExport(row.batchId)}
          >
            导出 CSV
          </Button>
          {row.status === 'open' ? (
            <Button
              type="link"
              size="small"
              danger
              loading={lockingId === row.batchId}
              onClick={() => confirmLock(row)}
            >
              锁定
            </Button>
          ) : null}
        </Space>
      ),
    },
  ]

  const entryColumns: ColumnsType<LedgerEntry> = [
    {
      title: '事实',
      key: 'fact',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Tag>{LEDGER_FACT_KIND_LABELS[row.factKind]}</Tag>
          <Typography.Text type="secondary" className="ledger-cell-mono">
            {row.sourceDisplayNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '账面毛额',
      key: 'amount',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>{formatCents(row.amountCents)}</span>
          <Typography.Text type="secondary">
            {SETTLEMENT_AMOUNT_STATUS_LABELS[row.settlementAmountStatus]}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '来源',
      dataIndex: 'sourceSystem',
      key: 'source',
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <span>{LEDGER_SOURCE_SYSTEM_LABELS[row.sourceSystem]}</span>
          <Typography.Text type="secondary">
            {LEDGER_EVIDENCE_KIND_LABELS[row.evidence.kind]}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '业务时间',
      dataIndex: 'occurredAt',
      key: 'occurredAt',
      render: (_value, row) => formatDateTime(row.occurredAt),
    },
  ]

  /* ------------------------------- diff view ------------------------------- */

  const unbatchedAvailable = useMemo(
    () =>
      diff !== null &&
      (diff.unbatchedCount !== undefined || diff.unbatchedEntries !== undefined),
    [diff],
  )

  const openAnomalies: LedgerAnomaly[] = useMemo(
    () =>
      diff?.openAnomalies
        ? [...diff.openAnomalies].sort(
            (left, right) =>
              severityRank(right.severity) - severityRank(left.severity) ||
              left.createdAt.localeCompare(right.createdAt),
          )
        : [],
    [diff],
  )

  const findings = useMemo(
    () =>
      diff
        ? [...diff.items].sort(
            (left, right) => severityRank(right.severity) - severityRank(left.severity),
          )
        : [],
    [diff],
  )

  return (
    <div className="page">
      <PageHeader
        title="对账结算"
        description="经营对账按业务日期间创建、锁定并导出账面明细；分成结算单是只读候选看板。两者都不在本页计算应付金额；候选接口的「待核定」不代表系统没有已核准合同或线下付款记录。"
        status={<Tag color="green">真实数据</Tag>}
        subnav={
          <Tabs
            activeKey={tab}
            onChange={switchTab}
            items={[
              { key: 'reconciliation', label: '经营对账' },
              { key: 'candidates', label: '分成结算单' },
            ]}
          />
        }
        extra={
          tab === 'reconciliation' ? (
            <Space wrap>
              <Button onClick={confirmWholeExport} loading={exporting}>
                导出全部 CSV
              </Button>
              <Button type="primary" onClick={openCreate}>
                新建对账批次
              </Button>
            </Space>
          ) : null
        }
      />

      <div className="page-stack">
        <div
          className="ledger-tabpanel"
          role="tabpanel"
          aria-label="经营对账"
          hidden={tab !== 'reconciliation'}
        >
          <Alert
            type="info"
            showIcon
            title="口径与边界"
            description="批次成员按「对账期间 + 社区范围」从不可变流水派生，系统不会回写流水；锁定只让合计与归属冻结。锁定之后补录的流水会以「锁后补录」出现在差异页，绝不会静默并入已冻结账目。"
          />

          {batchesError ? (
            <Alert
              type="error"
              showIcon
              title={batchErrorTitle(batchesError, '对账批次加载失败')}
              description={batchesError.message}
              action={
                <Button size="small" onClick={refreshBatches}>
                  重试
                </Button>
              }
            />
          ) : (
            <Card
              size="small"
              title="对账批次"
              extra={
                <Space wrap size={8}>
                  {batchesAsOf ? (
                    <Typography.Text type="secondary">
                      数据截至 {formatDateTime(batchesAsOf)}（Asia/Shanghai）
                    </Typography.Text>
                  ) : null}
                  <Button size="small" onClick={refreshBatches} loading={batchesLoading}>
                    刷新
                  </Button>
                </Space>
              }
            >
              <Table<ReconciliationBatch>
                rowKey={(row) => row.batchId}
                columns={batchColumns}
                dataSource={batches}
                loading={batchesLoading}
                size="small"
                pagination={false}
                scroll={{ x: 'max-content' }}
                locale={{
                  emptyText: batchesLoading ? null : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="还没有对账批次"
                    >
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                        先按一个业务日期间新建批次，核对完差异后再锁定。没有批次时，期间内的流水
                        处于「未纳入」状态。
                      </Typography.Paragraph>
                      <Button size="small" type="primary" onClick={openCreate}>
                        新建对账批次
                      </Button>
                    </Empty>
                  ),
                }}
              />
            </Card>
          )}

          <div className="ledger-note" role="note" aria-label="对账口径说明">
            <Typography.Text strong>对账口径说明</Typography.Text>
            <ul>
              <li>
                期间是<b>业务日期</b>（<code>YYYY-MM-DD</code>），按 Asia/Shanghai 解释，含首尾
                两天；跨月的期间同样闭合。
              </li>
              <li>
                <b>未纳入</b>是待办：期间内、但没有任何已锁定批次覆盖的流水；<b>锁后补录</b>是
                既成事实：期间被锁定、但流水在锁定之后才录入。两者按构造互斥，本页并列展示，
                <b>绝不相加</b>，也不据此推导应付或分账。
              </li>
              <li>
                差异结论清单每一项都是「必须有人处理」的判断；异常只是复核提示，复核不会修改
                流水本身。
              </li>
              <li>
                CSV 走独立下载通道（不是 JSON 接口）：文件为 UTF-8 BOM + CRLF，可直接用中文
                Excel 打开；每次导出都会留一条审计记录。
              </li>
            </ul>
          </div>
        </div>

        {candidatesMounted ? (
          <div
            className="ledger-tabpanel"
            role="tabpanel"
            aria-label="分成结算单"
            hidden={tab !== 'candidates'}
          >
            <Tabs
              size="small"
              activeKey={settlementView}
              onChange={switchSettlementView}
              items={[
                {
                  key: 'candidates',
                  label: '候选看板',
                  children: <SettlementCandidatePanel />,
                },
                {
                  key: 'parties',
                  label: '主体目录',
                  children: partiesMounted ? <SettlementPartyPanel /> : null,
                },
              ]}
            />
          </div>
        ) : null}
      </div>

      {/* --------------------------- create batch modal -------------------------- */}
      <Modal
        title="新建对账批次"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void submitCreate()}
        okText="创建开放批次"
        cancelText="取消"
        confirmLoading={creating}
        destroyOnHidden
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            期间按业务日期填写（含首尾两天，Asia/Shanghai）。新建的是<b>开放</b>批次，仍可继续
            核对；锁定后合计与归属才冻结。
          </Typography.Paragraph>
          <div>
            <label htmlFor="ledger-period-from">期间开始（含）</label>
            <Input
              id="ledger-period-from"
              type="date"
              value={periodFrom}
              placeholder="YYYY-MM-DD"
              onChange={(event) => setPeriodFrom(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="ledger-period-to">期间结束（含）</label>
            <Input
              id="ledger-period-to"
              type="date"
              value={periodTo}
              placeholder="YYYY-MM-DD"
              onChange={(event) => setPeriodTo(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="ledger-period-note">备注（可选）</label>
            <Input.TextArea
              id="ledger-period-note"
              value={createNote}
              maxLength={500}
              showCount
              rows={2}
              placeholder="例如：十一月第一周对账"
              onChange={(event) => setCreateNote(event.target.value)}
            />
          </div>
          {createError ? (
            <Alert type="error" showIcon title="批次未创建" description={createError} />
          ) : null}
        </Space>
      </Modal>

      {/* ------------------------------- detail drawer --------------------------- */}
      <Drawer
        title={detailBatch ? `对账差异 · ${detailBatch.batchNo}` : '对账差异'}
        size={720}
        open={detailOpen}
        onClose={closeDetail}
        rootClassName="local-drawer"
        destroyOnHidden
        extra={
          detailBatch ? (
            <Space wrap>
              <Button
                size="small"
                loading={exporting}
                onClick={() => void performExport(detailBatch.batchId)}
              >
                导出该批次 CSV
              </Button>
              {detailBatch.status === 'open' ? (
                <Button
                  size="small"
                  danger
                  loading={lockingId === detailBatch.batchId}
                  onClick={() => confirmLock(detailBatch)}
                >
                  锁定批次
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detailBatch ? (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <section className="local-section" aria-label="批次信息">
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="批次号">
                  <Space wrap>
                    <span className="ledger-cell-mono">{detailBatch.batchNo}</span>
                    <Tag color={BATCH_STATUS_META[detailBatch.status].color}>
                      {BATCH_STATUS_META[detailBatch.status].label}
                    </Tag>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="对账期间">
                  {detailBatch.periodFrom} ~ {detailBatch.periodTo}（含首尾，Asia/Shanghai）
                </Descriptions.Item>
                <Descriptions.Item label="批次行合计（冻结）">
                  {detailBatch.entryCount} 笔 / {formatCents(detailBatch.totalCents)} 账面毛额 ·{' '}
                  {SETTLEMENT_AMOUNT_STATUS_LABELS.pending_rule}
                </Descriptions.Item>
                <Descriptions.Item label="锁定时间">
                  {detailBatch.status === 'locked'
                    ? formatDateTime(detailBatch.lockedAt)
                    : '未锁定（可继续核对）'}
                </Descriptions.Item>
              </Descriptions>
            </section>

            <section className="local-section" aria-label="差异与待处理">
              <Typography.Text strong>差异与待处理</Typography.Text>
              {diffError ? (
                <Alert
                  style={{ marginTop: 12 }}
                  type="error"
                  showIcon
                  title="对账差异加载失败"
                  description={diffError}
                  action={
                    <Button size="small" onClick={() => setDiffToken((value) => value + 1)}>
                      重试
                    </Button>
                  }
                />
              ) : diff ? (
                <>
                  <div className="ledger-diff-period">
                    <Typography.Text type="secondary">
                      期间 {diff.periodFrom} ~ {diff.periodTo} · 数据截至{' '}
                      {formatDateTime(diff.asOf)}
                    </Typography.Text>
                  </div>
                  <div className="ledger-diff-grid">
                    <div className="ledger-diff-block" data-tone="todo">
                      <div className="ledger-diff-block-title">
                        <Typography.Text strong>未纳入（待办）</Typography.Text>
                        <Tag color="gold">待处理</Tag>
                      </div>
                      {unbatchedAvailable ? (
                        <div className="ledger-diff-numbers">
                          <div>
                            <span className="ledger-diff-number-label">笔数</span>
                            <span className="ledger-diff-number-value">
                              {diff.unbatchedCount ?? diff.unbatchedEntries?.length ?? 0}
                            </span>
                          </div>
                          <div>
                            <span className="ledger-diff-number-label">账面毛额</span>
                            <span className="ledger-diff-number-value">
                              {formatCents(diff.unbatchedTotalCents ?? 0)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <Typography.Paragraph className="ledger-diff-hint">
                          服务端当前未返回「未纳入」的下钻笔数与明细（契约中该字段为可选）。请用下方
                          差异结论清单中的「待归属 / 未处理异常 / 跨期冲正」逐条核对；本页不会用
                          其他数字代填这一格。
                        </Typography.Paragraph>
                      )}
                      <p className="ledger-diff-hint">
                        期间内、但没有任何已锁定批次覆盖的流水。它是待办，靠继续核对并开批次来消化。
                      </p>
                    </div>

                    <div className="ledger-diff-block" data-tone="fact">
                      <div className="ledger-diff-block-title">
                        <Typography.Text strong>锁后补录（既成事实）</Typography.Text>
                        <Tag color="blue">不可回退</Tag>
                      </div>
                      <div className="ledger-diff-numbers">
                        <div>
                          <span className="ledger-diff-number-label">笔数</span>
                          <span className="ledger-diff-number-value">{diff.lateRecordedCount}</span>
                        </div>
                        <div>
                          <span className="ledger-diff-number-label">账面毛额</span>
                          <span className="ledger-diff-number-value">
                            {formatCents(diff.lateRecordedTotalCents)}
                          </span>
                        </div>
                      </div>
                      <p className="ledger-diff-hint">
                        冻结账目之后才补录的流水。它们不在冻结成员里，也不会并入「未纳入」让已锁定的
                        账看起来没锁；处置方式（拒收 / 并入下一期 / 标记异常）由对账动作决定。
                      </p>
                    </div>
                  </div>

                  <Typography.Paragraph type="secondary" className="ledger-diff-hint">
                    两块数字并列展示，服务端聚合，非前端求和；两列<b>不相加</b>，也不推导应付金额。
                  </Typography.Paragraph>

                  <div className="ledger-diff-numbers">
                    <div>
                      <span className="ledger-diff-number-label">批次行冻结</span>
                      <span className="ledger-diff-number-value">
                        {diff.stored
                          ? `${diff.stored.entryCount} 笔 / ${formatCents(diff.stored.totalCents)}`
                          : '无批次行'}
                      </span>
                    </div>
                    <div>
                      <span className="ledger-diff-number-label">按流水复算</span>
                      <span className="ledger-diff-number-value">
                        {diff.computed.entryCount} 笔 / {formatCents(diff.computed.totalCents)}
                      </span>
                    </div>
                    <div>
                      <span className="ledger-diff-number-label">结论</span>
                      <span className="ledger-diff-number-value">
                        {diff.stored &&
                        (diff.stored.entryCount !== diff.computed.entryCount ||
                          diff.stored.totalCents !== diff.computed.totalCents)
                          ? '合计漂移'
                          : '合计一致'}
                      </span>
                    </div>
                  </div>

                  <div className="ledger-diff-findings" aria-label="差异结论清单">
                    <Typography.Text strong>
                      差异结论清单（{diff.summary.total} 条：高 {diff.summary.high} · 中{' '}
                      {diff.summary.medium} · 低 {diff.summary.low}）
                    </Typography.Text>
                    {findings.length === 0 ? (
                      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                        该期间没有需要处理的差异结论。
                      </Typography.Paragraph>
                    ) : (
                      findings.map((item, index) => (
                        <div
                          key={`${item.reason}-${item.entryId ?? 'batch'}-${index}`}
                          className="ledger-diff-finding"
                        >
                          <Tag color={SEVERITY_COLOR[item.severity]}>
                            {LEDGER_ANOMALY_SEVERITY_LABELS[item.severity]}
                          </Tag>
                          <Tag>{DIFF_REASON_META[item.reason].label}</Tag>
                          {item.sourceDisplayNo ? (
                            <span className="ledger-cell-mono">{item.sourceDisplayNo}</span>
                          ) : null}
                          <span className="ledger-diff-finding-detail">{item.detail}</span>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="ledger-diff-findings" aria-label="未解决异常">
                    <Typography.Text strong>
                      未解决异常（
                      {diff.openAnomalies === undefined
                        ? '明细未返回'
                        : `${openAnomalies.length} 条`}
                      ）
                    </Typography.Text>
                    {openAnomalies.length === 0 ? (
                      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                        {diff.openAnomalies === undefined
                          ? '服务端未返回异常明细（契约中为可选字段）；同上，请以差异结论清单中的「未处理异常」为准。'
                          : '该期间没有未解决异常。'}
                      </Typography.Paragraph>
                    ) : (
                      openAnomalies.map((anomaly) => (
                        <div key={anomaly.anomalyId} className="ledger-diff-finding">
                          <Tag color={SEVERITY_COLOR[anomaly.severity]}>
                            {LEDGER_ANOMALY_SEVERITY_LABELS[anomaly.severity]}
                          </Tag>
                          <Tag>{LEDGER_ANOMALY_KIND_LABELS[anomaly.kind]}</Tag>
                          <span className="ledger-diff-finding-detail">
                            {anomaly.note ?? '未填写说明'}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                  {diffLoading ? '正在读取对账差异…' : '暂无对账差异数据'}
                </Typography.Paragraph>
              )}
            </section>

            <section className="local-section" aria-label="批次冻结成员">
              <Space wrap size={8} style={{ marginBottom: 8 }}>
                <Typography.Text strong>批次冻结成员</Typography.Text>
                <Typography.Text type="secondary">
                  共 {entriesTotal} 条 · 只含已冻结成员；锁后补录请看上方差异
                </Typography.Text>
              </Space>
              {entriesError ? (
                <Alert
                  type="error"
                  showIcon
                  title="批次明细加载失败"
                  description={entriesError}
                  action={
                    <Button size="small" onClick={() => setEntriesToken((value) => value + 1)}>
                      重试
                    </Button>
                  }
                />
              ) : (
                <Table<LedgerEntry>
                  rowKey={(row) => row.entryId}
                  columns={entryColumns}
                  dataSource={entries}
                  loading={entriesLoading}
                  size="small"
                  scroll={{ x: 'max-content' }}
                  pagination={{
                    current: entriesPage,
                    pageSize: entriesPageSize,
                    total: entriesTotal,
                    showSizeChanger: true,
                    showTotal: (amount) => `共 ${amount} 条`,
                  }}
                  onChange={(pagination) => {
                    const page = pagination.current ?? 1
                    const size = pagination.pageSize ?? entriesPageSize
                    // A page-size change starts again at page 1, exactly like the
                    // shared DataPanel does, so paging can never ask for a page
                    // the new size does not have.
                    setEntriesPageSize(size)
                    setEntriesPage(size === entriesPageSize ? page : 1)
                  }}
                  locale={{
                    emptyText: entriesLoading ? null : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="该批次还没有冻结成员"
                      >
                        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                          {LEDGER_FACT_KIND_NOTES.order_registered}
                        </Typography.Paragraph>
                      </Empty>
                    ),
                  }}
                />
              )}
            </section>
          </Space>
        ) : null}
      </Drawer>
    </div>
  )
}

function severityRank(severity: 'low' | 'medium' | 'high'): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1
}
