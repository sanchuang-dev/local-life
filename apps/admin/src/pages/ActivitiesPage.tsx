import { PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import utc from 'dayjs/plugin/utc'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  activityRewardPlanSchema,
  createActivityRequestSchema,
  updateActivityRequestSchema,
  type ActivityAuditEntry,
  type ActivityCommunityRef,
  type ActivityKeyRules,
  type ActivityPublicRules,
  type ActivityRewardPlan,
  type ActivityRuleVersion,
  type ActivityStatus,
  type AdminActivityDetail,
  type AdminActivitySummary,
  type UpdateActivityRequest,
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
  ActivityApiError,
  createActivity,
  getActivity,
  isActivityApiError,
  listActivityAudit,
  listActivities,
  listActivityRuleVersions,
  listAdminCommunities,
  transitionActivity,
  updateActivity,
  type ActivityTransition,
} from '../services/activities'
import type { AuthenticatedSession } from '../services/auth'
import { DrawPoolDrawer } from './DrawPoolDrawer'
import './activities.css'

// utcOffset keeps the pickers on Asia/Shanghai wall time whatever zone the
// browser runs in; the plugin only adds the offset helpers to the same dayjs.
dayjs.extend(utc)

type ActivitySortKey = 'updatedAt'

interface ActivityFilters {
  keyword: string
  communityId?: string
  status?: ActivityStatus
}

interface ActivityFormValues {
  title: string
  communityId: string
  range?: [Dayjs | null, Dayjs | null] | null
  location: string
  budgetYuan?: number | null
  prizeQuantityCap?: number | null
  eligibility: string
  checkin: string
  purchase: string
  prizeClaim: string
  notes?: string
  /** Reward plan (LL-MVP-006). The three-state `rewardPlan` semantics live in
   * `rewardPlanFromForm`; these fields are only the editable projection. */
  rewardPlanEnabled?: boolean
  rewardPrizeName?: string
  rewardUnitCostYuan?: number | null
  rewardQuantityPerTeam?: number | null
  rewardTotalQuantity?: number | null
  rewardBudgetYuan?: number | null
  rewardClaimRecipient?: 'leader' | 'any_member'
  rewardCheckinRange?: [Dayjs | null, Dayjs | null] | null
  rewardRedemptionHours?: number | null
  rewardNotes?: string
  /**
   * The plan the server currently holds, carried through the form so an edit
   * that does not touch the reward plan can echo it back verbatim. `undefined`
   * means "the payload did not tell us" (older API), `null` means "no plan".
   */
  rewardPlanBaseline?: ActivityRewardPlan | null
}

const ACTIVITY_STATUS_META: Record<ActivityStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  published: { label: '已发布', color: 'green' },
  paused: { label: '已暂停', color: 'gold' },
  ended: { label: '已结束', color: 'default' },
}

const STATUS_OPTIONS = (Object.keys(ACTIVITY_STATUS_META) as ActivityStatus[]).map((status) => ({
  label: ACTIVITY_STATUS_META[status].label,
  value: status,
}))

const AUDIT_EVENT_LABELS: Record<string, string> = {
  'activity.created': '创建活动草稿',
  'activity.updated': '更新活动',
  'activity.published': '发布活动',
  'activity.paused': '暂停活动',
  'activity.resumed': '恢复活动',
  'activity.ended': '结束活动',
  'activity.rule_version.created': '生成规则版本',
}

const TRANSITION_META: Record<
  ActivityTransition,
  { title: string; okText: string; success: string; danger: boolean }
> = {
  publish: {
    title: '发布活动',
    okText: '确认发布',
    success: '活动已发布，规则已冻结为 v1',
    danger: false,
  },
  pause: { title: '暂停活动', okText: '确认暂停', success: '活动已暂停', danger: false },
  resume: { title: '恢复活动', okText: '确认恢复', success: '活动已恢复为已发布', danger: false },
  end: { title: '结束活动', okText: '确认结束', success: '活动已结束', danger: true },
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

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return DATE_TIME_FORMATTER.format(date).replace(/\//g, '-')
}

/** Activities are operated in China Standard Time, whatever the browser zone is. */
export const SHANGHAI_OFFSET_MINUTES = 480
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_MINUTES * 60_000

/**
 * The picker value's wall-clock fields, treated as Asia/Shanghai (+08:00).
 * Using the fields (not the instant) keeps the form honest when the operator's
 * browser is not on China Standard Time: what is typed is Shanghai time.
 */
function shanghaiWallMillis(value: Dayjs): number {
  return Date.UTC(
    value.year(),
    value.month(),
    value.date(),
    value.hour(),
    value.minute(),
    value.second(),
    value.millisecond(),
  )
}

/** ISO instant for picker wall-clock fields read as Asia/Shanghai (+08:00). */
export function shanghaiFieldsToIso(value: Dayjs): string {
  return new Date(shanghaiWallMillis(value) - SHANGHAI_OFFSET_MS).toISOString()
}

/** Render an ISO instant as an Asia/Shanghai wall clock for the form pickers. */
export function isoToShanghai(iso: string): Dayjs {
  return dayjs(iso).utcOffset(SHANGHAI_OFFSET_MINUTES)
}

function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

function centsToYuan(cents: number): number {
  return Number((cents / 100).toFixed(2))
}

/** Exact yuan → cents conversion for InputNumber values with 2 decimals. */
function yuanToCents(yuan: number): number {
  return Math.round(Number(yuan.toFixed(2)) * 100)
}

function describeError(cause: unknown, fallback: string): string {
  if (isActivityApiError(cause)) {
    switch (cause.status) {
      case 401:
        return `登录状态已失效：${cause.message}。请重新登录后重试。`
      case 403:
        return `没有权限：${cause.message}`
      case 409:
        return `数据冲突：${cause.message}。请刷新后重试，系统不会覆盖他人的修改。`
      case 400:
        return `请求不合法：${cause.message}`
      default:
        return cause.message || fallback
    }
  }
  return cause instanceof Error ? cause.message : fallback
}

function listErrorTitle(error: Error | null): string {
  if (error instanceof ActivityApiError) {
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return '没有活动管理权限'
  }
  return '活动列表加载失败'
}

function formatIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const detail = issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('；')
  return `表单内容不符合共享契约：${detail}`
}

function normalizePublicRules(rules: ActivityPublicRules): ActivityPublicRules {
  const notes = rules.notes?.trim()
  return {
    eligibility: rules.eligibility.trim(),
    checkin: rules.checkin.trim(),
    purchase: rules.purchase.trim(),
    prizeClaim: rules.prizeClaim.trim(),
    ...(notes ? { notes } : {}),
  }
}

function publicRulesFromForm(values: ActivityFormValues): ActivityPublicRules {
  return normalizePublicRules({
    eligibility: values.eligibility,
    checkin: values.checkin,
    purchase: values.purchase,
    prizeClaim: values.prizeClaim,
    notes: values.notes,
  })
}

