import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import type { WechatAccountType, WechatConfigSummary } from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import { users, wechatOauthConfigs } from '../src/db/schema.js'
import {
  encryptWechatSecret,
  type WechatSecretMasterKey,
} from '../src/wechat/crypto.js'
import {
  WechatConfigError,
  activateWechatConfig,
  findActiveWechatConfig,
  findLatestWechatConfigCandidate,
  findWechatConfigById,
  getWechatAdminConfigResponse,
  markWechatConfigFailed,
  markWechatConfigVerified,
  saveWechatConfigCandidate,
  type SaveWechatConfigCandidateInput,
} from '../src/wechat/repository.js'
import { resolveWechatRuntimeConfig } from '../src/wechat/runtime.js'

/**
 * Migration + persistence + runtime-resolution evidence for #113 LL-SYS-001.
 *
 * Keys are generated per test run with `randomBytes`. The fake AppSecret below is
 * obviously not a credential and never enters an assertion message or a file.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const APP_ID = 'wx0123456789abcdef'
const OTHER_APP_ID = 'wxffffffffffffffff'
/** Clearly fake; never a real WeChat AppSecret. */
const FAKE_APP_SECRET = 'fake-wechat-app-secret-for-db-tests'

const MASTER_KEY: WechatSecretMasterKey = { key: randomBytes(32), keyId: 'v1' }
const OTHER_MASTER_KEY: WechatSecretMasterKey = { key: randomBytes(32), keyId: 'v1' }

let clock = Date.parse('2026-02-01T00:00:00.000Z')
function nextTime(): Date {
  clock += 1_000
  return new Date(clock)
}

interface SqliteTestContext {
  db: AppDatabase
  sqlite: SqliteConnection
}

function withDatabase(run: (context: SqliteTestContext) => void): void {
  const context = createDatabase(':memory:', migrationsFolder)
  try {
    run(context)
  } finally {
    context.sqlite.close()
  }
}

interface TableInfoRow {
  name: string
  notnull: number
  dflt_value: string | null
}

interface IndexListRow {
  name: string
  unique: number
  partial: number
}

interface ForeignKeyRow {
  table: string
  from: string
  to: string
  on_delete: string
}

function saveCandidate(
  db: AppDatabase,
  overrides: Partial<
    Pick<SaveWechatConfigCandidateInput, 'appId' | 'accountType' | 'createdByUserId' | 'now'>
  > & { secret?: string; masterKey?: WechatSecretMasterKey } = {},
): WechatConfigSummary {
  const appId = overrides.appId ?? APP_ID
  const accountType: WechatAccountType = overrides.accountType ?? 'test'
  const secret = overrides.secret ?? FAKE_APP_SECRET
  const masterKey = overrides.masterKey ?? MASTER_KEY
  const encrypted = encryptWechatSecret(secret, { appId, accountType }, masterKey)
  return saveWechatConfigCandidate(db, {
    appId,
    accountType,
    encrypted,
    createdByUserId: overrides.createdByUserId ?? null,
    now: overrides.now ?? nextTime(),
  })
}

function seedUser(db: AppDatabase): string {
  const id = randomUUID()
  const now = nextTime()
  db.insert(users).values({ id, displayName: null, createdAt: now, updatedAt: now }).run()
  return id
}

/* ------------------------------- Migrations -------------------------------- */

