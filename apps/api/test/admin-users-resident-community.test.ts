import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { request as nodeRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { serve } from '@hono/node-server'
import {
  RESIDENT_COMMUNITY_ROUTES,
  USER_DIRECTORY_ROUTES,
  userDirectoryDetailPath,
  userDirectoryDetailSchema,
  userDirectoryResponseSchema,
  type UserDirectoryDetail,
  type UserDirectoryResponse,
} from '@sanchuang-dev/local-life-contracts'
import { hashToken } from '../src/auth/security.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import {
  communities,
  residentCommunityAssignments,
  sessions,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'
import { masterKeyEnv } from './wechat-fixtures.js'

/**
 * #171 LL-IDENTITY-001: the back-office directory must keep 「已确认常驻社区」 and
 * 「历史未确认归属」 as two INDEPENDENT facts.
 *
 * Why a dedicated file: `resident_community_bindings` (confirmed, permanent, one
 * per resident) and `resident_community_assignments` (the pre-#171 historical
 * relations, read-only) are different tables with different meanings. A directory
 * that merged them could report a resident as permanently settled in a community
 * they never confirmed — the exact defect #171 exists to remove. So the matrix
 * (history only / binding only / both agreeing / both disagreeing) is asserted end
 * to end against the real API rather than against the mapping function.
 *
 * Everything below crosses a real TCP socket into the real Hono app over a real
 * migrated SQLite database. Resident accounts are created through the real
 * `POST /auth/dev/login` and bound through the real
 * `POST /resident-community/confirm` (session cookie + CSRF + trusted Origin), so
 * no test can claim a confirmed community the product itself would refuse.
 */

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const WEB_ORIGIN = 'http://localhost:5173'
const NOW = new Date('2026-11-11T04:00:00.000Z')

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const communityA = uuid(9101)
const communityB = uuid(9102)
/** A community the A-scoped operator is NOT responsible for. */
const communityC = uuid(9103)

const staffAdminUser = uuid(3101)
const staffOperatorUser = uuid(3102)

type Who = 'admin' | 'operator' | 'none'
type Reply = {
  status: number
  raw: string
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
}

interface Resident {
  cookies: string[]
  csrfToken: string
  userId: string
}

function setCookies(headers: IncomingHttpHeaders): string[] {
  const raw = headers['set-cookie']
  if (!raw) return []
  return raw.map((value) => value.split(';', 1)[0]!.trim()).filter(Boolean)
}

async function fixture() {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  db.insert(communities)
    .values([
      { id: communityA, name: 'A 社区', address: 'A 路 1 号', createdAt: NOW },
      { id: communityB, name: 'B 社区', address: null, createdAt: NOW },
      { id: communityC, name: 'C 社区', address: null, createdAt: NOW },
    ])
    .run()

  db.insert(users)
    .values([
      { id: staffAdminUser, displayName: '平台管理员', createdAt: NOW, updatedAt: NOW },
      { id: staffOperatorUser, displayName: 'A 社区运营', createdAt: NOW, updatedAt: NOW },
    ])
    .run()

  const staffIds = { admin: uuid(2101), operator: uuid(2102) }
  db.insert(staffAccounts)
    .values([
      {
        id: staffIds.admin,
        userId: staffAdminUser,
        username: 'rc-admin',
        passwordHash: 'test-only-unused-password-hash',
        role: 'admin',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: staffIds.operator,
        userId: staffOperatorUser,
        username: 'rc-operator',
        passwordHash: 'test-only-unused-password-hash',
        role: 'operator',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])
    .run()
  db.insert(staffCommunityAssignments)
    .values([{
      staffAccountId: staffIds.operator,
      communityId: communityA,
      assignmentKind: 'operator_scope',
      createdAt: NOW,
    }])
    .run()

  const tokens = { admin: 'rc-admin-token', operator: 'rc-operator-token' }
  db.insert(sessions)
    .values([
      {
        id: randomUUID(),
        userId: staffAdminUser,
        staffAccountId: staffIds.admin,
        tokenHash: hashToken(tokens.admin),
        csrfHash: hashToken('irrelevant-for-GET'),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: randomUUID(),
        userId: staffOperatorUser,
        staffAccountId: staffIds.operator,
        tokenHash: hashToken(tokens.operator),
        csrfHash: hashToken('irrelevant-for-GET'),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    .run()

  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    WEB_BASE_URL: WEB_ORIGIN,
    TRUSTED_ORIGINS: WEB_ORIGIN,
    ...masterKeyEnv(),
  })
  const app = createApp({ db, config, logRequests: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port

  const send = (
    method: string,
    path: string,
    options: {
      body?: unknown
      cookies?: string[]
      csrfToken?: string
      origin?: string
    } = {},
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (options.cookies?.length) headers.cookie = options.cookies.join('; ')
      if (options.csrfToken) headers['x-csrf-token'] = options.csrfToken
      if (options.origin !== null) headers.origin = options.origin ?? WEB_ORIGIN
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
      if (payload !== undefined) headers['content-type'] = 'application/json'
      const request = nodeRequest(new URL(path, base), { method, headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            raw,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            headers: response.headers,
          })
        })
      })
      request.on('error', reject)
      if (payload !== undefined) request.write(payload)
      request.end()
    })

  /** Real dev login: this is how a resident account comes into existence. */
  const login = async (displayName: string): Promise<Resident> => {
    const csrf = await send('GET', '/auth/csrf')
    assert.equal(csrf.status, 200, csrf.raw)
    const response = await send('POST', '/auth/dev/login', {
      body: { displayName },
      cookies: setCookies(csrf.headers),
      csrfToken: (csrf.body as { csrfToken: string }).csrfToken,
    })
    assert.equal(response.status, 200, response.raw)
    const body = response.body as { user: { id: string }; csrfToken: string }
    return {
      cookies: setCookies(response.headers),
      csrfToken: body.csrfToken,
      userId: body.user.id,
    }
  }

  /** Real confirmation: session + CSRF + trusted Origin, exactly like the H5. */
  const confirm = async (resident: Resident, communityId: string): Promise<Reply> =>
    send('POST', RESIDENT_COMMUNITY_ROUTES.confirm, {
      body: { communityId },
      cookies: resident.cookies,
      csrfToken: resident.csrfToken,
    })

  /** A pre-#171 relation, inserted the way the retired flows left them behind. */
  const legacyAssignment = (userId: string, communityId: string) => {
    db.insert(residentCommunityAssignments)
      .values({ userId, communityId, createdAt: NOW })
      .run()
  }

  const staffCookie = (who: Exclude<Who, 'none'>) => 'll_session=' + tokens[who]

  const list = (search: Record<string, string> = {}, who: Who = 'admin') => {
    const url = new URL(USER_DIRECTORY_ROUTES.list, base)
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value)
    return send('GET', url.pathname + url.search, who === 'none' ? {} : { cookies: [staffCookie(who)] })
  }
  const detail = (userId: string, who: Who = 'admin') =>
    send('GET', userDirectoryDetailPath(userId), who === 'none' ? {} : { cookies: [staffCookie(who)] })

  const close = async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    sqlite.close()
  }

  return { db, sqlite, login, confirm, legacyAssignment, list, detail, close }
}

