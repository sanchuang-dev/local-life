import {
  LEDGER_ROUTES,
  apiErrorSchema,
  confirmSettlementOrderPartyRequestSchema,
  createSettlementMappingRequestSchema,
  createSettlementPartyRequestSchema,
  createSettlementRuleRequestSchema,
  createSettlementStatementRequestSchema,
  recordSettlementPaymentRequestSchema,
  settlementMappingListResponseSchema,
  settlementMappingSchema,
  settlementOrderPartyResponseSchema,
  settlementOrderPartySnapshotSchema,
  settlementPartyListResponseSchema,
  settlementPartySchema,
  settlementPaymentOverviewSchema,
  settlementQuoteRequestSchema,
  settlementQuoteResponseSchema,
  settlementRuleListResponseSchema,
  settlementRuleVersionSchema,
  settlementStatementActionRequestSchema,
  settlementStatementDetailSchema,
  settlementStatementListResponseSchema,
  settlementStatementSchema,
  type CreateSettlementMappingRequest,
  type CreateSettlementPartyRequest,
  type CreateSettlementRuleRequest,
  type CreateSettlementStatementRequest,
  type RecordSettlementPaymentRequest,
  type SettlementMapping,
  type SettlementOrderPartySnapshot,
  type SettlementParty,
  type SettlementPaymentOverview,
  type SettlementQuoteResponse,
  type SettlementRuleVersion,
  type SettlementStatement,
  type SettlementStatementDetail,
  type SettlementStatementListResponse,
} from '@sanchuang-dev/local-life-contracts'
import { filenameFromDisposition, saveBlob } from './ledger'
import { LocalApiError, fillRoute, parsePayload, requestLocalJson, withQuery } from './localApi'

/**
 * Back-office transport for real settlement parties (LL-SET-009A / #219, API #183).
 *
 * 「结算主体」是**真实存在的法人主体**（销售商户 / 三创主体 / 广电主体）的登记，
 * 不是结算规则，也不是应付金额：本模块只做传输与共享契约解析，不做页面，也不
 * 计算任何分账、应付或费率。
 *
 * 「商户映射」（LL-SET-009B / #220）是「商品 → 三方主体」的**版本化记录**：
 * 新增一条即产生一个新版本，过去已写入的映射与其 `effectiveFrom`/`effectiveTo`
 * 期间原样保留，本客户端从不回写或覆盖历史版本。
 *
 * 关键边界：**保存映射不会自动确认任何历史订单。** 订单的销售商户归属必须是运营
 * 人员对具体订单的显式确认（`confirmSettlementOrderParty`），并在服务端留下不可变
 * 的 `settlementOrderPartySnapshot`；映射更新不能回溯补写历史订单的归属。
 *
 * 「合同规则版本」（LL-SET-010A / #221）是**已核准合同的人工确认事实**：运营人员
 * 依据线下已签合同登记费率与期限，`approvalStatus` 恒为 `admin_attested`，
 * `version` / `approvedByUserId` / `approvedAt` 均由服务端生成并以响应为准。前端
 * 不得推断审批结果、不得自行递增版本号、更不得填充任何默认费率——没有登记就没有
 * 规则，没有规则就没有应付金额。
 *
 * 「单订单试算」（LL-SET-010B / #222）是**只读模拟**：契约要求以 POST + CSRF 调用
 * （按已核准规则逐笔计算，但不落库、不产生账单），响应中 `quoteOnly` 恒为 `true`、
 * `payableAmountCents` 恒为 `null`。它**不是**应付金额、不是结算单、不是付款指令：
 * 前端不得据此生成任何 payable 数字，也不得把 `allocation` 当作应付或已付款。
 *
 * 「结算单」（LL-SET-011A / #223）是**期间快照**：草案创建、复核、锁定都是人工
 * 事实，`paymentState` 只来自服务端登记的 #187 付款凭据。**锁定不等于已付款**：
 * `status='locked'` 只说明快照不可再改，付款状态必须另看 `paymentState`。页面只能
 * 原样展示服务端给出的状态与金额；`allocation: null` 的 blocked 行不得补 0，汇总
 * 金额也不得被当成应付或已付。
 *
 * 「复核 / 锁单 / 双 CSV」（LL-SET-011B / #224）：**独立复核是服务端强制的规则** ——
 * 制单人不得复核自己的草案、锁单还要求另一位管理员的复核签认，前端既不计算也不
 * 猜测这些条件，只把服务端 403/409 的 message 原样展示。两个 CSV 通道（主体结算表 /
 * 网格业绩附表）只下载服务端生成的文本：**任何错误响应（非 2xx，或 200 但
 * content-type 是 JSON）都必须抛 `LocalApiError`，绝不能把错误 JSON 存成 `.csv`**。
 *
 * 「付款凭据登记」（LL-SET-012A / #225）：登记凭据 **≠ 复核核销**。运营人员只登记
 * 脱敏的线下付款凭据，`state` 完全由服务端决定；前端不得把 `pending_review` 显示成
 * `verified`，也不得自行推断「已付款」。本模块**不调用任何银行 / 微信 / 支付 SDK**，
 * 不发起转账。`idempotencyKey` 只被原样传递：service 不生成、不替换、不重试。
 *
 * 硬规则：
 *
 * - **核验状态只来自服务端 `verifiedAt`。** 前端不得根据 `verificationRef`、
 *   `registryRef` 的格式、角色或创建时间推断「已核验」，也不得用当前时间补齐
 *   一个 `null` 的 `verifiedAt`。`null` 就是「未核验」，必须原样展示。
 * - 每个响应都先用 `@sanchuang-dev/local-life-contracts` 的共享 zod schema 解析，
 *   再交给页面；解析失败抛 `LocalApiError('invalid_response')`，绝不降级成空列表
 *   或伪造成功。
 * - 真实的 401/403/400/409 状态与错误码由 `requestLocalJson` 原样冒泡
 *   （`LocalApiError`），页面据此渲染真实错误态，而不是一个看起来成功的占位。
 * - URL 只由 `LEDGER_ROUTES` 生成；传输逻辑复用 `./localApi`，不复制。
 */

