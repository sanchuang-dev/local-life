import { randomUUID } from 'node:crypto'
import {
  API_ERROR_CODES,
  wechatAdminConfigResponseSchema,
  type ApiErrorCode,
  type SaveWechatConfigRequest,
  type WechatAdminConfigResponse,
  type WechatConfigFailureCode,
  type WechatConfigSummary,
} from '@sanchuang-dev/local-life-contracts'
import { wechatCallbackUrl } from '../auth/oauth-return.js'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import { auditLogs } from '../db/schema.js'
import type { HttpErrorStatus } from '../http.js'
import {
  decryptWechatSecret,
  encryptWechatSecret,
  WechatSecretError,
  type WechatSecretMasterKey,
} from './crypto.js'
import {
  activateWechatConfig,
  findWechatConfigById,
  getWechatAdminConfigResponse,
  markWechatConfigFailed,
  markWechatConfigVerified,
  saveWechatConfigCandidate,
  toWechatConfigSummary,
  WechatConfigError,
  type WechatConfigRow,
} from './repository.js'
import { resolveWechatRuntimeConfig, type WechatRuntimeOptions } from './runtime.js'
import { verifyWechatCredentials } from './verify.js'

/**
 * Admin-facing use cases for the WeChat public-account configuration (#113 T2).
 *
 * This layer owns the rules that must not be re-implemented per route:
 *
 * 1. **No master key -> no writes.** Saving or verifying without the server-side
 *    encryption key answers 503 `wechat_config_master_key_unavailable` instead
 *    of storing plaintext or pretending success.
 * 2. **Saving never touches the active provider.** The repository retires only
 *    candidate versions, so a typo cannot break resident OAuth.
 * 3. **Verification is real and redacted.** The injected `fetch` is called for
 *    the stored candidate; only the redacted failure code/message survives.
 *    `access_token` never leaves the verify module.
 * 4. **Activation is explicit, optimistic and atomic.** The caller must present
 *    the exact `expectedUpdatedAt` it saw (a stale tab cannot promote a changed
 *    candidate) and `confirm: true`; only a `verified` row can be promoted, and
 *    the switch runs inside the repository transaction.
 * 5. **Undecryptable rows fail closed.** They are never activated and the status
 *    endpoint reports a safe error code instead of 500.
 * 6. **Audit rows carry no secret material.** Only AppID (a public identifier),
 *    account type, lifecycle status and the redacted failure code.
 */

/** An API error with the HTTP status and shared envelope code the route sends. */
export class WechatAdminError extends Error {
  readonly status: HttpErrorStatus
  readonly code: ApiErrorCode

  constructor(status: HttpErrorStatus, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'WechatAdminError'
    this.status = status
    this.code = code
  }
}

/** Verification failed after a real WeChat call; carries the redacted code. */
export class WechatVerifyError extends WechatAdminError {
  readonly failureCode: WechatConfigFailureCode

  constructor(failureCode: WechatConfigFailureCode, message: string) {
    super(verifyFailureStatus(failureCode), API_ERROR_CODES.wechatConfigVerifyFailed, message)
    this.name = 'WechatVerifyError'
    this.failureCode = failureCode
  }
}

/** Transient provider/transport problems are 503; rate limiting is 429. */
function verifyFailureStatus(code: WechatConfigFailureCode): HttpErrorStatus {
  if (code === 'rate_limited') return 429
  if (code === 'timeout' || code === 'network_error' || code === 'wechat_api_error') return 503
  return 409
}

function statusForRepositoryError(code: ApiErrorCode): HttpErrorStatus {
  switch (code) {
    case API_ERROR_CODES.notFound:
      return 404
    case API_ERROR_CODES.conflict:
    case API_ERROR_CODES.wechatConfigNotVerified:
      return 409
    case API_ERROR_CODES.wechatConfigVerifyFailed:
      return 409
    case API_ERROR_CODES.wechatConfigMasterKeyUnavailable:
      return 503
    case API_ERROR_CODES.wechatConfigDecryptFailed:
      return 409
    default:
      return 500
  }
}

