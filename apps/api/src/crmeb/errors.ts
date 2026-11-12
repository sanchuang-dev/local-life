import { API_ERROR_CODES, type ApiErrorCode } from '@sanchuang-dev/local-life-contracts'
import type { HttpErrorStatus } from '../http.js'
import { CrmebClientError } from './client.js'

/** Domain failure raised by CRMEB adapter services and translated by the routes. */
export class CrmebDomainError extends Error {
  readonly status: 400 | 403 | 404 | 409
  readonly code: ApiErrorCode

  constructor(status: 400 | 403 | 404 | 409, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'CrmebDomainError'
    this.status = status
    this.code = code
  }
}

export interface CrmebHttpFailure {
  status: HttpErrorStatus
  code: ApiErrorCode
  message: string
}

/**
 * Maps an adapter/client failure to the shared error envelope. Upstream auth and
 * permission problems are server-side configuration failures, so they are never
 * reported as a resident 401/403; the browser must not learn anything about the
 * CRMEB account. No message ever contains a token, appsecret or upstream body.
 */
export function toCrmebHttpFailure(error: unknown): CrmebHttpFailure | null {
  if (error instanceof CrmebDomainError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (!(error instanceof CrmebClientError)) return null

  switch (error.kind) {
    case 'not_configured':
      return {
        status: 503,
        code: API_ERROR_CODES.notConfigured,
        message: 'CRMEB 商城未配置，真实商品与订单能力不可用',
      }
    case 'unauthorized':
      return {
        status: 503,
        code: API_ERROR_CODES.crmebUpstreamError,
        message: 'CRMEB outapi 鉴权失败，请检查服务端 appid/appsecret 配置',
      }
    case 'forbidden':
      return {
        status: 503,
        code: API_ERROR_CODES.crmebUpstreamError,
        message: error.message,
      }
    case 'not_found':
      return { status: 404, code: API_ERROR_CODES.notFound, message: error.message }
    case 'rate_limited':
      return {
        status: 503,
        code: API_ERROR_CODES.crmebUpstreamError,
        message: 'CRMEB outapi 暂时限流，请稍后重试',
      }
    case 'timeout':
      return {
        status: 503,
        code: API_ERROR_CODES.crmebTimeout,
        message: 'CRMEB 商城响应超时，请稍后重试',
      }
    case 'contract_mismatch':
      return {
        status: 503,
        code: API_ERROR_CODES.crmebContractMismatch,
        message: error.message,
      }
    case 'upstream_error':
      return {
        status: 503,
        code: API_ERROR_CODES.crmebUpstreamError,
        message: error.message,
      }
  }
}
