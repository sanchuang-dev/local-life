import type { WechatAccountType, WechatConfigStatus } from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  WechatSecretError,
  decryptWechatSecret,
  type WechatSecretMasterKey,
} from './crypto.js'
import { findActiveWechatConfig, findWechatConfigById } from './repository.js'

/**
 * Runtime resolution primitive for the persisted WeChat provider (#113).
 *
 * This is the single read path T2/T3 reuse: the admin "verify" flow resolves the
 * candidate it just saved, `/auth/methods` asks whether a usable provider
 * exists, `/auth/wechat/start` pins the exact config version into the OAuth
 * state, and the callback resolves that same version instead of whatever is
 * active at callback time.
 *
 * The function NEVER throws for an unusable configuration — it returns a
 * discriminable failure so callers can answer 503/401/retry without ever
 * treating an undecryptable row as a working provider. Only unexpected database
 * errors propagate.
 *
 * The returned `appSecret` is plaintext in memory by necessity. It must never be
 * logged, serialized into a DTO, written to an audit row or included in an
 * error. `WechatRuntimeConfig` is intentionally not part of `packages/contracts`.
 */

export type WechatRuntimeFailureReason =
  | 'not_configured'
  | 'config_missing'
  | 'master_key_unavailable'
  | 'master_key_invalid'
  | 'decrypt_failed'

export interface WechatRuntimeConfig {
  configId: string
  /** Changes on activation/retirement, including re-activating an earlier row. */
  revision: number
  appId: string
  accountType: WechatAccountType
  /** Plaintext AppSecret. In-memory only; never serialize. */
  appSecret: string
  keyId: string
  /**
   * Lifecycle status of the row that was resolved. A version resolved by id may
   * be `retired` (an in-flight OAuth attempt must still be decidable); callers
   * compare `configId` with the currently active row to enforce the switch rule.
   */
  status: WechatConfigStatus
}

export type WechatRuntimeResolution =
  | { ok: true; config: WechatRuntimeConfig }
  | {
      ok: false
      reason: WechatRuntimeFailureReason
      /** The row that failed, when one was found. Never contains a secret. */
      configId: string | null
    }

export interface WechatRuntimeOptions {
  /** Resolve this exact version instead of the active one (OAuth binding). */
  configId?: string
}

/**
 * Resolve the active provider, or the explicitly requested config version.
 *
 * Fail-closed cases:
 * - no active row and no requested id -> `not_configured`
 * - requested id does not exist -> `config_missing`
 * - no master key loaded -> `master_key_unavailable`
 * - supplied key has the wrong shape -> `master_key_invalid`
 * - key id mismatch / tampered payload / wrong AAD / wrong key -> `decrypt_failed`
 */
export function resolveWechatRuntimeConfig(
  db: AppDatabase,
  masterKey: WechatSecretMasterKey | null | undefined,
  options: WechatRuntimeOptions = {},
): WechatRuntimeResolution {
  const row = options.configId
    ? findWechatConfigById(db, options.configId)
    : findActiveWechatConfig(db)

  if (!row) {
    return {
      ok: false,
      reason: options.configId ? 'config_missing' : 'not_configured',
      configId: null,
    }
  }
  if (!masterKey) {
    return { ok: false, reason: 'master_key_unavailable', configId: row.id }
  }

  try {
    const appSecret = decryptWechatSecret(
      {
        ciphertext: row.appSecretCiphertext,
        iv: row.appSecretIv,
        tag: row.appSecretTag,
        keyId: row.keyId,
      },
      { appId: row.appId, accountType: row.accountType },
      masterKey,
    )
    return {
      ok: true,
      config: {
        configId: row.id,
        revision: row.updatedAt.getTime(),
        appId: row.appId,
        accountType: row.accountType,
        appSecret,
        keyId: row.keyId,
        status: row.status,
      },
    }
  } catch (error) {
    if (error instanceof WechatSecretError) {
      return {
        ok: false,
        reason: error.code === 'invalid_key' ? 'master_key_invalid' : 'decrypt_failed',
        configId: row.id,
      }
    }
    throw error
  }
}
