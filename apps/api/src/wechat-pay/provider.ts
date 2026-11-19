import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  WECHATPAY_PREPAY_VALIDITY_MS,
  createNonceStr,
  signWechatPayRequest,
  verifyWechatPayResponseSignature,
  type WechatPayResponseVerificationFailure,
} from './signing.js'
import type { WechatPayRuntimeConfig } from './credentials.js'

/**
 * Outbound WeChat Pay APIv3 JSAPI prepay client (PAY-10).
 *
 * Official protocol source (checked 2026-11-18):
 * - JSAPI下单: POST /v3/pay/transactions/jsapi, returns only `prepay_id`.
 * - Request signing and response verification: see `signing.ts` references.
 *
 * This module performs one HTTPS POST and normalizes the result into three
 * mutually exclusive outcomes:
 * - `prepay`   — a *verified* response with a prepay_id; the client may invoke
 *                the cashier. It is still not a payment.
 * - `rejected` — a *verified* deterministic provider refusal (4xx / WeChat
 *                error). No payable order exists, so a bounded retry is safe.
 * - `uncertain`— timeout, transport failure, untrusted/unverifiable response,
 *                protocol anomaly or 5xx. The provider may or may not have
 *                created the order; the caller must not treat it as failure and
 *                must not blindly submit a new payable order.
 *
 * The Authorization signature, private key and raw response body are never
 * logged or returned. Only a body SHA-256 and safe provider metadata leave here.
 */

export const WECHAT_PAY_JSAPI_PATH = '/v3/pay/transactions/jsapi'

export interface WechatPayJsapiPrepayInput {
  appId: string
  mchid: string
  /** Frozen order description shown on the WeChat bill; server-derived. */
  description: string
  outTradeNo: string
  /** WeChat order payment deadline (`time_expire`), independent of prepay validity. */
  timeExpire: Date
  notifyUrl: string
  amountTotalCents: number
  openid: string
}

export interface WechatPayOutboundRequest {
  method: 'POST'
  path: string
  /** Byte-exact body used both for the request signature and the HTTP call. */
  body: string
  bodySha256: string
  /** SHA-256 over `METHOD\nPATH\nBODY`; safe idempotency/audit fingerprint. */
  fingerprint: string
  /** Same body with the payer openid replaced by its SHA-256. */
  redactedBodyJson: string
  timestamp: string
  nonceStr: string
  /** Contains the request signature; persisted nowhere and never logged. */
  authorization: string
}

export type WechatPayPrepayFailureCode =
  | 'timeout'
  | 'network_error'
  | 'response_unreadable'
  | 'signature_missing'
  | 'signature_invalid'
  | 'signature_serial_mismatch'
  | 'signature_timestamp_invalid'
  | 'signature_timestamp_expired'
  | 'unparseable_response'
  | 'unexpected_payload'
  | 'provider_server_error'

interface WechatPayPrepayOutcomeBase {
  responseStatus: number | null
  requestId: string | null
  responseBodySha256: string | null
}

export type WechatPayPrepayOutcome =
  | (WechatPayPrepayOutcomeBase & {
      kind: 'prepay'
      prepayId: string
    })
  | (WechatPayPrepayOutcomeBase & {
      kind: 'rejected'
      code: string
      message: string
    })
  | (WechatPayPrepayOutcomeBase & {
      kind: 'uncertain'
      failureCode: WechatPayPrepayFailureCode
      detail: string
    })

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * RFC3339 `time_expire` in Beijing time (the only timezone WeChat documents for
 * this field examples): `yyyy-MM-DDTHH:mm:ss+08:00`, no fractional seconds.
 */
