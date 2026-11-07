import { z } from 'zod'

/**
 * Unified operating ledger, bookkeeping and reconciliation (LL-MVP-008, Issue #64).
 *
 * Business boundaries (see the Issue and `docs/engineering/`):
 *
 * - **四层事实口径，绝不合并**：订单登记金额 (`order_registered`)、已核验有效业绩
 *   (`order_verified`)、人工收款与冲正 (`payment_received` / `payment_reversed`)、
 *   奖励成本与冲正 (`reward_cost` / `reward_reversed`) 是四种不同的钱。把它们压成
 *   一个「成交额」正是本卡要禁止的事情。
 * - **数据来源只有既有事实表**：本地订单 (`local_orders`)、已核验广电 CRM
 *   (`crm_service_orders`)、奖励履约 (`activity_reward_grants`)。本契约不引入
 *   CRMEB 实时接入、在线支付、自动分账或第二套订单系统。
 * - `crm_service_orders` **没有金额列**，它只能贡献「笔数」与「归属」，永远不能
 *   作为金额来源；`local_orders.total_cents` 只是订单登记金额，`status='verified'`
 *   是人工事实核验，**不是付款**；`activity_reward_grants.total_cost_cents` 是可
 *   SUM 的奖励成本。
 * - **订单创建人 / 记录人不是业绩归属**。只有来源事实上显式存在的
 *   `attributedStaffId`（或经确认的归属事实）才能产生 `attribution.state =
 *   'attributed'`；其余一律 `pending`（「待归属」），宁可不归属也不臆造。
 * - **金额一律整数分**：所有 `*Cents` 字段都是 `z.number().int()`，不接受浮点。
 * - **没有结算规则就没有应付金额**：`settlementAmountStatus` 在无规则时只能是
 *   `pending_rule`，禁止生成虚假应付 / 分账金额。
 *
 * Every request/response body below is a `strictObject` unless it is a pure query
 * object, so an unknown field fails parsing instead of being silently dropped.
 * Both `/admin/*` and `/staff/*` surfaces return exactly these DTOs; the API
 * `schema.parse`s its own response before `c.json`.
 */

/** ISO-8601 UTC timestamp, identical shape to the other contract modules. */
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

/** Integer cents. A ledger amount is never a float, never a string. */
const cents = z.number().int().min(0)

const count = z.number().int().min(0)

const uuid = z.string().uuid()

/**
 * A business date (`YYYY-MM-DD`). Ledger period filters and reconciliation
 * periods are business days, not instants: the server interprets them in
 * `Asia/Shanghai` (see `LEDGER_TIME_ZONE`) and both ends are inclusive.
 */
const businessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD business date')

/** `true`/`false` query strings; anything else must fail instead of being truthy. */
const queryFlag = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
)

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Route identifiers of the ledger surfaces. Clients must build URLs from here.
 *
 * - `/staff/ledger/*`       任意 staff 角色（含网格员），按社区范围裁剪。存在的
 *                           理由与 `/staff/local-orders` 相同：`/admin/*` 按约定
 *                           拒绝网格员，而网格员需要看自己社区的流水。
 * - `/admin/ledger/*`       管理员 / 运营员（拒绝 `grid_worker`，403）。
 * - `/admin/reconciliation/*` 对账批次，同样是管理员 / 运营员专属。
 */
export const LEDGER_ROUTES = {
  /** Staff (any role): read-only overview of the caller's communities. */
  staffOverview: '/staff/ledger/overview',
  /** Staff (any role): append-only fact entries of the caller's communities. */
  staffEntries: '/staff/ledger/entries',
  /** Staff (any role): anomaly inbox of the caller's communities. */
  staffAnomalies: '/staff/ledger/anomalies',
  /** Back office: same overview, admin/operator only. */
  adminOverview: '/admin/ledger/overview',
  /** Back office: same entry list, admin/operator only. */
  adminEntries: '/admin/ledger/entries',
  /** Back office: anomaly inbox. */
  adminAnomalies: '/admin/ledger/anomalies',
  /** Explicit projection of existing business facts; a CSRF-protected POST. */
  adminSync: '/admin/ledger/sync',
  /** Back office: one reconciliation batch by id. */
  adminBatchDetail: '/admin/reconciliation/batches/:batchId',
  /** Back office: list / create reconciliation batches. */
  adminBatches: '/admin/reconciliation/batches',
  /** Back office: lock a batch (open -> locked, one way, CSRF required). */
  adminBatchLock: '/admin/reconciliation/batches/:batchId/lock',
  /** Back office: the fact entries of one batch, paged (read-only). */
  adminBatchEntries: '/admin/reconciliation/batches/:batchId/entries',
  /** Back office: facts of a period that no *locked* batch covers, plus open anomalies. */
  adminDiff: '/admin/reconciliation/diff',
  /** Back office: CSV download of one batch or period (Chinese-Excel-readable, redacted). */
  adminExportCsv: '/admin/reconciliation/export.csv',
} as const

/**
 * Time zone used for every business-date interpretation and report `asOf`
 * rendering. China has a single offset and no DST, so the API converts with a
 * fixed `+08:00` offset instead of a time zone database.
 */
export const LEDGER_TIME_ZONE = 'Asia/Shanghai' as const
export const LEDGER_TIME_ZONE_OFFSET = '+08:00' as const

/* -------------------------------------------------------------------------- */
/* Fact kinds (四层口径)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The six fact kinds. They are deliberately *not* merged: a report may sum
 * `order_registered` (登记金额), `order_verified` (已核验业绩), `payment_received`
 * (实收), `reward_cost` (奖励成本) separately, and a reversal is always its own
 * positive-amount row pointing at the entry it reverses (`counterEntryId`).
 */
