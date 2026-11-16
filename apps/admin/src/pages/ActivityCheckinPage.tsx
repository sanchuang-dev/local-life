import { PageInfoAlert } from '../components/PageInfoHelp'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityCheckin,
  AdminActivityCheckinList,
  AdminActivityRewardGrantRow,
  AdminActivityRewardOverview,
  AdminActivitySummary,
  RewardDisputeDecision,
  RewardGrantStatus,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { isActivityApiError, listActivities } from '../services/activities'
import {
  appendGrantDispute,
  getRewardOverview,
  listActivityCheckins,
  revokeCheckin,
  revokeRewardGrant,
  verifyCheckin,
} from '../services/rewards'
import type { AuthenticatedSession } from '../services/auth'
import './activities.css'

/**
 * 报名与核销 (LL-MVP-006).
 *
 * Everything on this page is server data: the frozen reward plan, the prize
 * stock/budget projection, the real check-ins and the grants with their
 * one-time credentials. `planSource: 'none'` is rendered as "奖励未配置" instead
 * of a table of zeros, because a missing plan means the formal reward entry is
 * closed rather than "0 prizes".
 */

const STATUS_META: Record<RewardGrantStatus, { label: string; color: string }> = {
  granted: { label: '已发放待核销', color: 'blue' },
  redeemed: { label: '已核销', color: 'green' },
  revoked: { label: '已撤销', color: 'red' },
  expired: { label: '已过期', color: 'default' },
  disputed: { label: '争议中', color: 'orange' },
  reversed: { label: '已反转', color: 'purple' },
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return DATE_TIME_FORMATTER.format(date).replace(/\//g, '-')
}

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `¥${(cents / 100).toFixed(2)}`
}

function describeError(cause: unknown, fallback: string): string {
  if (isActivityApiError(cause)) {
    switch (cause.status) {
      case 401:
        return `登录状态已失效：${cause.message}。请重新登录后重试。`
      case 403:
        return `没有该社区的核销权限：${cause.message}`
      case 404:
        return `对象不存在或已失效：${cause.message}`
      case 409:
        return `状态冲突：${cause.message}`
      default:
        return cause.message || fallback
    }
  }
  return cause instanceof Error ? cause.message : fallback
}

type ReasonAction =
  | { kind: 'revoke-checkin'; checkin: ActivityCheckin }
  | { kind: 'revoke-grant'; grant: AdminActivityRewardGrantRow }
  | {
      kind: 'dispute'
      grant: AdminActivityRewardGrantRow
      decision: RewardDisputeDecision
    }

export function ActivityCheckinPage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="报名与核销"
          description="核销与奖励履约仅对管理员与运营员开放；网格员请使用移动端工作台的现场核验入口。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有报名与核销权限"
            subTitle="即使直接访问该地址，服务端同样会拒绝网格员的奖励履约请求，并记录审计。"
          />
        </div>
      </div>
    )
  }

  return <CheckinConsole session={session} />
}

