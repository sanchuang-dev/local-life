import { randomUUID } from 'node:crypto'
import { desc, eq, inArray } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  resolveWechatAdminConfigState,
  wechatConfigFailureCodeSchema,
  type ApiErrorCode,
  type WechatAccountType,
  type WechatAdminConfigResponse,
  type WechatConfigFailureCode,
  type WechatConfigStatus,
  type WechatConfigSummary,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { wechatOauthConfigs } from '../db/schema.js'
import type { EncryptedWechatSecret } from './crypto.js'

/**
 * Persistence for the versioned WeChat public-account configuration (#113).
 *
 * Invariants owned here (and enforced a second time by migration 0010):
 * 1. Saving a candidate never touches the active row — a typo cannot break a
 *    working OAuth deployment.
 * 2. At most one `active` row. Activation retires the previous active row and
 *    promotes the candidate inside ONE transaction, so no reader can observe a
 *    moment with zero or two providers.
 * 3. Every non-active candidate is retired when a newer candidate is saved, so
 *    "the current candidate" is unambiguous.
 * 4. No function in this module returns or serializes `app_secret_ciphertext`,
 *    `iv`, `tag` or a plaintext secret. {@link toWechatConfigSummary} is the
 *    only mapper used for responses, and it selects the non-secret columns.
 */

export type WechatConfigRow = typeof wechatOauthConfigs.$inferSelect

type WechatTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

/** Statuses that represent "the candidate an operator is preparing". */
const CANDIDATE_STATUSES: WechatConfigStatus[] = ['draft', 'verified', 'failed']

/**
 * Repository-level failure with a stable API error code. Routes (T2) translate
 * it into the standard `{ error: { code, message, requestId } }` envelope.
 */
export class WechatConfigError extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'WechatConfigError'
    this.code = code
  }
}

function isoOrNull(timestamp: Date | null): string | null {
  return timestamp === null ? null : timestamp.toISOString()
}

function toFailureCode(raw: string | null): WechatConfigFailureCode | null {
  if (raw === null) return null
  // Stored text is mapped through the shared enum. An unknown value (e.g. a
  // code removed from the contract) degrades to `unknown` instead of throwing,
  // so reading a config list can never 500 because of one bad error label.
  const parsed = wechatConfigFailureCodeSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'unknown'
}

/**
 * The ONLY response-facing projection. It deliberately omits every encryption
 * column; adding one here is the only way a secret could ever reach a client.
 */
export function toWechatConfigSummary(row: WechatConfigRow): WechatConfigSummary {
  return {
    id: row.id,
    appId: row.appId,
    accountType: row.accountType,
    status: row.status,
    keyId: row.keyId,
    lastErrorCode: toFailureCode(row.lastErrorCode),
    verifiedAt: isoOrNull(row.verifiedAt),
    activatedAt: isoOrNull(row.activatedAt),
    retiredAt: isoOrNull(row.retiredAt),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/* ------------------------------- Read paths ------------------------------- */

export function findWechatConfigById(
  db: AppDatabase,
  configId: string,
): WechatConfigRow | undefined {
  return db.select().from(wechatOauthConfigs).where(eq(wechatOauthConfigs.id, configId)).get()
}

/** The single runtime provider, or `undefined` when nothing is enabled yet. */
export function findActiveWechatConfig(db: AppDatabase): WechatConfigRow | undefined {
  return db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.status, 'active'))
    .get()
}

/**
 * Newest version still being prepared (`draft`/`verified`/`failed`). Retired
 * rows are history and never become the candidate again, so "verify" can never
 * silently act on a superseded credential.
 */
export function findLatestWechatConfigCandidate(
  db: AppDatabase,
): WechatConfigRow | undefined {
  return db
    .select()
    .from(wechatOauthConfigs)
    .where(inArray(wechatOauthConfigs.status, CANDIDATE_STATUSES))
    .orderBy(desc(wechatOauthConfigs.createdAt), desc(wechatOauthConfigs.id))
    .limit(1)
    .get()
}