export const ledgerFactKindSchema = z.enum([
  'order_registered',
  'order_verified',
  'payment_received',
  'payment_reversed',
  'reward_cost',
  'reward_reversed',
])

export type LedgerFactKind = z.infer<typeof ledgerFactKindSchema>

/** Stable order of the six buckets in every report. */
export const LEDGER_FACT_KINDS = [
  'order_registered',
  'order_verified',
  'payment_received',
  'payment_reversed',
  'reward_cost',
  'reward_reversed',
] as const satisfies readonly LedgerFactKind[]

/**
 * Where one fact physically comes from. `manual` is the only producer of money
 * movement: there is no online payment integration in this MVP, so a
 * `payment_received` row is always a human-recorded receipt with evidence.
 */
export const ledgerSourceSystemSchema = z.enum([
  'local_order',
  'crm_service_order',
  'activity_reward_grant',
  'manual',
])

export type LedgerSourceSystem = z.infer<typeof ledgerSourceSystemSchema>

/**
 * Which producer may emit which fact kind. Enforced again in the service layer:
 * a `reward_cost` row can never claim to come from a local order, and an
 * `order_registered` row can never claim to come from the CRM.
 */
export const LEDGER_FACT_KIND_SOURCES: Record<
  LedgerFactKind,
  readonly LedgerSourceSystem[]
> = {
  order_registered: ['local_order'],
  order_verified: ['local_order', 'crm_service_order'],
  payment_received: ['manual'],
  payment_reversed: ['manual'],
  reward_cost: ['activity_reward_grant'],
  reward_reversed: ['activity_reward_grant'],
}

/** Money movement that must carry evidence + a handling staff member. */
export function isLedgerPaymentFact(kind: LedgerFactKind): boolean {
  return kind === 'payment_received' || kind === 'payment_reversed'
}

/** A reversal row always points at the entry it reverses (`counterEntryId`). */
export function isLedgerReversalFact(kind: LedgerFactKind): boolean {
  return kind === 'payment_reversed' || kind === 'reward_reversed'
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `attributed`  有明确归属：来源事实上的 `attributedStaffId` 或经确认的归属事实。
 * `pending`     待归属：来源事实没有归属信息，或归属存在冲突。**不臆造归属。**
 */
export const ledgerAttributionStateSchema = z.enum(['attributed', 'pending'])
export type LedgerAttributionState = z.infer<typeof ledgerAttributionStateSchema>

/**
 * Why an entry is (or is not) attributed. `explicit_attribution` /
 * `confirmed_fact` may only be paired with `state='attributed'`;
 * `no_explicit_attribution` / `source_missing` only with `state='pending'`.
 *
 * Recording the basis is what keeps "订单是网格员代下的" from silently becoming
 * "这一单算网格员的业绩": being the creator/recorder is never an attribution.
 */
export const ledgerAttributionBasisSchema = z.enum([
  'explicit_attribution',
  'confirmed_fact',
  'no_explicit_attribution',
  'source_missing',
])
export type LedgerAttributionBasis = z.infer<typeof ledgerAttributionBasisSchema>

export const LEDGER_ATTRIBUTED_BASES = [
  'explicit_attribution',
  'confirmed_fact',
] as const satisfies readonly LedgerAttributionBasis[]

export const ledgerAttributionSchema = z
  .strictObject({
    state: ledgerAttributionStateSchema,
    /** Owning grid worker / operator; `null` whenever the state is `pending`. */
    staffId: uuid.nullable(),
    /** Community the attribution belongs to; may be `null` for a manual fact. */
    communityId: uuid.nullable(),
    basis: ledgerAttributionBasisSchema,
  })
  .superRefine((attribution, ctx) => {
    const basisIsAttributed = (LEDGER_ATTRIBUTED_BASES as readonly string[]).includes(
      attribution.basis,
    )
    if (attribution.state === 'attributed') {
      if (attribution.staffId === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'an attributed fact must name the staff member it belongs to',
          path: ['staffId'],
        })
      }
      if (!basisIsAttributed) {
        ctx.addIssue({
          code: 'custom',
          message: 'state=attributed requires an explicit or confirmed attribution basis',
          path: ['basis'],
        })
      }
      return
    }
    if (attribution.staffId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a pending (待归属) fact must not claim a staff member',
        path: ['staffId'],
      })
    }
    if (basisIsAttributed) {
      ctx.addIssue({
        code: 'custom',
        message: 'a pending (待归属) fact cannot claim an explicit attribution basis',
        path: ['basis'],
      })
    }
  })

export type LedgerAttribution = z.infer<typeof ledgerAttributionSchema>

/* -------------------------------------------------------------------------- */
/* Amount status, evidence and reconciliation state                           */
/* -------------------------------------------------------------------------- */

/**
 * `pending_rule`   还没有结算规则，只能记录事实金额。**禁止据此生成应付/分账。**
 * `estimated`      已有一份明确的规则估算（人工确认后才会出现）。
 */
export const settlementAmountStatusSchema = z.enum(['pending_rule', 'estimated'])
export type SettlementAmountStatus = z.infer<typeof settlementAmountStatusSchema>

/**
 * Evidence reference of one fact. A payment is only a payment when it has a
 * human-verifiable reference (收据/转账凭据/CRM 确认截图). The database enforces
 * the same rule with a CHECK: 没有凭据不得计入实收.
 */