function CheckinConsole({ session }: { session: AuthenticatedSession }) {
  const { message } = AntdApp.useApp()
  const [activities, setActivities] = useState<AdminActivitySummary[]>([])
  const [activitiesLoading, setActivitiesLoading] = useState(true)
  const [activitiesError, setActivitiesError] = useState<string | null>(null)
  const [activityId, setActivityId] = useState<string | null>(null)

  const [overview, setOverview] = useState<AdminActivityRewardOverview | null>(null)
  const [checkins, setCheckins] = useState<AdminActivityCheckinList | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const [actionError, setActionError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null)
  const requestRef = useRef(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setActivitiesLoading(true)
    setActivitiesError(null)
    listActivities({ page: 1, pageSize: 50 }, controller.signal)
      .then((result) => {
        if (!active) return
        setActivities(result.items)
        setActivityId((current) => current ?? result.items[0]?.id ?? null)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setActivitiesError(describeError(cause, '无法读取活动列表'))
      })
      .finally(() => {
        if (active) setActivitiesLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (!activityId) {
      setOverview(null)
      setCheckins(null)
      return
    }
    const request = requestRef.current + 1
    requestRef.current = request
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)

    Promise.all([
      getRewardOverview(activityId, controller.signal),
      listActivityCheckins(activityId, controller.signal),
    ])
      .then(([nextOverview, nextCheckins]) => {
        if (requestRef.current !== request) return
        setOverview(nextOverview)
        setCheckins(nextCheckins)
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== request || controller.signal.aborted) return
        setOverview(null)
        setCheckins(null)
        setLoadError(describeError(cause, '无法读取奖励履约数据'))
      })
      .finally(() => {
        if (requestRef.current === request) setLoading(false)
      })

    return () => controller.abort()
  }, [activityId, reloadToken])

  const selectedActivity = activities.find((item) => item.id === activityId) ?? null
  const planConfigured = overview?.planConfigured === true

  const runAction = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusyKey(key)
    setActionError(null)
    try {
      await action()
      message.success(success)
      reload()
      return true
    } catch (cause) {
      setActionError(describeError(cause, '操作未完成'))
      return false
    } finally {
      setBusyKey(null)
    }
  }

  const confirmReason = async (reason: string, note?: string) => {
    if (!reasonAction || !activityId) return
    const action = reasonAction
    const ok = await runAction(
      `reason:${action.kind}`,
      () => {
        if (action.kind === 'revoke-checkin') {
          return revokeCheckin(session.csrfToken, activityId, action.checkin.id, reason)
        }
        if (action.kind === 'revoke-grant') {
          return revokeRewardGrant(session.csrfToken, activityId, action.grant.grant.id, reason)
        }
        return appendGrantDispute(
          session.csrfToken,
          activityId,
          action.grant.grant.id,
          action.decision,
          reason,
          note,
        )
      },
      action.kind === 'revoke-checkin'
        ? '签到已撤销'
        : action.kind === 'revoke-grant'
          ? '奖励授予已撤销'
          : '争议记录已追加',
    )
    if (ok) setReasonAction(null)
  }

  const verify = (checkin: ActivityCheckin) => {
    if (!activityId) return
    void runAction(
      `verify:${checkin.id}`,
      () => verifyCheckin(session.csrfToken, activityId, checkin.id),
      '已核验，该签到计入奖励进度',
    )
  }

  const tabItems = [
    {
      key: 'checkins',
      label: `签到核验${checkins ? `（${checkins.counts.pendingVerification} 待核验）` : ''}`,
      children: (
        <CheckinTable
          checkins={checkins}
          loading={loading}
          busyKey={busyKey}
          onVerify={verify}
          onRevoke={(checkin) => setReasonAction({ kind: 'revoke-checkin', checkin })}
        />
      ),
    },
    {
      key: 'grants',
      label: `奖励列表${overview ? `（${overview.counts.grantsTotal}）` : ''}`,
      children: (
        <GrantTable
          overview={overview}
          loading={loading}
          busyKey={busyKey}
          planConfigured={planConfigured}
          onRevoke={(grant) => setReasonAction({ kind: 'revoke-grant', grant })}
          onDispute={(grant, decision) => setReasonAction({ kind: 'dispute', grant, decision })}
        />
      ),
    },
    {
      key: 'records',
      label: '核销记录',
      children: <RedemptionTable overview={overview} loading={loading} />,
    },
    {
      key: 'exceptions',
      label: '异常处理',
      children: (
        <ExceptionPanel
          overview={overview}
          checkins={checkins}
          loading={loading}
          busyKey={busyKey}
          onDispute={(grant, decision) => setReasonAction({ kind: 'dispute', grant, decision })}
          onRevokeGrant={(grant) => setReasonAction({ kind: 'revoke-grant', grant })}
        />
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="报名与核销"
        description="真实签到核验、团队奖励资格、奖品库存与预算、一次性核销凭据与追加式争议审计。奖励计划来自发布时冻结的规则版本。"
      />

      <div className="page-stack">
        {activitiesError ? (
          <Alert
            type="error"
            showIcon
            title="活动列表加载失败"
            description={activitiesError}
            action={
              <Button size="small" onClick={() => setReloadToken((token) => token + 1)}>
                重试
              </Button>
            }
          />
        ) : null}

        <Card size="small">
          <Space wrap size={12} align="center">
            <Typography.Text strong>选择活动</Typography.Text>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ minWidth: 320, maxWidth: '100%' }}
              loading={activitiesLoading}
              placeholder={activitiesLoading ? '正在读取活动…' : '选择活动'}
              value={activityId ?? undefined}
              onChange={(value: string) => setActivityId(value)}
              options={activities.map((activity) => ({
                value: activity.id,
                label: `${activity.title} · ${activity.community.name} · ${
                  activity.status === 'published'
                    ? '已发布'
                    : activity.status === 'draft'
                      ? '草稿'
                      : activity.status === 'paused'
                        ? '已暂停'
                        : '已结束'
                }${activity.ruleVersion ? ` · v${activity.ruleVersion}` : ''}`,
              }))}
              notFoundContent={
                activitiesLoading ? '正在读取活动…' : '当前授权社区内没有活动'
              }
            />
            <Button onClick={reload} loading={loading} disabled={!activityId}>
              刷新
            </Button>
          </Space>
        </Card>

        {loadError ? (
          <Alert
            type="error"
            showIcon
            title="奖励履约数据加载失败"
            description={loadError}
            action={
              <Button size="small" onClick={reload}>
                重试
              </Button>
            }
          />
        ) : null}

        {actionError ? (
          <Alert
            type="error"
            showIcon
            closable={{ onClose: () => setActionError(null) }}
            title="操作未完成"
            description={actionError}
          />
        ) : null}

        {!activityId && !loading && !activitiesLoading && activities.length === 0 ? (
          <Empty description="当前授权社区内没有可核销的活动。活动发布后才会冻结奖励规则。" />
        ) : null}

        {loading && !overview ? (
          <div className="activity-drawer-loading">
            <Spin description="正在读取奖励履约数据…" />
          </div>
        ) : null}

        {overview ? (
          <>
            {!planConfigured ? (
              <Alert
                type="warning"
                showIcon
                title="该活动未配置奖励计划"
                description="冻结快照里没有 rewardPlan，因此签到、达标、领奖与核销的正式入口都不可用（不会回退读取活动表里的可变字段）。请管理员在活动草稿阶段补齐奖励计划后重新发布。"
              />
            ) : (
              <>
                <OverviewStats overview={overview} />
                <PlanCard overview={overview} />
              </>
            )}

            <Card size="small" title="签到与奖励">
              <Tabs items={tabItems} />
            </Card>
          </>
        ) : null}

        {selectedActivity ? (
          <Typography.Text type="secondary">
            当前活动：{selectedActivity.title}（{selectedActivity.community.name}）
          </Typography.Text>
        ) : null}
      </div>

      <ReasonModal
        action={reasonAction}
        busy={busyKey?.startsWith('reason:') === true}
        onCancel={() => setReasonAction(null)}
        onSubmit={confirmReason}
      />
    </div>
  )
}