/** The three real party roles. `seller` is the merchant, the other two are carriers. */
export type SettlementPartyRole = CreateSettlementPartyRequest['role']

/**
 * Display words for the roles. Kept as a `Record` so a contract change that adds a
 * role fails to compile instead of silently rendering a raw enum value.
 */
export const SETTLEMENT_PARTY_ROLE_LABELS: Record<SettlementPartyRole, string> = {
  seller: '商品销售商户',
  sanchuang: '三创主体',
  guangdian: '广电主体',
}

/**
 * The only narrowing the server implements. Omitting `communityId` means
 * 「管理员查看全部」; an operator's own community scope is applied server-side and
 * is never inferred here.
 */
export type SettlementPartyListFilters = { communityId?: string }

/**
 * GET /admin/settlement/parties — every registered party, optionally for one
 * community.
 *
 * The list carries `verifiedAt` per row and no aggregate: the caller must not
 * count rows into a "已核验 N 个" figure the server did not report. A row whose
 * `verifiedAt` is `null` is 未核验 — never inferred from `verificationRef`.
 */
export async function listSettlementParties(
  filters: SettlementPartyListFilters = {},
  signal?: AbortSignal,
): Promise<SettlementParty[]> {
  const communityId = filters.communityId?.trim()
  const payload = await requestLocalJson(
    withQuery(`/api${LEDGER_ROUTES.adminSettlementParties}`, {
      // Only sent when the operator actually narrowed to one community: the
      // absence of the parameter is the documented 「全部」 query.
      communityId: communityId ? communityId : undefined,
    }),
    { signal },
  )
  const parsed = parsePayload(settlementPartyListResponseSchema, payload, '结算主体列表')
  return parsed.items
}

/**
 * POST /admin/settlement/parties — register one real party with its verification
 * evidence reference.
 *
 * `verificationRef` is submitted evidence, *not* a verification decision: the
 * server decides `verifiedAt`, and this client must not pre-set it (the request
 * contract has no such field at all). A 409 (duplicate) or 400 (invalid) keeps its
 * real status/code/message; there is no "retry as success" path here.
 */