export const ledgerEvidenceKindSchema = z.enum([
  'manual_receipt',
  'bank_transfer',
  'crm_confirmation',
  'order_verification',
  'reward_grant',
  'none',
])
export type LedgerEvidenceKind = z.infer<typeof ledgerEvidenceKindSchema>

/**
 * A redacted, human-readable reference — never a full ID card, bank account or
 * password. `null` is allowed only for fact kinds that move no money.
 */
export const ledgerEvidenceSchema = z.strictObject({
  kind: ledgerEvidenceKindSchema,
  ref: z.string().trim().min(1).max(200).nullable(),
})

export type LedgerEvidence = z.infer<typeof ledgerEvidenceSchema>

/**
 * Where an entry stands in reconciliation.
 *
 * `unreconciled` 不在任何批次里；
 * `batched`      已加入某个 `open` 批次（仍可继续核对）；
 * `reconciled`   所属批次已 `locked`，金额与归属冻结。
 */
export const ledgerReconciliationStateSchema = z.enum([
  'unreconciled',
  'batched',
  'reconciled',
])
export type LedgerReconciliationState = z.infer<typeof ledgerReconciliationStateSchema>

/* -------------------------------------------------------------------------- */
/* Ledger entry (append-only fact row)                                        */
/* -------------------------------------------------------------------------- */

/**
 * One append-only ledger fact. Rows are never updated or deleted: a correction
 * is a new `*_reversed` row whose `counterEntryId` points at the original, which
 * is why every entry keeps `occurredAt` (when the business fact happened) and
 * `createdAt` (when it entered the ledger) apart.
 *
 * `sourceDisplayNo` is the human reference of the source (`local_orders.id` /
 * CRM `orderNo` / `activity_reward_grants.id`); `sourceId` is the machine key
 * that the `(sourceSystem, sourceId, factKind)` dedupe index protects.
 */
export const ledgerEntrySchema = z
  .strictObject({
    entryId: uuid,
    factKind: ledgerFactKindSchema,
    sourceSystem: ledgerSourceSystemSchema,
    sourceId: z.string().trim().min(1).max(200),
    sourceDisplayNo: z.string().trim().min(1).max(80),
    /** Owning community of the fact; always present (scope is community based). */
    communityId: uuid,
    /** Product of a local order fact; `null` for CRM / reward / manual facts. */
    productId: uuid.nullable(),
    occurredAt: isoTimestamp,
    /** Set exactly for `order_verified`; the moment the fact was verified. */
    verifiedAt: isoTimestamp.nullable(),
    amountCents: cents,
    settlementAmountStatus: settlementAmountStatusSchema,
    attribution: ledgerAttributionSchema,
    evidence: ledgerEvidenceSchema,
    /** Set exactly for reversal facts; points at the entry being reversed. */
    counterEntryId: uuid.nullable(),
    /** Reconciliation batch this entry belongs to; `null` when unbatchable yet. */
    batchId: uuid.nullable(),
    reconciliationState: ledgerReconciliationStateSchema,
    recordedByUserId: uuid.nullable(),
    recordedByStaffId: uuid.nullable(),
    createdAt: isoTimestamp,
  })
  .superRefine((entry, ctx) => {
    if (!LEDGER_FACT_KIND_SOURCES[entry.factKind].includes(entry.sourceSystem)) {
      ctx.addIssue({
        code: 'custom',
        message: `${entry.factKind} cannot be produced by ${entry.sourceSystem}`,
        path: ['sourceSystem'],
      })
    }

    if (isLedgerPaymentFact(entry.factKind)) {
      if (entry.evidence.ref === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'a recorded payment requires an evidence reference',
          path: ['evidence', 'ref'],
        })
      }
      if (entry.evidence.kind === 'none') {
        ctx.addIssue({
          code: 'custom',
          message: 'a recorded payment requires a concrete evidence kind',
          path: ['evidence', 'kind'],
        })
      }
      if (entry.recordedByStaffId === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'a recorded payment requires the staff member who handled it',
          path: ['recordedByStaffId'],
        })
      }
    } else if (entry.evidence.kind !== 'none' && entry.evidence.ref === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'evidence.kind requires evidence.ref',
        path: ['evidence', 'ref'],
      })
    }

    const reversal = isLedgerReversalFact(entry.factKind)
    if (reversal !== (entry.counterEntryId !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'counterEntryId is required exactly for reversal facts',
        path: ['counterEntryId'],
      })
    }

    if ((entry.factKind === 'order_verified') !== (entry.verifiedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'verifiedAt is required exactly for order_verified facts',
        path: ['verifiedAt'],
      })
    }

    if ((entry.batchId !== null) !== (entry.reconciliationState !== 'unreconciled')) {
      ctx.addIssue({
        code: 'custom',
        message: 'batchId is required exactly when the entry is batched/reconciled',
        path: ['batchId'],
      })
    }
  })

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

/** One fact-kind bucket of the overview. Never merged across fact kinds. */
export const ledgerFactKindBucketSchema = z.strictObject({
  factKind: ledgerFactKindSchema,
  entryCount: count,
  /** Gross sum of the bucket. Reversals are their own bucket, never a minus sign. */
  grossAmountCents: cents,
})

export type LedgerFactKindBucket = z.infer<typeof ledgerFactKindBucketSchema>

/**
 * Aggregated overview of the caller's communities.
 *
 * `amountStatus` is the *aggregate* settlement status. This MVP has no
 * settlement rule, so it is `pending_rule`: the overview reports recorded facts,
 * never a payable amount.
 */