function OverviewStats({ overview }: { overview: AdminActivityRewardOverview }) {
  const stock = overview.stock
  return (
    <Row gutter={[12, 12]}>
      <Col xs={12} md={6}>
        <Card size="small">
          <Statistic title="有效签到" value={overview.counts.checkinsValid} suffix="条" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已核验 {overview.counts.checkinsVerified} · 待核验{' '}
            {overview.counts.checkinsPendingVerification}
          </Typography.Text>
        </Card>
      </Col>
      <Col xs={12} md={6}>
        <Card size="small">
          <Statistic title="已发放奖励" value={overview.counts.grantsTotal} suffix="份" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已核销 {overview.counts.grantsRedeemed} · 争议 {overview.counts.grantsDisputed}
          </Typography.Text>
        </Card>
      </Col>
      <Col xs={12} md={6}>
        <Card size="small">
          <Statistic
            title="剩余库存"
            value={stock ? stock.availableQuantity : 0}
            suffix={stock ? `/ ${stock.totalQuantity}` : undefined}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已承诺 {stock?.claimedQuantity ?? 0} · 已核销 {stock?.redeemedQuantity ?? 0}
          </Typography.Text>
        </Card>
      </Col>
      <Col xs={12} md={6}>
        <Card size="small">
          <Statistic
            title="剩余预算"
            value={stock ? stock.remainingBudgetCents / 100 : 0}
            precision={2}
            prefix="¥"
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            上限 {formatCents(stock?.budgetCapCents ?? 0)} · 已核销{' '}
            {formatCents(stock?.redeemedBudgetCents ?? 0)}
          </Typography.Text>
        </Card>
      </Col>
    </Row>
  )
}