/** Convert a repository failure into its HTTP form without leaking details. */
function translateRepositoryError(error: unknown): never {
  if (error instanceof WechatConfigError) {
    throw new WechatAdminError(
      statusForRepositoryError(error.code),
      error.code,
      error.message,
    )
  }
  throw error
}

export interface WechatAdminServiceDeps {
  db: AppDatabase
  config: ApiConfig
  fetcher: typeof fetch
  /** Runtime reader built once in `createApp`; never a startup config snapshot. */
  resolveRuntime: (options?: WechatRuntimeOptions) => ReturnType<typeof resolveWechatRuntimeConfig>
  /** Injectable clock so tests can assert audit/verification timestamps. */
  now?: () => Date
}

/**
 * AppID format enforced by the admin surface: `wx` + 16 alphanumerics. The
 * shared DTO already bounds the length/alphabet; this is the stricter
 * public-account shape the task requires (WeChat official and interface-test
 * accounts both use it). It is a business rule, not a second DTO.
 */
const WECHAT_APP_ID_PATTERN = /^wx[A-Za-z0-9]{16}$/u

export function assertWechatAppId(appId: string): void {
  if (!WECHAT_APP_ID_PATTERN.test(appId)) {
    throw new WechatAdminError(
      400,
      API_ERROR_CODES.wechatConfigInvalid,
      'AppID 格式不正确：应为 wx 开头的 18 位字母数字（如 wx1234567890abcdef）',
    )
  }
}

function requireMasterKey(config: ApiConfig): WechatSecretMasterKey {
  const masterKey = config.wechatConfigMasterKey
  if (!masterKey) {
    throw new WechatAdminError(
      503,
      API_ERROR_CODES.wechatConfigMasterKeyUnavailable,
      '服务端未配置公众号凭证加密主密钥，暂时无法保存或验证配置',
    )
  }
  return masterKey
}

/**
 * The read-only callback URL derived from the approved resident web origin.
 * Both the admin status response and the resident OAuth start use the single
 * derivation in `auth/oauth-return.ts`, so they can never drift apart.
 */
export function wechatAdminCallbackUrl(config: ApiConfig): string {
  return wechatCallbackUrl(config.webBaseUrl)
}

function recordWechatAudit(
  db: AppDatabase,
  actorUserId: string,
  event: string,
  targetId: string,
  metadata: Record<string, string>,
  now: Date,
): void {
  db.insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId,
      event,
      targetId,
      metadata: JSON.stringify(metadata),
      createdAt: now,
    })
    .run()
}

function nowOf(deps: WechatAdminServiceDeps): Date {
  return deps.now?.() ?? new Date()
}

/**
 * `GET /admin/wechat/config`.
 *
 * The runtime reader is asked whether the active row is actually usable. A
 * missing master key or an undecryptable ciphertext is reported as a safe
 * `lastErrorCode` on the active summary, so the UI can render "已启用但不可用"
 * without the endpoint ever answering 500 or claiming success. The projection
 * is response-only: the database row is not mutated by a read.
 */
export function buildWechatAdminConfig(deps: WechatAdminServiceDeps): WechatAdminConfigResponse {
  const masterKey = deps.config.wechatConfigMasterKey
  const response = getWechatAdminConfigResponse(deps.db, {
    masterKeyAvailable: Boolean(masterKey),
    keyId: masterKey?.keyId ?? 'v1',
    redirectUri: wechatAdminCallbackUrl(deps.config),
  })

  const resolution = deps.resolveRuntime()
  if (!resolution.ok && response.active) {
    const failure: WechatConfigFailureCode =
      resolution.reason === 'master_key_unavailable' ? 'master_key_unavailable' : 'decrypt_failed'
    response.active = { ...response.active, lastErrorCode: failure }
  }

  return wechatAdminConfigResponseSchema.parse(response)
}

