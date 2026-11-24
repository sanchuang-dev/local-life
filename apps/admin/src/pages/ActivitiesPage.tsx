import { PageInfoAlert } from '../components/PageInfoHelp'
import { PlusOutlined } from '@ant-design/icons'
import { useLocation, useNavigate } from 'react-router'
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
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ACTIVITY_PROMO_SUBTITLE_MAX_LENGTH,
  ACTIVITY_PROMO_TITLE_MAX_LENGTH,
  ACTIVITY_THEME_KEYS,
  DEFAULT_ACTIVITY_THEME_KEY,
  activityRewardPlanSchema,
  activityVisualConfigInputSchema,
  activityVisualImageUrlSchema,
  createActivityRequestSchema,
  PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS,
  PURCHASE_REWARD_TEAM_SIZE,
  purchaseRewardPlanSchema,
  purchaseRewardTotalBudgetCents,
  updateActivityRequestSchema,
  type ActivityAuditEntry,
  type ActivityCommunityRef,
  type ActivityKeyRules,
  type ActivityPublicRules,
  type ActivityRewardPlan,
  type ActivityRuleVersion,
  type ActivityStatus,
  type ActivityThemeKey,
  type ActivityVisualConfig,
  type ActivityVisualConfigInput,
  type AdminActivityDetail,
  type AdminActivitySummary,
  type PurchaseRewardPlan,
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
  /**
   * Consumption team reward plan (LL-PUR-002). Same three-state semantics as the
   * check-in plan: absent key inherits, explicit `null` clears, an object
   * replaces. The baseline lets an untouched plan survive an unrelated edit.
   */
  purchaseRewardEnabled?: boolean
  purchaseThresholdYuan?: number | null
  purchaseCouponFaceValueYuan?: number | null
  purchaseMaxRewardedTeams?: number | null
  purchaseRewardPlanBaseline?: PurchaseRewardPlan | null
  /**
   * Visual configuration (LL-ACT-VIS-001, #309). These live on the same form as
   * the business fields so switching tabs never drops them; empty strings are
   * just the input representation of a cleared field.
   */
  visualThemeKey?: ActivityThemeKey
  visualHeroImageUrl?: string
  visualPromoTitle?: string
  visualPromoSubtitle?: string
  visualPosterImageUrl?: string
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

/** Server-owned state the form cannot always infer from its own fields. */
interface KeyRulesContext {
  /** Published/paused purchase rules are frozen; never send a changed plan. */
  purchaseRewardLocked?: boolean
  /** The plan currently stored on the activity; used to echo a locked plan. */
  purchaseRewardPlanBaseline?: PurchaseRewardPlan | null
}