function PlanCard({ overview }: { overview: AdminActivityRewardOverview }) {
  const plan = overview.plan
  if (!plan) return null
  return (
    <Card size="small" title="冻结的奖励计划">
      <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
        <Descriptions.Item label="奖品">{plan.prizeName}</Descriptions.Item>
        <Descriptions.Item label="单件成本">
          {formatCents(plan.prizeUnitCostCents)}
        </Descriptions.Item>
        <Descriptions.Item label="每团数量">{plan.prizeQuantityPerTeam}</Descriptions.Item>
        <Descriptions.Item label="总库存">{plan.totalPrizeQuantity}</Descriptions.Item>
        <Descriptions.Item label="预算上限">{formatCents(plan.budgetCapCents)}</Descriptions.Item>
        <Descriptions.Item label="领取人">
          {plan.claimRecipient === 'leader' ? '仅队长' : '任意团员'}
        </Descriptions.Item>
        <Descriptions.Item label="签到窗口">
          {formatDateTime(plan.checkinWindow.opensAt)} 至{' '}
          {formatDateTime(plan.checkinWindow.closesAt)}
        </Descriptions.Item>
        <Descriptions.Item label="核销有效期">
          {plan.redemptionValidHours} 小时
        </Descriptions.Item>
        <Descriptions.Item label="来源">
          规则版本快照
          {overview.ruleVersion ? ` v${overview.ruleVersion}` : ''}
        </Descriptions.Item>
      </Descriptions>
      {plan.notes ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          {plan.notes}
        </Typography.Paragraph>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        资格 = 团队满 3 席 + 该团成员 3 条<strong>已核验</strong>签到；自助签到未核验前不计入。
      </Typography.Text>
    </Card>
  )
}

function CheckinTable({
  checkins,
  loading,
  busyKey,
  onVerify,
  onRevoke,
}: {
  checkins: AdminActivityCheckinList | null
  loading: boolean
  busyKey: string | null
  onVerify: (checkin: ActivityCheckin) => void
  onRevoke: (checkin: ActivityCheckin) => void
}) {
  const columns: ColumnsType<ActivityCheckin> = [
    {
      title: '居民',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (value: string, row) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.seatNo !== null ? `${row.seatNo} 号位` : '未组队'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '签到时间',
      dataIndex: 'checkedInAt',
      key: 'checkedInAt',
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, row) =>
        row.status === 'revoked' ? (
          <Tag color="red">已撤销</Tag>
        ) : row.verifiedAt === null ? (
          <Tag color="orange">待核验</Tag>
        ) : (
          <Tag color="green">已核验</Tag>
        ),
    },
    {
      title: '核验 / 撤销信息',
      key: 'audit',
      render: (_, row) =>
        row.status === 'revoked' ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateTime(row.revokedAt)} · {row.revokeReason ?? '未填写原因'}
          </Typography.Text>
        ) : row.verifiedAt ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateTime(row.verifiedAt)}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            未核验不计入奖励进度
          </Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_, row) =>
        row.status === 'revoked' ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {row.verifiedAt === null ? (
              <Button
                size="small"
                type="primary"
                loading={busyKey === `verify:${row.id}`}
                onClick={() => onVerify(row)}
              >
                核验
              </Button>
            ) : null}
            <Button size="small" danger onClick={() => onRevoke(row)}>
              撤销
            </Button>
          </Space>
        ),
    },
  ]

  return (
    <Table<ActivityCheckin>
      size="small"
      rowKey="id"
      loading={loading}
      columns={columns}
      dataSource={checkins?.items ?? []}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: <Empty description="还没有签到记录" /> }}
    />
  )
}