export async function createSettlementParty(
  csrfToken: string,
  request: CreateSettlementPartyRequest,
): Promise<SettlementParty> {
  // Validate locally first so a malformed payload never leaves the browser; the
  // server validates again and stays the only authority.
  const body = createSettlementPartyRequestSchema.parse(request)
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminSettlementParties}`, {
    method: 'POST',
    csrfToken,
    body,
  })
  // The success body is one party (HTTP 201), not a list.
  return parsePayload(settlementPartySchema, payload, '结算主体创建结果')
}

/* -------------------------------------------------------------------------- */
/* Merchant mappings (#220) — versioned product → party records               */
/* -------------------------------------------------------------------------- */

/**
 * GET /admin/settlement/mappings — every mapping, optionally for one community.
 *
 * The same scope rule as the party list applies: omitting `communityId` is the
 * admin 「全部」 query, and an operator's own scope is applied server-side. The
 * list is a history: several rows may exist for the same product with different
 * periods, so the caller must not collapse them into one "current" row.
 */
export async function listSettlementMappings(
  filters: SettlementPartyListFilters = {},
  signal?: AbortSignal,
): Promise<SettlementMapping[]> {
  const communityId = filters.communityId?.trim()
  const payload = await requestLocalJson(
    withQuery(`/api${LEDGER_ROUTES.adminSettlementMappings}`, {
      communityId: communityId ? communityId : undefined,
    }),
    { signal },
  )
  const parsed = parsePayload(settlementMappingListResponseSchema, payload, '商户映射列表')
  return parsed.items
}

/**
 * POST /admin/settlement/mappings — append one mapping version.
 *
 * This never updates or deletes an existing version: a correction is a new row
 * with its own period. The shared contract rejects `effectiveTo < effectiveFrom`
 * before the request leaves the browser, and the server rejects unverified or
 * role-mismatched parties with a real `409` that keeps its code/message.
 *
 * Saving a mapping does **not** confirm any existing order's seller; that only
 * happens through {@link confirmSettlementOrderParty}.
 */
export async function createSettlementMapping(
  csrfToken: string,
  request: CreateSettlementMappingRequest,
): Promise<SettlementMapping> {
  const body = createSettlementMappingRequestSchema.parse(request)
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminSettlementMappings}`, {
    method: 'POST',
    csrfToken,
    body,
  })
  return parsePayload(settlementMappingSchema, payload, '商户映射创建结果')
}

/* -------------------------------------------------------------------------- */
/* Per-order seller confirmation — an explicit, append-only human fact        */
/* -------------------------------------------------------------------------- */

/** The three server-computed order seller states; never derived on the client. */
export type SettlementOrderPartySellerStatus =
  | 'missing_seller'
  | 'incomplete_parties'
  | 'verified'

/**
 * The order-party read model.
 *
 * Declared structurally here because `@sanchuang-dev/local-life-contracts`
 * exports `settlementOrderPartyResponseSchema` but **not** an inferred
 * `SettlementOrderPartyResponse` type. The shape mirrors
 * `settlementOrderPartyResponseSchema` exactly, and every response is still
 * parsed by that shared schema in {@link readSettlementOrderParty}, so this
 * declaration cannot drift into a second source of truth.
 */
export interface SettlementOrderPartyResponse {
  orderId: string
  sellerStatus: SettlementOrderPartySellerStatus
  snapshot: SettlementOrderPartySnapshot | null
}

/**
 * GET /admin/settlement/orders/:orderId/party — the confirmed seller fact, if any.
 *
 * `snapshot: null` is the server's 「尚无归属确认」 answer and always comes with
 * `missing_seller`; it must be rendered as-is. The client never fabricates an
 * empty snapshot, never backfills one from the product's current mapping, and
 * never treats a failed parse as 「未确认」.
 */
export async function readSettlementOrderParty(
  orderId: string,
  signal?: AbortSignal,
): Promise<SettlementOrderPartyResponse> {
  const payload = await requestLocalJson(
    `/api${fillRoute(LEDGER_ROUTES.adminSettlementOrderParty, ':orderId', orderId)}`,
    { signal },
  )
  return parsePayload(settlementOrderPartyResponseSchema, payload, '订单销售商户归属')
}

/** The human must name the source document they checked; no implicit default. */
export type ConfirmSettlementOrderPartyRequest = {
  mappingId: string
  confirmationRef: string
}

