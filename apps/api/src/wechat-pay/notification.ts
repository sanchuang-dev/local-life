import { createDecipheriv } from 'node:crypto'
import { z } from 'zod'
import { verifyWechatPayResponseSignature } from './signing.js'
import type { WechatPayRuntimeConfig } from './credentials.js'

/**
 * PAY-11: verify the byte-exact WeChat HTTP notification FIRST, then decrypt
 * AES-256-GCM with the APIv3 key. Neither a signed body alone nor a
 * successfully decrypted ciphertext establishes a paid transaction.
 * Official: https://pay.weixin.qq.com/doc/v3/merchant/4012071382
 */
export const WECHAT_PAY_NOTIFY_PATH = '/payments/wechat/notify'
const envelopeSchema = z.object({
  // Official WeChat ids may be EV-... rather than UUIDs.
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  create_time: z.string().datetime({ offset: true }),
  event_type: z.literal('TRANSACTION.SUCCESS'),
  resource_type: z.literal('encrypt-resource'),
  resource: z.object({
    algorithm: z.literal('AEAD_AES_256_GCM'),
    original_type: z.literal('transaction'),
    ciphertext: z.string().min(24).max(1_048_576),
    nonce: z.string().length(12),
    // Official APIv3 notification AAD is optional; absent means empty bytes.
    associated_data: z.string().max(16).optional(),
  }),
})
const transactionSchema = z.object({
  appid: z.string().min(1).max(64),
  mchid: z.string().min(1).max(64),
  out_trade_no: z.string().min(6).max(32),
  transaction_id: z.string().min(6).max(128),
  trade_state: z.literal('SUCCESS'),
  success_time: z.string().datetime({ offset: true }),
  amount: z.object({
    total: z.number().int().positive(),
    currency: z.literal('CNY'),
  }),
})

export type VerifiedPaymentNotification = {
  eventId: string
  observedAt: string
  transaction: z.infer<typeof transactionSchema>
}

export type NotificationErrorCode =
  | 'signature' | 'unsupported_event' | 'malformed' | 'decryption' | 'merchant_mismatch'
export class WechatNotificationError extends Error {
  readonly kind: NotificationErrorCode
  constructor(kind: NotificationErrorCode) {
    super('微信支付通知无法验证')
    this.name = 'WechatNotificationError'
    this.kind = kind
  }
}

export function verifyAndDecryptWechatNotification(input: {
  body: string
  headers: Headers
  runtime: WechatPayRuntimeConfig
  now: Date
}): VerifiedPaymentNotification {
  if (!input.runtime.apiV3Key) throw new WechatNotificationError('decryption')
  const verification = verifyWechatPayResponseSignature({
    signature: input.headers.get('wechatpay-signature') ?? undefined,
    timestamp: input.headers.get('wechatpay-timestamp') ?? undefined,
    nonceStr: input.headers.get('wechatpay-nonce') ?? undefined,
    serial: input.headers.get('wechatpay-serial') ?? undefined,
    body: input.body,
    platformPublicKey: input.runtime.platformPublicKey,
    expectedSerial: input.runtime.platformKeyId,
    now: input.now,
  })
  if (!verification.ok) throw new WechatNotificationError('signature')

  let parsed: unknown
  try {
    parsed = JSON.parse(input.body) as unknown
  } catch {
    throw new WechatNotificationError('malformed')
  }
  const envelope = envelopeSchema.safeParse(parsed)
  if (!envelope.success) throw new WechatNotificationError('unsupported_event')

  let plaintext: string
  try {
    const { ciphertext, nonce, associated_data } = envelope.data.resource
    const data = Buffer.from(ciphertext, 'base64')
    if (data.length <= 16) throw new Error('invalid AEAD payload')
    const decipher = createDecipheriv('aes-256-gcm', input.runtime.apiV3Key, Buffer.from(nonce), {
      authTagLength: 16,
    })
    decipher.setAAD(Buffer.from(associated_data ?? '', 'utf8'))
    decipher.setAuthTag(data.subarray(data.length - 16))
    plaintext = Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new WechatNotificationError('decryption')
  }
  let txn: unknown
  try {
    txn = JSON.parse(plaintext) as unknown
  } catch {
    throw new WechatNotificationError('malformed')
  }
  const transaction = transactionSchema.safeParse(txn)
  if (!transaction.success) throw new WechatNotificationError('malformed')
  if (transaction.data.appid !== input.runtime.appId ||
      transaction.data.mchid !== input.runtime.mchid) {
    throw new WechatNotificationError('merchant_mismatch')
  }
  return {
    eventId: envelope.data.id,
    // PAY-03 records the transaction success clock, not later delivery time.
    observedAt: transaction.data.success_time,
    transaction: transaction.data,
  }
}