export function formatWechatTimeExpire(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1_000)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`
  )
}

/**
 * The official prepay_id validity is two hours. The local invocation window is
 * additionally capped by the intent's payment deadline, so an expired prepay is
 * never treated as usable or as a paid fact.
 */
export function computePrepayExpiresAt(now: Date, intentExpiresAt: Date): Date {
  return new Date(
    Math.min(now.getTime() + WECHATPAY_PREPAY_VALIDITY_MS, intentExpiresAt.getTime()),
  )
}

type PrepayBody = {
  appid: string
  mchid: string
  description: string
  out_trade_no: string
  time_expire: string
  notify_url: string
  amount: { total: number; currency: 'CNY' }
  payer: { openid: string }
}

export function buildWechatPayJsapiRequest(
  runtime: Pick<
    WechatPayRuntimeConfig,
    'mchid' | 'merchantSerialNo' | 'merchantPrivateKey'
  >,
  input: WechatPayJsapiPrepayInput,
  options: { now: Date; nonceStr?: string },
): WechatPayOutboundRequest {
  const bodyObject: PrepayBody = {
    appid: input.appId,
    mchid: input.mchid,
    description: input.description,
    out_trade_no: input.outTradeNo,
    time_expire: formatWechatTimeExpire(input.timeExpire),
    notify_url: input.notifyUrl,
    amount: { total: input.amountTotalCents, currency: 'CNY' },
    payer: { openid: input.openid },
  }
  const body = JSON.stringify(bodyObject)
  const openidSha256 = sha256Hex(input.openid)
  const redactedBodyJson = JSON.stringify({
    ...bodyObject,
    payer: { openid: `sha256:${openidSha256}` },
  })
  const timestamp = Math.floor(options.now.getTime() / 1_000).toString()
  const nonceStr = options.nonceStr ?? createNonceStr()
  const signed = signWechatPayRequest({
    method: 'POST',
    urlPath: WECHAT_PAY_JSAPI_PATH,
    timestamp,
    nonceStr,
    body,
    mchid: runtime.mchid,
    merchantSerialNo: runtime.merchantSerialNo,
    merchantPrivateKey: runtime.merchantPrivateKey,
  })
  return {
    method: 'POST',
    path: WECHAT_PAY_JSAPI_PATH,
    body,
    bodySha256: sha256Hex(body),
    fingerprint: sha256Hex(`POST\n${WECHAT_PAY_JSAPI_PATH}\n${body}`),
    redactedBodyJson,
    timestamp: signed.timestamp,
    nonceStr: signed.nonceStr,
    authorization: signed.authorization,
  }
}

const prepayResponseSchema = z.object({
  prepay_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,128}$/u, 'invalid prepay_id'),
})

const wechatErrorSchema = z.object({
  code: z.string().trim().min(1).max(64),
  message: z.string().max(2_000).optional(),
})

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function verificationFailureCode(
  reason: WechatPayResponseVerificationFailure,
): WechatPayPrepayFailureCode {
  switch (reason) {
    case 'missing_headers':
      return 'signature_missing'
    case 'serial_mismatch':
      return 'signature_serial_mismatch'
    case 'invalid_timestamp':
      return 'signature_timestamp_invalid'
    case 'timestamp_out_of_tolerance':
      return 'signature_timestamp_expired'
    case 'invalid_signature':
      return 'signature_invalid'
  }
}

/**
 * Execute one signed prepay request. This function intentionally never throws
 * for provider/network conditions: every outcome is persisted by the caller so
 * an unknown result stays visible and cannot silently become a retry.
 */
export async function executeWechatPayJsapiRequest(input: {
  request: WechatPayOutboundRequest
  runtime: WechatPayRuntimeConfig
  now: Date
  fetcher?: typeof fetch
}): Promise<WechatPayPrepayOutcome> {
  const { request, runtime, now } = input
  const fetcher = input.fetcher ?? fetch
  let response: Response
  try {
    response = await fetcher(`${runtime.apiBaseUrl}${request.path}`, {
      method: 'POST',
      headers: {
        Authorization: request.authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(runtime.timeoutMs),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown'
    const isTimeout = name === 'TimeoutError' || name === 'AbortError'
    return {
      kind: 'uncertain',
      responseStatus: null,
      requestId: null,
      responseBodySha256: null,
      failureCode: isTimeout ? 'timeout' : 'network_error',
      detail: isTimeout ? '微信支付请求超时，结果未定' : '微信支付网络请求失败，结果未定',
    }
  }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    return {
      kind: 'uncertain',
      responseStatus: response.status,
      requestId: response.headers.get('request-id'),
      responseBodySha256: null,
      failureCode: 'response_unreadable',
      detail: '微信支付应答无法读取，结果未定',
    }
  }

  const responseBodySha256 = sha256Hex(raw)
  const verification = verifyWechatPayResponseSignature({
    signature: response.headers.get('wechatpay-signature') ?? undefined,
    timestamp: response.headers.get('wechatpay-timestamp') ?? undefined,
    nonceStr: response.headers.get('wechatpay-nonce') ?? undefined,
    serial: response.headers.get('wechatpay-serial') ?? undefined,
    body: raw,
    platformPublicKey: runtime.platformPublicKey,
    expectedSerial: runtime.platformKeyId,
    now,
  })
  if (!verification.ok) {
    return {
      kind: 'uncertain',
      responseStatus: response.status,
      requestId: response.headers.get('request-id'),
      responseBodySha256,
      failureCode: verificationFailureCode(verification.reason),
      detail: `微信支付应答验签失败（${verification.reason}），已拒绝该应答`,
    }
  }

  const parsed = raw.trim() === '' ? undefined : parseJson(raw)
  const errorPayload = wechatErrorSchema.safeParse(parsed)
  const isSuccessStatus = response.status >= 200 && response.status < 300

  if (isSuccessStatus) {
    if (parsed === undefined) {
      return {
        kind: 'uncertain',
        responseStatus: response.status,
        requestId: response.headers.get('request-id'),
        responseBodySha256,
        failureCode: 'unparseable_response',
        detail: '微信支付应答无法解析，结果未定',
      }
    }
    if (errorPayload.success) {
      return {
        kind: 'rejected',
        responseStatus: response.status,
        requestId: response.headers.get('request-id'),
        responseBodySha256,
        code: errorPayload.data.code,
        message: truncate(errorPayload.data.message ?? '微信支付返回错误', 500),
      }
    }
    const prepay = prepayResponseSchema.safeParse(parsed)
    if (prepay.success) {
      return {
        kind: 'prepay',
        responseStatus: response.status,
        requestId: response.headers.get('request-id'),
        responseBodySha256,
        prepayId: prepay.data.prepay_id,
      }
    }
    return {
      kind: 'uncertain',
      responseStatus: response.status,
      requestId: response.headers.get('request-id'),
      responseBodySha256,
      failureCode: 'unexpected_payload',
      detail: '微信支付应答缺少有效的 prepay_id，结果未定',
    }
  }

  if (response.status >= 500) {
    return {
      kind: 'uncertain',
      responseStatus: response.status,
      requestId: response.headers.get('request-id'),
      responseBodySha256,
      failureCode: 'provider_server_error',
      detail: '微信支付返回服务端错误，结果未定',
    }
  }

  if (response.status >= 400 && response.status < 500) {
    return {
      kind: 'rejected',
      responseStatus: response.status,
      requestId: response.headers.get('request-id'),
      responseBodySha256,
      code: errorPayload.success ? errorPayload.data.code : `HTTP_${response.status}`,
      message: truncate(
        errorPayload.success && errorPayload.data.message
          ? errorPayload.data.message
          : '微信支付拒绝了预下单请求',
        500,
      ),
    }
  }

  return {
    kind: 'uncertain',
    responseStatus: response.status,
    requestId: response.headers.get('request-id'),
    responseBodySha256,
    failureCode: 'unexpected_payload',
    detail: '微信支付返回了非预期状态码，结果未定',
  }
}