function parseList(reply: Reply): UserDirectoryResponse {
  assert.equal(reply.status, 200, reply.raw)
  return userDirectoryResponseSchema.parse(reply.body)
}

function parseDetail(reply: Reply): UserDirectoryDetail {
  assert.equal(reply.status, 200, reply.raw)
  return userDirectoryDetailSchema.parse(reply.body)
}

function itemOf(list: UserDirectoryResponse, userId: string) {
  const item = list.items.find((candidate) => candidate.id === userId)
  assert.ok(item, `account ${userId} missing from ${JSON.stringify(list.items.map((i) => i.id))}`)
  return item
}

/* -------------------------------------------------------------------------- */
/* The four-cell matrix                                                       */
/* -------------------------------------------------------------------------- */

test('history only: 历史归属 is shown, and never promoted to 已确认常驻社区', async () => {
  const f = await fixture()
  try {
    const resident = await f.login('仅历史居民')
    f.legacyAssignment(resident.userId, communityA)

    const detail = parseDetail(await f.detail(resident.userId))
    assert.deepEqual(detail.residentCommunities.map((item) => item.id), [communityA])
    assert.equal(detail.confirmedCommunity, null, '历史归属不是确认关系')
    assert.equal(detail.communityRelationSource, 'historical_assignment')
    assert.equal(detail.residentCommunityState, 'unbound', '仍需本人首次确认')

    const item = itemOf(parseList(await f.list({ pageSize: '100' })), resident.userId)
    assert.equal(item.confirmedCommunity, null)
    assert.equal(item.communityRelationSource, 'historical_assignment')
    assert.deepEqual(item.residentCommunities.map((community) => community.id), [communityA])
  } finally {
    await f.close()
  }
})