type KeyRulesResult = { ok: true; keyRules: ActivityKeyRules } | { ok: false; message: string }

export function keyRulesFromForm(values: ActivityFormValues): KeyRulesResult {
  const start = values.range?.[0]
  const end = values.range?.[1]
  if (!start || !end) return { ok: false, message: '请选择完整的活动开始与结束时间。' }
  // Compare the values the operator sees (Shanghai wall clock), not each
  // instance's offset, so a non-Shanghai browser cannot invert the range.
  if (shanghaiWallMillis(end) <= shanghaiWallMillis(start)) {
    return { ok: false, message: '结束时间必须晚于开始时间。' }
  }
  if (typeof values.budgetYuan !== 'number' || !Number.isFinite(values.budgetYuan)) {
    return { ok: false, message: '请填写预算上限（元）。' }
  }
  if (
    typeof values.prizeQuantityCap !== 'number' ||
    !Number.isInteger(values.prizeQuantityCap) ||
    values.prizeQuantityCap < 0
  ) {
    return { ok: false, message: '请填写有效的奖品数量上限。' }
  }
  const plan = rewardPlanFromForm(values)
  if (!plan.ok) return plan
  return {
    ok: true,
    keyRules: {
      startsAt: shanghaiFieldsToIso(start),
      endsAt: shanghaiFieldsToIso(end),
      location: values.location.trim(),
      budgetCapCents: yuanToCents(values.budgetYuan),
      prizeQuantityCap: values.prizeQuantityCap,
      publicRules: publicRulesFromForm(values),
      // Reward plan is *three-state* on the wire:
      //   key absent  → the server keeps whatever plan it already froze
      //   explicit null → the operator cleared the plan (destructive)
      //   an object   → replace/define the plan
      // The form therefore only emits a key when it has an opinion. Emitting
      // `undefined` here is deliberate: it drops the key from the JSON body.
      ...(plan.rewardPlan === undefined ? {} : { rewardPlan: plan.rewardPlan }),
    },
  }
}

type RewardPlanResult =
  | { ok: true; rewardPlan: ActivityRewardPlan | null | undefined }
  | { ok: false; message: string }

/**
 * Reads the reward-plan section of the form.
 *
 * `undefined` (key omitted from the payload) means "leave the server's plan
 * alone"; `null` means "clear it"; an object means "this is the new plan".
 * Clearing is only ever produced by an explicit operator action, never by a
 * form that simply could not load the current plan.
 */
function rewardPlanFromForm(values: ActivityFormValues): RewardPlanResult {
  const baseline = values.rewardPlanBaseline
  if (!values.rewardPlanEnabled) {
    // Turning the switch off only means "clear it" when the server actually had
    // a plan. With no baseline a `null` would be a destructive no-op that still
    // mints a rule version, so the key stays omitted instead.
    return { ok: true, rewardPlan: baseline ? null : undefined }
  }

  const prizeName = values.rewardPrizeName?.trim() ?? ''
  if (!prizeName) return { ok: false, message: '请填写奖励计划中的奖品名称。' }
  const unitCostYuan = values.rewardUnitCostYuan
  if (typeof unitCostYuan !== 'number' || !Number.isFinite(unitCostYuan)) {
    return { ok: false, message: '请填写奖励计划中的单件成本（元）。' }
  }
  const quantityPerTeam = values.rewardQuantityPerTeam
  if (typeof quantityPerTeam !== 'number' || !Number.isInteger(quantityPerTeam)) {
    return { ok: false, message: '请填写每团奖品数量（整数）。' }
  }
  const totalQuantity = values.rewardTotalQuantity
  if (typeof totalQuantity !== 'number' || !Number.isInteger(totalQuantity)) {
    return { ok: false, message: '请填写奖品总库存（整数）。' }
  }
  const budgetYuan = values.rewardBudgetYuan
  if (typeof budgetYuan !== 'number' || !Number.isFinite(budgetYuan)) {
    return { ok: false, message: '请填写奖励预算上限（元）。' }
  }
  const redemptionHours = values.rewardRedemptionHours
  if (typeof redemptionHours !== 'number' || !Number.isInteger(redemptionHours)) {
    return { ok: false, message: '请填写核销有效期（整数小时）。' }
  }
  const windowStart = values.rewardCheckinRange?.[0]
  const windowEnd = values.rewardCheckinRange?.[1]
  if (!windowStart || !windowEnd) {
    return { ok: false, message: '请选择完整的签到窗口开始与结束时间。' }
  }
  if (shanghaiWallMillis(windowEnd) <= shanghaiWallMillis(windowStart)) {
    return { ok: false, message: '签到窗口的结束时间必须晚于开始时间。' }
  }

  const notes = values.rewardNotes?.trim()
  const parsed = activityRewardPlanSchema.safeParse({
    prizeName,
    prizeUnitCostCents: yuanToCents(unitCostYuan),
    prizeQuantityPerTeam: quantityPerTeam,
    totalPrizeQuantity: totalQuantity,
    budgetCapCents: yuanToCents(budgetYuan),
    claimRecipient: values.rewardClaimRecipient ?? 'leader',
    checkinWindow: {
      opensAt: shanghaiFieldsToIso(windowStart),
      closesAt: shanghaiFieldsToIso(windowEnd),
    },
    redemptionValidHours: redemptionHours,
    ...(notes ? { notes } : {}),
  })
  if (!parsed.success) {
    return { ok: false, message: `奖励计划不符合共享契约：${formatIssues(parsed.error.issues)}` }
  }
  return { ok: true, rewardPlan: parsed.data }
}

/**
 * Identity used to decide whether a save actually changes the key rules.
 *
 * `rewardPlan` is folded to `plan ?? null`, which is the same equality the API
 * applies after it merges an absent key with the stored plan. Comparing the raw
 * `undefined`/`null` distinction here would report a change for an ordinary edit
 * and mint a rule version nobody asked for.
 */
function normalizeKeyRules(rules: ActivityKeyRules) {
  return {
    startsAt: rules.startsAt,
    endsAt: rules.endsAt,
    location: rules.location.trim(),
    budgetCapCents: rules.budgetCapCents,
    prizeQuantityCap: rules.prizeQuantityCap,
    publicRules: normalizePublicRules(rules.publicRules),
    rewardPlan: rules.rewardPlan ?? null,
  }
}

function keyRulesEqual(detail: AdminActivityDetail, next: ActivityKeyRules): boolean {
  const current = {
    startsAt: detail.startsAt,
    endsAt: detail.endsAt,
    location: detail.location,
    budgetCapCents: detail.budgetCapCents,
    prizeQuantityCap: detail.prizeQuantityCap,
    publicRules: normalizePublicRules(detail.publicRules),
    rewardPlan: detail.rewardPlan ?? null,
  }
  return JSON.stringify(current) === JSON.stringify(normalizeKeyRules(next))
}