/**
 * `POST /admin/wechat/config/candidates`.
 *
 * The plaintext AppSecret exists only for the duration of the encryption call;
 * the repository receives base64 ciphertext and the response is a summary that
 * has no secret field at all.
 */
export function saveWechatCandidate(
  deps: WechatAdminServiceDeps,
  input: SaveWechatConfigRequest,
  actorUserId: string,
): WechatConfigSummary {
  const masterKey = requireMasterKey(deps.config)
  assertWechatAppId(input.appId)

  const encrypted = encryptWechatSecret(
    input.appSecret,
    { appId: input.appId, accountType: input.accountType },
    masterKey,
  )
  const summary = saveWechatConfigCandidate(deps.db, {
    appId: input.appId,
    accountType: input.accountType,
    encrypted,
    createdByUserId: actorUserId,
    now: nowOf(deps),
  })

  recordWechatAudit(
    deps.db,
    actorUserId,
    'wechat.config.saved',
    summary.id,
    { appId: summary.appId, accountType: summary.accountType, status: summary.status },
    nowOf(deps),
  )
  return summary
}

/** Reject a stale admin tab: the caller must echo the version it last saw. */
function assertExpectedUpdatedAt(row: WechatConfigRow, expectedUpdatedAt: string): void {
  if (row.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
    throw new WechatAdminError(
      409,
      API_ERROR_CODES.conflict,
      '配置已被其他操作更新，请刷新后重试',
    )
  }
}

function requireCandidateRow(deps: WechatAdminServiceDeps, configId: string): WechatConfigRow {
  const row = findWechatConfigById(deps.db, configId)
  if (!row) {
    throw new WechatAdminError(404, API_ERROR_CODES.notFound, '公众号配置不存在')
  }
  if (row.status === 'active' || row.status === 'retired') {
    throw new WechatAdminError(
      409,
      API_ERROR_CODES.conflict,
      '已启用或已停用的公众号配置不能再验证',
    )
  }
  return row
}

/** Repository write wrappers that translate failures into API errors. */
function markVerifiedOrThrow(
  deps: WechatAdminServiceDeps,
  configId: string,
): WechatConfigSummary {
  try {
    return markWechatConfigVerified(deps.db, configId, { now: nowOf(deps) })
  } catch (error) {
    translateRepositoryError(error)
  }
}

function promoteOrThrow(
  deps: WechatAdminServiceDeps,
  configId: string,
): ReturnType<typeof activateWechatConfig> {
  try {
    return activateWechatConfig(deps.db, configId, { now: nowOf(deps) })
  } catch (error) {
    translateRepositoryError(error)
  }
}

/**
 * `POST /admin/wechat/config/:configId/verify`.
 *
 * A real provider call decides the outcome. On any failure the candidate is
 * marked `failed` with the redacted code and the route answers a 409/429/503
 * with an actionable message; the active provider is untouched because the
 * repository only ever mutates candidate rows.
 */