export const ledgerOverviewSchema = z
  .strictObject({
    /** The instant the report was computed; never a cached page timestamp. */
    asOf: isoTimestamp,
    timeZone: z.literal(LEDGER_TIME_ZONE),
    amountStatus: settlementAmountStatusSchema,
    buckets: z.array(ledgerFactKindBucketSchema).length(LEDGER_FACT_KINDS.length),
    totals: z.strictObject({
      entryCount: count,
      grossAmountCents: cents,
    }),
    attributed: z.strictObject({
      entryCount: count,
      amountCents: cents,
    }),
    /** 「待归属」合计：这些钱没有可计入的业绩归属。 */
    pendingAttribution: z.strictObject({
      entryCount: count,
      amountCents: cents,
    }),
    openAnomalies: z.strictObject({ count }),
    /** 实收与收款冲正分列，禁止把冲正当负号静默抵消掉。 */
    payment: z.strictObject({
      receivedCents: cents,
      reversedCents: cents,
    }),
    reward: z.strictObject({
      costCents: cents,
      reversedCents: cents,
    }),
  })
  .superRefine((overview, ctx) => {
    const kinds = overview.buckets.map((bucket) => bucket.factKind)
    const expected = [...LEDGER_FACT_KINDS]
    if (kinds.length !== expected.length || kinds.some((kind, index) => kind !== expected[index])) {
      ctx.addIssue({
        code: 'custom',
        message: 'buckets must contain exactly the six fact kinds in LEDGER_FACT_KINDS order',
        path: ['buckets'],
      })
      return
    }

    const sumCount = overview.buckets.reduce((total, bucket) => total + bucket.entryCount, 0)
    const sumAmount = overview.buckets.reduce(
      (total, bucket) => total + bucket.grossAmountCents,
      0,
    )
    if (sumCount !== overview.totals.entryCount) {
      ctx.addIssue({
        code: 'custom',
        message: 'totals.entryCount must equal the sum of the fact-kind buckets',
        path: ['totals', 'entryCount'],
      })
    }
    if (sumAmount !== overview.totals.grossAmountCents) {
      ctx.addIssue({
        code: 'custom',
        message: 'totals.grossAmountCents must equal the sum of the fact-kind buckets',
        path: ['totals', 'grossAmountCents'],
      })
    }
    if (
      overview.attributed.entryCount + overview.pendingAttribution.entryCount !==
      overview.totals.entryCount
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'attributed + pendingAttribution entry counts must equal totals.entryCount',
        path: ['attributed', 'entryCount'],
      })
    }
    if (
      overview.attributed.amountCents + overview.pendingAttribution.amountCents !==
      overview.totals.grossAmountCents
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'attributed + pendingAttribution amounts must equal totals.grossAmountCents',
        path: ['attributed', 'amountCents'],
      })
    }
    const bucketOf = (kind: LedgerFactKind) =>
      overview.buckets.find((bucket) => bucket.factKind === kind)?.grossAmountCents ?? 0
    if (
      overview.payment.receivedCents !== bucketOf('payment_received') ||
      overview.payment.reversedCents !== bucketOf('payment_reversed')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'payment.receivedCents / reversedCents must mirror their fact-kind buckets',
        path: ['payment'],
      })
    }
    if (
      overview.reward.costCents !== bucketOf('reward_cost') ||
      overview.reward.reversedCents !== bucketOf('reward_reversed')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'reward.costCents / reversedCents must mirror their fact-kind buckets',
        path: ['reward'],
      })
    }
  })

export type LedgerOverview = z.infer<typeof ledgerOverviewSchema>

/** Explicit, authorized source projection; read-only GETs never ingest facts. */
export const ledgerSyncRequestSchema = z.strictObject({
  from: businessDate.optional(),
  to: businessDate.optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.to < value.from) {
    ctx.addIssue({ code: 'custom', message: 'to must not be earlier than from', path: ['to'] })
  }
})
export type LedgerSyncRequest = z.infer<typeof ledgerSyncRequestSchema>

const ledgerSyncSourceSchema = z.strictObject({
  scanned: count,
  created: count,
  skipped: count,
})
export const ledgerSyncResponseSchema = z.strictObject({
  scanned: count,
  created: count,
  skipped: count,
  sources: z.strictObject({
    localOrder: ledgerSyncSourceSchema,
    crmServiceOrder: ledgerSyncSourceSchema,
    activityRewardGrant: ledgerSyncSourceSchema,
  }),
})
export type LedgerSyncResponse = z.infer<typeof ledgerSyncResponseSchema>

/* -------------------------------------------------------------------------- */
/* List                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Server-side pagination and filtering of the ledger.
 *
 * `from` / `to` are **business dates** (`YYYY-MM-DD`) interpreted by the server
 * in `Asia/Shanghai` (UTC+08:00, no DST); both ends are inclusive. A query must
 * never widen the caller's community scope: `communityId` / `staffId` only
 * narrow it.
 */
export const ledgerListQuerySchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    from: businessDate.optional(),
    to: businessDate.optional(),
    communityId: uuid.optional(),
    /** Attribution filter: matches `attribution.staffId` only, never the recorder. */
    staffId: uuid.optional(),
    factKind: ledgerFactKindSchema.optional(),
    productId: uuid.optional(),
    sourceSystem: ledgerSourceSystemSchema.optional(),
    /** `true` = only entries with an unresolved anomaly. */
    anomalyOnly: queryFlag.default(false),
    keyword: z.string().trim().min(1).max(80).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.from && query.to && query.to < query.from) {
      ctx.addIssue({
        code: 'custom',
        message: 'to must not be earlier than from',
        path: ['to'],
      })
    }
  })

