import { randomBytes } from 'node:crypto'
import type { WechatAccountType, WechatConfigSummary } from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../src/db/client.js'
import { encryptWechatSecret } from '../src/wechat/crypto.js'
import {
  activateWechatConfig,
  markWechatConfigFailed,
  markWechatConfigVerified,
  saveWechatConfigCandidate,
} from '../src/wechat/repository.js'

/**
 * Shared test fixture for the persisted WeChat provider (#113 T3).
 *
 * The runtime configuration lives in SQLite and is encrypted with an AES-256
 * key that only exists in the environment. Tests therefore cannot configure
 * OAuth through env any more: they create a migrated database, seed an
 * encrypted row and give the app the matching master key. The key material is
 * generated per test process and never written to the repository.
 */

/** 32 random bytes, loaded into the app through `masterKeyEnv()`. */
export const TEST_MASTER_KEY = {
  key: randomBytes(32),
  keyId: 'test-key-1',
}

/** Public-account AppID shape: `wx` + 16 alphanumerics. */
export const TEST_APP_ID = 'wx1234567890abcdef'
export const TEST_APP_SECRET = 'test-wechat-secret-a-0123456789'
/** A second account, used to prove a switch never mixes identities. */
export const TEST_APP_ID_B = 'wxfedcba0987654321'
export const TEST_APP_SECRET_B = 'test-wechat-secret-b-9876543210'

export const TEST_ACCOUNT_TYPE: WechatAccountType = 'official'

/** Env fragment that gives `loadConfig` the matching master key. */
export function masterKeyEnv(): Record<string, string> {
  return {
    WECHAT_CONFIG_MASTER_KEY: TEST_MASTER_KEY.key.toString('base64'),
    WECHAT_CONFIG_KEY_ID: TEST_MASTER_KEY.keyId,
  }
}

export type SeedWechatStatus = 'draft' | 'verified' | 'failed' | 'active'

export interface SeedWechatOptions {
  appId?: string
  appSecret?: string
  accountType?: WechatAccountType
  status?: SeedWechatStatus
  createdByUserId?: string | null
}

/**
 * Persist one encrypted provider version and bring it to the requested state
 * through the real repository transitions (save -> verify -> activate).
 */
export function seedWechatConfig(
  db: AppDatabase,
  options: SeedWechatOptions = {},
): WechatConfigSummary {
  const appId = options.appId ?? TEST_APP_ID
  const appSecret = options.appSecret ?? TEST_APP_SECRET
  const accountType = options.accountType ?? TEST_ACCOUNT_TYPE
  const target = options.status ?? 'active'

  const created = saveWechatConfigCandidate(db, {
    appId,
    accountType,
    encrypted: encryptWechatSecret(appSecret, { appId, accountType }, TEST_MASTER_KEY),
    createdByUserId: options.createdByUserId ?? null,
  })
  if (target === 'draft') return created
  if (target === 'failed') {
    return markWechatConfigFailed(db, created.id, 'invalid_app_secret')
  }

  const verified = markWechatConfigVerified(db, created.id)
  if (target === 'verified') return verified
  return activateWechatConfig(db, verified.id).active
}