export function keyRulesFromForm(
  values: ActivityFormValues,
  context: KeyRulesContext = {},
): KeyRulesResult {
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
  const purchasePlan = purchaseRewardPlanFromForm(values, context)
  if (!purchasePlan.ok) return purchasePlan
  return {
    ok: true,
    keyRules: {
      startsAt: shanghaiFieldsToIso(start),
      endsAt: shanghaiFieldsToIso(end),
      location: values.location.trim(),
      budgetCapCents: yuanToCents(values.budgetYuan),
      prizeQuantityCap: values.prizeQuantityCap,
      publicRules: publicRulesFromForm(values),
      // Both plans are *three-state* on the wire:
      //   key absent  → the server keeps whatever plan it already froze
      //   explicit null → the operator cleared the plan (destructive)
      //   an object   → replace/define the plan
      // The form therefore only emits a key when it has an opinion. Emitting
      // `undefined` here is deliberate: it drops the key from the JSON body.
      ...(plan.rewardPlan === undefined ? {} : { rewardPlan: plan.rewardPlan }),
      ...(purchasePlan.purchaseRewardPlan === undefined
        ? {}
        : { purchaseRewardPlan: purchasePlan.purchaseRewardPlan }),
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

type PurchaseRewardPlanResult =
  | { ok: true; purchaseRewardPlan: PurchaseRewardPlan | null | undefined }
  | { ok: false; message: string }

/**
 * Reads the consumption team reward section of the form.
 *
 * Mirrors `rewardPlanFromForm`: `undefined` keeps the stored plan, `null` clears
 * it, an object replaces it. On published/paused activities the plan is frozen
 * by the API, so the form echoes the stored baseline instead of submitting a
 * (possibly unavailable) edit and provoking a 409.
 */
function purchaseRewardPlanFromForm(
  values: ActivityFormValues,
  context: KeyRulesContext,
): PurchaseRewardPlanResult {
  const baseline = Object.hasOwn(context, 'purchaseRewardPlanBaseline')
    ? (context.purchaseRewardPlanBaseline ?? null)
    : (values.purchaseRewardPlanBaseline ?? null)

  if (context.purchaseRewardLocked) {
    // Echoing the baseline keeps `keyRulesEqual` stable, so an ordinary title or
    // location edit cannot mint a new rule version just because the plan is
    // locked. A null baseline stays omitted (same equality after `?? null`).
    return { ok: true, purchaseRewardPlan: baseline ?? undefined }
  }

  if (!values.purchaseRewardEnabled) {
    return { ok: true, purchaseRewardPlan: baseline ? null : undefined }
  }

  const thresholdYuan = values.purchaseThresholdYuan
  if (typeof thresholdYuan !== 'number' || !Number.isFinite(thresholdYuan)) {
    return { ok: false, message: '请填写消费奖励中的团队实付门槛（元）。' }
  }
  const couponFaceValueYuan = values.purchaseCouponFaceValueYuan
  if (typeof couponFaceValueYuan !== 'number' || !Number.isFinite(couponFaceValueYuan)) {
    return { ok: false, message: '请填写消费奖励中的每人券面额（元）。' }
  }
  const maxRewardedTeams = values.purchaseMaxRewardedTeams
  if (typeof maxRewardedTeams !== 'number' || !Number.isInteger(maxRewardedTeams)) {
    return { ok: false, message: '请填写消费奖励中的奖励团队数量上限（整数）。' }
  }

  const parsed = purchaseRewardPlanSchema.safeParse({
    thresholdCents: yuanToCents(thresholdYuan),
    couponFaceValueCents: yuanToCents(couponFaceValueYuan),
    maxRewardedTeams,
  })
  if (!parsed.success) {
    return {
      ok: false,
      message: `消费奖励规则不符合共享契约：${formatIssues(parsed.error.issues)}`,
    }
  }
  return { ok: true, purchaseRewardPlan: parsed.data }
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
    purchaseRewardPlan: rules.purchaseRewardPlan ?? null,
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
    purchaseRewardPlan: detail.purchaseRewardPlan ?? null,
  }
  return JSON.stringify(current) === JSON.stringify(normalizeKeyRules(next))
}

/* --------------------------- Activity visual config ------------------------ */

interface ActivityThemeVisual {
  key: ActivityThemeKey
  label: string
  description: string
  primary: string
  surface: string
  accentSoft: string
  text: string
}

/**
 * Preview tokens for the four curated themes (#309).
 *
 * The admin page only previews the palette; the resident H5 owns the real
 * mapping. These values mirror the approved warm/community/health/festival
 * families so an operator can tell the themes apart before saving.
 */
const ACTIVITY_THEME_VISUAL_META: Record<
  ActivityThemeKey,
  Omit<ActivityThemeVisual, 'key'>
> = {
  'community-green': {
    label: '社区绿',
    description: '社区日常与邻里活动，默认主题',
    primary: '#176f61',
    surface: '#eaf5e9',
    accentSoft: '#d8eee5',
    text: '#275942',
  },
  'festival-red': {
    label: '节庆红',
    description: '节日、庆典与热闹场次',
    primary: '#b3342b',
    surface: '#fdf0ee',
    accentSoft: '#f7d7d1',
    text: '#7a2a22',
  },
  'health-blue': {
    label: '健康蓝',
    description: '义诊、健康筛查与公益服务',
    primary: '#1d6fb8',
    surface: '#eef5fc',
    accentSoft: '#d6e8f8',
    text: '#204e77',
  },
  'warm-gold': {
    label: '暖阳金',
    description: '敬老、助老与温暖关怀',
    primary: '#8f6514',
    surface: '#fdf5e6',
    accentSoft: '#f6e3bd',
    text: '#6b4513',
  },
}

export const ACTIVITY_THEME_VISUALS: readonly ActivityThemeVisual[] = ACTIVITY_THEME_KEYS.map(
  (key) => ({ key, ...ACTIVITY_THEME_VISUAL_META[key] }),
)

export function activityThemeVisual(key: ActivityThemeKey | undefined): ActivityThemeVisual {
  const resolved: ActivityThemeKey =
    key && (ACTIVITY_THEME_KEYS as readonly string[]).includes(key)
      ? key
      : DEFAULT_ACTIVITY_THEME_KEY
  return { key: resolved, ...ACTIVITY_THEME_VISUAL_META[resolved] }
}

function blankVisualText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** Projects the server read shape onto the shared form's input fields. */
export function visualConfigToForm(
  config: ActivityVisualConfig | null | undefined,
): Partial<ActivityFormValues> {
  return {
    visualThemeKey: config?.themeKey ?? DEFAULT_ACTIVITY_THEME_KEY,
    visualHeroImageUrl: config?.heroImageUrl ?? '',
    visualPromoTitle: config?.promoTitle ?? '',
    visualPromoSubtitle: config?.promoSubtitle ?? '',
    visualPosterImageUrl: config?.posterImageUrl ?? '',
  }
}

export type VisualConfigResult =
  | { ok: true; visualConfig: ActivityVisualConfigInput }
  | { ok: false; message: string }

/**
 * Reads the visual tab into the shared write contract.
 *
 * Only the theme is mandatory for a useful visual configuration, so every
 * artwork/copy field may stay blank; blanks become explicit `null`s. The
 * contract remains the single validation source for URL scheme/length and copy
 * length, so an invalid value can never be posted as "saved".
 */
export function visualConfigFromForm(values: ActivityFormValues): VisualConfigResult {
  const candidate = {
    themeKey: values.visualThemeKey ?? DEFAULT_ACTIVITY_THEME_KEY,
    heroImageUrl: blankVisualText(values.visualHeroImageUrl),
    promoTitle: blankVisualText(values.visualPromoTitle),
    promoSubtitle: blankVisualText(values.visualPromoSubtitle),
    posterImageUrl: blankVisualText(values.visualPosterImageUrl),
  }
  const parsed = activityVisualConfigInputSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      ok: false,
      message: `界面风格配置不符合共享契约：${formatIssues(parsed.error.issues)}`,
    }
  }
  return { ok: true, visualConfig: parsed.data }
}

function normalizeVisualConfig(
  config: ActivityVisualConfig | ActivityVisualConfigInput | null | undefined,
) {
  return {
    themeKey: config?.themeKey ?? DEFAULT_ACTIVITY_THEME_KEY,
    heroImageUrl: blankVisualText(config?.heroImageUrl),
    promoTitle: blankVisualText(config?.promoTitle),
    promoSubtitle: blankVisualText(config?.promoSubtitle),
    posterImageUrl: blankVisualText(config?.posterImageUrl),
  }
}

/** True when saving would actually change the stored visual configuration. */
export function visualConfigChanged(
  detail: ActivityVisualConfig,
  next: ActivityVisualConfigInput,
): boolean {
  return JSON.stringify(normalizeVisualConfig(detail)) !== JSON.stringify(normalizeVisualConfig(next))
}