export type LedgerListQuery = z.infer<typeof ledgerListQuerySchema>

/**
 * Filters of the overview report.
 *
 * Deliberately the **same** narrowings the list accepts for scope and time, and
 * nothing else: an overview either reports the same population as the list under
 * the same filters, or the two pages contradict each other. A filter that the
 * server does not implement must fail parsing (`400`) instead of being silently
 * ignored, which is why this is a `strictObject`.
 */
export const ledgerOverviewQuerySchema = z
  .strictObject({
    /** Inclusive business dates, interpreted in `Asia/Shanghai`. */
    from: businessDate.optional(),
    to: businessDate.optional(),
    /** Narrowing only: never widens the caller's community scope. */
    communityId: uuid.optional(),
    /** Attribution filter: matches `attribution.staffId` only, never the recorder. */
    staffId: uuid.optional(),
  })
  .superRefine((query, ctx) => {
    if (query.from && query.to && query.to < query.from) {
      ctx.addIssue({
        code: 'custom',
        message: 'to must not be earlier than from',
        path: ['to'],
      })
    }
  })

export type LedgerOverviewQuery = z.infer<typeof ledgerOverviewQuerySchema>

export const ledgerListResponseSchema = z.strictObject({
  items: z.array(ledgerEntrySchema),
  total: count,
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  /** The instant the list (and its `total`) was computed. */
  asOf: isoTimestamp,
})

export type LedgerListResponse = z.infer<typeof ledgerListResponseSchema>

/* -------------------------------------------------------------------------- */
/* Anomalies                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Why an entry is flagged. These are *review hints*, not verdicts: the fact
 * itself stays immutable, only the anomaly can be resolved.
 */
export const ledgerAnomalyKindSchema = z.enum([
  'amount_mismatch',
  'attribution_conflict',
  'source_missing_evidence',
  'duplicate_candidate',
  'period_gap',
])
export type LedgerAnomalyKind = z.infer<typeof ledgerAnomalyKindSchema>

export const ledgerAnomalySeveritySchema = z.enum(['low', 'medium', 'high'])
export type LedgerAnomalySeverity = z.infer<typeof ledgerAnomalySeveritySchema>

export const ledgerAnomalySchema = z.strictObject({
  anomalyId: uuid,
  entryId: uuid,
  kind: ledgerAnomalyKindSchema,
  severity: ledgerAnomalySeveritySchema,
  note: z.string().trim().min(1).max(500).nullable(),
  flaggedByUserId: uuid.nullable(),
  resolvedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
})

export type LedgerAnomaly = z.infer<typeof ledgerAnomalySchema>

export const ledgerAnomalyListResponseSchema = z.strictObject({
  items: z.array(ledgerAnomalySchema),
  asOf: isoTimestamp,
})

export type LedgerAnomalyListResponse = z.infer<typeof ledgerAnomalyListResponseSchema>

/* -------------------------------------------------------------------------- */
/* Reconciliation batches                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Batch lifecycle. `open -> locked` is the only transition and it is one-way:
 * a locked period is the frozen basis of a reconciliation statement. The
 * database enforces this with a trigger, not with the service layer alone.
 */
export const reconciliationBatchStatusSchema = z.enum(['open', 'locked'])
export type ReconciliationBatchStatus = z.infer<typeof reconciliationBatchStatusSchema>

/**
 * One reconciliation batch over a business-day period.
 *
 * `totalCents` is the gross recorded amount of the batch's entries — **not** a
 * payable amount. There is no settlement rule in this MVP, so a batch never
 * produces a distribution figure.
 */
export const reconciliationBatchSchema = z
  .strictObject({
    batchId: uuid,
    batchNo: z.string().trim().min(1).max(40),
    /** Inclusive business dates, interpreted in `Asia/Shanghai`. */
    periodFrom: businessDate,
    periodTo: businessDate,
    status: reconciliationBatchStatusSchema,
    entryCount: count,
    totalCents: cents,
    note: z.string().trim().max(500).nullable(),
    lockedAt: isoTimestamp.nullable(),
    lockedByUserId: uuid.nullable(),
    lockedByStaffId: uuid.nullable(),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  })
  .superRefine((batch, ctx) => {
    if (batch.periodTo < batch.periodFrom) {
      ctx.addIssue({
        code: 'custom',
        message: 'periodTo must not be earlier than periodFrom',
        path: ['periodTo'],
      })
    }
    if (batch.status === 'locked') {
      if (batch.lockedAt === null || batch.lockedByUserId === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'a locked batch must record lockedAt and lockedByUserId',
          path: ['lockedAt'],
        })
      }
      return
    }
    if (batch.lockedAt !== null || batch.lockedByUserId !== null || batch.lockedByStaffId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'an open batch must not carry any lock stamp',
        path: ['lockedAt'],
      })
    }
  })

export type ReconciliationBatch = z.infer<typeof reconciliationBatchSchema>

export const reconciliationBatchListResponseSchema = z.strictObject({
  items: z.array(reconciliationBatchSchema),
  asOf: isoTimestamp,
})

export type ReconciliationBatchListResponse = z.infer<
  typeof reconciliationBatchListResponseSchema
>

/**
 * Create an `open` batch for a business-day period. The body never carries a
 * community, a total or an entry count: the server derives all of them, so a
 * client can neither pre-seed a fake total nor widen the period.
 */