function GrantTable({
  overview,
  loading,
  busyKey,
  planConfigured,
  onRevoke,
  onDispute,
}: {
  overview: AdminActivityRewardOverview | null
  loading: boolean
  busyKey: string | null
  planConfigured: boolean
  onRevoke: (grant: AdminActivityRewardGrantRow) => void
  onDispute: (grant: AdminActivityRewardGrantRow, decision: RewardDisputeDecision) => void
}) {
  if (!planConfigured) {
    return (
      <Empty description="未配置奖励计划，没有正式奖励记录。居民端只会看到「奖励未配置」。" />
    )
  }

  const columns: ColumnsType<AdminActivityRewardGrantRow> = [
    {
      title: '奖品',
      key: 'prize',
      render: (_, row) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{row.grant.prizeName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.grant.quantity} × {formatCents(row.grant.unitCostCents)} ={' '}
            {formatCents(row.grant.totalCostCents)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '领取人',
      key: 'recipient',
      render: (_, row) =>
        row.grant.recipientRole === 'leader' ? (
          <Space orientation="vertical" size={0}>
            <Tag color="blue">队长</Tag>
            <Typography.Text style={{ fontSize: 12 }}>
              {row.grant.recipientDisplayName ?? '未记录'}
            </Typography.Text>
          </Space>
        ) : (
          <Tag>团员共享</Tag>
        ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, row) => (
        <Space orientation="vertical" size={0}>
          <Tag color={STATUS_META[row.grant.status].color}>
            {STATUS_META[row.grant.status].label}
          </Tag>
          {row.openDispute ? <Tag color="orange">存在未结争议</Tag> : null}
        </Space>
      ),
    },
    {
      title: '授予时间',
      key: 'grantedAt',
      render: (_, row) => formatDateTime(row.grant.grantedAt),
    },
    {
      title: '凭据',
      key: 'credential',
      render: (_, row) =>
        row.credentialMaskedCode ? (
          <Space orientation="vertical" size={0}>
            <Typography.Text code>{row.credentialMaskedCode}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.credentialStatus ?? '—'} · 过期 {formatDateTime(row.credentialExpiresAt)}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">未签发</Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_, row) => (
        <Space size={4} wrap>
          {row.grant.status === 'granted' ? (
            <Button
              size="small"
              danger
              loading={busyKey === 'reason:revoke-grant'}
              onClick={() => onRevoke(row)}
            >
              撤销
            </Button>
          ) : null}
          {row.grant.redeemedAt !== null && (row.grant.status === 'redeemed' || row.grant.status === 'disputed') ? (
            <Button size="small" onClick={() => onDispute(row, 'opened')}>
              开争议
            </Button>
          ) : null}
        </Space>
      ),
    },
  ]

  return (
    <Table<AdminActivityRewardGrantRow>
      size="small"
      rowKey={(row) => row.grant.id}
      loading={loading}
      columns={columns}
      dataSource={overview?.grants ?? []}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: <Empty description="还没有奖励授予记录" /> }}
    />
  )
}

function RedemptionTable({
  overview,
  loading,
}: {
  overview: AdminActivityRewardOverview | null
  loading: boolean
}) {
  if (overview && !overview.planConfigured) {
    return <Empty description="未配置奖励计划，没有核销凭据。" />
  }
  const rows = (overview?.grants ?? []).filter((row) => row.credentialStatus !== null)

  const columns: ColumnsType<AdminActivityRewardGrantRow> = [
    {
      title: '凭据尾号',
      key: 'code',
      render: (_, row) => <Typography.Text code>{row.credentialMaskedCode ?? '—'}</Typography.Text>,
    },
    {
      title: '奖品',
      key: 'prize',
      render: (_, row) => row.grant.prizeName,
    },
    {
      title: '凭据状态',
      key: 'credentialStatus',
      render: (_, row) => {
        const status = row.credentialStatus
        const meta =
          status === 'active'
            ? { label: '有效待核销', color: 'blue' }
            : status === 'redeemed'
              ? { label: '已核销', color: 'green' }
              : status === 'expired'
                ? { label: '已过期', color: 'default' }
                : status === 'superseded'
                  ? { label: '已换新码', color: 'gold' }
                  : { label: '已作废', color: 'red' }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: '签发时间',
      key: 'issuedAt',
      render: (_, row) => formatDateTime(row.credentialIssuedAt),
    },
    {
      title: '核销有效期至',
      key: 'expiresAt',
      render: (_, row) => formatDateTime(row.credentialExpiresAt),
    },
    {
      title: '核销时间',
      key: 'redeemedAt',
      render: (_, row) => formatDateTime(row.grant.redeemedAt),
    },
    {
      title: '奖励状态',
      key: 'grantStatus',
      render: (_, row) => (
        <Tag color={STATUS_META[row.grant.status].color}>
          {STATUS_META[row.grant.status].label}
        </Tag>
      ),
    },
  ]

  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        凭据只保存 sha256 哈希，明文仅在居民领取的那一次响应里出现；这里只显示尾号用于核对纸券。
      </Typography.Text>
      <Table<AdminActivityRewardGrantRow>
        size="small"
        rowKey={(row) => row.grant.id}
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <Empty description="还没有签发过核销凭据" /> }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        统计：有效码 {overview?.counts.codesActive ?? 0} · 已核销码{' '}
        {overview?.counts.codesRedeemed ?? 0}
      </Typography.Text>
    </Space>
  )
}