/**
 * POST /admin/settlement/orders/:orderId/party — freeze the seller identity.
 *
 * CSRF is mandatory even though the path template is shared with the GET: the
 * server rejects a write without `x-csrf-token`. The `201` body is the snapshot
 * object alone (no `sellerStatus`); a `409` (order not verified, or the mapping
 * does not match the order/business date) bubbles up unchanged and is never
 * retried as a success.
 */
export async function confirmSettlementOrderParty(
  csrfToken: string,
  orderId: string,
  request: ConfirmSettlementOrderPartyRequest,
): Promise<SettlementOrderPartySnapshot> {
  const body = confirmSettlementOrderPartyRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(LEDGER_ROUTES.adminSettlementOrderParty, ':orderId', orderId)}`,
    { method: 'POST', csrfToken, body },
  )
  return parsePayload(settlementOrderPartySnapshotSchema, payload, '订单销售商户确认结果')
}

/* -------------------------------------------------------------------------- */
/* Contract rule versions (#221) — human-attested facts, never auto-derived   */
/* -------------------------------------------------------------------------- */

/**
 * The only scope the rules endpoint accepts. Both fields are sent **only when the
 * caller actually provided them**: the strict `settlementRuleListQuerySchema`
 * would reject anything else, and the client must not invent a default community.
 */
export interface SettlementRuleListQuery {
  communityId?: string
  mappingId?: string
}

/** Party keys inside a rule's `ratesBps`; wording matches the party registry. */
export const SETTLEMENT_RULE_PARTY_KEY_LABELS: Record<
  'seller' | 'sanchuang' | 'guangdian',
  string
> = {
  seller: '商品销售商户',
  sanchuang: '三创主体',
  guangdian: '广电主体',
}

/** Who bears the payment-processor fee. `none` means a zero-fee contract. */
export const SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS: Record<
  'none' | 'seller' | 'sanchuang' | 'guangdian',
  string
> = {
  none: '无',
  seller: '由销售商户承担',
  sanchuang: '由三创承担',
  guangdian: '由广电承担',
}

/**
 * Read-only explanation of the policies the contract *fixes* (each is a zod
 * literal). These are not editable options, so they are shown as descriptive
 * sentences instead of controls. `feeBase` is the #166 receipt amount, never the
 * order's registered value.
 */
export const SETTLEMENT_RULE_FIXED_POLICY_LABELS: {
  feeBase: string
  roundingPolicy: string
  processorFeeRounding: string
  reversalPolicy: string
  partialRefundPolicy: string
} = {
  feeBase: '按实际到账金额计算（#166 收款凭据），不是订单金额',
  roundingPolicy: '先向下取整分摊，剩余分币归指定主体',
  processorFeeRounding: '手续费向下取整',
  reversalPolicy: '整单冲正即阻断结算',
  partialRefundPolicy: '不支持部分退款，一经出现即阻断',
}

/**
 * GET /admin/settlement/rules — the approved rule versions, newest first as the
 * server returns them.
 *
 * A version list is history, not a single "current rate": the page must not pick
 * one row and present it as the applicable rule for every order. An empty list is
 * a real 「尚未登记」 answer and is returned as `[]`; a failed request throws, so a
 * transport error can never look like an empty rule set.
 */
export async function listSettlementRuleVersions(
  query: SettlementRuleListQuery = {},
  signal?: AbortSignal,
): Promise<SettlementRuleVersion[]> {
  const communityId = query.communityId?.trim()
  const mappingId = query.mappingId?.trim()
  const payload = await requestLocalJson(
    withQuery(`/api${LEDGER_ROUTES.adminSettlementRules}`, {
      communityId: communityId ? communityId : undefined,
      mappingId: mappingId ? mappingId : undefined,
    }),
    { signal },
  )
  const parsed = parsePayload(settlementRuleListResponseSchema, payload, '合同规则版本列表')
  return parsed.items
}

/**
 * POST /admin/settlement/rules — append one approved contract version.
 *
 * The shared `createSettlementRuleRequestSchema` is parsed first, so these are
 * rejected **before any request leaves the browser**: rates that do not sum to
 * exactly 10,000 bps, `effectiveTo < effectiveFrom`, `approvalOn > effectiveFrom`,
 * and a processor fee that disagrees with its owner (`0` ⇔ `none`).
 *
 * The client never fills a default rate and never sets `version` /
 * `approvalStatus` / `approvedByUserId` / `approvedAt`: the request contract has
 * no such fields, and the server's `201` is the single source of truth. Overlapping
 * periods or an invalid mapping surface as a real `409` that keeps its code and
 * message.
 */
export async function createSettlementRuleVersion(
  csrfToken: string,
  request: CreateSettlementRuleRequest,
): Promise<SettlementRuleVersion> {
  const body = createSettlementRuleRequestSchema.parse(request)
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminSettlementRules}`, {
    method: 'POST',
    csrfToken,
    body,
  })
  return parsePayload(settlementRuleVersionSchema, payload, '合同规则版本创建结果')
}