/** Newest versions first, active and retired included (admin history view). */
export function listRecentWechatConfigs(
  db: AppDatabase,
  limit = 20,
): WechatConfigRow[] {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 50)
  return db
    .select()
    .from(wechatOauthConfigs)
    .orderBy(desc(wechatOauthConfigs.createdAt), desc(wechatOauthConfigs.id))
    .limit(bounded)
    .all()
}

/* ------------------------------- Write paths ------------------------------ */

export interface SaveWechatConfigCandidateInput {
  appId: string
  accountType: WechatAccountType
  /** Already encrypted by `encryptWechatSecret`; this module never sees plaintext. */
  encrypted: EncryptedWechatSecret
  createdByUserId: string | null
  now?: Date
}

/**
 * Store a new candidate version.
 *
 * A single transaction retires every previous non-active candidate and inserts
 * the new draft. The active provider is deliberately untouched, so saving an
 * unverified credential cannot disable resident login.
 */
export function saveWechatConfigCandidate(
  db: AppDatabase,
  input: SaveWechatConfigCandidateInput,
): WechatConfigSummary {
  const now = input.now ?? new Date()
  return db.transaction((tx) => {
    tx.update(wechatOauthConfigs)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(inArray(wechatOauthConfigs.status, CANDIDATE_STATUSES))
      .run()

    const id = randomUUID()
    tx.insert(wechatOauthConfigs)
      .values({
        id,
        appId: input.appId,
        accountType: input.accountType,
        appSecretCiphertext: input.encrypted.ciphertext,
        appSecretIv: input.encrypted.iv,
        appSecretTag: input.encrypted.tag,
        keyId: input.encrypted.keyId,
        status: 'draft',
        lastErrorCode: null,
        verifiedAt: null,
        activatedAt: null,
        retiredAt: null,
        createdByUserId: input.createdByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const row = tx
      .select()
      .from(wechatOauthConfigs)
      .where(eq(wechatOauthConfigs.id, id))
      .get()
    if (!row) {
      throw new WechatConfigError(API_ERROR_CODES.internal, '公众号配置保存后无法读取')
    }
    return toWechatConfigSummary(row)
  })
}

function requireWechatConfigRow(tx: WechatTransaction, configId: string): WechatConfigRow {
  const row = tx
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, configId))
    .get()
  if (!row) throw new WechatConfigError(API_ERROR_CODES.notFound, '公众号配置不存在')
  return row
}

/**
 * Record a REAL successful verification. Verification is only meaningful for a
 * version still being prepared; an active or retired version is rejected so a
 * live provider cannot be mutated by a stale admin tab.
 */
