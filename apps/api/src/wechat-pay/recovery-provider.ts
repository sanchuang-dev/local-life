import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { WechatPayRuntimeConfig } from './credentials.js'
import { createNonceStr, signWechatPayRequest, verifyWechatPayResponseSignature } from './signing.js'

const querySchema = z.object({
  appid: z.string().min(1),
  mchid: z.string().min(1),
  out_trade_no: z.string().min(6),
  transaction_id: z.string().optional(),
  trade_state: z.enum([
    'SUCCESS', 'REFUND', 'NOTPAY', 'CLOSED', 'REVOKED', 'USERPAYING', 'PAYERROR',
  ]),
  success_time: z.string().datetime({ offset: true }).optional(),
  // APIv3 query marks amount/total/currency optional, especially for NOTPAY
  // and CLOSED. Successful payments still require positive provider proof.
  amount: z.object({
    total: z.number().int().positive().optional(),
    currency: z.literal('CNY').optional(),
  }).optional(),
})
export type WechatVerifiedQuery = z.infer<typeof querySchema>

export type WechatQueryOutcome =
  | { kind: 'verified'; transaction: WechatVerifiedQuery; responseHash: string; responseTimestamp: string; responseNonce: string }
  | { kind: 'uncertain'; reason: string; responseHash: string | null }

export type WechatCloseOutcome =
  | { kind: 'sent'; responseHash: string | null }
  | { kind: 'uncertain'; reason: string; responseHash: string | null }

type Result = {
  status: number
  body: string
  headers: Headers
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export async function signedWechatRequest(input: {
  runtime: WechatPayRuntimeConfig
  method: 'GET' | 'POST'
  path: string
  body?: string
  fetcher?: typeof fetch
  now?: Date
}): Promise<Result | null> {
  const body = input.body ?? ''
  const now = input.now ?? new Date()
  const signed = signWechatPayRequest({
    method: input.method,
    urlPath: input.path,
    timestamp: Math.floor(now.getTime() / 1_000).toString(),
    nonceStr: createNonceStr(),
    body,
    mchid: input.runtime.mchid,
    merchantSerialNo: input.runtime.merchantSerialNo,
    merchantPrivateKey: input.runtime.merchantPrivateKey,
  })
  try {
    const res = await (input.fetcher ?? fetch)(input.runtime.apiBaseUrl + input.path, {
      method: input.method,
      headers: {
        Authorization: signed.authorization,
        Accept: 'application/json',
        ...(input.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input.method === 'POST' ? { body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(input.runtime.timeoutMs),
    })
    const responseBody = await res.text()
    if (responseBody.length > 128 * 1024) return null
    return { status: res.status, body: responseBody, headers: res.headers }
  } catch {
    return null
  }
}

/** The only source of trusted query evidence is a signed 200 response. */
export async function queryWechatOrder(input: {
  runtime: WechatPayRuntimeConfig
  merchantOrderNo: string
  fetcher?: typeof fetch
  now?: Date
}): Promise<WechatQueryOutcome> {
  const path = '/v3/pay/transactions/out-trade-no/' +
    encodeURIComponent(input.merchantOrderNo) + '?mchid=' + encodeURIComponent(input.runtime.mchid)
  const response = await signedWechatRequest({
    runtime: input.runtime, method: 'GET', path,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.now ? { now: input.now } : {}),
  })
  if (!response) return { kind: 'uncertain', reason: 'transport_unavailable', responseHash: null }
  const responseHash = sha256(response.body)
  const verification = verifyWechatPayResponseSignature({
    signature: response.headers.get('wechatpay-signature') ?? undefined,
    timestamp: response.headers.get('wechatpay-timestamp') ?? undefined,
    nonceStr: response.headers.get('wechatpay-nonce') ?? undefined,
    serial: response.headers.get('wechatpay-serial') ?? undefined,
    body: response.body,
    platformPublicKey: input.runtime.platformPublicKey,
    expectedSerial: input.runtime.platformKeyId,
    now: new Date(),
  })
  if (!verification.ok) {
    return { kind: 'uncertain', reason: 'untrusted_response_' + verification.reason, responseHash }
  }
  if (response.status !== 200) {
    return { kind: 'uncertain', reason: 'provider_http_' + response.status, responseHash }
  }
  let decoded: unknown
  try { decoded = JSON.parse(response.body) as unknown } catch {
    return { kind: 'uncertain', reason: 'invalid_json', responseHash }
  }
  const result = querySchema.safeParse(decoded)
  if (!result.success || result.data.mchid !== input.runtime.mchid ||
      result.data.appid !== input.runtime.appId ||
      result.data.out_trade_no !== input.merchantOrderNo) {
    return { kind: 'uncertain', reason: 'response_identity_or_schema_mismatch', responseHash }
  }
  if (result.data.trade_state === 'SUCCESS' &&
      (!result.data.transaction_id || !result.data.success_time ||
       result.data.amount?.total === undefined || result.data.amount?.currency !== 'CNY')) {
    return { kind: 'uncertain', reason: 'paid_missing_proof', responseHash }
  }
  return {
    kind: 'verified', transaction: result.data, responseHash,
    responseTimestamp: response.headers.get('wechatpay-timestamp')!,
    responseNonce: response.headers.get('wechatpay-nonce')!,
  }
}

/**
 * A close request acknowledgment NEVER proves closure. Only a subsequent
 * signed order query with trade_state=CLOSED/REVOKED may close PAY-03.
 */
export async function sendWechatCloseOrder(input: {
  runtime: WechatPayRuntimeConfig
  merchantOrderNo: string
  fetcher?: typeof fetch
}): Promise<WechatCloseOutcome> {
  const path = '/v3/pay/transactions/out-trade-no/' +
    encodeURIComponent(input.merchantOrderNo) + '/close'
  const response = await signedWechatRequest({
    runtime: input.runtime, method: 'POST', path,
    body: JSON.stringify({ mchid: input.runtime.mchid }),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  })
  if (!response) return { kind: 'uncertain', reason: 'transport_unavailable', responseHash: null }
  const responseHash = sha256(response.body)
  // WeChat's documented success is 204 (empty body). This is merely an
  // acknowledgment and must be followed by a signed order query.
  if (response.status === 204 && response.body === '') {
    return { kind: 'sent', responseHash }
  }
  // Never use an error (including a forged one) as a status transition.
  return { kind: 'uncertain', reason: 'provider_http_' + response.status, responseHash }
}