/* -------------------------------------------------------------------------- */
/* Single-order trial quote (#222) — a simulation, never a payable amount     */
/* -------------------------------------------------------------------------- */

/**
 * POST /admin/settlement/quotes — trial allocation for exactly one order.
 *
 * Why a *read-only* operation is a POST: the shared contract defines it as one
 * (`settlementQuoteRequestSchema` is a strict body, not a query), so the request
 * must be `POST` **with CSRF** — never a GET, and never a POST without
 * `x-csrf-token`. The body is parsed locally first, so an empty or non-UUID
 * `orderId` is rejected before any request is sent.
 *
 * The response is a pure simulation:
 *
 * - `quoteOnly` is always `true` and `payableAmountCents` is always `null`; a
 *   response claiming otherwise fails the shared schema and raises
 *   `invalid_response`. This endpoint is **not** a payable amount, **not** a
 *   settlement statement and **not** a payment instruction, and no caller may
 *   derive a payable figure from `allocation`.
 * - `status='pending_rule'` / `'blocked'` come with `rule`/`allocation` `null`;
 *   they are returned as-is and must not be rendered as `¥0` or a zero split.
 * - 401/403/400/404/409 keep their real status/code/message via `LocalApiError`;
 *   a network rejection is `status 0 / network_error`. There is no fallback that
 *   turns a failure into「未试算」or an empty object.
 */
export async function quoteSettlementOrder(
  csrfToken: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<SettlementQuoteResponse> {
  const body = settlementQuoteRequestSchema.parse({ orderId })
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminSettlementQuote}`, {
    method: 'POST',
    csrfToken,
    body,
    signal,
  })
  return parsePayload(settlementQuoteResponseSchema, payload, '订单分成试算结果')
}

/* -------------------------------------------------------------------------- */
/* Settlement statements (#223) — period snapshots, locking ≠ payment         */
/* -------------------------------------------------------------------------- */

/**
 * The only paging shape the statements endpoint accepts. `page`/`pageSize` are
 * required here (the contract gives the server defaults, but the page always knows
 * what it is asking for); `communityId` is sent only when explicitly provided.
 */
export interface SettlementStatementListQuery {
  communityId?: string
  page: number
  pageSize: number
}

/**
 * Snapshot lifecycle wording.
 *
 * `locked` deliberately says only 「已锁定」: locking freezes the snapshot and is
 * **not** a payment. Whether money arrived is `paymentState` (below), never this
 * label.
 */
export const SETTLEMENT_STATEMENT_STATUS_LABELS: Record<
  'draft' | 'reviewed' | 'locked' | 'superseded',
  string
> = {
  draft: '草案未复核',
  reviewed: '已复核未锁定',
  locked: '已锁定',
  superseded: '已被替代',
}

/**
 * Payment truth comes from #187 offline evidence only. These labels must not be
 * merged with `status`: a `locked` statement is usually `awaiting_payment`.
 */
export const SETTLEMENT_PAYMENT_STATE_LABELS: Record<
  'not_recorded' | 'awaiting_payment' | 'pending_review' | 'partial' | 'verified' | 'disputed',
  string
> = {
  not_recorded: '未登记付款',
  awaiting_payment: '待付款',
  pending_review: '已登记待复核',
  partial: '部分支付',
  verified: '已核销',
  disputed: '争议',
}

/**
 * GET /admin/settlement/statements — server-paged statement list.
 *
 * The whole response (`items`, `total`, `page`, `pageSize`) is returned because
 * the page must show the server's pagination; it must never re-count rows into a
 * client-side total. An empty `items` is a real 「该范围暂无结算单」 state, while a
 * failed request throws, so a transport error can never render as an empty list.
 */
export async function listSettlementStatements(
  query: SettlementStatementListQuery,
  signal?: AbortSignal,
): Promise<SettlementStatementListResponse> {
  const communityId = query.communityId?.trim()
  const payload = await requestLocalJson(
    withQuery(`/api${LEDGER_ROUTES.adminSettlementStatements}`, {
      communityId: communityId ? communityId : undefined,
      page: query.page,
      pageSize: query.pageSize,
    }),
    { signal },
  )
  return parsePayload(settlementStatementListResponseSchema, payload, '结算单列表')
}

/**
 * POST /admin/settlement/statements — generate a draft snapshot for a period.
 *
 * The body is parsed locally first, so `periodFrom > periodTo` and a one-sided
 * `replaceStatementId`/`expectedRevision` pair are rejected before any request is
 * sent (the shared `superRefine` owns both rules). The POST is CSRF-protected.
 *
 * **Server response shape (verified against `apps/api`):** the `201` body is a
 * `SettlementStatementDetail` (`{ statement, lines, performance, events,
 * postLockDisputes }`), not a bare statement. This helper therefore validates the
 * real body with `settlementStatementDetailSchema`, then returns the nested
 * `statement` (re-validated with `settlementStatementSchema`) so the fixed
 * `Promise<SettlementStatement>` signature still holds and no fabricated wrapper
 * is invented. Callers that need the lines/events after creation should
 * `getSettlementStatement(statement.id)`.
 */
export async function createSettlementStatement(
  csrfToken: string,
  request: CreateSettlementStatementRequest,
): Promise<SettlementStatement> {
  const body = createSettlementStatementRequestSchema.parse(request)
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminSettlementStatements}`, {
    method: 'POST',
    csrfToken,
    body,
  })
  const detail = parsePayload(settlementStatementDetailSchema, payload, '结算单草案创建结果')
  return parsePayload(settlementStatementSchema, detail.statement, '结算单草案')
}