/** Shared-contract URL check reused by the head/poster inputs and their previews. */
export function visualImageUrlError(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  const parsed = activityVisualImageUrlSchema.safeParse(trimmed)
  return parsed.success ? null : '请输入以 http:// 或 https:// 开头的可访问图片地址'
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
    ...purchaseRewardPlanToForm(detail.purchaseRewardPlan ?? null),
    ...visualConfigToForm(detail.visualConfig),
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
 * Projects the stored consumption reward plan into the editable fields.
 * `purchaseRewardPlanBaseline` is the value echoed back by a save that does not
 * touch the plan, so a title/location edit cannot silently clear it.
 */
function purchaseRewardPlanToForm(
  plan: PurchaseRewardPlan | null,
): Partial<ActivityFormValues> {
  if (!plan) {
    return {
      purchaseRewardEnabled: false,
      purchaseThresholdYuan: null,
      purchaseCouponFaceValueYuan: null,
      purchaseMaxRewardedTeams: null,
      purchaseRewardPlanBaseline: null,
    }
  }
  return {
    purchaseRewardEnabled: true,
    purchaseThresholdYuan: centsToYuan(plan.thresholdCents),
    purchaseCouponFaceValueYuan: centsToYuan(plan.couponFaceValueCents),
    purchaseMaxRewardedTeams: plan.maxRewardedTeams,
    purchaseRewardPlanBaseline: plan,
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const claimRecipient = Form.useWatch('rewardClaimRecipient')
  const redemptionHours = Form.useWatch('rewardRedemptionHours')
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
        label="签到时间"
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

      >
        <DatePicker.RangePicker
          showTime={{ format: 'HH:mm' }}
          format="YYYY-MM-DD HH:mm"
          allowEmpty={[false, false]}
          placeholder={['签到开始', '签到结束']}
          style={{ width: '100%' }}
        />
      </Form.Item>

      <div className="activity-editor-disclosure">
        <Button type="text" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((v) => !v)}>
          {advancedOpen ? '收起' : '展开'}更多设置
        </Button>
        <Typography.Text type="secondary">
          {claimRecipient === 'any_member' ? '任意团员领取' : '仅队长领取'} ·
          {typeof redemptionHours === 'number' ? ` 发码后 ${redemptionHours} 小时内核销` : ' 核销时效待填写'}
        </Typography.Text>
      </div>
      <div style={{ display: advancedOpen ? undefined : 'none' }}>
      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item
            name="rewardClaimRecipient"
            label="领取人"
            rules={[{ required: true, message: '请选择领取人' }]}

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

      </div>
      <Typography.Paragraph type="secondary" className="activity-editor-tip">
        团队满 3 人且每人完成 3 次已核验签到才达标。发布后奖励规则按版本冻结。
      </Typography.Paragraph>
    </>
  )
}

/**
 * Read-only summary of a consumption team reward plan.
 *
 * Used in the frozen snapshot (published/paused drawer), the ended-activity
 * snapshot and the rule-version history, so the same budget meaning is shown
 * everywhere the plan is not editable.
 */
function PurchaseRewardPlanSummary({ plan }: { plan: PurchaseRewardPlan | null }) {
  if (!plan) {
    return <Typography.Text type="secondary">未配置（不影响签到奖励）</Typography.Text>
  }
  return (
    <Space orientation="vertical" size={2}>
      <Typography.Text>
        团队实付门槛 {formatCents(plan.thresholdCents)} · 每人券面额{' '}
        {formatCents(plan.couponFaceValueCents)}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        奖励团队上限 {plan.maxRewardedTeams} 个 · 团队券总预算{' '}
        {formatCents(purchaseRewardTotalBudgetCents(plan))}（每人券额 × {PURCHASE_REWARD_TEAM_SIZE}{' '}
        人 × 团队数）
      </Typography.Text>
    </Space>
  )
}

/** Read-only budget arithmetic; the API still owns the authoritative limit. */
function PurchaseRewardBudgetHint({
  couponFaceValueYuan,
  maxRewardedTeams,
}: {
  couponFaceValueYuan?: number | null
  maxRewardedTeams?: number | null
}) {
  const hasInputs =
    typeof couponFaceValueYuan === 'number' &&
    Number.isFinite(couponFaceValueYuan) &&
    typeof maxRewardedTeams === 'number' &&
    Number.isInteger(maxRewardedTeams)
  if (!hasInputs) {
    return (
      <Typography.Paragraph type="secondary" className="activity-editor-tip">
        券总预算将随券面额及团队上限自动计算。
      </Typography.Paragraph>
    )
  }
  const totalCents = purchaseRewardTotalBudgetCents({
    couponFaceValueCents: yuanToCents(couponFaceValueYuan),
    maxRewardedTeams,
  })
  const overLimit = totalCents > PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS
  return (
    <div className={overLimit ? 'activity-editor-budget is-over-limit' : 'activity-editor-budget'}>
      <span>团队券总预算</span>
      <Typography.Text strong>{formatCents(totalCents)}</Typography.Text>
      <Typography.Text type={overLimit ? 'danger' : 'secondary'}>
        {overLimit
          ? `超过 ${formatCents(PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS)} 的上限，请调整配置`
          : '每人券面额 × 3 人 × 奖励团队数'}
      </Typography.Text>
    </div>
  )
}

/**
 * Consumption team reward editor (LL-PUR-002).
 *
 * Deliberately independent from `RewardPlanFields`: an activity can run the
 * check-in reward, the consumption team reward, both, or neither. Every field
 * maps 1:1 onto `purchaseRewardPlanSchema`; the only derived value is the
 * read-only total coupon budget, and even that is re-checked by the server.
 */