export function toFormValues(detail: AdminActivityDetail): ActivityFormValues {
  return {
    title: detail.title,
    communityId: detail.community.id,
    // utcOffset keeps the pickers on Asia/Shanghai wall time; a browser set to
    // another zone must not shift the operating window.
    range: [isoToShanghai(detail.startsAt), isoToShanghai(detail.endsAt)],
    location: detail.location,
    budgetYuan: centsToYuan(detail.budgetCapCents),
    prizeQuantityCap: detail.prizeQuantityCap,
    eligibility: detail.publicRules.eligibility,
    checkin: detail.publicRules.checkin,
    purchase: detail.publicRules.purchase,
    prizeClaim: detail.publicRules.prizeClaim,
    notes: detail.publicRules.notes ?? '',
    ...rewardPlanToForm(detail.rewardPlan ?? null),
  }
}

/**
 * Projects a server plan into the editable reward-plan fields.
 *
 * `rewardPlanBaseline` is the value the form echoes back on save; it is what
 * lets an untouched plan travel through an unrelated edit unharmed.
 */
function rewardPlanToForm(plan: ActivityRewardPlan | null): Partial<ActivityFormValues> {
  if (!plan) {
    return {
      rewardPlanEnabled: false,
      rewardPrizeName: '',
      rewardUnitCostYuan: null,
      rewardQuantityPerTeam: 1,
      rewardTotalQuantity: null,
      rewardBudgetYuan: null,
      rewardClaimRecipient: 'leader',
      rewardCheckinRange: null,
      rewardRedemptionHours: 72,
      rewardNotes: '',
      rewardPlanBaseline: null,
    }
  }
  return {
    rewardPlanEnabled: true,
    rewardPrizeName: plan.prizeName,
    rewardUnitCostYuan: centsToYuan(plan.prizeUnitCostCents),
    rewardQuantityPerTeam: plan.prizeQuantityPerTeam,
    rewardTotalQuantity: plan.totalPrizeQuantity,
    rewardBudgetYuan: centsToYuan(plan.budgetCapCents),
    rewardClaimRecipient: plan.claimRecipient,
    rewardCheckinRange: [
      isoToShanghai(plan.checkinWindow.opensAt),
      isoToShanghai(plan.checkinWindow.closesAt),
    ],
    rewardRedemptionHours: plan.redemptionValidHours,
    rewardNotes: plan.notes ?? '',
    rewardPlanBaseline: plan,
  }
}

/**
 * Reward-plan editor rows.
 *
 * Rendered only while the plan switch is on, so an activity without a plan never
 * shows a half-filled form that looks saveable. Every field maps 1:1 onto
 * `activityRewardPlanSchema`; the cross-field rules the schema enforces
 * (window order, stock ≥ per-team, budget ≥ one team) are surfaced here as
 * plain-language validation instead of a raw contract error at submit time.
 */
function RewardPlanFields() {
  return (
    <>
      <Form.Item
        name="rewardPrizeName"
        label="奖品名称"
        rules={[
          { required: true, whitespace: true, message: '请填写奖品名称' },
          { max: 60, message: '最多 60 个字符' },
        ]}
      >
        <Input maxLength={60} placeholder="例如：10 斤装东北大米" />
      </Form.Item>

      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item
            name="rewardUnitCostYuan"
            label="单件成本（元）"
            rules={[{ required: true, message: '请填写单件成本' }]}
            extra="库存与预算的金额都按 单件成本 × 数量 计算。"
          >
            <InputNumber
              min={0.01}
              max={100000}
              precision={2}
              style={{ width: '100%' }}
              placeholder="0.00"
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item
            name="rewardQuantityPerTeam"
            label="每团奖品数量"
            rules={[{ required: true, message: '请填写每团奖品数量' }]}
            extra="按「团队」计，不是按人；一个达标团队领这么多份。"
          >
            <InputNumber
              min={1}
              max={100}
              precision={0}
              style={{ width: '100%' }}
              placeholder="1"
            />
          </Form.Item>
        </Col>
      </Row>

      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item
            name="rewardTotalQuantity"
            label="奖品总库存（份）"
            dependencies={['rewardQuantityPerTeam']}
            rules={[
              { required: true, message: '请填写奖品总库存' },
              ({ getFieldValue }) => ({
                validator: async (_rule, value: number | null | undefined) => {
                  const perTeam = getFieldValue('rewardQuantityPerTeam') as number | undefined
                  if (typeof value !== 'number' || typeof perTeam !== 'number') return
                  if (value < perTeam) {
                    throw new Error('总库存不能少于一个团队的数量，否则第一个达标团队就领不到')
                  }
                },
              }),
            ]}
          >
            <InputNumber
              min={1}
              max={100000}
              precision={0}
              style={{ width: '100%' }}
              placeholder="0"
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item
            name="rewardBudgetYuan"
            label="奖励预算上限（元）"
            dependencies={['rewardUnitCostYuan', 'rewardQuantityPerTeam']}
            rules={[
              { required: true, message: '请填写奖励预算上限' },
              ({ getFieldValue }) => ({
                validator: async (_rule, value: number | null | undefined) => {
                  const unit = getFieldValue('rewardUnitCostYuan') as number | undefined
                  const perTeam = getFieldValue('rewardQuantityPerTeam') as number | undefined
                  if (typeof value !== 'number' || typeof unit !== 'number') return
                  if (typeof perTeam !== 'number') return
                  if (yuanToCents(value) < yuanToCents(unit) * perTeam) {
                    throw new Error('预算至少要够一个团队，否则第一个达标团队必然 budget_exceeded')
                  }
                },
              }),
            ]}
          >
            <InputNumber
              min={0.01}
              max={1000000}
              precision={2}
              style={{ width: '100%' }}
              placeholder="0.00"
            />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item
        name="rewardCheckinRange"
        label="签到窗口（Asia/Shanghai，UTC+08:00）"
        rules={[
          {
            validator: async (_rule, value: unknown) => {
              const range = value as [Dayjs | null, Dayjs | null] | null | undefined
              if (!range?.[0] || !range?.[1]) {
                throw new Error('请选择完整的签到窗口开始与结束时间')
              }
              if (shanghaiWallMillis(range[1]) <= shanghaiWallMillis(range[0])) {
                throw new Error('签到窗口的结束时间必须晚于开始时间')
              }
            },
          },
        ]}
        extra="只有落在这个窗口内的签到会被接受；窗口通常应落在活动时间内。"
      >
        <DatePicker.RangePicker
          showTime={{ format: 'HH:mm' }}
          format="YYYY-MM-DD HH:mm"
          allowEmpty={[false, false]}
          placeholder={['签到开始', '签到结束']}
          style={{ width: '100%' }}
        />
      </Form.Item>

      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item
            name="rewardClaimRecipient"
            label="领取人"
            rules={[{ required: true, message: '请选择领取人' }]}
            extra="团队达标后由谁出面领取奖励。"
          >
            <Select
              options={[
                { value: 'leader', label: '仅队长' },
                { value: 'any_member', label: '任意团员' },
              ]}
            />
          </Form.Item>
        </Col>
        <Col xs={24} sm={12}>
          <Form.Item
            name="rewardRedemptionHours"
            label="核销有效期（小时）"
            rules={[{ required: true, message: '请填写核销有效期' }]}
            extra="从发码时刻起算，过期后柜台需要重新签发。"
          >
            <InputNumber
              min={1}
              max={720}
              precision={0}
              style={{ width: '100%' }}
              placeholder="72"
            />
          </Form.Item>
        </Col>
      </Row>

      <Form.Item
        name="rewardNotes"
        label="奖励备注（选填）"
        rules={[{ max: 500, message: '最多 500 个字符' }]}
      >
        <Input.TextArea rows={2} maxLength={500} showCount placeholder="例如：奖品由社区仓库统一发放" />
      </Form.Item>

      <Alert
        type="info"
        showIcon
        title="资格口径"
        description="团队满 3 席且该团成员各自完成 3 条已核验签到才达标；自助签到在工作人员现场核验前不计入进度。奖励计划发布后随规则版本冻结，之后修改会生成新版本。"
      />
    </>
  )
}