/**
 * GET /admin/settlement/statements/:statementId — the immutable snapshot detail.
 *
 * `lines`, `performance`, `events` and `postLockDisputes` are returned exactly as
 * the server sent them. A blocked line keeps `allocation: null` (never `0`) and a
 * post-lock dispute stays a separate entry rather than rewriting a line.
 */
export async function getSettlementStatement(
  statementId: string,
  signal?: AbortSignal,
): Promise<SettlementStatementDetail> {
  const payload = await requestLocalJson(
    `/api${fillRoute(LEDGER_ROUTES.adminSettlementStatement, ':statementId', statementId)}`,
    { signal },
  )
  return parsePayload(settlementStatementDetailSchema, payload, '结算单详情')
}

/* -------------------------------------------------------------------------- */
/* Review / lock (#224) — server-enforced independence, never guessed         */
/* -------------------------------------------------------------------------- */

/** Both fields are mandatory: the revision is the optimistic-concurrency token. */
export type SettlementStatementActionRequest = {
  expectedRevision: number
  evidenceRef: string
}

/**
 * Shared POST for review/lock. Real API (verified in `apps/api`, #186):
 *
 * - `POST /admin/settlement/statements/:statementId/review` and `/lock`;
 * - admin-only (`guard('admin')`) and CSRF-protected → 403 without a valid token;
 * - success is **HTTP 200** (not 201) with a `SettlementStatementDetail` body;
 * - 404 for an unknown/invalid statement id, 400 for a body that fails the strict
 *   action contract, 403 for「制单人不能复核自己的结算草案」, and 409 for stale
 *   revision / status / missing independent review / non-calculated lines.
 *
 * Independence is a *server* rule: this client never decides who may review and
 * never rewrites a 403/409 — the page shows the server's message verbatim.
 */
