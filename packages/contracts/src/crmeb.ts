import { z } from 'zod'

/**
 * CRMEB adapter contracts (LL-MVP-007, Issue #63).
 *
 * All evidence for the upstream shapes below comes from
 * `docs/engineering/crmeb-integration.md`, which was produced by reading
 * `sanchuang-dev/shop_crmeb` v6.0.0 sources. Nothing here is invented: fields the
 * evidence marks as missing (product stock, order `refund_status` in list
 * responses, `is_cancel`, `update_time`, ...) are deliberately absent, and
 * CRMEB's display strings such as `status_name` are never modelled as enums.
 */

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

const numeric = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform((value) => Number(value))

const money = z.union([z.number(), z.string()])

/** Route identifiers shared by the API and its clients. */
export const CRMEB_ROUTES = {
  status: '/integrations/crmeb/status',
  products: '/integrations/crmeb/products',
  productDetail: '/integrations/crmeb/products/:crmebProductId',
  purchaseLink: '/integrations/crmeb/purchase-link',
  identityMe: '/integrations/crmeb/identity/me',
  adminOrderSync: '/admin/integrations/crmeb/orders/sync',
  adminIdentityBind: '/admin/integrations/crmeb/identities',
  adminIdentityRevoke: '/admin/integrations/crmeb/identities/:platformUserId/revoke',
} as const

/* -------------------------------------------------------------------------- */
/* Adapter status                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Configuration state exposed to clients. It never contains the base URL,
 * appid or appsecret; a resident only needs to know whether the entry works.
 */
export const crmebAdapterStatusSchema = z.object({
  configured: z.boolean(),
  status: z.enum(['ready', 'not_configured']),
  h5EntryConfigured: z.boolean(),
  /** CRMEB exposes no trustworthy signed webhook; the only supported path is polling. */
  orderReconciliation: z.literal('outapi_pull'),
  pushWebhook: z.literal(false),
  detail: z.string().nullable(),
})

export type CrmebAdapterStatus = z.infer<typeof crmebAdapterStatusSchema>

/* -------------------------------------------------------------------------- */
/* Upstream (outapi) response shapes                                          */
/* -------------------------------------------------------------------------- */

/**
 * CRMEB always answers HTTP 200 with this envelope; failures are encoded in
 * `status` (`crmeb/crmeb/utils/Json.php`, `outapi/OutApiExceptionHandle.php`).
 */
export const crmebOutapiEnvelopeSchema = z.object({
  status: z.number().int(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
})

export type CrmebOutapiEnvelope = z.infer<typeof crmebOutapiEnvelopeSchema>

export const crmebOutapiTokenDataSchema = z.object({
  access_token: z.string().min(20),
  /** Absolute Unix timestamp in seconds (`JwtAuth` `exp`), not OAuth `expires_in`. */
  exp_time: numeric,
  auth_info: z.unknown().optional(),
})

export type CrmebOutapiTokenData = z.infer<typeof crmebOutapiTokenDataSchema>

const crmebRawSkuSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  unique: z.union([z.number(), z.string()]).optional(),
  price: money.optional(),
  image: z.string().nullish(),
  suk: z.union([z.string(), z.array(z.string())]).nullish(),
  stock: z.unknown().optional(),
})

/**
 * `GET /outapi/product/list` row (`OutStoreProductServices::searchList`).
 * `stock` is intentionally not read: the evidence shows CRMEB unsets it both in
 * list and detail responses, so the adapter must report stock as unknown.
 */
export const crmebRawProductSchema = z.looseObject({
  id: numeric,
  image: z.string().nullish(),
  slider_image: z.union([z.array(z.string()), z.string()]).nullish(),
  store_name: z.string(),
  store_info: z.string().nullish(),
  price: money,
  ot_price: money.nullish(),
  cate_id: z.union([z.array(z.union([z.number(), z.string()])), z.string()]).nullish(),
  cate_name: z.string().nullish(),
  is_show: numeric.nullish(),
  spec_type: numeric.nullish(),
  description: z.string().nullish(),
  attrs: z.array(crmebRawSkuSchema).nullish(),
})

export type CrmebRawProduct = z.infer<typeof crmebRawProductSchema>

export const crmebRawProductListSchema = z.object({
  list: z.array(crmebRawProductSchema),
  count: numeric,
})