function ExceptionPanel({
  overview,
  checkins,
  loading,
  busyKey,
  onDispute,
  onRevokeGrant,
}: {
  overview: AdminActivityRewardOverview | null
  checkins: AdminActivityCheckinList | null
  loading: boolean
  busyKey: string | null
  onDispute: (grant: AdminActivityRewardGrantRow, decision: RewardDisputeDecision) => void
  onRevokeGrant: (grant: AdminActivityRewardGrantRow) => void
}) {
  const abnormalGrants = (overview?.grants ?? []).filter(
    (row) =>
      row.grant.status === 'revoked' ||
      row.grant.status === 'disputed' ||
      row.grant.status === 'reversed' ||
      row.grant.status === 'expired' ||
      row.openDispute,
  )
  const revokedCheckins = (checkins?.items ?? []).filter((item) => item.status === 'revoked')

  if (loading && !overview) {
    return (
      <div className="activity-drawer-loading">
        <Spin description="正在读取异常记录…" />
      </div>
    )
  }

  const columns: ColumnsType<AdminActivityRewardGrantRow> = [
    {
      title: '奖品 / 凭据',
      key: 'prize',
      render: (_, row) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{row.grant.prizeName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.credentialMaskedCode ?? '未签发凭据'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, row) => (
        <Space orientation="vertical" size={0}>
          <Tag color={STATUS_META[row.grant.status].color}>
            {STATUS_META[row.grant.status].label}
          </Tag>
          {row.grant.revokedAt ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              撤销于 {formatDateTime(row.grant.revokedAt)}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '处理',
      key: 'actions',
      render: (_, row) => (
        <Space size={4} wrap>
          {row.openDispute ? (
            <>
              <Tooltip title="确认问题成立：记录反转决定，库存与已核销计数不回退">
                <Button
                  size="small"
                  danger
                  loading={busyKey === 'reason:dispute'}
                  onClick={() => onDispute(row, 'reversed')}
                >
                  反转
                </Button>
              </Tooltip>
              <Button
                size="small"
                loading={busyKey === 'reason:dispute'}
                onClick={() => onDispute(row, 'dismissed')}
              >
                驳回争议
              </Button>
            </>
          ) : null}
          {row.grant.status === 'granted' ? (
            <Button size="small" danger onClick={() => onRevokeGrant(row)}>
              撤销未核销授予
            </Button>
          ) : null}
          {!row.openDispute && row.grant.redeemedAt !== null && row.grant.status === 'redeemed' ? (
            <Button size="small" onClick={() => onDispute(row, 'opened')}>
              开争议
            </Button>
          ) : null}
        </Space>
      ),
    },
  ]

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <PageInfoAlert
        type="info"
        showIcon
        title="争议与撤销都是追加式记录"
        description="每条处理都会新增一条审计记录；已核销数量不会因为反转而回退，账面以追加的争议/事件行说明差异。"
      />

      <div>
        <Typography.Title level={5}>异常奖励</Typography.Title>
        <Table<AdminActivityRewardGrantRow>
          size="small"
          rowKey={(row) => row.grant.id}
          loading={loading}
          columns={columns}
          dataSource={abnormalGrants}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description="没有撤销、争议或过期的奖励" /> }}
        />
      </div>

      <div>
        <Typography.Title level={5}>被撤销的签到</Typography.Title>
        <Table<ActivityCheckin>
          size="small"
          rowKey="id"
          loading={loading}
          columns={[
            { title: '居民', dataIndex: 'displayName', key: 'displayName' },
            {
              title: '撤销时间',
              key: 'revokedAt',
              render: (_, row) => formatDateTime(row.revokedAt),
            },
            {
              title: '原因',
              key: 'reason',
              render: (_, row) => row.revokeReason ?? '未填写',
            },
          ]}
          dataSource={revokedCheckins}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description="没有被撤销的签到" /> }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          撤销签到会让该居民的凭据失效（{overview?.counts.checkinsRevoked ?? 0} 条已撤销）。
        </Typography.Text>
      </div>
    </Space>
  )
}

