import { z } from 'zod'

/** Read-only reconciliation of locally verifiable payment facts, not a provider statement. */
export const paymentReconciliationRoutes = {
  list: '/admin/reconciliation/payments',
  detail: '/admin/reconciliation/payments/:intentId',
  exportCsv: '/admin/reconciliation/payments.csv',
} as const

export const paymentDifferenceReasons = [
  'local_consistent',
  'awaiting_payment',
  'confirmation_timeout',
  'provider_exception',
  'duplicate_provider_event',
  'manual_online_conflict',
  'amount_mismatch',
  'channel_evidence_missing',
  'paid_not_projected',
  'ledger_missing',
  'order_state_conflict',
  'outbound_uncertain',
] as const
export const paymentDifferenceReasonSchema = z.enum(paymentDifferenceReasons)
export type PaymentDifferenceReason = z.infer<typeof paymentDifferenceReasonSchema>

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const positiveInt = z.coerce.number().int().min(1)
export const paymentDifferencesQuerySchema = z.strictObject({
  page: positiveInt.default(1),
  pageSize: positiveInt.max(100).default(20),
  from: date.optional(),
  to: date.optional(),
  communityId: z.string().uuid().optional(),
  status: z.enum(['all', 'difference', 'consistent', 'awaiting']).default('all'),
  reason: paymentDifferenceReasonSchema.optional(),
  source: z.enum(['all', 'mock', 'wechat_jsapi', 'zero_amount']).default('all'),
}).refine((v) => !v.from || !v.to || v.from <= v.to, '开始日期不得晚于结束日期')
export type PaymentDifferencesQuery = z.infer<typeof paymentDifferencesQuerySchema>

export const paymentDifferenceSchema = z.strictObject({
  intentId: z.string().uuid(),
  orderId: z.string().uuid(),
  merchantOrderNo: z.string(),
  communityId: z.string().uuid(),
  source: z.enum(['mock', 'wechat_jsapi', 'zero_amount']),
  simulated: z.boolean(),
  paymentStatus: z.string(),
  orderStatus: z.string(),
  reason: paymentDifferenceReasonSchema,
  status: z.enum(['difference', 'consistent', 'awaiting']),
  businessDate: date,
  createdAt: z.string().datetime(),
  netAmountCents: z.number().int().nonnegative(),
  completionAmountCents: z.number().int().nonnegative().nullable(),
  ledgerAmountCents: z.number().int().nonnegative().nullable(),
  bankSettlement: z.literal('unverified'),
  channelBill: z.literal('not_connected'),
})
export type PaymentDifference = z.infer<typeof paymentDifferenceSchema>
export const paymentDifferencesResponseSchema = z.strictObject({
  items: z.array(paymentDifferenceSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  asOf: z.string().datetime(),
})
export type PaymentDifferencesResponse = z.infer<typeof paymentDifferencesResponseSchema>