function PublicRulesDescriptions({ rules }: { rules: ActivityPublicRules }) {
  return (
    <Descriptions size="small" column={1} colon={false} className="activity-snapshot">
      <Descriptions.Item label="参与资格">{rules.eligibility}</Descriptions.Item>
      <Descriptions.Item label="签到 / 参与方式">{rules.checkin}</Descriptions.Item>
      <Descriptions.Item label="购买要求">{rules.purchase}</Descriptions.Item>
      <Descriptions.Item label="奖品领取">{rules.prizeClaim}</Descriptions.Item>
      {rules.notes ? <Descriptions.Item label="备注">{rules.notes}</Descriptions.Item> : null}
    </Descriptions>
  )
}

/**
 * Real activity operations console. Every list, detail, rule-version and audit
 * read comes from the API; every write carries the session CSRF token and
 * refreshes the server data after success. A failed request is rendered as the
 * real error, never as a success-looking placeholder.
 */
export function ActivitiesPage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="活动管理"
          description="活动运营工作台仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有活动管理权限"
            subTitle="该入口仅对管理员与运营员开放；即使直接访问该地址，服务端同样会拒绝网格员的活动管理请求。"
          />
        </div>
      </div>
    )
  }

  return <ActivityConsole session={session} />
}

function ActivityConsole({ session }: { session: AuthenticatedSession }) {
  const { message, modal } = AntdApp.useApp()
  const [form] = Form.useForm<ActivityFormValues>()
  const role = session.staff.role
  const isAdmin = role === 'admin'
  const assignedCommunities = session.staff.communities

  const initialFilters = useMemo<ActivityFilters>(
    () => ({
      keyword: '',
      communityId: isAdmin ? undefined : assignedCommunities[0]?.id,
      status: undefined,
    }),
    [isAdmin, assignedCommunities],
  )

  const [query, setQuery] = useState<PanelQuery<ActivityFilters, ActivitySortKey>>(() => ({
    filters: { keyword: '', communityId: isAdmin ? undefined : assignedCommunities[0]?.id },
    page: 1,
    pageSize: 20,
  }))
  const [rows, setRows] = useState<AdminActivitySummary[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<Error | null>(null)
  const [listToken, setListToken] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [transitioningId, setTransitioningId] = useState<string | null>(null)

  const [communities, setCommunities] = useState<readonly ActivityCommunityRef[]>([])
  const [communitiesLoading, setCommunitiesLoading] = useState(true)
  const [communitiesError, setCommunitiesError] = useState<string | null>(null)
  const [communitiesToken, setCommunitiesToken] = useState(0)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create')
  const [detail, setDetail] = useState<AdminActivityDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editingActivityId, setEditingActivityId] = useState<string | null>(null)
  const detailRequestRef = useRef(0)

  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versionsActivity, setVersionsActivity] = useState<AdminActivitySummary | null>(null)
  const [versions, setVersions] = useState<ActivityRuleVersion[] | null>(null)
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const versionsRequestRef = useRef(0)

  const [auditOpen, setAuditOpen] = useState(false)
  const [auditActivity, setAuditActivity] = useState<AdminActivitySummary | null>(null)
  const [auditEntries, setAuditEntries] = useState<ActivityAuditEntry[] | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const auditRequestRef = useRef(0)

  const [drawPoolActivity, setDrawPoolActivity] = useState<AdminActivitySummary | null>(null)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setCommunitiesLoading(true)
    setCommunitiesError(null)
    listAdminCommunities(controller.signal)
      .then((items) => {
        if (active) setCommunities(items)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setCommunitiesError(describeError(cause, '无法读取社区列表'))
        setCommunities([])
      })
      .finally(() => {
        if (active) setCommunitiesLoading(false)
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
    listActivities(
      {
        page: query.page,
        pageSize: query.pageSize,
        communityId: query.filters.communityId,
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
        setListError(cause instanceof Error ? cause : new Error('活动列表加载失败'))
      })
      .finally(() => {
        if (active) setListLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [query, listToken])

  useEffect(() => {
    if (!editorOpen || editorMode !== 'create') return
    // Runs after the drawer's Form is mounted, so the reset and the operator's
    // default community never touch a disconnected Form instance.
    form.resetFields()
    const defaultCommunity = isAdmin
      ? communities[0]?.id
      : (assignedCommunities[0]?.id ?? communities[0]?.id)
    form.setFieldsValue({
      ...(defaultCommunity ? { communityId: defaultCommunity } : {}),
      // A brand-new activity has no plan: keep the section collapsed but give
      // the fields usable starting values for when the operator turns it on.
      ...rewardPlanToForm(null),
    })
    // Only the create-drawer opening should reset the form; later community
    // refreshes must not wipe what the operator is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpen, editorMode])

  const applyQuery = (next: PanelQuery<ActivityFilters, ActivitySortKey>): boolean => {
    const communityId = next.filters.communityId
    if (communityId && !isAdmin && !assignedCommunities.some((item) => item.id === communityId)) {
      message.error('只能查看管理员分配给当前账号的社区。')
      return false
    }
    setQuery(next)
    return true
  }

  const refreshList = () => setListToken((value) => value + 1)

  const filters = useMemo<readonly PanelFilter<ActivityFilters>[]>(
    () => [
      {
        key: 'keyword',
        kind: 'text',
        label: '关键词',
        placeholder: '搜索活动标题',
        width: 220,
      },
      {
        key: 'communityId',
        kind: 'select',
        label: '社区',
        width: 200,
        options: communities.map((community) => ({
          label: community.name,
          value: community.id,
        })),
      },
      { key: 'status', kind: 'status', label: '状态', options: STATUS_OPTIONS },
    ],
    [communities],
  )

  const columns = useMemo<readonly PanelColumn<AdminActivitySummary, ActivitySortKey>[]>(
    () => [
      {
        key: 'title',
        title: '标题',
        dataIndex: 'title',
        hideable: false,
        render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
      },
      {
        key: 'community',
        title: '社区',
        render: (_value, row) => row.community.name,
      },
      {
        key: 'status',
        title: '状态',
        dataIndex: 'status',
        render: (status: ActivityStatus) => (
          <Tag color={ACTIVITY_STATUS_META[status].color}>{ACTIVITY_STATUS_META[status].label}</Tag>
        ),
      },
      {
        key: 'startsAt',
        title: '开始时间',
        dataIndex: 'startsAt',
        render: (value: string) => formatDateTime(value),
      },
      {
        key: 'endsAt',
        title: '结束时间',
        dataIndex: 'endsAt',
        render: (value: string) => formatDateTime(value),
      },
      {
        key: 'ruleVersion',
        title: '规则版本',
        dataIndex: 'ruleVersion',
        render: (value: number | null) =>
          value ? (
            <Tag color="green">v{value}</Tag>
          ) : (
            <Typography.Text type="secondary">未冻结</Typography.Text>
          ),
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

  function openCreate() {
    detailRequestRef.current += 1
    setEditorMode('create')
    setEditorOpen(true)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
    setSaveError(null)
    setEditingActivityId(null)
  }

  async function loadDetail(activityId: string) {
    const request = detailRequestRef.current + 1
    detailRequestRef.current = request
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const result = await getActivity(activityId)
      if (detailRequestRef.current !== request) return
      setDetail(result)
      form.setFieldsValue(toFormValues(result))
    } catch (cause: unknown) {
      if (detailRequestRef.current !== request) return
      setDetailError(describeError(cause, '无法读取活动详情'))
    } finally {
      if (detailRequestRef.current === request) setDetailLoading(false)
    }
  }

  function openEdit(row: AdminActivitySummary) {
    setEditorMode('edit')
    setEditorOpen(true)
    setSaveError(null)
    setEditingActivityId(row.id)
    void loadDetail(row.id)
  }

  const closeEditor = () => {
    detailRequestRef.current += 1
    setEditorOpen(false)
    setSaving(false)
    // Closing must not leave the drawer spinner armed for the next open: a
    // superseded detail GET is ignored and can never flip this back to true.
    setDetailLoading(false)
    setEditingActivityId(null)
  }

  async function loadVersions(activityId: string) {
    const request = versionsRequestRef.current + 1
    versionsRequestRef.current = request
    setVersionsLoading(true)
    setVersionsError(null)
    try {
      const result = await listActivityRuleVersions(activityId)
      if (versionsRequestRef.current !== request) return
      setVersions(result.items)
    } catch (cause: unknown) {
      if (versionsRequestRef.current !== request) return
      setVersionsError(describeError(cause, '无法读取规则版本'))
    } finally {
      if (versionsRequestRef.current === request) setVersionsLoading(false)
    }
  }

  function openVersions(row: AdminActivitySummary) {
    setVersionsActivity(row)
    setVersions(null)
    setVersionsError(null)
    setVersionsOpen(true)
    void loadVersions(row.id)
  }

  async function loadAudit(activityId: string) {
    const request = auditRequestRef.current + 1
    auditRequestRef.current = request
    setAuditLoading(true)
    setAuditError(null)
    try {
      const result = await listActivityAudit(activityId)
      if (auditRequestRef.current !== request) return
      setAuditEntries(result.items)
    } catch (cause: unknown) {
      if (auditRequestRef.current !== request) return
      setAuditError(describeError(cause, '无法读取活动审计'))
    } finally {
      if (auditRequestRef.current === request) setAuditLoading(false)
    }
  }

  function openAudit(row: AdminActivitySummary) {
    setAuditActivity(row)
    setAuditEntries(null)
    setAuditError(null)
    setAuditOpen(true)
    void loadAudit(row.id)
  }

  async function runWrite(
    operation: () => Promise<AdminActivityDetail>,
    buildSuccessMessage: (result: AdminActivityDetail) => string,
  ) {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await operation()
      message.success(buildSuccessMessage(result))
      setEditorOpen(false)
      setDetail(null)
      setEditingActivityId(null)
      refreshList()
    } catch (cause: unknown) {
      setSaveError(describeError(cause, '保存失败'))
      if (isActivityApiError(cause) && cause.status === 409) {
        message.error('活动已被其他人修改或状态已变化，请刷新后重试；当前表单内容不会被覆盖。')
      }
    } finally {
      setSaving(false)
    }
  }

  async function submitEditor(values: ActivityFormValues) {
    setSaveError(null)
    const keyRulesResult = keyRulesFromForm(values)
    if (!keyRulesResult.ok) {
      setSaveError(keyRulesResult.message)
      return
    }
    const keyRules = keyRulesResult.keyRules

    if (editorMode === 'create') {
      const parsed = createActivityRequestSchema.safeParse({
        communityId: values.communityId,
        title: values.title.trim(),
        keyRules,
      })
      if (!parsed.success) {
        setSaveError(formatIssues(parsed.error.issues))
        return
      }
      await runWrite(
        () => createActivity(session.csrfToken, parsed.data),
        () => '活动草稿已创建，可在列表中继续编辑或发布。',
      )
      return
    }

    if (!detail) {
      setSaveError('活动详情尚未加载完成，请稍后重试。')
      return
    }

    const changes: UpdateActivityRequest = { expectedUpdatedAt: detail.updatedAt }
    const nextTitle = values.title.trim()
    if (nextTitle !== detail.title) changes.title = nextTitle
    const keyRulesChanged = !keyRulesEqual(detail, keyRules)
    if (keyRulesChanged) changes.keyRules = keyRules
    if (!changes.title && !changes.keyRules) {
      message.info('没有需要保存的修改。')
      return
    }
    const parsedChanges = updateActivityRequestSchema.safeParse(changes)
    if (!parsedChanges.success) {
      setSaveError(formatIssues(parsedChanges.error.issues))
      return
    }

    const performSave = () =>
      runWrite(
        () => updateActivity(session.csrfToken, detail.id, parsedChanges.data),
        (result) =>
          result.ruleVersion && result.ruleVersion !== detail.ruleVersion
            ? `活动已更新，规则版本更新为 v${result.ruleVersion}`
            : '活动已更新',
      )

    if (keyRulesChanged && (detail.status === 'published' || detail.status === 'paused')) {
      const nextVersion = (detail.ruleVersion ?? 0) + 1
      modal.confirm({
        title: '修改已发布规则将生成新版本',
        content: (
          <div className="activity-confirm">
            <p>
              保存将生成新规则版本 <Typography.Text strong>v{nextVersion}</Typography.Text>
              ；旧版本仍可在「规则版本」中查看，居民端读取最新版本。
            </p>
            <p>当前活动：{detail.title}</p>
          </div>
        ),
        okText: `生成 v${nextVersion} 并保存`,
        cancelText: '取消',
        onOk: performSave,
      })
      return
    }

    await performSave()
  }

  function confirmTransition(row: AdminActivitySummary, transition: ActivityTransition) {
    const meta = TRANSITION_META[transition]
    modal.confirm({
      title: meta.title,
      content: (
        <div className="activity-confirm">
          <p>
            <Typography.Text strong>{row.title}</Typography.Text>
          </p>
          <p>社区：{row.community.name}</p>
          <p>
            时间：{formatDateTime(row.startsAt)} 至 {formatDateTime(row.endsAt)}
          </p>
          {transition === 'publish' ? <p>发布后规则将冻结为 v1，居民端将读取该活动。</p> : null}
          {transition === 'pause' ? <p>暂停后居民端显示「已暂停」，恢复前不能继续参与。</p> : null}
          {transition === 'resume' ? <p>恢复后居民端重新显示进行中。</p> : null}
          {transition === 'end' ? <p>结束后活动不可恢复，居民端将显示「已结束」。</p> : null}
        </div>
      ),
      okText: meta.okText,
      cancelText: '取消',
      okButtonProps: meta.danger ? { danger: true } : undefined,
      onOk: async () => {
        setTransitioningId(row.id)
        setActionError(null)
        try {
          const updated = await transitionActivity(
            session.csrfToken,
            transition,
            row.id,
            row.updatedAt,
          )
          message.success(meta.success)
          refreshList()
          setDetail((current) => (current && current.id === updated.id ? updated : current))
        } catch (cause: unknown) {
          setActionError(describeError(cause, '活动状态变更失败'))
          if (isActivityApiError(cause) && cause.status === 409) {
            // Never overwrite silently: show the server's current state instead.
            refreshList()
          }
        } finally {
          setTransitioningId(null)
        }
      },
    })
  }

  const rowActions = (row: AdminActivitySummary) => {
    const busy = transitioningId === row.id
    return [
      { key: 'edit', label: '编辑', onClick: () => openEdit(row) },
      {
        key: 'publish',
        label: '发布',
        disabled: busy || row.status !== 'draft',
        onClick: () => confirmTransition(row, 'publish'),
      },
      {
        key: 'pause',
        label: '暂停',
        disabled: busy || row.status !== 'published',
        onClick: () => confirmTransition(row, 'pause'),
      },
      {
        key: 'resume',
        label: '恢复',
        disabled: busy || row.status !== 'paused',
        onClick: () => confirmTransition(row, 'resume'),
      },
      {
        key: 'end',
        label: '结束',
        danger: true,
        disabled: busy || (row.status !== 'published' && row.status !== 'paused'),
        onClick: () => confirmTransition(row, 'end'),
      },
      { key: 'versions', label: '规则版本', onClick: () => openVersions(row) },
      { key: 'draw', label: '今日抽奖', onClick: () => setDrawPoolActivity(row) },
      { key: 'audit', label: '审计', onClick: () => openAudit(row) },
    ]
  }

  const readOnlyEditor = editorMode === 'edit' && detail?.status === 'ended'
  const createDisabled = communitiesLoading || communities.length === 0
  const drawerTitle =
    editorMode === 'create'
      ? '新建活动草稿'
      : detail?.status === 'ended'
        ? '活动详情（已结束，只读）'
        : detail
          ? `编辑活动 · ${detail.title}`
          : '编辑活动'

  return (
    <div className="page">
      <PageHeader
        title="活动管理"
        description="创建草稿、配置规则并发布活动；已发布规则冻结为只读版本，居民 H5 读取同一份活动数据。"
        status={<Tag color="green">真实数据</Tag>}
        extra={
          <Tooltip
            title={
              createDisabled
                ? communitiesLoading
                  ? '正在读取社区列表'
                  : '没有可用社区，无法创建活动'
                : '创建活动草稿'
            }
          >
            <span>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={createDisabled}
                onClick={openCreate}
              >
                新建活动
              </Button>
            </span>
          </Tooltip>
        }
      />

      <div className="page-stack">
        {role === 'operator' ? (
          <Alert
            type="info"
            showIcon
            title="运营员视图"
            description={
              assignedCommunities.length > 0
                ? `仅能查看与操作管理员分配的社区（${assignedCommunities
                    .map((item) => item.name)
                    .join('、')}）；服务端同样会校验社区范围。`
                : '当前账号尚未被分配社区，暂时无法创建或查看活动，请联系管理员。'
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

        <DataPanel<AdminActivitySummary, ActivityFilters, ActivitySortKey>
          id="activities"
          label="活动列表"
          rowKey={(row) => row.id}
          query={query}
          onQueryChange={applyQuery}
          initialFilters={initialFilters}
          data={{
            rows,
            total,
            loading: listLoading,
            error: listError ?? undefined,
          }}
          filters={filters}
          columns={columns}
          onRefresh={refreshList}
          errorTitle={listErrorTitle(listError)}
          rowActions={rowActions}
          renderCard={(row) => (
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text strong>{row.title}</Typography.Text>
                <Tag color={ACTIVITY_STATUS_META[row.status].color}>
                  {ACTIVITY_STATUS_META[row.status].label}
                </Tag>
              </Space>
              <Typography.Text type="secondary">
                {row.community.name} · {formatDateTime(row.startsAt)} 至{' '}
                {formatDateTime(row.endsAt)}
              </Typography.Text>
              <Typography.Text type="secondary">
                规则版本：{row.ruleVersion ? `v${row.ruleVersion}` : '未冻结'} · 更新{' '}
                {formatDateTime(row.updatedAt)}
              </Typography.Text>
            </Space>
          )}
        />
      </div>

      <Drawer
        title={drawerTitle}
        size={560}
        open={editorOpen}
        onClose={closeEditor}
        rootClassName="activity-drawer"
        forceRender
      >
        {detailLoading ? (
          <div className="activity-drawer-loading">
            <Spin description="正在读取活动详情…" />
          </div>
        ) : detailError ? (
          <Alert
            type="error"
            showIcon
            title="活动详情加载失败"
            description={detailError}
            action={
              <Button
                size="small"
                disabled={!editingActivityId}
                onClick={() => {
                  if (editingActivityId) void loadDetail(editingActivityId)
                }}
              >
                重试
              </Button>
            }
          />
        ) : readOnlyEditor && detail ? (
          <div className="activity-drawer-readonly">
            <Alert
              type="info"
              showIcon
              title="活动已结束"
              description="已结束活动不可再修改；以下为当前活动快照。"
            />
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="社区">{detail.community.name}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={ACTIVITY_STATUS_META[detail.status].color}>
                  {ACTIVITY_STATUS_META[detail.status].label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="活动时间">
                {formatDateTime(detail.startsAt)} 至 {formatDateTime(detail.endsAt)}
              </Descriptions.Item>
              <Descriptions.Item label="举办地点">{detail.location}</Descriptions.Item>
              <Descriptions.Item label="预算上限">
                {formatCents(detail.budgetCapCents)}
              </Descriptions.Item>
              <Descriptions.Item label="奖品数量上限">
                {detail.prizeQuantityCap}
              </Descriptions.Item>
              <Descriptions.Item label="规则版本">
                {detail.ruleVersion ? `v${detail.ruleVersion}` : '未冻结'}
              </Descriptions.Item>
              <Descriptions.Item label="正式奖励计划">
                {detail.rewardPlan ? (
                  <Space orientation="vertical" size={2}>
                    <Typography.Text>
                      {detail.rewardPlan.prizeName} · {formatCents(detail.rewardPlan.prizeUnitCostCents)}{' '}
                      × {detail.rewardPlan.prizeQuantityPerTeam}/团
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      总库存 {detail.rewardPlan.totalPrizeQuantity} · 预算{' '}
                      {formatCents(detail.rewardPlan.budgetCapCents)} · 核销有效期{' '}
                      {detail.rewardPlan.redemptionValidHours} 小时
                    </Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">未配置（居民签到与领奖入口不可用）</Typography.Text>
                )}
              </Descriptions.Item>
            </Descriptions>
            <PublicRulesDescriptions rules={detail.publicRules} />
            <Button onClick={closeEditor}>关闭</Button>
          </div>
        ) : (
          <Form<ActivityFormValues>
            form={form}
            layout="vertical"
            className="activity-form"
            onFinish={submitEditor}
          >
            {saveError ? (
              <Alert
                className="activity-form-error"
                type="error"
                showIcon
                title="保存失败"
                description={saveError}
              />
            ) : null}

            <Form.Item
              name="title"
              label="活动标题"
              rules={[
                { required: true, whitespace: true, message: '请填写活动标题' },
                { min: 2, max: 80, message: '标题长度需为 2-80 个字符' },
              ]}
            >
              <Input maxLength={80} placeholder="例如：银发社区欢乐季" />
            </Form.Item>

            <Form.Item
              name="communityId"
              label="所属社区"
              rules={[{ required: true, message: '请选择所属社区' }]}
              tooltip={editorMode === 'edit' ? '活动创建后不能更换社区' : undefined}
            >
              <Select
                showSearch
                optionFilterProp="label"
                disabled={editorMode === 'edit'}
                placeholder="选择社区"
                options={communities.map((community) => ({
                  value: community.id,
                  label: community.name,
                }))}
              />
            </Form.Item>

            <Form.Item
              name="range"
              label="活动时间（Asia/Shanghai，UTC+08:00）"
              rules={[
                {
                  validator: async (_rule, value: unknown) => {
                    const range = value as [Dayjs | null, Dayjs | null] | null | undefined
                    if (!range?.[0] || !range?.[1]) {
                      throw new Error('请选择完整的活动开始与结束时间')
                    }
                    if (shanghaiWallMillis(range[1]) <= shanghaiWallMillis(range[0])) {
                      throw new Error('结束时间必须晚于开始时间')
                    }
                  },
                },
              ]}
            >
              <DatePicker.RangePicker
                showTime={{ format: 'HH:mm' }}
                format="YYYY-MM-DD HH:mm"
                allowEmpty={[false, false]}
                placeholder={['开始时间', '结束时间']}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item
              name="location"
              label="举办地点"
              rules={[
                { required: true, whitespace: true, message: '请填写举办地点' },
                { min: 2, max: 120, message: '地点长度需为 2-120 个字符' },
              ]}
            >
              <Input maxLength={120} placeholder="例如：幸福社区党群服务中心" />
            </Form.Item>

            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="budgetYuan"
                  label="预算上限（元）"
                  rules={[{ required: true, message: '请填写预算上限' }]}
                >
                  <InputNumber
                    min={0}
                    max={1000000}
                    precision={2}
                    style={{ width: '100%' }}
                    placeholder="0.00"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="prizeQuantityCap"
                  label="奖品数量上限"
                  rules={[{ required: true, message: '请填写奖品数量上限' }]}
                >
                  <InputNumber
                    min={0}
                    max={100000}
                    precision={0}
                    style={{ width: '100%' }}
                    placeholder="0"
                  />
                </Form.Item>
              </Col>
            </Row>

            <Typography.Text type="secondary" className="activity-form-section">
              公开规则（居民端只读展示，四项均必填）
            </Typography.Text>

            <Form.Item
              name="eligibility"
              label="参与资格"
              rules={[
                { required: true, whitespace: true, message: '请填写参与资格' },
                { max: 500, message: '最多 500 个字符' },
              ]}
            >
              <Input.TextArea
                rows={2}
                maxLength={500}
                showCount
                placeholder="例如：本社区 60 岁以上居民"
              />
            </Form.Item>

            <Form.Item
              name="checkin"
              label="签到 / 参与方式"
              rules={[
                { required: true, whitespace: true, message: '请填写签到或参与方式' },
                { max: 500, message: '最多 500 个字符' },
              ]}
            >
              <Input.TextArea
                rows={2}
                maxLength={500}
                showCount
                placeholder="例如：到社区服务中心签到"
              />
            </Form.Item>

            <Form.Item
              name="purchase"
              label="购买要求"
              rules={[
                { required: true, whitespace: true, message: '请填写购买要求' },
                { max: 500, message: '最多 500 个字符' },
              ]}
            >
              <Input.TextArea
                rows={2}
                maxLength={500}
                showCount
                placeholder="例如：现场购买指定套餐"
              />
            </Form.Item>

            <Form.Item
              name="prizeClaim"
              label="奖品领取"
              rules={[
                { required: true, whitespace: true, message: '请填写奖品领取规则' },
                { max: 500, message: '最多 500 个字符' },
              ]}
            >
              <Input.TextArea
                rows={2}
                maxLength={500}
                showCount
                placeholder="例如：凭核销码领取，每人限一次"
              />
            </Form.Item>

            <Form.Item
              name="notes"
              label="备注（选填）"
              rules={[{ max: 500, message: '最多 500 个字符' }]}
            >
              <Input.TextArea rows={2} maxLength={500} showCount placeholder="补充说明，可留空" />
            </Form.Item>

            <Typography.Text type="secondary" className="activity-form-section">
              奖励履约计划（LL-MVP-006 · 发布后冻结为快照，居民签到与领奖依赖它）
            </Typography.Text>

            <Form.Item
              name="rewardPlanEnabled"
              label="配置正式奖励计划"
              valuePropName="checked"
              extra="关闭表示该活动没有正式奖品；居民端签到、达标与领取入口都会被服务端以 409 拒绝。只有打开并填写完整，才会计入奖励资格、库存与预算。"
            >
              <Switch checkedChildren="已配置" unCheckedChildren="未配置" />
            </Form.Item>

            <Form.Item
              noStyle
              shouldUpdate={(prev, next) =>
                prev.rewardPlanEnabled !== next.rewardPlanEnabled ||
                prev.rewardPlanBaseline !== next.rewardPlanBaseline
              }
            >
              {({ getFieldValue }) =>
                getFieldValue('rewardPlanEnabled') ? (
                  <RewardPlanFields />
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    title={
                      getFieldValue('rewardPlanBaseline')
                        ? '保存后该活动的奖励计划将被清空'
                        : '未配置奖励计划'
                    }
                    description={
                      getFieldValue('rewardPlanBaseline')
                        ? '当前活动已冻结过奖励计划。关闭开关再保存会显式清空它，并生成新规则版本；已发放的奖励与凭据不受影响，但新的签到与领奖会立即关闭。'
                        : '未配置奖励计划时，发布后居民签到、达标与领奖入口不可用，服务端返回 409 reward_unavailable。'
                    }
                  />
                )
              }
            </Form.Item>

            {editorMode === 'edit' && detail?.status === 'draft' ? (
              <Alert
                type="info"
                showIcon
                title="草稿阶段修改规则不会生成版本"
                description="活动发布后规则将冻结为 v1；之后修改关键规则会生成新的版本。"
              />
            ) : null}

            <Space className="activity-form-actions">
              <Button onClick={closeEditor} disabled={saving}>
                取消
              </Button>
              <Button type="primary" htmlType="submit" loading={saving}>
                {editorMode === 'create' ? '保存草稿' : '保存修改'}
              </Button>
            </Space>
          </Form>
        )}
      </Drawer>

      <Drawer
        title={versionsActivity ? `规则版本 · ${versionsActivity.title}` : '规则版本'}
        size={620}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        rootClassName="activity-drawer"
      >
        {versionsLoading ? (
          <div className="activity-drawer-loading">
            <Spin description="正在读取规则版本…" />
          </div>
        ) : versionsError ? (
          <Alert
            type="error"
            showIcon
            title="规则版本加载失败"
            description={versionsError}
            action={
              <Button
                size="small"
                onClick={() => {
                  if (versionsActivity) void loadVersions(versionsActivity.id)
                }}
              >
                重试
              </Button>
            }
          />
        ) : !versions || versions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚无规则版本：活动发布时会冻结为 v1"
          />
        ) : (
          <Space orientation="vertical" size={12} className="activity-version-list">
            {versions.map((version, index) => (
              <Card
                key={version.id}
                size="small"
                title={
                  <Space wrap>
                    <Tag color={index === 0 ? 'green' : 'default'}>v{version.version}</Tag>
                    <Typography.Text type="secondary">
                      创建于 {formatDateTime(version.createdAt)}
                    </Typography.Text>
                  </Space>
                }
              >
                <Descriptions size="small" column={1} colon={false}>
                  <Descriptions.Item label="活动时间">
                    {formatDateTime(version.snapshot.startsAt)} 至{' '}
                    {formatDateTime(version.snapshot.endsAt)}
                  </Descriptions.Item>
                  <Descriptions.Item label="举办地点">
                    {version.snapshot.location}
                  </Descriptions.Item>
                  <Descriptions.Item label="预算上限">
                    {formatCents(version.snapshot.budgetCapCents)}
                  </Descriptions.Item>
                  <Descriptions.Item label="奖品数量上限">
                    {version.snapshot.prizeQuantityCap}
                  </Descriptions.Item>
                  <Descriptions.Item label="正式奖励计划">
                    {version.snapshot.rewardPlan ? (
                      <Space orientation="vertical" size={2}>
                        <Typography.Text>
                          {version.snapshot.rewardPlan.prizeName} ·{' '}
                          {formatCents(version.snapshot.rewardPlan.prizeUnitCostCents)} ×{' '}
                          {version.snapshot.rewardPlan.prizeQuantityPerTeam}/团
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          总库存 {version.snapshot.rewardPlan.totalPrizeQuantity} · 预算{' '}
                          {formatCents(version.snapshot.rewardPlan.budgetCapCents)} · 签到窗口{' '}
                          {formatDateTime(version.snapshot.rewardPlan.checkinWindow.opensAt)} 至{' '}
                          {formatDateTime(version.snapshot.rewardPlan.checkinWindow.closesAt)} · 核销有效期{' '}
                          {version.snapshot.rewardPlan.redemptionValidHours} 小时
                        </Typography.Text>
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">
                        未配置（该版本下居民签到与领奖入口不可用）
                      </Typography.Text>
                    )}
                  </Descriptions.Item>
                </Descriptions>
                <PublicRulesDescriptions rules={version.snapshot.publicRules} />
                <Typography.Text type="secondary" className="activity-version-note">
                  只读快照，不可编辑或删除
                </Typography.Text>
              </Card>
            ))}
          </Space>
        )}
      </Drawer>

      <Drawer
        title={auditActivity ? `操作审计 · ${auditActivity.title}` : '操作审计'}
        size={560}
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        rootClassName="activity-drawer"
      >
        {auditLoading ? (
          <div className="activity-drawer-loading">
            <Spin description="正在读取审计记录…" />
          </div>
        ) : auditError ? (
          <Alert
            type="error"
            showIcon
            title="审计记录加载失败"
            description={auditError}
            action={
              <Button
                size="small"
                onClick={() => {
                  if (auditActivity) void loadAudit(auditActivity.id)
                }}
              >
                重试
              </Button>
            }
          />
        ) : !auditEntries || auditEntries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无审计记录" />
        ) : (
          <Timeline
            items={auditEntries.map((entry) => ({
              key: entry.id,
              color:
                entry.event === 'activity.ended'
                  ? 'gray'
                  : entry.event === 'activity.published'
                    ? 'green'
                    : 'blue',
              content: (
                <div className="activity-audit-entry">
                  <Space wrap>
                    <Typography.Text strong>
                      {AUDIT_EVENT_LABELS[entry.event] ?? entry.event}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {formatDateTime(entry.createdAt)}
                    </Typography.Text>
                  </Space>
                  <div>
                    <Typography.Text type="secondary">
                      操作者：{entry.actorDisplayName ?? '未知操作者'}
                    </Typography.Text>
                  </div>
                  {entry.metadata && Object.keys(entry.metadata).length > 0 ? (
                    <Typography.Paragraph className="activity-audit-metadata" type="secondary">
                      <Typography.Text code>{JSON.stringify(entry.metadata)}</Typography.Text>
                    </Typography.Paragraph>
                  ) : null}
                </div>
              ),
            }))}
          />
        )}
      </Drawer>

      <DrawPoolDrawer
        open={drawPoolActivity !== null}
        activity={drawPoolActivity}
        session={session}
        onClose={() => setDrawPoolActivity(null)}
      />
    </div>
  )
}
