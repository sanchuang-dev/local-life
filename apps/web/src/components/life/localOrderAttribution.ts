import type {
  CreateLocalOrderRequest,
  LocalOrderSummary,
  LocalOrderTeamOption,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Resident-facing consumption-team attribution for a new local order (#209).
 *
 * The option list is read from `GET /local-orders/team-options`; this module only
 * decides how that list maps to one immutable `(activity, team)` pair. It never
 * infers a second team, a default community or a fallback attribution: zero
 * options means "no team", one option is selected automatically, and more than
 * one requires an explicit choice by the resident.
 */

/** The subset of the create request that freezes the order's team attribution. */
export type LocalOrderAttribution = Pick<
  CreateLocalOrderRequest,
  'sourceActivityId' | 'sourceTeamId'
>

export type TeamSelectionMode = 'none' | 'auto' | 'choice'

export function teamSelectionMode(options: readonly LocalOrderTeamOption[]): TeamSelectionMode {
  if (options.length === 0) return 'none'
  if (options.length === 1) return 'auto'
  return 'choice'
}

/**
 * The one option the current UI state stands for, or `null` when a multi-team
 * list has no valid explicit selection. A stale id that disappeared from a
 * refreshed list resolves to `null` rather than to some other team.
 */
export function chooseTeamOption(
  options: readonly LocalOrderTeamOption[],
  selectedTeamId: string | null,
): LocalOrderTeamOption | null {
  if (options.length === 0) return null
  if (options.length === 1) return options[0] ?? null
  if (!selectedTeamId) return null
  return options.find((option) => option.team.id === selectedTeamId) ?? null
}

export type AttributionResolution =
  | { ok: true; option: LocalOrderTeamOption | null; attribution: LocalOrderAttribution }
  | { ok: false; message: string }

/**
 * Decide the attribution for a fresh submission.
 *
 * A team always travels with its activity id, because the API refuses a bare
 * team id and re-checks that the resident joined that exact team. A multi-team
 * list without a valid explicit choice is a refusal, never a silent first item.
 */
export function resolveOrderAttribution(
  options: readonly LocalOrderTeamOption[],
  selectedTeamId: string | null,
): AttributionResolution {
  const mode = teamSelectionMode(options)
  if (mode === 'none') {
    return { ok: true, option: null, attribution: {} }
  }

  const option = chooseTeamOption(options, selectedTeamId)
  if (!option) {
    return { ok: false, message: '请选择一个消费团归属后再提交登记。' }
  }

  return {
    ok: true,
    option,
    attribution: {
      sourceActivityId: option.activity.id,
      sourceTeamId: option.team.id,
    },
  }
}

export interface LocalOrderSubmissionAttempt {
  idempotencyKey: string
  attribution: LocalOrderAttribution
}

/**
 * One submission attempt = one idempotency key + one frozen attribution.
 *
 * Once an attempt exists every retry reuses both. Changing the UI selection can
 * therefore not turn a replay into a different order; the resident must
 * explicitly discard the attempt before choosing another team.
 */
export function resolveSubmissionAttempt(
  previous: LocalOrderSubmissionAttempt | null,
  attribution: LocalOrderAttribution,
  createKey: () => string,
): LocalOrderSubmissionAttempt {
  return previous ?? { idempotencyKey: createKey(), attribution }
}

export function buildLocalOrderRegistration(input: {
  productId: string
  quantity: number
  note: string
  attribution: LocalOrderAttribution
  idempotencyKey: string
}): CreateLocalOrderRequest {
  const note = input.note.trim()
  return {
    productId: input.productId,
    quantity: input.quantity,
    ...(note ? { note } : {}),
    ...input.attribution,
    idempotencyKey: input.idempotencyKey,
  }
}

/** Shorten a UUID for display; the full id stays on the frozen order. */
export function shortTeamId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/** Read-only description of the attribution already frozen on an order. */
export function describeOrderAttribution(
  order: Pick<LocalOrderSummary, 'sourceActivity' | 'sourceTeam'>,
): string {
  if (!order.sourceTeam) return '不参与消费团'
  const activityTitle = order.sourceActivity?.title ?? '来源活动'
  return `${activityTitle} · 团号 ${shortTeamId(order.sourceTeam.id)}（已锁定）`
}