export type CrmebRawProductList = z.infer<typeof crmebRawProductListSchema>

export const crmebRawOrderItemSchema = z.looseObject({
  store_name: z.string().nullish(),
  suk: z.string().nullish(),
  image: z.string().nullish(),
  price: money.nullish(),
  cart_num: numeric.nullish(),
})

export type CrmebRawOrderItem = z.infer<typeof crmebRawOrderItemSchema>

/**
 * `GET /outapi/order/list` row. The list response has no `refund_status`,
 * `refund_type`, `status_name`, `is_cancel` or `update_time`
 * (`OutStoreOrderServices::tidyOrderList`), so this schema must not claim them.
 */
export const crmebRawOrderSchema = z.looseObject({
  id: numeric,
  order_id: z.string().min(1),
  uid: numeric.nullish(),
  paid: numeric,
  status: numeric,
  pay_type: z.string().nullish(),
  pay_time: numeric.nullish(),
  add_time: numeric.nullish(),
  pay_price: money.nullish(),
  total_price: money.nullish(),
  items: z.array(crmebRawOrderItemSchema).nullish(),
  /** Only present on `GET /outapi/order/<order_id>` detail responses. */
  refund_status: numeric.nullish(),
})

export type CrmebRawOrder = z.infer<typeof crmebRawOrderSchema>

export const crmebRawOrderListSchema = z.object({
  list: z.array(crmebRawOrderSchema),
  count: numeric,
})

export type CrmebRawOrderList = z.infer<typeof crmebRawOrderListSchema>

/** `GET /outapi/refund/list` row (`OutStoreOrderRefundServices`). */
export const crmebRawRefundSchema = z.looseObject({
  id: numeric,
  store_order_id: numeric,
  order_id: z.string().min(1),
  refund_type: numeric,
  refund_price: money.nullish(),
  pay_price: money.nullish(),
  refunded_price: money.nullish(),
  refunded_time: numeric.nullish(),
  add_time: numeric.nullish(),
})

export type CrmebRawRefund = z.infer<typeof crmebRawRefundSchema>

export const crmebRawRefundListSchema = z.object({
  list: z.array(crmebRawRefundSchema),
  count: numeric,
})

export type CrmebRawRefundList = z.infer<typeof crmebRawRefundListSchema>

/* -------------------------------------------------------------------------- */
/* Normalised product DTOs                                                    */
/* -------------------------------------------------------------------------- */

export const crmebProductSkuSchema = z.object({
  skuKey: z.string().min(1),
  priceCents: z.number().int().nonnegative(),
  image: z.string().nullable(),
  specText: z.string().nullable(),
})

export type CrmebProductSku = z.infer<typeof crmebProductSkuSchema>

/**
 * Normalised product summary. `stockKnown` is always `false`: CRMEB outapi
 * never returns stock, so the platform must not pretend an item is purchasable.
 */
export const crmebProductSummarySchema = z.object({
  id: z.string().min(1),
  crmebProductId: z.number().int().positive(),
  name: z.string(),
  summary: z.string(),
  images: z.array(z.string()),
  priceCents: z.number().int().nonnegative(),
  originalPriceCents: z.number().int().nonnegative().nullable(),
  categoryIds: z.array(z.number().int()),
  categoryNames: z.array(z.string()),
  onShelf: z.boolean(),
  specType: z.union([z.literal(0), z.literal(1)]),
  stockKnown: z.literal(false),
})

export type CrmebProductSummary = z.infer<typeof crmebProductSummarySchema>

export const crmebProductDetailSchema = crmebProductSummarySchema.extend({
  detailHtml: z.string(),
  skus: z.array(crmebProductSkuSchema),
})

export type CrmebProductDetail = z.infer<typeof crmebProductDetailSchema>

export const crmebProductListResponseSchema = z.object({
  items: z.array(crmebProductSummarySchema),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  /** Proves the payload was read from CRMEB outapi instead of local demo data. */
  source: z.literal('crmeb_outapi'),
  fetchedAt: isoTimestamp,
})

export type CrmebProductListResponse = z.infer<typeof crmebProductListResponseSchema>

/* -------------------------------------------------------------------------- */
/* Purchase entry and attribution                                             */
/* -------------------------------------------------------------------------- */