export function markWechatConfigVerified(
  db: AppDatabase,
  configId: string,
  options: { now?: Date } = {},
): WechatConfigSummary {
  const now = options.now ?? new Date()
  return db.transaction((tx) => {
    const row = requireWechatConfigRow(tx, configId)
    if (!CANDIDATE_STATUSES.includes(row.status)) {
      throw new WechatConfigError(
        API_ERROR_CODES.conflict,
        '已启用或已停用的公众号配置不能再验证',
      )
    }
    tx.update(wechatOauthConfigs)
      .set({
        status: 'verified',
        verifiedAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(eq(wechatOauthConfigs.id, configId))
      .run()
    return toWechatConfigSummary(requireWechatConfigRow(tx, configId))
  })
}

/**
 * Record a failed verification on the candidate. The active provider is never
 * touched: a wrong credential typed into the admin form must leave resident
 * OAuth working. `verifiedAt` is cleared because the CHECK constraint requires
 * `failed` rows to carry no verification stamp.
 */
export function markWechatConfigFailed(
  db: AppDatabase,
  configId: string,
  failureCode: WechatConfigFailureCode,
  options: { now?: Date } = {},
): WechatConfigSummary {
  const now = options.now ?? new Date()
  return db.transaction((tx) => {
    const row = requireWechatConfigRow(tx, configId)
    if (!CANDIDATE_STATUSES.includes(row.status)) {
      throw new WechatConfigError(
        API_ERROR_CODES.conflict,
        '已启用或已停用的公众号配置不能记录验证失败',
      )
    }
    tx.update(wechatOauthConfigs)
      .set({
        status: 'failed',
        lastErrorCode: failureCode,
        verifiedAt: null,
        updatedAt: now,
      })
      .where(eq(wechatOauthConfigs.id, configId))
      .run()
    return toWechatConfigSummary(requireWechatConfigRow(tx, configId))
  })
}

export interface ActivateWechatConfigResult {
  active: WechatConfigSummary
  /** The provider retired by this switch, or null when nothing was active. */
  previous: WechatConfigSummary | null
}

/**
 * Activate one verified version.
 *
 * The whole switch is one transaction: old active -> retired, candidate ->
 * active. The partial unique index on `status = 'active'` is the final guard, so
 * even two concurrent activations cannot both succeed. Activating the already
 * active version is a no-op success (idempotent, never retires itself).
 */
export function activateWechatConfig(
  db: AppDatabase,
  configId: string,
  options: { now?: Date } = {},
): ActivateWechatConfigResult {
  const now = options.now ?? new Date()
  return db.transaction((tx) => {
    const candidate = requireWechatConfigRow(tx, configId)

    if (candidate.status === 'active') {
      return { active: toWechatConfigSummary(candidate), previous: null }
    }
    if (candidate.status !== 'verified') {
      throw new WechatConfigError(
        API_ERROR_CODES.wechatConfigNotVerified,
        '公众号配置尚未验证通过，不能启用',
      )
    }

    const previousRow = tx
      .select()
      .from(wechatOauthConfigs)
      .where(eq(wechatOauthConfigs.status, 'active'))
      .get()

    if (previousRow) {
      tx.update(wechatOauthConfigs)
        .set({ status: 'retired', retiredAt: now, updatedAt: now })
        .where(eq(wechatOauthConfigs.id, previousRow.id))
        .run()
    }

    tx.update(wechatOauthConfigs)
      .set({
        status: 'active',
        activatedAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(eq(wechatOauthConfigs.id, configId))
      .run()

    // Re-read both rows after the writes: the previously selected `previousRow`
    // still carries `status = 'active'` and must not be reported as such.
    return {
      active: toWechatConfigSummary(requireWechatConfigRow(tx, configId)),
      previous: previousRow
        ? toWechatConfigSummary(requireWechatConfigRow(tx, previousRow.id))
        : null,
    }
  })
}

/* ------------------------------ Admin summary ----------------------------- */

export interface WechatAdminConfigOptions {
  /** Whether the server holds a usable master key (never the key itself). */
  masterKeyAvailable: boolean
  /** Configured master-key generation id; a non-secret label. */
  keyId: string
  /** Read-only callback URL derived from the approved resident web origin. */
  redirectUri: string
  recentLimit?: number
}

/**
 * Build `GET /admin/wechat/config`. `state` is derived from the same rows that
 * are returned, so the badge and the list can never disagree.
 */
export function getWechatAdminConfigResponse(
  db: AppDatabase,
  options: WechatAdminConfigOptions,
): WechatAdminConfigResponse {
  const activeRow = findActiveWechatConfig(db)
  const candidateRow = findLatestWechatConfigCandidate(db)
  const active = activeRow ? toWechatConfigSummary(activeRow) : null
  const candidate = candidateRow ? toWechatConfigSummary(candidateRow) : null

  return {
    state: resolveWechatAdminConfigState(active, candidate),
    active,
    candidate,
    recent: listRecentWechatConfigs(db, options.recentLimit ?? 20).map(toWechatConfigSummary),
    masterKeyAvailable: options.masterKeyAvailable,
    keyId: options.keyId,
    redirectUri: options.redirectUri,
  }
}
