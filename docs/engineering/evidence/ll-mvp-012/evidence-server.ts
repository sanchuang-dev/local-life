/**
 * Evidence-only server for LL-MVP-012 (#123) browser verification.
 *
 * It runs the **production** Hono app (`createApp`) over a real TCP listener with
 * the disposable seeded SQLite database. Exactly one thing is substituted: the
 * remote WeChat token endpoint, faked at the `fetch` boundary, because this
 * repository has no real AppID/AppSecret and no real WeChat authorization may be
 * attempted. Everything downstream of the code exchange (state consumption,
 * identity creation, community assignment, session, redirect) is production code.
 *
 * The `__evidence/*` routes are mounted **outside** the product app by wrapping
 * `app.fetch`. They are observability for this evidence run only (a DB snapshot,
 * a scenario reset and a results sink) and are never part of the shipped API.
 * They read the database with plain SQL so this folder needs no extra dependency
 * beyond what the API already owns.
 *
 * Run (from the repository root):
 *   WECHAT_CONFIG_MASTER_KEY=<base64> LL_EVIDENCE_DATABASE=<abs path> \
 *     apps/api/node_modules/.bin/tsx docs/engineering/evidence/ll-mvp-012/evidence-server.ts
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../../../apps/api/src/app.js'
import { hashPassword } from '../../../../apps/api/src/auth/security.js'
import { loadConfig } from '../../../../apps/api/src/config.js'
import { createDatabase } from '../../../../apps/api/src/db/client.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const DATABASE_PATH = process.env.LL_EVIDENCE_DATABASE ?? join(REPO_ROOT, '.data', 'll-mvp-012-browser.sqlite')
const MIGRATIONS = join(REPO_ROOT, 'apps', 'api', 'db', 'migrations')
const PORT = Number(process.env.LL_EVIDENCE_PORT ?? 4081)
const HOST = '127.0.0.1'
const ADMIN_USERNAME = process.env.LL_EVIDENCE_ADMIN ?? 'evidence.admin'
const ADMIN_PASSWORD = process.env.LL_EVIDENCE_ADMIN_PASSWORD ?? 'EvidenceOnlyPassw0rd!'
const WECHAT_APP_ID = 'wx1234567890abcdef'

// `@hono/node-server` is a dependency of the API package, not of this evidence
// folder, so it is resolved from the API's own manifest rather than added to the
// workspace root. It is the same adapter `apps/api/src/index.ts` serves with.
const apiRequire = createRequire(join(REPO_ROOT, 'apps', 'api', 'package.json'))
const { serve } = apiRequire('@hono/node-server') as {
  serve: typeof import('@hono/node-server').serve
}

const tokenCalls: Array<{ appId: string; code: string }> = []

const fakeWechat = (async (input: string | URL) => {
  const url = input instanceof URL ? input : new URL(String(input))
  if (url.pathname === '/sns/oauth2/access_token') {
    tokenCalls.push({
      appId: url.searchParams.get('appid') ?? '',
      code: url.searchParams.get('code') ?? '',
    })
    // A stable openid models "the same resident logs in again", which is exactly
    // what the duplicate-login scenario must exercise. A real exchange is never
    // performed: this fake answers the only endpoint the callback calls.
    return Response.json({
      openid: 'evidence-resident-openid',
      unionid: 'evidence-resident-unionid',
    })
  }
  throw new Error(`unexpected external request: ${url.pathname}`)
}) as typeof fetch

const config = loadConfig({
  NODE_ENV: 'development',
  HOST,
  PORT: String(PORT),
  DATABASE_PATH,
  WEB_BASE_URL: 'http://127.0.0.1:5173/',
  TRUSTED_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
  AUTH_DEV_ENABLED: 'false',
  ...(process.env.WECHAT_CONFIG_MASTER_KEY
    ? {
        WECHAT_CONFIG_MASTER_KEY: process.env.WECHAT_CONFIG_MASTER_KEY,
        WECHAT_CONFIG_KEY_ID: process.env.WECHAT_CONFIG_KEY_ID ?? 'v1',
      }
    : {}),
})

if (!config.wechatConfigMasterKey) {
  throw new Error('WECHAT_CONFIG_MASTER_KEY must be set so the seeded provider can be decrypted')
}

const { db, sqlite } = createDatabase(DATABASE_PATH, MIGRATIONS)

function rows<T>(statement: string): T[] {
  return sqlite.prepare(statement).all() as T[]
}

function count(table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }
  return row.value
}

// Seed one admin so the harness can read `/crm/residents` through the real API.
const existingAdmin = sqlite
  .prepare("SELECT id FROM staff_accounts WHERE role = 'admin' LIMIT 1")
  .get() as { id: string } | undefined
if (!existingAdmin) {
  const now = new Date()
  const userId = randomUUID()
  sqlite
    .prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(userId, '验收管理员', now.getTime(), now.getTime())
  sqlite
    .prepare(
      `INSERT INTO staff_accounts (id, user_id, username, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?)`,
    )
    .run(randomUUID(), userId, ADMIN_USERNAME, await hashPassword(ADMIN_PASSWORD), now.getTime(), now.getTime())
}

const app = createApp({ db, config, fetcher: fakeWechat, logRequests: false })

function snapshot(): Response {
  return Response.json({
    generatedAt: new Date().toISOString(),
    database: DATABASE_PATH,
    activities: rows<{ id: string; community_id: string; status: string; title: string }>(
      'SELECT id, community_id, status, title FROM activities ORDER BY created_at',
    ).map((row) => ({
      id: row.id,
      communityId: row.community_id,
      status: row.status,
      title: row.title,
    })),
    communities: rows<{ id: string; name: string }>('SELECT id, name FROM communities ORDER BY created_at'),
    oauthStates: rows<{
      id: string
      community_id: string | null
      config_id: string | null
      consumed_at: number | null
      created_at: number
    }>('SELECT id, community_id, config_id, consumed_at, created_at FROM oauth_states ORDER BY created_at').map(
      (row) => ({
        id: row.id,
        communityId: row.community_id,
        hasConfigId: Boolean(row.config_id),
        consumed: row.consumed_at !== null,
        createdAt: new Date(row.created_at).toISOString(),
      }),
    ),
    assignments: rows<{ user_id: string; community_id: string; created_at: number }>(
      'SELECT user_id, community_id, created_at FROM resident_community_assignments ORDER BY created_at',
    ).map((row) => ({
      userId: row.user_id,
      communityId: row.community_id,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    identities: rows<{ user_id: string; app_id: string; open_id: string }>(
      'SELECT user_id, app_id, open_id FROM wechat_identities ORDER BY created_at',
    ).map((row) => ({ userId: row.user_id, appId: row.app_id, openId: row.open_id })),
    residents: rows<{ id: string; display_name: string }>(
      `SELECT users.id AS id, users.display_name AS display_name
         FROM users
         INNER JOIN wechat_identities ON wechat_identities.user_id = users.id
        ORDER BY users.created_at`,
    ),
    sessions: count('sessions'),
    counts: {
      users: count('users'),
      participations: count('activity_participations'),
      teams: count('activity_teams'),
      invitations: count('activity_invitations'),
      checkins: count('activity_checkins'),
      rewards: count('activity_reward_grants'),
      orders: count('local_orders'),
      staff: count('staff_accounts'),
    },
    wechatTokenCalls: tokenCalls,
  })
}

/**
 * Reset only the resident-identity side, keeping the seeded activities and admin.
 *
 * Only users that actually carry a WeChat identity are removed: the activity
 * owner and the staff account are also rows in `users`, and `activities`
 * references its creator, so a blanket delete would violate the FK.
 */
function resetIdentity(): Response {
  const residentUserIds = [
    ...new Set(
      rows<{ user_id: string }>('SELECT user_id FROM wechat_identities').map((row) => row.user_id),
    ),
  ]
  sqlite.prepare('DELETE FROM sessions').run()
  sqlite.prepare('DELETE FROM resident_community_assignments').run()
  sqlite.prepare('DELETE FROM wechat_identities').run()
  sqlite.prepare('DELETE FROM oauth_states').run()
  for (const userId of residentUserIds) {
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId)
  }
  tokenCalls.length = 0
  return Response.json({ reset: true, removedResidents: residentUserIds.length })
}

const server = serve({
  hostname: HOST,
  port: PORT,
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/__evidence/snapshot') return snapshot()
    if (url.pathname === '/__evidence/reset') return resetIdentity()
    return app.fetch(request)
  },
})

console.log(
  JSON.stringify(
    {
      apiOrigin: `http://${HOST}:${PORT}`,
      database: DATABASE_PATH,
      admin: ADMIN_USERNAME,
      wechatProviderAppId: WECHAT_APP_ID,
    },
    null,
    2,
  ),
)

const shutdown = (): void => {
  server.close(() => {
    sqlite.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