function PurchaseRewardPlanFields() {
  return (
    <>
      <Row gutter={12}>
        <Col xs={24} sm={12}>
          <Form.Item
            name="purchaseThresholdYuan"
            label="团队实付门槛（元）"
            rules={[{ required: true, message: '请填写团队实付门槛' }]}

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
        <Col xs={24} sm={12}>
          <Form.Item
            name="purchaseCouponFaceValueYuan"
            label="每人券面额（元）"
            rules={[{ required: true, message: '请填写每人券面额' }]}

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
        name="purchaseMaxRewardedTeams"
        label="奖励团队数量上限"
        dependencies={['purchaseCouponFaceValueYuan']}
        rules={[
          { required: true, message: '请填写奖励团队数量上限' },
          ({ getFieldValue }) => ({
            validator: async (_rule, value: number | null | undefined) => {
              if (typeof value !== 'number' || !Number.isInteger(value)) return
              const couponYuan = getFieldValue('purchaseCouponFaceValueYuan') as
                | number
                | undefined
              if (typeof couponYuan !== 'number') return
              const totalCents = purchaseRewardTotalBudgetCents({
                couponFaceValueCents: yuanToCents(couponYuan),
                maxRewardedTeams: value,
              })
              if (totalCents > PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS) {
                throw new Error(
                  `团队券总预算 ${formatCents(totalCents)} 超过上限 ${formatCents(
                    PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS,
                  )}，请降低每人券面额或团队数量上限`,
                )
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

      <Form.Item
        noStyle
        shouldUpdate={(prev, next) =>
          prev.purchaseCouponFaceValueYuan !== next.purchaseCouponFaceValueYuan ||
          prev.purchaseMaxRewardedTeams !== next.purchaseMaxRewardedTeams
        }
      >
        {({ getFieldValue }) => (
          <PurchaseRewardBudgetHint
            couponFaceValueYuan={getFieldValue('purchaseCouponFaceValueYuan') as number | undefined}
            maxRewardedTeams={getFieldValue('purchaseMaxRewardedTeams') as number | undefined}
          />
        )}
      </Form.Item>

      <Typography.Paragraph type="secondary" className="activity-editor-tip">
        消费奖励与签到奖励独立，可同时启用；总预算由服务器校验。
      </Typography.Paragraph>
    </>
  )
}

interface ThemeSwatchPickerProps {
  value?: ActivityThemeKey
  onChange?: (value: ActivityThemeKey) => void
}

/** Four curated theme swatches; the value lives in the shared activity Form. */
function ThemeSwatchPicker({ value, onChange }: ThemeSwatchPickerProps) {
  const selected = value ?? DEFAULT_ACTIVITY_THEME_KEY
  return (
    <div className="activity-theme-swatches" role="radiogroup" aria-label="活动主题">
      {ACTIVITY_THEME_VISUALS.map((theme) => {
        const checked = selected === theme.key
        return (
          <button
            key={theme.key}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={theme.label}
            className={checked ? 'activity-theme-swatch is-selected' : 'activity-theme-swatch'}
            onClick={() => onChange?.(theme.key)}
            style={
              {
                '--activity-theme-primary': theme.primary,
                '--activity-theme-surface': theme.surface,
              } as CSSProperties
            }
          >
            <span className="activity-theme-swatch-dot" aria-hidden="true" />
            <span className="activity-theme-swatch-copy">
              <strong>{theme.label}</strong>
              <small>{theme.description}</small>
            </span>
          </button>
        )
      })}
    </div>
  )
}

interface VisualImageUrlFieldProps {
  value?: string
  onChange?: (value: string) => void
  /** Injected by Form.Item so its label points at the URL input. */
  id?: string
  kind: 'hero' | 'poster'
}

/**
 * URL input + load/replace/clear preview for the head image and the single
 * poster. Previewing is deliberately local: the admin never uploads or proxies
 * the file, so a broken/hotlink-protected URL must say so instead of looking
 * configured.
 */
function VisualImageUrlField({ value, onChange, id, kind }: VisualImageUrlFieldProps) {
  const raw = value ?? ''
  const trimmed = raw.trim()
  const invalidReason = visualImageUrlError(trimmed)
  const canPreview = trimmed !== '' && invalidReason === null
  // Derive the phase from the URL instead of resetting it in an effect: a new
  // URL is "loading" until its own <img> reports load/error.
  const [preview, setPreview] = useState<{
    url: string
    phase: 'loading' | 'loaded' | 'error'
  }>({ url: '', phase: 'loading' })
  const phase = preview.url === trimmed ? preview.phase : 'loading'

  const noun = kind === 'hero' ? '头图' : '海报'
  return (
    <div className="activity-visual-image-field">
      <div className="activity-visual-image-input">
        <Input
          id={id}
          value={raw}
          placeholder={
            kind === 'hero' ? 'https://…/activity-hero.jpg' : 'https://…/activity-poster.jpg'
          }
          onChange={(event) => onChange?.(event.target.value)}
        />
        <Button
          type="default"
          aria-label={`清空${noun}`}
          disabled={trimmed === ''}
          onClick={() => onChange?.('')}
        >
          清空
        </Button>
      </div>
      {canPreview ? (
        <div className={`activity-visual-image-preview is-${kind}`}>
          <img
            key={trimmed}
            src={trimmed}
            alt={`${noun}链接预览`}
            onLoad={() => setPreview({ url: trimmed, phase: 'loaded' })}
            onError={() => setPreview({ url: trimmed, phase: 'error' })}
          />
          {phase === 'loading' ? (
            <Typography.Text type="secondary" className="activity-visual-image-status">
              正在加载{noun}预览…
            </Typography.Text>
          ) : null}
          {phase === 'error' ? (
            <Alert
              className="activity-visual-image-status"
              type="warning"
              showIcon
              title={`${noun}加载失败`}
              description="请确认该 http(s) 地址可直接访问、指向图片文件，且未限制外链。"
            />
          ) : null}
        </div>
      ) : trimmed !== '' ? (
        <Typography.Text type="danger" className="activity-visual-image-status">
          无法预览：{invalidReason}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary" className="activity-visual-image-status">
          {kind === 'hero'
            ? '填写头图 URL 后在此预览；建议 4:3 横图。'
            : '填写海报 URL 后在此预览；建议 3:4 或 9:16 竖图。'}
        </Typography.Text>
      )}
    </div>
  )
}

/**
 * Compact phone-shaped preview fed by the live form values.
 *
 * Every visible value is read from the same Form as the editor, so the operator
 * sees the real theme/title/copy instead of a hard-coded sample. The poster has
 * its own preview below and no share/QR mock is drawn here.
 */
function ActivityVisualPreview({
  status,
  location,
}: {
  status: ActivityStatus | null
  location?: string
}) {
  const title = Form.useWatch('title')
  const themeKey = Form.useWatch('visualThemeKey') as ActivityThemeKey | undefined
  const heroImageUrl = Form.useWatch('visualHeroImageUrl')
  const promoTitle = Form.useWatch('visualPromoTitle')
  const promoSubtitle = Form.useWatch('visualPromoSubtitle')
  const theme = activityThemeVisual(themeKey)
  const hero = (heroImageUrl ?? '').trim()
  const heroInvalid = visualImageUrlError(hero)
  const heroViewable = hero !== '' && heroInvalid === null
  const [heroPreview, setHeroPreview] = useState<{
    url: string
    phase: 'loading' | 'loaded' | 'error'
  }>({ url: '', phase: 'loading' })
  const heroPhase = heroPreview.url === hero ? heroPreview.phase : 'loading'

  const ctaLabel =
    status === 'published'
      ? '立即参与活动'
      : status === 'paused'
        ? '活动已暂停'
        : status === 'ended'
          ? '活动已结束'
          : '活动未发布'
  const headline = promoTitle?.trim() || title?.trim() || '填写活动标题后预览'
  const subline = promoSubtitle?.trim() || '填写宣传副标题后在此预览'

  return (
    <aside className="activity-visual-preview" aria-label="活动页实时预览">
      <div className="activity-visual-preview-head">
        <Typography.Text strong>居民端实时预览</Typography.Text>
        <Typography.Text type="secondary">读取当前表单值</Typography.Text>
      </div>
      <div
        className="activity-preview-phone"
        data-theme={theme.key}
        style={
          {
            '--activity-preview-primary': theme.primary,
            '--activity-preview-surface': theme.surface,
            '--activity-preview-accent': theme.accentSoft,
            '--activity-preview-text': theme.text,
          } as CSSProperties
        }
      >
        <div className="activity-preview-hero">
          {heroViewable ? (
            <>
              <img
                src={hero}
                alt="居民端头图预览"
                onLoad={() => setHeroPreview({ url: hero, phase: 'loaded' })}
                onError={() => setHeroPreview({ url: hero, phase: 'error' })}
              />
              {heroPhase === 'error' ? (
                <span className="activity-preview-hero-error" role="status">
                  头图加载失败，请检查链接
                </span>
              ) : null}
            </>
          ) : (
            <span className="activity-preview-hero-empty">
              {hero !== '' ? '头图地址无效，无法预览' : '填写头图 URL 后在此预览（建议 4:3）'}
            </span>
          )}
        </div>
        <div className="activity-preview-body">
          <span className="activity-preview-theme-label">{theme.label}</span>
          <h3 className="activity-preview-title">{headline}</h3>
          <p className="activity-preview-subtitle">{subline}</p>
          <p className="activity-preview-location">
            {location?.trim() || '活动地点来自「活动信息」'}
          </p>
          <span className="activity-preview-cta" aria-hidden="true">
            {ctaLabel}
          </span>
        </div>
      </div>
    </aside>
  )
}

/** Single vertical poster preview; no share card, QR code or "shared" state. */
function ActivityPosterPreview() {
  const posterImageUrl = Form.useWatch('visualPosterImageUrl')
  const poster = (posterImageUrl ?? '').trim()
  const invalidReason = visualImageUrlError(poster)
  const [posterPreview, setPosterPreview] = useState<{
    url: string
    phase: 'loading' | 'loaded' | 'error'
  }>({ url: '', phase: 'loading' })
  const phase = posterPreview.url === poster ? posterPreview.phase : 'loading'

  return (
    <div className="activity-visual-poster" aria-label="宣传海报预览">
      <div className="activity-visual-poster-head">
        <Typography.Title level={5}>宣传海报（单张竖版）</Typography.Title>
        <Typography.Text type="secondary">
          建议 3:4 或 9:16 竖图；此处只预览主视觉，不生成分享卡片或二维码。
        </Typography.Text>
      </div>
      <div className="activity-poster-frame">
        {poster !== '' && invalidReason === null ? (
          <>
            <img
              src={poster}
              alt="海报预览"
              onLoad={() => setPosterPreview({ url: poster, phase: 'loaded' })}
              onError={() => setPosterPreview({ url: poster, phase: 'error' })}
            />
            {phase === 'error' ? (
              <span className="activity-poster-status" role="status">
                海报加载失败，请检查链接是否可直接访问
              </span>
            ) : null}
          </>
        ) : (
          <span className="activity-poster-status">
            {poster !== '' ? `无法预览：${invalidReason}` : '填写海报 URL 后在此预览'}
          </span>
        )}
      </div>
    </div>
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
  const location = useLocation()
  const navigate = useNavigate()
  // The same activity editor owns the three tabbed sections and one Form;
  // routes are URL-addressable, but tab changes never remount or lose fields.
  const editMatch = location.pathname.match(/^\/activities\/([^/]+)\/edit\/?$/u)
  const editorOpen = location.pathname === '/activities/new' || Boolean(editMatch)
  const editorMode: 'create' | 'edit' = editMatch ? 'edit' : 'create'
  const editingActivityId = editMatch?.[1] ?? null
  const [activeSection, setActiveSection] = useState<'info' | 'checkin' | 'purchase' | 'visual'>('info')
  const [publicRulesOpen, setPublicRulesOpen] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
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

  const [detail, setDetail] = useState<AdminActivityDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
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
    // The create-page Form is mounted before this effect, and tab changes
    // never reset it; the initial community is set only on route entry.
    form.resetFields()
    setHasUnsavedChanges(false)
    const defaultCommunity = isAdmin
      ? communities[0]?.id
      : (assignedCommunities[0]?.id ?? communities[0]?.id)
    form.setFieldsValue({
      ...(defaultCommunity ? { communityId: defaultCommunity } : {}),
      // A brand-new activity has no plan: keep the section collapsed but give
      // the fields usable starting values for when the operator turns it on.
      ...rewardPlanToForm(null),
      ...purchaseRewardPlanToForm(null),
      // Only the default theme is pre-selected; the artwork/copy stay blank.
      ...visualConfigToForm(null),
    })
    // Only entering the create route resets; later community refreshes
    // must not wipe what the operator is typing.
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
    setActiveSection('info')
    setPublicRulesOpen(false)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
    setSaveError(null)
    setHasUnsavedChanges(false)
    navigate('/activities/new')
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
      setHasUnsavedChanges(false)
    } catch (cause: unknown) {
      if (detailRequestRef.current !== request) return
      setDetailError(describeError(cause, '无法读取活动详情'))
    } finally {
      if (detailRequestRef.current === request) setDetailLoading(false)
    }
  }

  // Direct links and list navigation share one loader; late replies from
  // previous activity IDs are discarded by loadDetail's request guard.
  useEffect(() => {
    if (!editorOpen || editorMode !== 'edit' || !editingActivityId) return
    setActiveSection('info')
    setPublicRulesOpen(false)
    setSaveError(null)
    void loadDetail(editingActivityId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorMode, editorOpen, editingActivityId])

  function openEdit(row: AdminActivitySummary) {
    detailRequestRef.current += 1
    setSaveError(null)
    setActiveSection('info')
    setPublicRulesOpen(false)
    setHasUnsavedChanges(false)
    navigate('/activities/' + row.id + '/edit')
  }

  // The editor is URL-addressable, so guard refresh/close as well as the
  // in-page back button. Loading or saving clears the flag again.
  useEffect(() => {
    if (!editorOpen || !hasUnsavedChanges) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [editorOpen, hasUnsavedChanges])

  const leaveEditor = () => {
    detailRequestRef.current += 1
    setHasUnsavedChanges(false)
    setSaving(false)
    setDetailLoading(false)
    navigate('/activities')
  }

  const closeEditor = () => {
    if (!hasUnsavedChanges) {
      leaveEditor()
      return
    }
    modal.confirm({
      title: '放弃未保存的修改？',
      content: '当前表单内容尚未保存，离开后将无法恢复。',
      okText: '放弃修改',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: leaveEditor,
    })
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
      setHasUnsavedChanges(false)
      refreshList()
      if (editorMode === 'edit' && result?.id) {
        // Re-read the persisted detail after a save instead of trusting the
        // form: a visual-only save must be verified against the server, and
        // the operator stays in the editor so the saved values are visible.
        const request = detailRequestRef.current + 1
        detailRequestRef.current = request
        try {
          const refreshed = await getActivity(result.id)
          if (detailRequestRef.current === request) {
            setDetail(refreshed)
            form.setFieldsValue(toFormValues(refreshed))
          }
        } catch {
          if (detailRequestRef.current === request) {
            setDetail(result)
            form.setFieldsValue(toFormValues(result))
          }
        }
      } else {
        setDetail(null)
        navigate('/activities')
      }
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
    const purchaseRewardLocked =
      editorMode === 'edit' &&
      (detail?.status === 'published' || detail?.status === 'paused')
    const keyRulesResult = keyRulesFromForm(
      values,
      editorMode === 'edit' && detail
        ? {
            purchaseRewardLocked,
            purchaseRewardPlanBaseline: detail.purchaseRewardPlan ?? null,
          }
        : {},
    )
    if (!keyRulesResult.ok) {
      setSaveError(keyRulesResult.message)
      return
    }
    const keyRules = keyRulesResult.keyRules
    const visualResult = visualConfigFromForm(values)
    if (!visualResult.ok) {
      setActiveSection('visual')
      setSaveError(visualResult.message)
      return
    }
    const visualConfig = visualResult.visualConfig

    if (editorMode === 'create') {
      const parsed = createActivityRequestSchema.safeParse({
        communityId: values.communityId,
        title: values.title.trim(),
        keyRules,
        // A brand-new activity may pick only a theme; the artwork/copy stay
        // explicit `null`s so the H5 shows its own safe defaults.
        visualConfig,
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
    const visualChanged =
      !detail.visualConfig || visualConfigChanged(detail.visualConfig, visualConfig)
    if (visualChanged) changes.visualConfig = visualConfig
    if (!changes.title && !changes.keyRules && !changes.visualConfig) {
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
    const stateAction: ActivityTransition | null =
      row.status === 'draft' ? 'publish' :
      row.status === 'published' ? 'pause' :
      row.status === 'paused' ? 'resume' : null
    const stateLabel = {
      publish: '发布',
      pause: '暂停',
      resume: '恢复',
      end: '结束',
    } as const
    return [
      {
        key: 'edit',
        label: row.status === 'ended' ? '查看' : '编辑',
        primary: true,
        disabled: busy,
        onClick: () => openEdit(row),
      },
      ...(stateAction ? [{
        key: stateAction,
        label: stateLabel[stateAction],
        primary: true,
        disabled: busy,
        onClick: () => confirmTransition(row, stateAction),
      }] : []),
      ...((row.status === 'published' || row.status === 'paused') ? [{
        key: 'end',
        label: '结束',
        danger: true,
        disabled: busy,
        onClick: () => confirmTransition(row, 'end'),
      }] : []),
      { key: 'versions', label: '规则版本', onClick: () => openVersions(row) },
      // Keep the existing entry for every state; draw-pool availability is
      // decided by its domain page, not silently removed by table cosmetics.
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
    <>
      {!editorOpen ? (
    <div className="page">
      <PageHeader
        title="活动管理"
        description="创建草稿、配置规则并发布活动；已发布规则冻结为只读版本，居民 H5 读取同一份活动数据。"
      />

      <div className="page-stack">
        {role === 'operator' ? (
          <PageInfoAlert
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
          toolbarExtra={
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
    </div>
      ) : null}

      {editorOpen ? (
      <div className="page activity-editor-page">
        <div className="activity-editor-heading">
          <Button type="text" className="activity-editor-back" onClick={closeEditor}>
            ← 返回活动列表
          </Button>
          <div className="activity-editor-heading-row">
            <div>
              <Typography.Title level={3} className="activity-editor-title">
                {drawerTitle}
              </Typography.Title>
              <Typography.Text type="secondary">
                {editorMode === 'create' ? '先保存草稿，确认奖励规则后再发布' : '活动资料与奖励独立管理，发布后受原有规则版本约束'}
              </Typography.Text>
            </div>
            {detail ? <Tag color={ACTIVITY_STATUS_META[detail.status].color}>{ACTIVITY_STATUS_META[detail.status].label}</Tag> : null}
          </div>
        </div>
        <nav className="activity-editor-tabs" role="tablist" aria-label="活动编辑区域">
          {([
            ['info', '活动信息'],
            ['checkin', '签到奖励'],
            ['purchase', '消费奖励'],
            ['visual', '界面风格'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeSection === key}
              aria-controls={'activity-editor-' + key}
              className={activeSection === key ? 'activity-editor-tab is-active' : 'activity-editor-tab'}
              onClick={() => setActiveSection(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="activity-editor-content">
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
            <PageInfoAlert inline
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
              <Descriptions.Item label="消费组团奖励">
                <PurchaseRewardPlanSummary plan={detail.purchaseRewardPlan ?? null} />
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
            onValuesChange={() => setHasUnsavedChanges(true)}
            onFinish={submitEditor}
            onFinishFailed={({ errorFields }) => {
              const name = String(errorFields[0]?.name[0] ?? '')
              const section = name.startsWith('reward') ? 'checkin'
                : name.startsWith('purchase') ? 'purchase'
                : name.startsWith('visual') ? 'visual' : 'info'
              setActiveSection(section)
              if (section === 'info' && ['eligibility', 'checkin', 'purchase', 'prizeClaim', 'notes'].includes(name)) {
                setPublicRulesOpen(true)
              }
              setSaveError('有必填项或格式需要检查，已为你切换到相应区域。')
            }}
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

                        <section
              id="activity-editor-info"
              role="tabpanel"
              aria-label="活动信息"
              style={{ display: activeSection === 'info' ? undefined : 'none' }}
            >
            <Typography.Title level={5} className="activity-editor-section-title">活动信息</Typography.Title>
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
              label="活动时间"
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

            <div className="activity-editor-disclosure">
              <Button type="text" onClick={() => setPublicRulesOpen((v) => !v)} aria-expanded={publicRulesOpen}>
                {publicRulesOpen ? '收起' : '展开'}参与说明（居民端展示）
              </Button>
              <Typography.Text type="secondary">参与资格、签到、购买与领取说明（居民端只读）</Typography.Text>
            </div>
            <div style={{ display: publicRulesOpen ? undefined : 'none' }}>

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

            </div>
            </section>

            <section
              id="activity-editor-checkin"
              role="tabpanel"
              aria-label="签到奖励"
              style={{ display: activeSection === 'checkin' ? undefined : 'none' }}
            >
              <Typography.Title level={5} className="activity-editor-section-title">签到奖励</Typography.Title>
              <Typography.Paragraph type="secondary" className="activity-editor-intro">
                三人团队完成有效签到后，按活动配置领取实物奖励。
              </Typography.Paragraph>

            <Form.Item
              name="rewardPlanEnabled"
              label="启用签到奖励"
              valuePropName="checked"
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
                  <Typography.Paragraph type={getFieldValue('rewardPlanBaseline') ? 'danger' : 'secondary'}>
                    {getFieldValue('rewardPlanBaseline')
                      ? '注意：保存后会清空此活动的签到奖励计划，并关闭新的领奖资格；已发出的奖励不受影响。'
                      : '未启用签到奖励；居民仍可查看活动，但不能参与该活动的奖励签到和领奖。'}
                  </Typography.Paragraph>
                )
              }
            </Form.Item>

            </section>

            <section
              id="activity-editor-purchase"
              role="tabpanel"
              aria-label="消费奖励"
              style={{ display: activeSection === 'purchase' ? undefined : 'none' }}
            >
              <Typography.Title level={5} className="activity-editor-section-title">消费奖励</Typography.Title>
              <Typography.Paragraph type="secondary" className="activity-editor-intro">
                三人团队达成消费门槛后，每人领取一张同面额平台券。
              </Typography.Paragraph>

            {editorMode === 'edit' && detail && detail.status !== 'draft' ? (
              <PageInfoAlert inline
                type="info"
                showIcon
                title="消费组团奖励已冻结"
                description={
                  <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                    <PurchaseRewardPlanSummary plan={detail.purchaseRewardPlan ?? null} />
                    <Typography.Text type="secondary">
                      发布/暂停期间该规则随规则版本冻结，不可修改；其他活动字段仍可编辑。如需调整请结束活动后新建。
                    </Typography.Text>
                  </Space>
                }
              />
            ) : (
              <>
                <Form.Item
                  name="purchaseRewardEnabled"
                  label="启用消费奖励"
                  valuePropName="checked"
                >
                  <Switch checkedChildren="已配置" unCheckedChildren="未配置" />
                </Form.Item>

                <Form.Item
                  noStyle
                  shouldUpdate={(prev, next) =>
                    prev.purchaseRewardEnabled !== next.purchaseRewardEnabled ||
                    prev.purchaseRewardPlanBaseline !== next.purchaseRewardPlanBaseline
                  }
                >
                  {({ getFieldValue }) =>
                    getFieldValue('purchaseRewardEnabled') ? (
                      <PurchaseRewardPlanFields />
                    ) : (
                      <Typography.Paragraph type={getFieldValue('purchaseRewardPlanBaseline') ? 'danger' : 'secondary'}>
                        {getFieldValue('purchaseRewardPlanBaseline')
                          ? '注意：保存后会清空本活动的消费奖励配置。'
                          : '未启用消费奖励，不影响签到奖励。'}
                      </Typography.Paragraph>
                    )
                  }
                </Form.Item>
              </>
            )}

            {editorMode === 'edit' && detail?.status === 'draft' ? (
              <Typography.Text type="secondary">
                草稿修改不生成规则版本；发布后奖励规则按原有合同冻结。
              </Typography.Text>
            ) : null}
            </section>

            <section
              id="activity-editor-visual"
              role="tabpanel"
              aria-label="界面风格"
              style={{ display: activeSection === 'visual' ? undefined : 'none' }}
            >
              <Typography.Title level={5} className="activity-editor-section-title">界面风格</Typography.Title>
              <Typography.Paragraph type="secondary" className="activity-editor-intro">
                配置居民 H5 活动页的主题、头图、宣传文案与单张海报；只选择主题也可以保存，其余字段可留空。
              </Typography.Paragraph>

              <div className="activity-visual-layout">
                <div className="activity-visual-fields">
                  <Form.Item
                    name="visualThemeKey"
                    label="活动主题"
                    extra="四种主题只影响活动页配色，不改变活动状态或奖励规则。"
                  >
                    <ThemeSwatchPicker />
                  </Form.Item>

                  <Form.Item
                    name="visualHeroImageUrl"
                    label="活动头图 URL"
                    rules={[
                      {
                        validator: async (_rule, value: unknown) => {
                          const message = visualImageUrlError(
                            typeof value === 'string' ? value : '',
                          )
                          if (message) throw new Error(message)
                        },
                      },
                    ]}
                    extra="建议 4:3 横图；仅支持可直接访问的 http(s) 图片地址，留空则使用默认视觉。"
                  >
                    <VisualImageUrlField kind="hero" />
                  </Form.Item>

                  <Form.Item
                    name="visualPosterImageUrl"
                    label="宣传海报 URL（单张竖版）"
                    rules={[
                      {
                        validator: async (_rule, value: unknown) => {
                          const message = visualImageUrlError(
                            typeof value === 'string' ? value : '',
                          )
                          if (message) throw new Error(message)
                        },
                      },
                    ]}
                    extra="建议 3:4 或 9:16 竖图；用于分享海报主视觉，留空则回退使用头图。"
                  >
                    <VisualImageUrlField kind="poster" />
                  </Form.Item>

                  <Form.Item
                    name="visualPromoTitle"
                    label="宣传标题（选填）"
                    rules={[
                      {
                        max: ACTIVITY_PROMO_TITLE_MAX_LENGTH,
                        message: `最多 ${ACTIVITY_PROMO_TITLE_MAX_LENGTH} 个字符`,
                      },
                    ]}
                    extra={`最多 ${ACTIVITY_PROMO_TITLE_MAX_LENGTH} 个字符；留空时居民端使用活动标题。`}
                  >
                    <Input
                      maxLength={ACTIVITY_PROMO_TITLE_MAX_LENGTH}
                      showCount
                      placeholder="填写面向居民的活动宣传标题"
                    />
                  </Form.Item>

                  <Form.Item
                    name="visualPromoSubtitle"
                    label="宣传副标题（选填）"
                    rules={[
                      {
                        max: ACTIVITY_PROMO_SUBTITLE_MAX_LENGTH,
                        message: `最多 ${ACTIVITY_PROMO_SUBTITLE_MAX_LENGTH} 个字符`,
                      },
                    ]}
                    extra={`最多 ${ACTIVITY_PROMO_SUBTITLE_MAX_LENGTH} 个字符；留空时居民端不显示副标题。`}
                  >
                    <Input
                      maxLength={ACTIVITY_PROMO_SUBTITLE_MAX_LENGTH}
                      showCount
                      placeholder="填写一句补充说明，例如时间或亮点"
                    />
                  </Form.Item>
                </div>

                <ActivityVisualPreview status={detail?.status ?? null} location={detail?.location} />
              </div>

              <ActivityPosterPreview />
            </section>

            <div className="activity-editor-footer">
              <Typography.Text type="secondary" className="activity-editor-footer-hint">
                {editorMode === 'create' ? '先保存草稿，发布操作仍在活动列表中进行' : '保存前会检查各区域的全部必填项'}
              </Typography.Text>
              <Space className="activity-form-actions">
              <Button onClick={closeEditor} disabled={saving}>
                取消
              </Button>
              <Button type="primary" htmlType="submit" loading={saving}>
                {editorMode === 'create' ? '保存草稿' : '保存修改'}
              </Button>
              </Space>
            </div>
          </Form>
        )}
        </div>
      </div>
      ) : null}

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
                  <Descriptions.Item label="消费组团奖励">
                    <PurchaseRewardPlanSummary
                      plan={version.snapshot.purchaseRewardPlan ?? null}
                    />
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
    </>
  )
}