const REASON_COPY: Record<
  ReasonAction['kind'],
  { title: string; label: string; hint: string; max: number }
> = {
  'revoke-checkin': {
    title: '撤销签到',
    label: '撤销原因',
    hint: '2-200 字，会写入审计记录。撤销后该签到的核销凭据同时失效。',
    max: 200,
  },
  'revoke-grant': {
    title: '撤销奖励授予',
    label: '撤销原因',
    hint: '2-500 字，会写入追加式审计记录。已核销的奖励不能走撤销，请使用争议处理。',
    max: 500,
  },
  dispute: {
    title: '奖励争议处理',
    label: '处理原因',
    hint: '2-500 字。打开争议后，只有最后一条决定（反转/驳回）能结束该争议。',
    max: 500,
  },
}

/**
 * Reason dialog for revoke / dispute actions.
 *
 * `ReasonBody` owns the draft text and the Modal shell, and is remounted through
 * `key` whenever the target changes, so a fresh dialog never inherits the
 * previous reason and no effect writes state during render.
 */
function ReasonModal({
  action,
  busy,
  onCancel,
  onSubmit,
}: {
  action: ReasonAction | null
  busy: boolean
  onCancel: () => void
  onSubmit: (reason: string, note?: string) => Promise<void> | void
}) {
  if (!action) return null
  return (
    <ReasonBody
      key={`${action.kind}:${'checkin' in action ? action.checkin.id : action.grant.grant.id}:${
        action.kind === 'dispute' ? action.decision : ''
      }`}
      action={action}
      busy={busy}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  )
}

function ReasonBody({
  action,
  busy,
  onCancel,
  onSubmit,
}: {
  action: ReasonAction
  busy: boolean
  onCancel: () => void
  onSubmit: (reason: string, note?: string) => Promise<void> | void
}) {
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const copy = REASON_COPY[action.kind]
  const decisionLabel =
    action.kind === 'dispute'
      ? action.decision === 'opened'
        ? '打开争议'
        : action.decision === 'reversed'
          ? '反转（问题成立）'
          : '驳回争议'
      : null

  return (
    <Modal
      open
      title={`${copy.title}${decisionLabel ? ` · ${decisionLabel}` : ''}`}
      okText="确认提交"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: reason.trim().length < 2 }}
      onCancel={onCancel}
      onOk={() => void onSubmit(reason.trim(), note.trim() || undefined)}
      destroyOnHidden
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{copy.hint}</Typography.Text>
        <div>
          <Typography.Text strong>{copy.label}</Typography.Text>
          <Input.TextArea
            rows={3}
            maxLength={copy.max}
            showCount
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如 现场核对发现代签，本人未到场"
          />
        </div>
        <div>
          <Typography.Text strong>补充说明（选填）</Typography.Text>
          <Input.TextArea
            rows={2}
            maxLength={copy.max}
            showCount
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="可留空"
          />
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          对象：
          {action.kind === 'revoke-checkin'
            ? `${action.checkin.displayName} 的签到`
            : `${action.grant.grant.prizeName} · 团队 ${action.grant.grant.teamId.slice(0, 8)}`}
        </Typography.Text>
      </Space>
    </Modal>
  )
}