async function postSettlementStatementAction(
  csrfToken: string,
  routeTemplate: string,
  statementId: string,
  request: SettlementStatementActionRequest,
  label: string,
): Promise<SettlementStatementDetail> {
  const body = settlementStatementActionRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(routeTemplate, ':statementId', statementId)}`,
    { method: 'POST', csrfToken, body },
  )
  return parsePayload(settlementStatementDetailSchema, payload, label)
}

/** POST /admin/settlement/statements/:statementId/review — draft → reviewed. */
export async function reviewSettlementStatement(
  csrfToken: string,
  statementId: string,
  request: SettlementStatementActionRequest,
): Promise<SettlementStatementDetail> {
  return postSettlementStatementAction(
    csrfToken,
    LEDGER_ROUTES.adminSettlementReview,
    statementId,
    request,
    '结算单复核结果',
  )
}

/**
 * POST /admin/settlement/statements/:statementId/lock — reviewed → locked.
 *
 * Locking freezes the snapshot; it is **not** payment. The returned detail's
 * `statement.paymentState` remains the only payment truth.
 */
export async function lockSettlementStatement(
  csrfToken: string,
  statementId: string,
  request: SettlementStatementActionRequest,
): Promise<SettlementStatementDetail> {
  return postSettlementStatementAction(
    csrfToken,
    LEDGER_ROUTES.adminSettlementLock,
    statementId,
    request,
    '结算单锁定结果',
  )
}

/* -------------------------------------------------------------------------- */
/* CSV downloads (#224) — the admin app's audited, redacted text channel      */
/* -------------------------------------------------------------------------- */

/** Test seam: capture the blob instead of touching the DOM/OS download. */
export interface SettlementCsvDownloadOptions {
  save?: (blob: Blob, filename: string) => void
  signal?: AbortSignal
}

/** What the server said about the file it produced (no row counts on this API). */
export interface SettlementCsvDownloadResult {
  filename: string
  byteLength: number
  contentType: string | null
}

const SETTLEMENT_CSV_ROUTE_BY_KIND = {
  entity: LEDGER_ROUTES.adminSettlementEntityCsv,
  performance: LEDGER_ROUTES.adminSettlementPerformanceCsv,
} as const

/** Deterministic ASCII fallback name when the server sends no usable filename. */
function settlementCsvFilename(
  kind: 'entity' | 'performance',
  statementId: string,
): string {
  const stem = statementId.replace(/[^A-Za-z0-9]/gu, '').slice(0, 8)
  return `settlement-${kind}-${stem || 'unknown'}.csv`
}

/**
 * Turns a non-file response back into the shared `{ error: { code, message } }`
 * envelope. A 2xx whose body is JSON is treated the same way: saving an error
 * document as `.csv` would hand the operator an unreadable "success".
 */
async function settlementCsvFailure(response: Response): Promise<LocalApiError> {
  const text = await response.text().catch(() => '')
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  const parsed = apiErrorSchema.safeParse(payload)
  if (parsed.success) {
    return new LocalApiError(response.status, parsed.data.error.code, parsed.data.error.message)
  }
  const trimmed = text.trim()
  return new LocalApiError(
    response.status,
    'http_error',
    trimmed.length > 0 && trimmed.length <= 200 && !/^\s*</u.test(trimmed)
      ? trimmed
      : `导出失败（HTTP ${response.status}）`,
  )
}

/**
 * GET the audited CSV for one statement — `entity` (主体结算表, admin/operator) or
 * `performance` (网格业绩附表, also readable by grid workers).
 *
 * Reuses `requestLocalJson`? No: that helper ends with `response.json()`, which
 * would throw on a perfectly good `text/csv` attachment. This function therefore
 * owns the only `response.blob()` call on the settlement surface and keeps the
 * same guarantees as the ledger CSV channel:
 *
 * 1. `fetch` with `credentials: 'include'` and `accept: text/csv`;
 * 2. non-2xx **or** a 2xx carrying `content-type: *json*` → parse the shared error
 *    envelope and throw a real `LocalApiError` (401/403/404/409 keep their code);
 *    `save` is never called for an error;
 * 3. filename from `Content-Disposition` (`filename*=UTF-8''…` first, then
 *    `filename="…"`), else `settlement-<kind>-<statementId 前8位>.csv`;
 * 4. hands the file to `options.save ?? saveBlob` and returns the real file name,
 *    byte length and content type.
 */
export async function downloadSettlementCsv(
  statementId: string,
  kind: 'entity' | 'performance',
  options: SettlementCsvDownloadOptions = {},
): Promise<SettlementCsvDownloadResult> {
  const path = `/api${fillRoute(
    SETTLEMENT_CSV_ROUTE_BY_KIND[kind],
    ':statementId',
    statementId,
  )}`

  let response: Response
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      signal: options.signal,
      headers: { accept: 'text/csv' },
    })
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    throw new LocalApiError(0, 'network_error', '无法连接管理后台 API，结算单导出未开始。')
  }

  if (!response.ok) throw await settlementCsvFailure(response)

  const contentType = response.headers.get('content-type')
  // A 200 carrying JSON is the error envelope, not a file.
  if (contentType !== null && /json/iu.test(contentType)) {
    throw await settlementCsvFailure(response)
  }

  const blob = await response.blob()
  const filename =
    filenameFromDisposition(response.headers.get('content-disposition')) ??
    settlementCsvFilename(kind, statementId)
  const save = options.save ?? saveBlob
  save(blob, filename)
  return { filename, byteLength: blob.size, contentType }
}

/* -------------------------------------------------------------------------- */
/* Payment proof registration (#225) — register ≠ verify                      */
/* -------------------------------------------------------------------------- */

/** Record lifecycle wording. `pending_review` is NOT a payment confirmation. */
export const SETTLEMENT_PAYMENT_RECORD_STATE_LABELS: Record<
  'pending_review' | 'verified' | 'disputed',
  string
> = {
  pending_review: '待复核',
  verified: '已核销',
  disputed: '争议',
}

/** Per-beneficiary payment progress. Only `verified` means the money was checked. */
export const SETTLEMENT_BENEFICIARY_STATE_LABELS: Record<
  'awaiting_payment' | 'pending_review' | 'partial' | 'verified' | 'disputed',
  string
> = {
  awaiting_payment: '待付款',
  pending_review: '已登记待复核',
  partial: '部分支付',
  verified: '已核销',
  disputed: '争议',
}

/**
 * GET /admin/settlement/statements/:statementId/payments — the payment overview.
 *
 * Measured against `apps/api` (#187): the route guard is `'read'`, but
 * `getSettlementPaymentOverview` itself calls `requireAdmin`, so the effective
 * caller is an **admin** — an operator receives a real `403`
 * (「只有管理员可登记或复核线下付款凭据」). The whole overview is returned:
 * `state`, the three totals, `beneficiaries`, `records` and `events`. Empty
 * arrays are a real 「尚未登记」 state; a failed request throws instead.
 */
export async function getSettlementPaymentOverview(
  statementId: string,
  signal?: AbortSignal,
): Promise<SettlementPaymentOverview> {
  const payload = await requestLocalJson(
    `/api${fillRoute(LEDGER_ROUTES.adminSettlementPayments, ':statementId', statementId)}`,
    { signal },
  )
  return parsePayload(settlementPaymentOverviewSchema, payload, '结算单付款概览')
}

/**
 * POST /admin/settlement/statements/:statementId/payments — register one masked
 * offline payment proof.
 *
 * Measured against `apps/api` (#187): admin-only + CSRF, success is **HTTP 201**
 * and the body is the whole `SettlementPaymentOverview` (not a single record), so
 * the page can refresh everything from the resolved value.
 *
 * `idempotencyKey` is **passed through verbatim**: this service never generates,
 * replaces, mutates or retries it. Callers own one key per logical submission and
 * reuse the same key when retrying the identical payload; the server's replay
 * rule returns the current overview for an identical replay and a `409` for a
 * key reused with different content.
 *
 * The body is parsed locally first, so a weak proof reference (12+ consecutive
 * digits), a non-positive/non-integer amount, a malformed timestamp or a non-UUID
 * key never leave the browser. Registering is not verifying: the server keeps the
 * record `pending_review` until an independent admin verifies it.
 */
export async function recordSettlementPayment(
  csrfToken: string,
  statementId: string,
  request: RecordSettlementPaymentRequest,
): Promise<SettlementPaymentOverview> {
  // Verbatim idempotency key: `parse` only validates/normalises the proof text.
  const body = recordSettlementPaymentRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(LEDGER_ROUTES.adminSettlementPayments, ':statementId', statementId)}`,
    { method: 'POST', csrfToken, body },
  )
  return parsePayload(settlementPaymentOverviewSchema, payload, '付款凭据登记结果')
}
