import {
  LEDGER_ROUTES,
  confirmSettlementOrderPartyRequestSchema,
  createSettlementMappingRequestSchema,
  createSettlementPartyRequestSchema,
  settlementMappingListResponseSchema,
  settlementMappingSchema,
  settlementOrderPartyResponseSchema,
  settlementOrderPartySnapshotSchema,
  settlementPartyListResponseSchema,
  settlementPartySchema,
  type CreateSettlementMappingRequest,
  type CreateSettlementPartyRequest,
  type SettlementMapping,
  type SettlementOrderPartySnapshot,
  type SettlementParty,
} from '@sanchuang-dev/local-life-contracts'
import { fillRoute, parsePayload, requestLocalJson, withQuery } from './localApi'

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