export const createBatchRequestSchema = z
  .strictObject({
    periodFrom: businessDate,
    periodTo: businessDate,
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.periodTo < value.periodFrom) {
      ctx.addIssue({
        code: 'custom',
        message: 'periodTo must not be earlier than periodFrom',
        path: ['periodTo'],
      })
    }
  })

export type CreateBatchRequest = z.infer<typeof createBatchRequestSchema>

/**
 * Lock an open batch. `expectedUpdatedAt` is the shared optimistic-concurrency
 * token: locking a stale view is a 409, never a silent re-lock. Locking twice
 * is rejected with `ledger_batch_locked`, never a fake second success.
 */
export const lockBatchRequestSchema = z.strictObject({
  expectedUpdatedAt: isoTimestamp,
  note: z.string().trim().max(500).optional(),
})

export type LockBatchRequest = z.infer<typeof lockBatchRequestSchema>

/* -------------------------------------------------------------------------- */
/* Batch entries (batch detail page)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The fact entries of one reconciliation batch, paged.
 *
 * `items` reuse `ledgerEntrySchema` instead of a narrower "batch row" DTO on
 * purpose: a batch detail page and the fact list must show the same fact, so a
 * second shape would let the two screens disagree about the same entry.
 *
 * `items` 是**已冻结的批次成员**：某个 `locked` 批次锁定之后才补录进来的事实
 * （`createdAt > lockedAt`）按定义不属于冻结账目，不在这份 `items` 里；它们的笔数
 * 与毛额由 `reconciliationDiffSchema` 的 `lateRecordedCount` /
 * `lateRecordedTotalCents` 单独报出，确保「锁后补录」既不冒充已对账、也不凭空消失。
 *
 * Money口径：`items[].amountCents` 是**账面登记毛额，不是应付**。本 MVP 没有结算
 * 规则，`items[].settlementAmountStatus` 恒为 `pending_rule`，因此这一页**不得**
 * 出现任何由金额推导出的应付 / 分账 / 打款数字，也不得把六类事实压成一个「成交额」。
 *
 * `total` counts the same predicate as `items` (「共 N 条」can never disagree
 * with what is on screen), `page` / `pageSize` echo the request, and `asOf` is
 * the instant this page was computed — never a cached page timestamp.
 */
export const reconciliationBatchEntriesResponseSchema = z.strictObject({
  batchId: uuid,
  items: z.array(ledgerEntrySchema),
  total: count,
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  asOf: isoTimestamp,
})

export type ReconciliationBatchEntriesResponse = z.infer<
  typeof reconciliationBatchEntriesResponseSchema
>

/* -------------------------------------------------------------------------- */
/* Reconciliation diff                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The two numbers a statement is made of: how many facts, and how much.
 *
 * Used twice in the same DTO on purpose — `stored` is what the batch **row**
 * froze at lock time, `computed` is what the **immutable facts** say today under
 * the derived-membership rule. Keeping them as one shape makes the comparison a
 * single diff instead of two parallel fields that could drift apart.
 *
 * `totalCents` is a **账面登记毛额, not a payable amount** (账面登记毛额，不是应付):
 * this MVP has no settlement rule, so `settlementAmountStatus` stays
 * `pending_rule` and no figure here may be rendered as 应付 / 分账 / 打款.
 */
export const reconciliationBatchTotalsSchema = z.strictObject({
  entryCount: count,
  /** Gross recorded amount — 账面登记毛额，**不是应付**；`pending_rule` 时不得当应付用. */
  totalCents: cents,
})

export type ReconciliationBatchTotals = z.infer<typeof reconciliationBatchTotalsSchema>

/**
 * Why a period still needs a human before it can be called clean.
 *
 * The list is closed on purpose: every reason is something a person can act on,
 * and none of them is "unknown". A new reason is a contract change, not a
 * silently tolerated string.
 */
export const reconciliationDiffReasonSchema = z.enum([
  /** The money is real but cannot be attributed to a grid worker (待归属). */
  'pending_attribution',
  /** An anomaly of this period is still unresolved (未处理异常). */
  'open_anomaly',
  /** The reversal sits in this period but the entry it reverses does not (跨期冲正). */
  'reversal_original_outside_period',
  /** A locked batch whose stored totals no longer equal the derived ones (合计漂移). */
  'batch_totals_drift',
  /** A fact of a locked period that was recorded after the lock (锁后补录, L2). */
  'late_recorded_after_lock',
  /** A period with no facts at all — worth a look before locking (空期间). */
  'empty_period',
])

export type ReconciliationDiffReason = z.infer<typeof reconciliationDiffReasonSchema>

/**
 * One finding of the diff — a **conclusion**, not a row.
 *
 * `entryId` is nullable because some findings are batch-level rather than
 * fact-level (a totals drift belongs to the statement, not to one entry).
 * `detail` is a human explanation and must never carry a phone number, an
 * evidence ref or any other sensitive identifier.
 */
export const reconciliationDiffItemSchema = z.strictObject({
  reason: reconciliationDiffReasonSchema,
  severity: ledgerAnomalySeveritySchema,
  /** `null` for a batch-level finding (e.g. totals drift). */
  entryId: uuid.nullable(),
  /** Human reference of the source; `null` when the finding has no single fact. */
  sourceDisplayNo: z.string().trim().min(1).max(80).nullable(),
  /** Human explanation; never contains a phone number or a secret. */
  detail: z.string().trim().min(1).max(500),
})

export type ReconciliationDiffItem = z.infer<typeof reconciliationDiffItemSchema>