/**
 * `strictObject` is intentional: a browser must not be able to smuggle
 * `gridWorkerId`, `claimState`/`confirmed`, `platformUserId` or a CRMEB uid
 * into the attribution flow. Unknown keys fail validation with 400.
 */
export const crmebPurchaseLinkRequestSchema = z.strictObject({
  /**
   * Optional activity context. A natural purchase from a product page has no
   * activity; when supplied, the server still requires it to be published and
   * to belong to one of the resident's communities.
   */
  activityId: z.string().uuid().optional(),
  crmebProductId: z.number().int().positive(),
  /** Opaque staff referral code; resolved and scoped entirely server-side. */
  referralCode: z.string().trim().min(1).max(64).optional(),
})

export type CrmebPurchaseLinkRequest = z.infer<typeof crmebPurchaseLinkRequestSchema>

/**
 * `confirmed` is reserved for a future audited verification path. The public
 * purchase endpoint can only ever write `claimed` or `unconfirmed`.
 */
export const crmebAttributionClaimStateSchema = z.enum(['claimed', 'unconfirmed', 'confirmed'])
export type CrmebAttributionClaimState = z.infer<typeof crmebAttributionClaimStateSchema>

export const crmebAttributionSubmitStateSchema = z.enum(['claimed', 'unconfirmed'])
export type CrmebAttributionSubmitState = z.infer<typeof crmebAttributionSubmitStateSchema>

export const crmebAttributionClaimSchema = z.object({
  id: z.string().uuid(),
  clickId: z.string().uuid(),
  /** Null for a natural purchase without an activity context. */
  activityId: z.string().uuid().nullable(),
  crmebProductId: z.number().int().positive(),
  claimState: crmebAttributionClaimStateSchema,
  claimedStaffId: z.string().uuid().nullable(),
  createdAt: isoTimestamp,
})

export type CrmebAttributionClaim = z.infer<typeof crmebAttributionClaimSchema>

export const crmebPurchaseLinkResponseSchema = z.object({
  url: z.string().url(),
  claim: crmebAttributionClaimSchema,
  warnings: z.array(z.string()),
})

export type CrmebPurchaseLinkResponse = z.infer<typeof crmebPurchaseLinkResponseSchema>

/* -------------------------------------------------------------------------- */
/* Order status and pull sync                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Platform-owned order state. Derived from `paid`/`status`/`refund_status`
 * only; CRMEB's `status_name` is display text and is never used.
 *
 * There is deliberately no `cancelled` value: outapi returns neither `is_cancel`
 * nor `update_time`, so a cancelled-unpaid order is indistinguishable from a
 * never-paid one and must stay `unpaid` (never counted as a valid transaction).
 */
export const crmebOrderStatusSchema = z.enum([
  'unpaid',
  'unshipped',
  'shipped',
  'received',
  'completed',
  'refunding',
  'partial_refund',
  'refunded',
  'unknown',
])

export type CrmebOrderStatus = z.infer<typeof crmebOrderStatusSchema>

export const crmebOrderSyncRequestSchema = z.strictObject({
  page: z.number().int().min(1).max(1_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  /** Filters CRMEB `add_time`; converted to the CRMEB `YYYY/MM/DD HH:mm:ss` window format. */
  sinceAddTime: isoTimestamp.optional(),
  /**
   * Refund scan cursor. After-sale scanning is never optional: it always runs,
   * and scanning starts at `refundPage` (default 1). A run that cannot finish
   * the scan never marks orders as valid transactions.
   */
  refundPage: z.number().int().min(1).max(1_000).optional(),
  refundLimit: z.number().int().min(1).max(100).optional(),
})

export type CrmebOrderSyncRequest = z.infer<typeof crmebOrderSyncRequestSchema>

export const crmebOrderSyncScopeSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  sinceAddTime: isoTimestamp.nullable(),
  refundPage: z.number().int().min(1),
  refundLimit: z.number().int().min(1),
  /** Refund exclusion cannot be disabled; every run performs the scan. */
  refundScan: z.literal('mandatory'),
  /** Real staff role that triggered the run (sync is admin-only). */
  actorRole: z.literal('admin'),
})

export const crmebOrderSyncCountsSchema = z.object({
  scanned: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
})

export const crmebRefundSyncCountsSchema = z.object({
  scanned: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
})