export async function verifyWechatCandidate(
  deps: WechatAdminServiceDeps,
  configId: string,
  expectedUpdatedAt: string,
  actorUserId: string,
): Promise<WechatConfigSummary> {
  const masterKey = requireMasterKey(deps.config)
  const row = requireCandidateRow(deps, configId)
  assertExpectedUpdatedAt(row, expectedUpdatedAt)

  let appSecret: string
  try {
    appSecret = decryptWechatSecret(
      {
        ciphertext: row.appSecretCiphertext,
        iv: row.appSecretIv,
        tag: row.appSecretTag,
        keyId: row.keyId,
      },
      { appId: row.appId, accountType: row.accountType },
      masterKey,
    )
  } catch (error) {
    if (!(error instanceof WechatSecretError)) throw error
    try {
      markWechatConfigFailed(deps.db, configId, 'decrypt_failed', { now: nowOf(deps) })
    } catch (markError) {
      translateRepositoryError(markError)
    }
    recordWechatAudit(
      deps.db,
      actorUserId,
      'wechat.config.verify_failed',
      configId,
      { appId: row.appId, accountType: row.accountType, errorCode: 'decrypt_failed' },
      nowOf(deps),
    )
    throw new WechatAdminError(
      409,
      API_ERROR_CODES.wechatConfigDecryptFailed,
      '已保存的 AppSecret 无法解密，请重新保存凭证后再验证',
    )
  }

  const outcome = await verifyWechatCredentials(deps.fetcher, {
    appId: row.appId,
    appSecret,
  })

  if (outcome.ok) {
    const summary = markVerifiedOrThrow(deps, configId)
    recordWechatAudit(
      deps.db,
      actorUserId,
      'wechat.config.verify_succeeded',
      summary.id,
      { appId: summary.appId, accountType: summary.accountType },
      nowOf(deps),
    )
    return summary
  }

  try {
    markWechatConfigFailed(deps.db, configId, outcome.code, { now: nowOf(deps) })
  } catch (error) {
    translateRepositoryError(error)
  }
  recordWechatAudit(
    deps.db,
    actorUserId,
    'wechat.config.verify_failed',
    configId,
    { appId: row.appId, accountType: row.accountType, errorCode: outcome.code },
    nowOf(deps),
  )
  throw new WechatVerifyError(outcome.code, outcome.message)
}

/**
 * `POST /admin/wechat/config/:configId/activate`.
 *
 * Preconditions proven here: the caller saw the current version, the row is
 * `verified`, and the stored ciphertext still decrypts with the configured key
 * (so activation can never make the runtime unusable). The actual switch is the
 * repository transaction: previous active -> retired, candidate -> active, with
 * the partial unique index as the final guard.
 */
export function activateWechatCandidate(
  deps: WechatAdminServiceDeps,
  configId: string,
  expectedUpdatedAt: string,
  actorUserId: string,
): { active: WechatConfigSummary; previous: WechatConfigSummary | null } {
  const row = findWechatConfigById(deps.db, configId)
  if (!row) {
    throw new WechatAdminError(404, API_ERROR_CODES.notFound, '公众号配置不存在')
  }
  // A repeat activation is a no-op only when the existing provider is
  // actually usable. Returning 200 for an active row whose key is missing or
  // ciphertext is corrupt would falsely report success while OAuth is broken.
  const alreadyActive = row.status === 'active'
  if (!alreadyActive) {
    assertExpectedUpdatedAt(row, expectedUpdatedAt)
    if (row.status !== 'verified') {
      throw new WechatAdminError(
        409,
        API_ERROR_CODES.wechatConfigNotVerified,
        '公众号配置尚未验证通过，不能启用',
      )
    }
  }

  const resolution = deps.resolveRuntime({ configId })
  if (!resolution.ok) {
    if (resolution.reason === 'master_key_unavailable') {
      throw new WechatAdminError(
        503,
        API_ERROR_CODES.wechatConfigMasterKeyUnavailable,
        '服务端未配置公众号凭证加密主密钥，不能启用配置',
      )
    }
    throw new WechatAdminError(
      409,
      API_ERROR_CODES.wechatConfigDecryptFailed,
      '该配置的 AppSecret 无法用当前主密钥解密，已拒绝启用并保留原启用配置',
    )
  }

  // A healthy active row is idempotent; no write or duplicate audit.
  if (alreadyActive) {
    return { active: toWechatConfigSummary(row), previous: null }
  }

  const result = promoteOrThrow(deps, configId)

  recordWechatAudit(
    deps.db,
    actorUserId,
    'wechat.config.activated',
    result.active.id,
    {
      appId: result.active.appId,
      accountType: result.active.accountType,
      ...(result.previous ? { previousAppId: result.previous.appId } : {}),
    },
    nowOf(deps),
  )
  return result
}