/** Findings counted by severity, so the badge counts can never disagree with `items`. */
export const reconciliationDiffSummarySchema = z.strictObject({
  total: count,
  low: count,
  medium: count,
  high: count,
})

export type ReconciliationDiffSummary = z.infer<typeof reconciliationDiffSummarySchema>

/**
 * What a reconciliation period is still missing.
 *
 * Definition of the diff (and the single reason it has to exist): `ledger_entries`
 * is append-only, so joining a batch can never be recorded by stamping
 * `batch_id` onto a fact row afterwards. Membership is *derived* from the batch
 * period + community scope. The diff is therefore the complement of that
 * derivation — the facts whose `occurredAt` falls inside `periodFrom..periodTo`
 * but which no **`locked`** batch covers, plus the still-open anomalies of the
 * same slice. An `open` batch does not remove a fact from the diff: an open
 * period is still being reconciled, so those facts are exactly the ones a human
 * has to look at before locking.
 *
 * 「未纳入」和「锁后补录」是两件不同的事，必须分开报，不能合成一个数字。两者
 * **按构造互斥**：一笔钱只能落在其中一边，既不重复也不会消失。完整报出时
 * （4 个下钻字段都在）二者之和等于该期间的条目总数；下钻字段缺失时，`lateRecorded*`
 * 仍然独立成立，「未纳入」的部分由流水列表本身承担，不得据缺失推断为 0。
 *
 * - **未纳入（`unbatched*`）** 指 `occurredAt` 落在期间内、但**没有任何 `locked`
 *   批次覆盖**的条目——本期该看、却还没冻结的部分（含只进了 `open` 批次的条目：
 *   未锁定就不算已对账）。它是**待办**，靠继续核对 / 开批次来消化。
 * - **锁后补录（`lateRecorded*`）** 指期间被某个 `locked` 批次覆盖、但 `createdAt`
 *   晚于该批次 `lockedAt` 的条目——批次**冻结之后**才补录进来的事实。它被冻结的
 *   账目按定义排除在外，不可能再吸收（append-only 不回写 `batch_id`），所以只能
 *   显式呈现（拒绝补录 / 归入下一期 / 标记异常，由对账卡决定）：**绝不能静默并进
 *   「未纳入」让锁定过的账看起来没锁，也绝不能悄悄从报表里消失**。
 *   这里只报**笔数与毛额**：它们不属于冻结账目，因此**不在**批次明细的 `items` 里
 *   （见 `reconciliationBatchEntriesResponseSchema`）。在只读契约中，这对数字是这
 *   批钱被看见的位置；逐条处置属于对账动作，不在只读契约里假装已经处理。
 *
 * `unbatchedTotalCents` / `lateRecordedTotalCents` 都是**账面登记毛额，不是应付**：
 * 本 MVP 没有结算规则，`settlementAmountStatus` 恒为 `pending_rule`，任何金额
 * 字段都不得被渲染成应付 / 分账 / 打款数字。
 *
 * ## `stored` vs `computed`
 *
 * `stored` 是**批次行上冻结的数字**（`entry_count` / `total_cents`，锁定那一刻写死）；
 * `computed` 是**按不可变事实派生重算出来的数字**（期间 + 截止时刻）。两者必须相等，
 * 那就是「锁定 = 冻结」；一旦不等，说明账目漂移，由 `items` 里的 `batch_totals_drift`
 * 报出来。对临时期间（无批次）`stored` 为 `null`，此时只有 `computed` 有意义。
 *
 * ## `items` 是结论，明细是明细（两层不得合并）
 *
 * `items` 是**结论清单**：待归属、未处理异常、跨期冲正、合计漂移、锁后补录、空期间
 * ——每一条都是「必须有人处理」的判断，带 `reason` / `severity` / `detail`。
 * `unbatchedEntries`、`unbatchedCount`、`unbatchedTotalCents`、`openAnomalies` 是
 * **可下钻的原始明细**：前者是还没进已锁批次的流水行本身，后者是异常记录本身。
 * 两层不能合并：把明细摊平进 `items` 会让「多少条要处理」变成「多少行数据」，
 * 230 行待归属就会被报成 230 条待办；反过来只给结论，人也无法下钻核对。
 *
 * ## 关于 `unbatched*` / `openAnomalies` 目前是可选字段
 *
 * **这 4 个字段线上是有的**，只是不在领域层。领域服务
 * `apps/api/src/ledger/reconciliation-service.ts` 的 `ReconciliationDiff` 不含它们
 * （它把同样的信息表达成 `items` 结论 + 批次明细接口的 `lateRecorded`）；它们由
 * **HTTP 适配层** `apps/api/src/ledger/reconciliation.ts` 的 `diffResponse()` 补齐后
 * 一并交给本 schema 校验：
 *
 * ```ts
 * return reconciliationDiffSchema.parse({
 *   ...serviceResult,
 *   unbatchedCount: unbatched.count,
 *   unbatchedTotalCents: unbatched.totalCents,
 *   unbatchedEntries: unbatched.items,
 *   openAnomalies: collectOpenAnomalies(db, actor, range),
 * })
 * ```
 *
 * 之所以在契约里写成 `.optional()`：同一份 schema 要同时描述**领域层形状**（12 字段）
 * 和**适配层形状**（12 + 4）。写成必填会让领域层那个返回类型与 schema 对不上，也让
 * `ReconciliationDiff` 接口无法保持「只描述领域事实」；写成 optional 则两层的对象都能
 * 通过校验，而适配层补的字段照样被严格校验（多一个拼错的键仍会被 `strictObject` 拒）。
 *
 * 因此：**走 HTTP 的消费方实际能拿到这 4 个字段，可以正常下钻**；但类型层面必须按
 * 「可能不存在」处理（例如直接对领域层做单测时）。要收紧成必填，前提是把这 4 个字段
 * 下沉进领域服务的返回类型——顺序不能反。
 *
 * `batchId` is the batch the diff was requested for, or `null` when the diff is
 * asked for an arbitrary period rather than one existing batch.
 */
