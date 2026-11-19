import { randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import {
  WECHAT_JSAPI_SIGN_TYPE,
  type WechatJsapiInvocation,
} from '@sanchuang-dev/local-life-contracts'

/**
 * WeChat Pay APIv3 signing primitives (PAY-10).
 *
 * Protocol facts are taken from the current official documentation (checked
 * 2026-11-18):
 *
 * - request signature: five lines `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n`,
 *   RSA-SHA256 with the merchant API certificate private key, Base64 encoded;
 * - `Authorization: WECHATPAY2-SHA256-RSA2048 mchid=..,nonce_str=..,signature=..,timestamp=..,serial_no=..`;
 * - JSAPI invocation signature: four lines `appId\ntimeStamp\nnonceStr\npackage\n`
 *   where `package` is exactly `prepay_id=<id>`; `signType` is not signed;
 * - response verification: three lines `timestamp\nnonce\nbody\n`, verified
 *   with the trusted WeChat Pay public key / platform certificate; the
 *   `Wechatpay-Serial` header must match the configured trust anchor and the
 *   timestamp must be within a small clock-skew window.
 *
 * This module never logs or returns key material.
 */

export const WECHATPAY_AUTH_SCHEME = 'WECHATPAY2-SHA256-RSA2048'
/** Official guidance: reject replies whose timestamp is more than 5 minutes off. */
export const WECHATPAY_RESPONSE_TOLERANCE_SECONDS = 300
/** WeChat documents `prepay_id` as valid for two hours. */
export const WECHATPAY_PREPAY_VALIDITY_MS = 2 * 60 * 60 * 1000

/** 32-character uppercase hex random string, matching the documented examples. */
export function createNonceStr(): string {
  return randomBytes(16).toString('hex').toUpperCase()
}

export function buildWechatPayRequestSignatureMessage(
  method: string,
  urlPath: string,
  timestamp: string,
  nonceStr: string,
  body: string,
): string {
  return `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`
}

export interface SignedWechatPayRequest {
  timestamp: string
  nonceStr: string
  signature: string
  authorization: string
}

export function signWechatPayRequest(input: {
  method: string
  urlPath: string
  timestamp: string
  nonceStr: string
  body: string
  mchid: string
  merchantSerialNo: string
  merchantPrivateKey: KeyObject
}): SignedWechatPayRequest {
  const message = buildWechatPayRequestSignatureMessage(
    input.method,
    input.urlPath,
    input.timestamp,
    input.nonceStr,
    input.body,
  )
  const signature = sign('sha256', Buffer.from(message, 'utf8'), input.merchantPrivateKey)
    .toString('base64')
  const authorization =
    `${WECHATPAY_AUTH_SCHEME} mchid="${input.mchid}",` +
    `nonce_str="${input.nonceStr}",signature="${signature}",` +
    `timestamp="${input.timestamp}",serial_no="${input.merchantSerialNo}"`
  return { timestamp: input.timestamp, nonceStr: input.nonceStr, signature, authorization }
}

export function buildWechatPayJsapiPaySignMessage(
  appId: string,
  timeStamp: string,
  nonceStr: string,
  prepayPackage: string,
): string {
  return `${appId}\n${timeStamp}\n${nonceStr}\n${prepayPackage}\n`
}

/**
 * Produce the browser invocation parameters. The caller supplies only trusted
 * server values: the configured appId and a `prepay_id` accepted after response
 * verification. A fresh timestamp/nonce is generated for every invocation, so a
 * replayed response cannot reuse an old `paySign`.
 */
export function createWechatJsapiInvocation(input: {
  appId: string
  prepayId: string
  merchantPrivateKey: KeyObject
  now: Date
  nonceStr?: string
}): WechatJsapiInvocation {
  const timeStamp = Math.floor(input.now.getTime() / 1_000).toString()
  const nonceStr = input.nonceStr ?? createNonceStr()
  const prepayPackage = `prepay_id=${input.prepayId}`
  const message = buildWechatPayJsapiPaySignMessage(
    input.appId,
    timeStamp,
    nonceStr,
    prepayPackage,
  )
  const paySign = sign('sha256', Buffer.from(message, 'utf8'), input.merchantPrivateKey)
    .toString('base64')
  return {
    appId: input.appId,
    timeStamp,
    nonceStr,
    package: prepayPackage,
    signType: WECHAT_JSAPI_SIGN_TYPE,
    paySign,
  }
}

export function buildWechatPayResponseSignatureMessage(
  timestamp: string,
  nonceStr: string,
  body: string,
): string {
  return `${timestamp}\n${nonceStr}\n${body}\n`
}

export type WechatPayResponseVerificationFailure =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'serial_mismatch'
  | 'invalid_signature'

export type WechatPayResponseVerification =
  | { ok: true }
  | { ok: false; reason: WechatPayResponseVerificationFailure }

/**
 * Fail-closed verification of a WeChat Pay HTTP response.
 *
 * A missing header, a serial that is not the configured trust anchor, a
 * timestamp outside the tolerated skew or a bad signature all return a failure.
 * The caller must never accept a `prepay_id` without `ok: true`.
 */
export function verifyWechatPayResponseSignature(input: {
  signature: string | undefined
  timestamp: string | undefined
  nonceStr: string | undefined
  serial: string | undefined
  body: string
  platformPublicKey: KeyObject
  expectedSerial: string
  now: Date
  toleranceSeconds?: number
}): WechatPayResponseVerification {
  const signature = input.signature?.trim()
  const timestamp = input.timestamp?.trim()
  const nonceStr = input.nonceStr?.trim()
  const serial = input.serial?.trim()
  if (!signature || !timestamp || !nonceStr || !serial) {
    return { ok: false, reason: 'missing_headers' }
  }
  if (!/^[0-9]{1,20}$/u.test(timestamp)) {
    return { ok: false, reason: 'invalid_timestamp' }
  }
  const timestampSeconds = Number(timestamp)
  const nowSeconds = Math.floor(input.now.getTime() / 1_000)
  const tolerance = input.toleranceSeconds ?? WECHATPAY_RESPONSE_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }
  if (serial !== input.expectedSerial.trim()) {
    return { ok: false, reason: 'serial_mismatch' }
  }
  const message = buildWechatPayResponseSignatureMessage(timestamp, nonceStr, input.body)
  try {
    const ok = verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      input.platformPublicKey,
      Buffer.from(signature, 'base64'),
    )
    return ok ? { ok: true } : { ok: false, reason: 'invalid_signature' }
  } catch {
    return { ok: false, reason: 'invalid_signature' }
  }
}
