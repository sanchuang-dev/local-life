import {
  LEDGER_ROUTES,
  createSettlementPartyRequestSchema,
  settlementPartyListResponseSchema,
  settlementPartySchema,
  type CreateSettlementPartyRequest,
  type SettlementParty,
} from '@sanchuang-dev/local-life-contracts'
import { parsePayload, requestLocalJson, withQuery } from './localApi'

/**
 * Back-office transport for real settlement parties (LL-SET-009A / #219, API #183).
 *
 * 「结算主体」是**真实存在的法人主体**（销售商户 / 三创主体 / 广电主体）的登记，
 * 不是结算规则，也不是应付金额：本模块只做传输与共享契约解析，不做页面，也不
 * 计算任何分账、应付或费率。
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