export const reconciliationDiffSchema = z.strictObject({
  /** The batch this diff belongs to; `null` for a free-standing period query. */
  batchId: uuid.nullable(),
  /** Human batch number (same constraint as `reconciliationBatchSchema.batchNo`). */
  batchNo: z.string().trim().min(1).max(40).nullable(),
  /** `open` / `locked`; `null` for an ad-hoc period that has no batch row. */
  status: reconciliationBatchStatusSchema.nullable(),
  /** Inclusive business dates (`YYYY-MM-DD`), interpreted in `Asia/Shanghai`. */
  periodFrom: businessDate,
  periodTo: businessDate,
  /**
   * What the batch row claims — 批次行上冻结的数字. `null` for an ad-hoc period
   * (no batch row exists), which is why it is nullable while `computed` is not.
   */
  stored: reconciliationBatchTotalsSchema.nullable(),
  /**
   * What the immutable facts say under the derived-membership rule — 按不可变事实
   * 重算的数字. `stored` ≠ `computed` means the statement drifted and is reported
   * as `batch_totals_drift`. Gross recorded amount, **不是应付**.
   */
  computed: reconciliationBatchTotalsSchema,
  /**
   * The findings — 结论清单 (待归属 / 未处理异常 / 跨期冲正 / 合计漂移 / 锁后补录 /
   * 空期间). Not a row list: the drill-down details live in the fields below, and a
   * finding is a judgement that needs a human, not a copy of the data.
   */
  items: z.array(reconciliationDiffItemSchema),
  /** Findings counted by severity; must agree with `items`. */
  summary: reconciliationDiffSummarySchema,
  /**
   * Facts of the period covered by a `locked` batch but recorded **after** that
   * batch was locked (锁后补录). Disjoint from `unbatched*` by construction, so
   * a locked period can never look un-locked *and* the late facts can never be
   * dropped from the report. The frozen statement cannot absorb them, so this
   * pair (count + gross amount) is the only place they surface — deliberately
   * not a row list: no fact is duplicated across two independently computed
   * sources, and the read-only contract never implies the gap is already closed.
   */
  lateRecordedCount: count,
  /**
   * Gross recorded amount of the late-recorded facts — 账面登记毛额，**不是应付**；
   * `settlementAmountStatus = 'pending_rule'` (no settlement rule in this MVP),
   * so it must never be read as a payable or distribution figure.
   */
  lateRecordedTotalCents: cents,
  asOf: isoTimestamp,
  /* ---------------------------------------------------------------------- */
  /* Drill-down details — 可选下钻明细                                        */
  /*                                                                         */
  /* 领域服务 `ReconciliationDiff` 不含这 4 个字段；它们由 HTTP 适配层         */
  /* `reconciliation.ts` 的 `diffResponse()` 补齐（见上方文档）。               */
  /* 设为 optional 是为了让「领域层形状」和「适配层形状」都能通过同一份校验；   */
  /* 走 HTTP 的消费方实际拿得到它们，但类型层面必须按可能存在/可能缺失处理。    */
  /* 收紧成必填的前提是先把这 4 个字段下沉进领域服务的返回类型——顺序不能反。    */
  /* ---------------------------------------------------------------------- */
  /** Facts of the period that no locked batch covers (待办部分). 适配层补齐，故可选. */
  unbatchedCount: count.optional(),
  /**
   * Gross recorded amount of `unbatchedEntries` — 账面登记毛额，**不是应付**.
   * No settlement rule exists, so the settlement view of this figure is
   * `pending_rule`: it must never be rendered as a payout or distribution.
   */
  unbatchedTotalCents: cents.optional(),
  /** The un-batched fact rows themselves (drill-down, not a finding). 适配层补齐，故可选. */
  unbatchedEntries: z.array(ledgerEntrySchema).optional(),
  /** Unresolved anomalies of the same slice; resolving one never rewrites a fact. */
  openAnomalies: z.array(ledgerAnomalySchema).optional(),
}).superRefine((diff, ctx) => {
  // `summary` is a cached count of `items`: if the two ever disagree, a badge
  // would show a number the list cannot reproduce. Cheap to check, impossible to
  // fake, so it is enforced here instead of trusted from the server.
  if (diff.summary.total !== diff.items.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['summary', 'total'],
      message: 'summary.total must equal items.length',
    })
  }
  const bySeverity = { low: 0, medium: 0, high: 0 }
  for (const item of diff.items) bySeverity[item.severity] += 1
  for (const severity of ['low', 'medium', 'high'] as const) {
    if (diff.summary[severity] !== bySeverity[severity]) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', severity],
        message: `summary.${severity} must equal the number of items with that severity`,
      })
    }
  }
  if (diff.summary.low + diff.summary.medium + diff.summary.high !== diff.summary.total) {
    ctx.addIssue({
      code: 'custom',
      path: ['summary'],
      message: 'summary severity counts must add up to summary.total',
    })
  }
})

export type ReconciliationDiff = z.infer<typeof reconciliationDiffSchema>