test('an empty database migrates to the encrypted config schema and single-active index', () => {
  withDatabase(({ sqlite }) => {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    assert.ok(tables.some((table) => table.name === 'wechat_oauth_configs'))

    const columns = sqlite
      .prepare('PRAGMA table_info(wechat_oauth_configs)')
      .all() as TableInfoRow[]
    const names = columns.map((column) => column.name)
    for (const expected of [
      'id',
      'app_id',
      'account_type',
      'app_secret_ciphertext',
      'app_secret_iv',
      'app_secret_tag',
      'key_id',
      'status',
      'last_error_code',
      'verified_at',
      'activated_at',
      'retired_at',
      'created_by_user_id',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(names.includes(expected), `missing column ${expected}`)
    }
    // No plaintext secret column may exist, under any plausible name.
    for (const forbidden of ['app_secret', 'secret', 'plain_secret', 'app_secret_plaintext']) {
      assert.equal(names.includes(forbidden), false, `unexpected plaintext column ${forbidden}`)
    }

    const indexes = sqlite
      .prepare('PRAGMA index_list(wechat_oauth_configs)')
      .all() as IndexListRow[]
    const activeIndex = indexes.find((index) => index.name === 'wechat_oauth_configs_active_uq')
    assert.ok(activeIndex, 'partial unique index wechat_oauth_configs_active_uq is missing')
    assert.equal(activeIndex.unique, 1)
    assert.equal(activeIndex.partial, 1)
    const activeIndexColumns = sqlite
      .prepare('PRAGMA index_info(wechat_oauth_configs_active_uq)')
      .all() as Array<{ name: string }>
    assert.deepEqual(
      activeIndexColumns.map((column) => column.name),
      ['status'],
    )

    const oauthColumns = sqlite
      .prepare('PRAGMA table_info(oauth_states)')
      .all() as TableInfoRow[]
    const configId = oauthColumns.find((column) => column.name === 'config_id')
    assert.ok(configId, 'oauth_states.config_id is missing')
    assert.equal(configId.notnull, 0, 'oauth_states.config_id must be nullable')
    assert.equal(configId.dflt_value, null)
    const purpose = oauthColumns.find((column) => column.name === 'purpose')
    const profileUserId = oauthColumns.find((column) => column.name === 'user_id')
    assert.ok(purpose, 'oauth_states.purpose is missing')
    assert.equal(purpose.notnull, 0, 'legacy OAuth states must keep a nullable purpose')
    assert.ok(profileUserId, 'oauth_states.user_id is missing')
    assert.equal(profileUserId.notnull, 0, 'legacy OAuth states must keep a nullable user binding')

    const identityColumns = sqlite
      .prepare('PRAGMA table_info(wechat_identities)')
      .all() as TableInfoRow[]
    const identityColumnNames = identityColumns.map((column) => column.name)
    for (const expected of ['nickname', 'avatar_url', 'profile_authorized_at']) {
      assert.ok(identityColumnNames.includes(expected), `missing WeChat profile column ${expected}`)
    }
    for (const forbidden of ['sex', 'province', 'city', 'country', 'location']) {
      assert.equal(identityColumnNames.includes(forbidden), false, `unexpected profile column ${forbidden}`)
    }

    const foreignKeys = sqlite
      .prepare('PRAGMA foreign_key_list(oauth_states)')
      .all() as ForeignKeyRow[]
    const configFk = foreignKeys.find((foreignKey) => foreignKey.from === 'config_id')
    assert.ok(configFk, 'oauth_states.config_id has no foreign key')
    assert.equal(configFk.table, 'wechat_oauth_configs')
    assert.equal(configFk.to, 'id')
    assert.equal(configFk.on_delete, 'SET NULL')
    const profileUserFk = foreignKeys.find((foreignKey) => foreignKey.from === 'user_id')
    assert.ok(profileUserFk, 'oauth_states.user_id has no foreign key')
    assert.equal(profileUserFk.table, 'users')
    assert.equal(profileUserFk.to, 'id')
    assert.equal(profileUserFk.on_delete, 'SET NULL')

    const oauthIndexes = sqlite
      .prepare('PRAGMA index_list(oauth_states)')
      .all() as IndexListRow[]
    assert.ok(oauthIndexes.some((index) => index.name === 'oauth_state_config_idx'))
    assert.ok(oauthIndexes.some((index) => index.name === 'oauth_state_user_purpose_idx'))
  })
})

test('a 0011 database upgrades incrementally, preserving legacy login OAuth attempts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'll-wechat-migrate-'))
  try {
    // Stage the complete pre-profile schema (0000..0011).
    const legacyFolder = join(directory, 'migrations-0011')
    mkdirSync(join(legacyFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number }> }
    // Keep the source schema pinned to 0011; the upgrade target follows the full journal.
    const fullJournalCount = journal.entries.length
    journal.entries = journal.entries.filter((entry) => entry.idx <= 11)
    writeFileSync(join(legacyFolder, 'meta', '_journal.json'), JSON.stringify(journal))
    for (const file of readdirSync(migrationsFolder)) {
      if (/^\d{4}_.*\.sql$/u.test(file)) {
        copyFileSync(join(migrationsFolder, file), join(legacyFolder, file))
      }
    }

    const databasePath = join(directory, 'legacy.sqlite')
    const legacy = createDatabase(databasePath, legacyFolder)
    const userId = randomUUID()
    const stateId = randomUUID()
    const now = nextTime()
    try {
      legacy.db
        .insert(users)
        .values({ id: userId, displayName: null, createdAt: now, updatedAt: now })
        .run()
      // Written with raw SQL to model the pre-#121 table. The current Drizzle
      // schema object already includes the new purpose and user_id columns.
      legacy.sqlite
        .prepare(
          `INSERT INTO oauth_states
             (id, state_hash, nonce_hash, community_id, config_id, expires_at, consumed_at, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?)`,
        )
        .run(
          stateId,
          'a'.repeat(64),
          'b'.repeat(64),
          now.getTime() + 10 * 60 * 1000,
          now.getTime(),
        )
      // The 0011 schema has config_id but not the new consent purpose/user binding.
      const legacyColumns = legacy.sqlite
        .prepare('PRAGMA table_info(oauth_states)')
        .all() as TableInfoRow[]
      assert.equal(legacyColumns.some((column) => column.name === 'config_id'), true)
      assert.equal(legacyColumns.some((column) => column.name === 'purpose'), false)
      assert.equal(legacyColumns.some((column) => column.name === 'user_id'), false)
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const applied = upgraded.sqlite
        .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
        .get() as { count: number }
      assert.equal(
        applied.count,
        fullJournalCount,
        'every journal entry (0000..0012 today) must be recorded after the upgrade',
      )

      const stateRows = upgraded.sqlite
        .prepare('SELECT id, config_id, purpose, user_id FROM oauth_states')
        .all() as Array<{
          id: string
          config_id: string | null
          purpose: string | null
          user_id: string | null
        }>
      assert.equal(stateRows.length, 1)
      assert.equal(stateRows[0]?.id, stateId)
      assert.equal(stateRows[0]?.config_id, null, 'existing rows keep config_id = NULL')
      assert.equal(stateRows[0]?.purpose, null, 'legacy login states remain distinguishable from profile consent')
      assert.equal(stateRows[0]?.user_id, null, 'legacy login states have no bound resident user')

      const saved = saveCandidate(upgraded.db)
      assert.equal(saved.status, 'draft')

      // Binding a pending attempt to the new version, then removing the version,
      // must SET NULL instead of stranding or deleting the attempt.
      upgraded.sqlite
        .prepare('UPDATE oauth_states SET config_id = ? WHERE id = ?')
        .run(saved.id, stateId)
      upgraded.sqlite.prepare('DELETE FROM wechat_oauth_configs WHERE id = ?').run(saved.id)
      const rebound = upgraded.sqlite
        .prepare('SELECT config_id FROM oauth_states WHERE id = ?')
        .get(stateId) as { config_id: string | null }
      assert.equal(rebound.config_id, null)
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/* -------------------------------- Repository ------------------------------- */

test('saving a candidate retires the previous candidate and never touches the active row', () => {
  withDatabase(({ db }) => {
    const createdByUserId = seedUser(db)
    const first = saveCandidate(db, { createdByUserId })
    assert.equal(first.status, 'draft')
    assert.equal(first.createdByUserId, createdByUserId)
    assert.equal(findActiveWechatConfig(db), undefined)

    const second = saveCandidate(db, { appId: OTHER_APP_ID, accountType: 'official' })

    const retiredFirst = findWechatConfigById(db, first.id)
    assert.ok(retiredFirst)
    assert.equal(retiredFirst.status, 'retired')
    assert.ok(retiredFirst.retiredAt instanceof Date)
    assert.equal(findLatestWechatConfigCandidate(db)?.id, second.id)

    const response = getWechatAdminConfigResponse(db, {
      masterKeyAvailable: true,
      keyId: 'v1',
      redirectUri: 'https://local.example.test/api/auth/wechat/callback',
    })
    assert.equal(response.state, 'draft')
    assert.equal(response.active, null)
    assert.equal(response.candidate?.id, second.id)
    assert.equal(response.recent.length, 2)
    assert.equal(response.masterKeyAvailable, true)
    assert.equal(response.keyId, 'v1')

    // Nothing in a response may carry the secret, ciphertext, IV or tag.
    const stored = findWechatConfigById(db, second.id)
    assert.ok(stored)
    const serialized = JSON.stringify(response)
    for (const secretValue of [
      FAKE_APP_SECRET,
      stored.appSecretCiphertext,
      stored.appSecretIv,
      stored.appSecretTag,
    ]) {
      assert.equal(serialized.includes(secretValue), false)
    }
    assert.equal(serialized.includes('app_secret'), false)
  })
})

test('verification and activation keep exactly one active provider', () => {
  withDatabase(({ db }) => {
    const first = saveCandidate(db)
    const verified = markWechatConfigVerified(db, first.id)
    assert.equal(verified.status, 'verified')
    assert.ok(verified.verifiedAt)

    const activated = activateWechatConfig(db, first.id)
    assert.equal(activated.active.id, first.id)
    assert.equal(activated.previous, null)
    assert.equal(findActiveWechatConfig(db)?.id, first.id)

    const second = saveCandidate(db, { appId: OTHER_APP_ID })
    // Saving a candidate must not disturb the active provider.
    assert.equal(findActiveWechatConfig(db)?.id, first.id)

    // An unverified candidate cannot be activated.
    assert.throws(
      () => activateWechatConfig(db, second.id),
      (error: unknown) =>
        error instanceof WechatConfigError && error.code === 'wechat_config_not_verified',
    )

    markWechatConfigVerified(db, second.id)
    const switched = activateWechatConfig(db, second.id)
    assert.equal(switched.active.id, second.id)
    assert.equal(switched.active.status, 'active')
    assert.equal(switched.previous?.id, first.id)
    assert.equal(switched.previous?.status, 'retired')

    const activeRows = db
      .select()
      .from(wechatOauthConfigs)
      .where(eq(wechatOauthConfigs.status, 'active'))
      .all()
    assert.equal(activeRows.length, 1, 'the database must hold exactly one active provider')

    // The partial unique index is the authority: re-activating the retired row
    // directly (bypassing the repository) is rejected by SQLite itself. All other
    // lifecycle columns already satisfy the active CHECK, so this proves the
    // uniqueness constraint rather than a timestamp check.
    assert.throws(
      () =>
        db
          .update(wechatOauthConfigs)
          .set({ status: 'active', retiredAt: null })
          .where(eq(wechatOauthConfigs.id, first.id))
          .run(),
      /UNIQUE constraint failed/u,
    )

    // Idempotent re-activation of the current provider is a no-op success.
    const again = activateWechatConfig(db, second.id)
    assert.equal(again.active.id, second.id)
    assert.equal(again.previous, null)
  })
})

test('a failed verification never damages the active provider', () => {
  withDatabase(({ db }) => {
    const active = saveCandidate(db)
    markWechatConfigVerified(db, active.id)
    activateWechatConfig(db, active.id)

    const candidate = saveCandidate(db, { appId: OTHER_APP_ID })
    const failed = markWechatConfigFailed(db, candidate.id, 'invalid_app_secret')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.lastErrorCode, 'invalid_app_secret')
    assert.equal(failed.verifiedAt, null)

    // The live provider is untouched and still resolves.
    assert.equal(findActiveWechatConfig(db)?.id, active.id)
    const state = getWechatAdminConfigResponse(db, {
      masterKeyAvailable: true,
      keyId: 'v1',
      redirectUri: 'https://local.example.test/api/auth/wechat/callback',
    })
    assert.equal(state.state, 'active')
    assert.equal(state.active?.id, active.id)
    assert.equal(state.candidate?.lastErrorCode, 'invalid_app_secret')

    // Active/retired versions are immutable through the verification path.
    assert.throws(
      () => markWechatConfigVerified(db, active.id),
      (error: unknown) => error instanceof WechatConfigError && error.code === 'conflict',
    )
    assert.throws(
      () => markWechatConfigFailed(db, active.id, 'unknown'),
      (error: unknown) => error instanceof WechatConfigError && error.code === 'conflict',
    )

    // A retried verification on the failed candidate clears the error and sets
    // the verification stamp.
    const retried = markWechatConfigVerified(db, candidate.id)
    assert.equal(retried.status, 'verified')
    assert.equal(retried.lastErrorCode, null)
    assert.ok(retried.verifiedAt)
  })
})

test('the repository rejects unknown config ids with a stable error code', () => {
  withDatabase(({ db }) => {
    assert.throws(
      () => markWechatConfigVerified(db, randomUUID()),
      (error: unknown) => error instanceof WechatConfigError && error.code === 'not_found',
    )
    assert.throws(
      () => activateWechatConfig(db, randomUUID()),
      (error: unknown) => error instanceof WechatConfigError && error.code === 'not_found',
    )
  })
})

/* --------------------------------- Runtime --------------------------------- */

test('runtime resolution is fail-closed and discriminable for every failure', () => {
  withDatabase(({ db }) => {
    assert.deepEqual(resolveWechatRuntimeConfig(db, MASTER_KEY), {
      ok: false,
      reason: 'not_configured',
      configId: null,
    })

    const saved = saveCandidate(db)
    // A draft is not a runtime provider.
    assert.deepEqual(resolveWechatRuntimeConfig(db, MASTER_KEY), {
      ok: false,
      reason: 'not_configured',
      configId: null,
    })

    markWechatConfigVerified(db, saved.id)
    activateWechatConfig(db, saved.id)

    const resolved = resolveWechatRuntimeConfig(db, MASTER_KEY)
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.config.appSecret, FAKE_APP_SECRET)
    assert.equal(resolved.config.configId, saved.id)
    assert.equal(resolved.config.appId, APP_ID)
    assert.equal(resolved.config.accountType, 'test')
    assert.equal(resolved.config.keyId, 'v1')
    assert.equal(resolved.config.status, 'active')

    assert.deepEqual(resolveWechatRuntimeConfig(db, undefined), {
      ok: false,
      reason: 'master_key_unavailable',
      configId: saved.id,
    })
    const wrongKey = resolveWechatRuntimeConfig(db, OTHER_MASTER_KEY)
    assert.equal(wrongKey.ok, false)
    if (!wrongKey.ok) assert.equal(wrongKey.reason, 'decrypt_failed')
    const rotatedKey = resolveWechatRuntimeConfig(db, { key: MASTER_KEY.key, keyId: 'v2' })
    assert.equal(rotatedKey.ok, false)
    if (!rotatedKey.ok) assert.equal(rotatedKey.reason, 'decrypt_failed')
    const invalidKey = resolveWechatRuntimeConfig(db, { key: randomBytes(8), keyId: 'v1' })
    assert.equal(invalidKey.ok, false)
    if (!invalidKey.ok) assert.equal(invalidKey.reason, 'master_key_invalid')

    assert.deepEqual(resolveWechatRuntimeConfig(db, MASTER_KEY, { configId: randomUUID() }), {
      ok: false,
      reason: 'config_missing',
      configId: null,
    })

    // A retired version stays resolvable by id, so an OAuth attempt that started
    // before a switch can be decided instead of silently using the new provider.
    const second = saveCandidate(db, { appId: OTHER_APP_ID })
    markWechatConfigVerified(db, second.id)
    activateWechatConfig(db, second.id)
    const retired = resolveWechatRuntimeConfig(db, MASTER_KEY, { configId: saved.id })
    assert.equal(retired.ok, true)
    if (!retired.ok) return
    assert.equal(retired.config.configId, saved.id)
    assert.equal(retired.config.status, 'retired')
    assert.equal(retired.config.appSecret, FAKE_APP_SECRET)

    // Tampering with the stored ciphertext fails closed instead of throwing a
    // secret or falling back to another provider.
    db.update(wechatOauthConfigs)
      .set({ appSecretCiphertext: Buffer.from('tampered-ciphertext').toString('base64') })
      .where(eq(wechatOauthConfigs.id, second.id))
      .run()
    const tampered = resolveWechatRuntimeConfig(db, MASTER_KEY)
    assert.equal(tampered.ok, false)
    if (!tampered.ok) {
      assert.equal(tampered.reason, 'decrypt_failed')
      assert.equal(tampered.configId, second.id)
    }
  })
})

test('AAD binds a ciphertext to its app id and account type', () => {
  withDatabase(({ db }) => {
    const saved = saveCandidate(db)
    markWechatConfigVerified(db, saved.id)
    activateWechatConfig(db, saved.id)

    // Simulate a row whose ciphertext was copied from another account type
    // without re-encrypting: GCM authentication must reject it.
    db.update(wechatOauthConfigs)
      .set({ accountType: 'official' })
      .where(eq(wechatOauthConfigs.id, saved.id))
      .run()

    const result = resolveWechatRuntimeConfig(db, MASTER_KEY)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'decrypt_failed')
  })
})