export const crmebSyncErrorSchema = z.object({
  scope: z.enum(['order', 'refund', 'run']),
  externalOrderNo: z.string().nullable(),
  code: z.string().min(1),
  message: z.string().min(1),
})

export type CrmebSyncError = z.infer<typeof crmebSyncErrorSchema>

export const crmebOrderSyncResponseSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(['succeeded', 'failed']),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  scope: crmebOrderSyncScopeSchema,
  orders: crmebOrderSyncCountsSchema,
  refunds: crmebRefundSyncCountsSchema,
  validTransactions: z.number().int().nonnegative(),
  eventsAppended: z.number().int().nonnegative(),
  cursor: z.object({
    lastAddTime: isoTimestamp.nullable(),
    lastExternalOrderNo: z.string().nullable(),
    refunds: z.object({
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      pagesScanned: z.number().int().nonnegative(),
      nextPage: z.number().int().min(1).nullable(),
      hasMore: z.boolean(),
      complete: z.boolean(),
      lastExternalRefundNo: z.string().nullable(),
      lastRefundAddTime: isoTimestamp.nullable(),
    }),
  }),
  errors: z.array(crmebSyncErrorSchema),
})

export type CrmebOrderSyncResponse = z.infer<typeof crmebOrderSyncResponseSchema>

/* -------------------------------------------------------------------------- */
/* Identity mapping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The only currently supported proof is a staff member manually verifying the
 * mapping. CRMEB exposes no signed identity assertion / SSO and its
 * `/api/remote_register` endpoint is forgeable, so it is never used.
 */
export const crmebIdentityVerificationMethodSchema = z.literal('manual_verified')
export type CrmebIdentityVerificationMethod = z.infer<
  typeof crmebIdentityVerificationMethodSchema
>

export const crmebIdentityBindRequestSchema = z.strictObject({
  platformUserId: z.string().uuid(),
  crmebUid: z.number().int().positive(),
  verificationMethod: crmebIdentityVerificationMethodSchema,
  note: z.string().trim().max(500).optional(),
})

export type CrmebIdentityBindRequest = z.infer<typeof crmebIdentityBindRequestSchema>

export const crmebIdentitySchema = z.object({
  id: z.string().uuid(),
  platformUserId: z.string().uuid(),
  crmebUid: z.number().int().positive(),
  status: z.enum(['active', 'revoked']),
  verificationMethod: crmebIdentityVerificationMethodSchema,
  verifiedAt: isoTimestamp,
  createdAt: isoTimestamp,
})

export type CrmebIdentity = z.infer<typeof crmebIdentitySchema>

/**
 * Minimal resident-facing status: never exposes the CRMEB uid, admin notes or
 * platform ids. A resident only needs to know whether a real account is linked,
 * how it was verified and when.
 */
export const crmebResidentIdentitySchema = z.object({
  status: z.enum(['active', 'revoked']),
  verificationMethod: crmebIdentityVerificationMethodSchema,
  verifiedAt: isoTimestamp,
})

export type CrmebResidentIdentity = z.infer<typeof crmebResidentIdentitySchema>

export const crmebIdentityStatusResponseSchema = z.discriminatedUnion('linked', [
  z.object({ linked: z.literal(false) }),
  z.object({ linked: z.literal(true), identity: crmebResidentIdentitySchema }),
])

export type CrmebIdentityStatusResponse = z.infer<typeof crmebIdentityStatusResponseSchema>

export const crmebIdentityBindResponseSchema = z.object({
  identity: crmebIdentitySchema,
})

export type CrmebIdentityBindResponse = z.infer<typeof crmebIdentityBindResponseSchema>

/** Revoking is also admin-only, audited, and the row can be rebound later. */
export const crmebIdentityRevokeResponseSchema = z.object({
  identity: crmebIdentitySchema,
})

export type CrmebIdentityRevokeResponse = z.infer<
  typeof crmebIdentityRevokeResponseSchema
>

/** Shared warning copy so the API, H5 and admin show identical limitations. */
export const CRMEB_PURCHASE_WARNINGS = [
  '库存与可售状态以 CRMEB 商城为准，平台无法判断是否售罄',
  '需先在商城完成登录才能下单；平台不代下单、不代支付',
  '商城 H5 深链依赖 CRMEB 部署层 SPA 回退，上线前必须用真实域名实测',
] as const