test('binding only: 已确认常驻社区 is populated while the historical list stays empty', async () => {
  const f = await fixture()
  try {
    const resident = await f.login('仅确认居民')
    const confirmed = await f.confirm(resident, communityA)
    assert.equal(confirmed.status, 200, confirmed.raw)

    const detail = parseDetail(await f.detail(resident.userId))
    assert.deepEqual(detail.residentCommunities, [], '确认关系不是历史归属')
    assert.equal(detail.confirmedCommunity?.id, communityA)
    assert.equal(detail.confirmedCommunity?.name, 'A 社区')
    assert.equal(detail.confirmedCommunity?.source, 'resident_h5_confirmed')
    assert.match(detail.confirmedCommunity!.confirmedAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.equal(detail.communityRelationSource, 'confirmed_binding')
    assert.equal(detail.residentCommunityState, 'confirmed')

    const item = itemOf(parseList(await f.list({ pageSize: '100' })), resident.userId)
    assert.equal(item.confirmedCommunity?.id, communityA)
    assert.deepEqual(item.residentCommunities, [])
    assert.equal(item.communityRelationSource, 'confirmed_binding')
  } finally {
    await f.close()
  }
})

test('history and binding on the same community: both fields report, state stays 已确认', async () => {
  const f = await fixture()
  try {
    const resident = await f.login('历史与确认一致居民')
    f.legacyAssignment(resident.userId, communityA)
    assert.equal((await f.confirm(resident, communityA)).status, 200)

    const detail = parseDetail(await f.detail(resident.userId))
    // The two facts stay separately addressable even when they agree.
    assert.equal(detail.confirmedCommunity?.id, communityA)
    assert.deepEqual(detail.residentCommunities.map((item) => item.id), [communityA])
    assert.equal(detail.communityRelationSource, 'confirmed_binding')
    // Agreeing history is not a conflict: it is simply the same community.
    assert.equal(detail.residentCommunityState, 'confirmed')
  } finally {
    await f.close()
  }
})

test('history and binding on different communities: reported as 冲突, both facts preserved', async () => {
  const f = await fixture()
  try {
    const resident = await f.login('历史与确认冲突居民')
    f.legacyAssignment(resident.userId, communityA)
    assert.equal((await f.confirm(resident, communityB)).status, 200)

    const detail = parseDetail(await f.detail(resident.userId))
    assert.equal(detail.confirmedCommunity?.id, communityB, '确认的社区是 B')
    assert.deepEqual(
      detail.residentCommunities.map((item) => item.id),
      [communityA],
      '历史归属仍是 A，不被覆盖也不被当作确认',
    )
    assert.equal(detail.communityRelationSource, 'confirmed_binding')
    assert.equal(detail.residentCommunityState, 'conflict')

    // Neither relation may be dropped by the community filter, and the union
    // still yields exactly one row per account (never a duplicate).
    for (const community of [communityA, communityB]) {
      const filtered = parseList(await f.list({ community, pageSize: '100' }))
      const matches = filtered.items.filter((item) => item.id === resident.userId)
      assert.equal(matches.length, 1, `community=${community} must match exactly once`)
      assert.equal(filtered.total, 1)
    }
  } finally {
    await f.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Filters, totals and scope stay honest                                      */
/* -------------------------------------------------------------------------- */

test('an account with no relation at all is 未关联 and carries 无关系', async () => {
  const f = await fixture()
  try {
    const resident = await f.login('无关系居民')
    const detail = parseDetail(await f.detail(resident.userId))
    assert.deepEqual(detail.residentCommunities, [])
    assert.equal(detail.confirmedCommunity, null)
    assert.equal(detail.communityRelationSource, 'none')
    assert.equal(detail.residentCommunityState, 'unbound')

    const unassigned = parseList(await f.list({ community: 'unassigned', pageSize: '100' }))
    assert.ok(unassigned.items.some((item) => item.id === resident.userId))
  } finally {
    await f.close()
  }
})

test('a confirmed resident is not reported as 未关联 and stays filterable by that community', async () => {
  const f = await fixture()
  try {
    const resident = await f.login('确认后无历史居民')
    assert.equal((await f.confirm(resident, communityA)).status, 200)

    const unassigned = parseList(await f.list({ community: 'unassigned', pageSize: '100' }))
    assert.equal(
      unassigned.items.some((item) => item.id === resident.userId),
      false,
      '已确认常驻社区的居民不是未关联',
    )

    const filtered = parseList(await f.list({ community: communityA, pageSize: '100' }))
    assert.deepEqual(filtered.items.map((item) => item.id), [resident.userId])
    assert.equal(filtered.total, 1)
    // B and C genuinely have nobody.
    for (const community of [communityB, communityC]) {
      const empty = parseList(await f.list({ community, pageSize: '100' }))
      assert.equal(empty.total, 0)
      assert.deepEqual(empty.items, [])
    }
  } finally {
    await f.close()
  }
})

test('total and pageSize keep counting accounts, not relations', async () => {
  const f = await fixture()
  try {
    const withHistory = await f.login('分页历史居民')
    const withBinding = await f.login('分页确认居民')
    const both = await f.login('分页双关系居民')
    const pending = await f.login('分页待核查居民')
    f.legacyAssignment(withHistory.userId, communityA)
    assert.equal((await f.confirm(withBinding, communityA)).status, 200)
    // One account carrying BOTH kinds of relation, plus one carrying two legacy
    // relations (the pre-#171 ambiguity a human must resolve).
    f.legacyAssignment(both.userId, communityA)
    assert.equal((await f.confirm(both, communityB)).status, 200)
    f.legacyAssignment(pending.userId, communityA)
    f.legacyAssignment(pending.userId, communityB)

    const all = parseList(await f.list({ pageSize: '100' }))
    // 2 staff accounts + 4 residents, one row each despite several relations.
    assert.equal(all.total, 6)
    assert.equal(all.items.length, 6)
    assert.equal(new Set(all.items.map((item) => item.id)).size, 6)
    assert.equal(itemOf(all, both.userId).residentCommunityState, 'conflict')
    assert.equal(itemOf(all, pending.userId).residentCommunityState, 'pending_review')

    const firstPage = parseList(await f.list({ pageSize: '2', page: '1' }))
    assert.equal(firstPage.total, 6)
    assert.equal(firstPage.items.length, 2)
    assert.equal(firstPage.pageSize, 2)
    const secondPage = parseList(await f.list({ pageSize: '2', page: '2' }))
    assert.equal(secondPage.total, 6)
    assert.equal(secondPage.items.length, 2)
    assert.deepEqual(
      firstPage.items.map((item) => item.id).filter((id) =>
        secondPage.items.some((item) => item.id === id)),
      [],
      'pagination must not repeat an account across pages',
    )

    // The detail projection and the list row never disagree for the same account.
    for (const item of all.items) {
      const detail = parseDetail(await f.detail(item.id))
      assert.equal(detail.confirmedCommunity?.id ?? null, item.confirmedCommunity?.id ?? null)
      assert.equal(detail.communityRelationSource, item.communityRelationSource)
      assert.deepEqual(
        detail.residentCommunities.map((community) => community.id),
        item.residentCommunities.map((community) => community.id),
      )
    }
  } finally {
    await f.close()
  }
})

test('a community-scoped operator sees the relation but not an out-of-scope confirmation', async () => {
  const f = await fixture()
  try {
    const outOfScope = await f.login('跨社区确认居民')
    f.legacyAssignment(outOfScope.userId, communityA)
    assert.equal((await f.confirm(outOfScope, communityC)).status, 200)

    // Authorized through the A relation, so the account itself is visible.
    const detail = parseDetail(await f.detail(outOfScope.userId, 'operator'))
    assert.equal(detail.confirmedCommunity, null, 'C 社区的确认不外泄')
    assert.equal(detail.communityRelationSource, 'out_of_scope', '既不谎称已确认，也不谎称未绑定')
    assert.equal(detail.residentCommunityState, null, '状态由全部关系推出，跨范围时不计算')
    assert.deepEqual(detail.residentCommunities.map((item) => item.id), [communityA])

    for (const reply of [
      await f.detail(outOfScope.userId, 'operator'),
      await f.list({ pageSize: '100' }, 'operator'),
    ]) {
      assert.equal(reply.raw.includes(communityC), false, '社区 id 不外泄')
      assert.equal(reply.raw.includes('C 社区'), false, '社区名不外泄')
    }

    // A confirmation inside the operator's own scope IS shown, in full.
    const inScope = await f.login('A 社区确认居民')
    assert.equal((await f.confirm(inScope, communityA)).status, 200)
    const visible = parseDetail(await f.detail(inScope.userId, 'operator'))
    assert.equal(visible.confirmedCommunity?.id, communityA)
    assert.equal(visible.communityRelationSource, 'confirmed_binding')
    assert.equal(visible.residentCommunityState, null, 'scoped staff never get the global state')

    // And a resident of another community alone stays invisible (404, not 403).
    const otherOnly = await f.login('只有 B 社区居民')
    assert.equal((await f.confirm(otherOnly, communityB)).status, 200)
    assert.equal((await f.detail(otherOnly.userId, 'operator')).status, 404)

    // Unauthenticated callers get nothing at all.
    assert.equal((await f.detail(outOfScope.userId, 'none')).status, 401)
    assert.equal((await f.list({}, 'none')).status, 401)
  } finally {
    await f.close()
  }
})

test('reading the directory never creates, moves or deletes a binding', async () => {
  const f = await fixture()
  try {
    const resident = await f.login('只读居民')
    f.legacyAssignment(resident.userId, communityA)
    assert.equal((await f.confirm(resident, communityB)).status, 200)
    const before = {
      bindings: f.sqlite.prepare('SELECT COUNT(*) AS n FROM resident_community_bindings').get() as { n: number },
      assignments: f.sqlite.prepare('SELECT COUNT(*) AS n FROM resident_community_assignments').get() as { n: number },
      candidates: f.sqlite.prepare('SELECT COUNT(*) AS n FROM resident_community_binding_candidates').get() as { n: number },
      boundCommunity: (f.sqlite.prepare('SELECT community_id AS id FROM resident_community_bindings').get() as { id: string }).id,
    }
    assert.equal(before.bindings.n, 1)
    assert.equal(before.boundCommunity, communityB)

    await f.list({ pageSize: '100' })
    await f.list({ community: communityA, pageSize: '100' })
    await f.list({ community: communityB, pageSize: '100' })
    await f.list({ community: 'unassigned', pageSize: '100' })
    await f.list({ pageSize: '100' }, 'operator')
    await f.detail(resident.userId)
    await f.detail(resident.userId, 'operator')

    assert.equal(
      (f.sqlite.prepare('SELECT COUNT(*) AS n FROM resident_community_bindings').get() as { n: number }).n,
      1,
    )
    assert.equal(
      (f.sqlite.prepare('SELECT COUNT(*) AS n FROM resident_community_assignments').get() as { n: number }).n,
      1,
    )
    assert.equal(
      (f.sqlite.prepare('SELECT COUNT(*) AS n FROM resident_community_binding_candidates').get() as { n: number }).n,
      0,
    )
    assert.equal(
      (f.sqlite.prepare('SELECT community_id AS id FROM resident_community_bindings').get() as { id: string }).id,
      communityB,
      '目录读取不得改写绑定',
    )
  } finally {
    await f.close()
  }
})
