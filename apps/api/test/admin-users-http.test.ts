import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { request as nodeRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { serve } from '@hono/node-server'
import {
  API_ERROR_CODES,
  USER_DIRECTORY_ROUTES,
  userDirectoryDetailPath,
  userDirectoryDetailSchema,
  userDirectoryResponseSchema,
  type UserDirectoryDetail,
  type UserDirectoryResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import {
  communities,
  residentCommunityAssignments,
  residentPhoneIdentities,
  residentProfiles,
  sessions,
  staffAccounts,
  staffCommunityAssignments,
  users,
  wechatIdentities,
} from '../src/db/schema.js'
import { hashToken } from '../src/auth/security.js'
import { activateWechatConfig } from '../src/wechat/repository.js'
import { seedWechatConfig, TEST_APP_ID, TEST_APP_ID_B } from './wechat-fixtures.js'

/**
 * Real TCP HTTP + migrated SQLite coverage for the back-office user directory
 * (#153 LL-USER-001 T2).
 *
 * The fixture deliberately contains accounts the legacy `/crm/residents`
 * directory cannot show: a logged-in user with zero communities, a staff-only
 * account, and an account whose only identity belongs to another public
 * account. It also contains multi-community / multi-WeChat-identity users so a
 * single account can never become several rows or several `total` counts.
 *
 * Every request goes through a real listening Hono server and the real session
 * cookie; no handler is called directly and no auth is mocked.
 */

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const date = new Date('2026-10-01T00:00:00.000Z')
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
const communityA = uuid(9001)
const communityB = uuid(9002)

const staffAdminUser = uuid(3001)
const staffOperatorUser = uuid(3002)
const staffGridUser = uuid(3003)
const unassignedUser = uuid(10001)
const wechatPhoneUser = uuid(10002)
const unconsentedUser = uuid(10003)
const multiCommunityUser = uuid(10004)
const otherAppUser = uuid(10005)
const bareUser = uuid(10006)
const phoneOnlyUser = uuid(10007)
const likeSpecialUser = uuid(10008)
const extraUsers = Array.from({ length: 17 }, (_, index) => uuid(20_000 + index))

const totalUsers = 11 + extraUsers.length
const totalCommunityA = 6 + extraUsers.length
const totalUnassigned = 4
const operatorVisible = totalCommunityA + 2

type Who = 'admin' | 'operator' | 'grid' | 'resident' | 'none'
type Reply = { status: number; raw: string; body: Record<string, unknown> }

const at = (offsetMs: number) => new Date(date.getTime() + offsetMs)

async function fixture() {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  seedWechatConfig(db)
  db.insert(communities).values([
    { id: communityA, name: 'A 社区', createdAt: date },
    { id: communityB, name: 'B 社区', createdAt: date },
  ]).run()

  db.insert(users).values([
    { id: staffAdminUser, displayName: '平台管理员', createdAt: at(1), updatedAt: date },
    { id: staffOperatorUser, displayName: '运营小张', createdAt: at(2), updatedAt: date },
    { id: staffGridUser, displayName: '网格小李', createdAt: at(3), updatedAt: date },
    { id: unassignedUser, displayName: '未关联用户', createdAt: at(4), updatedAt: date },
    { id: wechatPhoneUser, displayName: '本地阿花', createdAt: at(5), updatedAt: date },
    { id: unconsentedUser, displayName: '普通居民', createdAt: at(6), updatedAt: date },
    { id: multiCommunityUser, displayName: '多社区居民', createdAt: at(7), updatedAt: date },
    { id: otherAppUser, displayName: 'B社区居民', createdAt: at(8), updatedAt: date },
    { id: bareUser, displayName: '开发登录用户', createdAt: at(9), updatedAt: date },
    { id: phoneOnlyUser, displayName: '手机号居民', createdAt: at(10), updatedAt: date },
    { id: likeSpecialUser, displayName: '100%_特殊\\', createdAt: at(11), updatedAt: date },
    ...extraUsers.map((id, index) => ({
      id,
      displayName: `分页居民 ${String(index).padStart(2, '0')}`,
      createdAt: at(100 + index),
      updatedAt: date,
    })),
  ]).run()

  const staffIds = {
    admin: uuid(2001),
    operator: uuid(2002),
    grid: uuid(2003),
  }
  db.insert(staffAccounts).values([
    {
      id: staffIds.admin,
      userId: staffAdminUser,
      username: 'users-admin',
      passwordHash: 'test-only-unused-password-hash',
      role: 'admin',
      status: 'active',
      createdAt: date,
      updatedAt: date,
    },
    {
      id: staffIds.operator,
      userId: staffOperatorUser,
      username: 'users-operator',
      passwordHash: 'test-only-unused-password-hash',
      role: 'operator',
      status: 'active',
      createdAt: date,
      updatedAt: date,
    },
    {
      id: staffIds.grid,
      userId: staffGridUser,
      username: 'users-grid',
      passwordHash: 'test-only-unused-password-hash',
      role: 'grid_worker',
      status: 'active',
      createdAt: date,
      updatedAt: date,
    },
  ]).run()
  db.insert(staffCommunityAssignments).values([
    {
      staffAccountId: staffIds.operator,
      communityId: communityA,
      assignmentKind: 'operator_scope',
      createdAt: date,
    },
    {
      staffAccountId: staffIds.grid,
      communityId: communityA,
      assignmentKind: 'grid_territory',
      createdAt: date,
    },
  ]).run()

  const tokens = {
    admin: 'admin-directory-token',
    operator: 'operator-directory-token',
    grid: 'grid-directory-token',
    resident: 'resident-directory-token',
  }
  db.insert(residentCommunityAssignments).values([
    ...[
      wechatPhoneUser,
      unconsentedUser,
      multiCommunityUser,
      bareUser,
      phoneOnlyUser,
      likeSpecialUser,
      ...extraUsers,
    ].map((userId) => ({ userId, communityId: communityA, createdAt: date })),
    { userId: multiCommunityUser, communityId: communityB, createdAt: date },
    { userId: otherAppUser, communityId: communityB, createdAt: date },
  ]).run()

  db.insert(wechatIdentities).values([
    {
      id: uuid(5001),
      userId: unassignedUser,
      appId: TEST_APP_ID,
      openId: 'openid-unassigned',
      nickname: '未关联花花',
      avatarUrl: 'https://wx.example/unassigned.png',
      profileAuthorizedAt: at(20),
      createdAt: date,
    },
    {
      id: uuid(5002),
      userId: wechatPhoneUser,
      appId: TEST_APP_ID,
      openId: 'openid-authorized-a',
      unionId: 'unionid-authorized-a',
      nickname: '微信阿花',
      avatarUrl: 'https://wx.example/authorized.png',
      sex: 2,
      country: '中国',
      province: '浙江省',
      city: '杭州市',
      profileAuthorizedAt: at(30),
      profileUpdatedAt: at(90),
      createdAt: date,
    },
    {
      id: uuid(5003),
      userId: unconsentedUser,
      appId: TEST_APP_ID,
      openId: 'openid-not-consented',
      nickname: '不应展示',
      avatarUrl: 'https://wx.example/not-consented.png',
      profileAuthorizedAt: null,
      createdAt: date,
    },
    {
      id: uuid(5004),
      userId: multiCommunityUser,
      appId: TEST_APP_ID,
      openId: 'openid-multi-new',
      nickname: '多社区昵称',
      avatarUrl: 'https://wx.example/multi-new.png',
      profileAuthorizedAt: at(60),
      createdAt: date,
    },
    {
      id: uuid(5005),
      userId: multiCommunityUser,
      appId: TEST_APP_ID,
      openId: 'openid-multi-old',
      nickname: '旧微信昵称',
      avatarUrl: 'https://wx.example/multi-old.png',
      profileAuthorizedAt: at(40),
      createdAt: date,
    },
    {
      id: uuid(5006),
      userId: multiCommunityUser,
      appId: TEST_APP_ID_B,
      openId: 'openid-multi-b',
      nickname: 'B公众号多社区',
      avatarUrl: 'https://wx.example/multi-b.png',
      profileAuthorizedAt: at(70),
      createdAt: date,
    },
    {
      id: uuid(5007),
      userId: otherAppUser,
      appId: TEST_APP_ID_B,
      openId: 'openid-other-app',
      nickname: '别的公众号资料',
      avatarUrl: 'https://wx.example/other-app.png',
      profileAuthorizedAt: at(50),
      createdAt: date,
    },
  ]).run()

  db.insert(residentPhoneIdentities).values([
    {
      id: uuid(6001),
      userId: wechatPhoneUser,
      phone: '13800138000',
      verifiedAt: at(80),
      createdAt: date,
      updatedAt: date,
    },
    {
      id: uuid(6002),
      userId: phoneOnlyUser,
      phone: '13900139000',
      verifiedAt: at(81),
      createdAt: date,
      updatedAt: date,
    },
  ]).run()

  // #257 resident-entered contact addresses. A row may exist with a null
  // address (resident opened the profile but has not filled it in), and a
  // resident may have no row at all (never opened it) — both are 未填写.
  db.insert(residentProfiles).values([
    {
      userId: wechatPhoneUser,
      contactAddress: '杭州市西湖区文三路 100 号 3 幢 501 室',
      createdAt: at(110),
      updatedAt: at(110),
    },
    {
      userId: phoneOnlyUser,
      contactAddress: null,
      createdAt: at(111),
      updatedAt: at(111),
    },
  ]).run()

  db.insert(sessions).values([
    {
      id: randomUUID(),
      userId: staffAdminUser,
      staffAccountId: staffIds.admin,
      tokenHash: hashToken(tokens.admin),
      csrfHash: hashToken('irrelevant-for-GET'),
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: date,
      lastSeenAt: date,
    },
    {
      id: randomUUID(),
      userId: staffOperatorUser,
      staffAccountId: staffIds.operator,
      tokenHash: hashToken(tokens.operator),
      csrfHash: hashToken('irrelevant-for-GET'),
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: date,
      lastSeenAt: date,
    },
    {
      id: randomUUID(),
      userId: staffGridUser,
      staffAccountId: staffIds.grid,
      tokenHash: hashToken(tokens.grid),
      csrfHash: hashToken('irrelevant-for-GET'),
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: date,
      lastSeenAt: date,
    },
    {
      id: randomUUID(),
      userId: wechatPhoneUser,
      staffAccountId: null,
      tokenHash: hashToken(tokens.resident),
      csrfHash: hashToken('irrelevant-for-GET'),
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: date,
      lastSeenAt: date,
    },
  ]).run()

  const app = createApp({ db, config: loadConfig({ NODE_ENV: 'test' }), logRequests: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port

  const request = (path: string, who: Who, search: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const url = new URL(path, base)
      for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value)
      const headers = who === 'none' ? {} : { cookie: 'll_session=' + tokens[who] }
      const req = nodeRequest(url, { headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({
              status: response.statusCode ?? 0,
              raw,
              body: JSON.parse(raw) as Record<string, unknown>,
            })
          } catch (error) {
            reject(error)
          }
        })
      })
      req.on('error', reject)
      req.end()
    })

  const list = (search: Record<string, string> = {}, who: Who = 'admin') =>
    request(USER_DIRECTORY_ROUTES.list, who, search)
  const detail = (userId: string, who: Who = 'admin') =>
    request(userDirectoryDetailPath(userId), who)

  const tableCounts = () => {
    const tables = [
      'users',
      'communities',
      'resident_community_assignments',
      'staff_accounts',
      'staff_community_assignments',
      'wechat_identities',
      'resident_phone_identities',
      'resident_profiles',
      'sessions',
    ]
    return Object.fromEntries(
      tables.map((table) => [
        table,
        (sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number })
          .total,
      ]),
    )
  }

  const close = async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    sqlite.close()
  }

  return { db, sqlite, list, detail, close, tableCounts, staffIds }
}

function parseList(reply: Reply): UserDirectoryResponse {
  assert.equal(reply.status, 200, reply.raw)
  return userDirectoryResponseSchema.parse(reply.body)
}

function parseDetail(reply: Reply): UserDirectoryDetail {
  assert.equal(reply.status, 200, reply.raw)
  return userDirectoryDetailSchema.parse(reply.body)
}

function errorCode(reply: Reply): string {
  return (reply.body.error as { code: string }).code
}

test('users is the root table: unassigned and staff-only accounts are visible to an admin', async () => {
  const f = await fixture()
  try {
    const all = parseList(await f.list({ pageSize: '100' }))
    assert.equal(all.total, totalUsers)
    assert.equal(all.items.length, totalUsers)
    assert.equal(new Set(all.items.map((item) => item.id)).size, totalUsers)

    const unassigned = all.items.find((item) => item.id === unassignedUser)
    assert.ok(unassigned, 'a logged-in user with zero communities must be listed')
    assert.deepEqual(unassigned.residentCommunities, [])
    assert.equal(unassigned.displayName, '未关联花花')

    const staffOnly = all.items.find((item) => item.id === staffAdminUser)
    assert.ok(staffOnly, 'a staff-only account must be listed')
    assert.equal(staffOnly.staffRole, 'admin')
    assert.deepEqual(staffOnly.residentCommunities, [])

    const multi = all.items.find((item) => item.id === multiCommunityUser)
    assert.ok(multi)
    assert.deepEqual(
      multi.residentCommunities.map((community) => community.id),
      [communityA, communityB],
    )
    assert.equal(multi.wechatNickname, '多社区昵称')
    assert.equal(multi.displayName, '多社区昵称')
  } finally {
    await f.close()
  }
})

test('server-side pagination uses the same visible scope and a real, non-duplicated total', async () => {
  const f = await fixture()
  try {
    const first = parseList(await f.list({ page: '1', pageSize: '10' }))
    assert.equal(first.total, totalUsers)
    assert.equal(first.page, 1)
    assert.equal(first.pageSize, 10)
    assert.equal(first.items.length, 10)
    const seen: string[] = first.items.map((item) => item.id)

    const second = parseList(await f.list({ page: '2', pageSize: '10' }))
    const third = parseList(await f.list({ page: '3', pageSize: '10' }))
    assert.equal(second.total, totalUsers)
    assert.equal(third.total, totalUsers)
    assert.equal(second.items.length, 10)
    assert.equal(third.items.length, totalUsers - 20)
    seen.push(...second.items.map((item) => item.id), ...third.items.map((item) => item.id))
    assert.equal(new Set(seen).size, totalUsers, 'pages must not repeat a multi-relation account')

    // Stable ordering: the same request returns the same slice.
    assert.deepEqual(
      parseList(await f.list({ page: '1', pageSize: '10' })).items.map((item) => item.id),
      first.items.map((item) => item.id),
    )
    const beyond = parseList(await f.list({ page: '99', pageSize: '10' }))
    assert.equal(beyond.total, totalUsers)
    assert.deepEqual(beyond.items, [])

    const scoped = parseList(await f.list({ pageSize: '100' }, 'operator'))
    assert.equal(scoped.total, operatorVisible)
    assert.equal(scoped.items.length, operatorVisible)
  } finally {
    await f.close()
  }
})

test('keyword searches UUID, current-app consented nickname and local name literally', async () => {
  const f = await fixture()
  try {
    const search = async (keyword: string) =>
      parseList(await f.list({ pageSize: '100', keyword }))
    const ids = (result: UserDirectoryResponse) => result.items.map((item) => item.id)

    assert.deepEqual(ids(await search('微信阿花')), [wechatPhoneUser])
    assert.deepEqual(ids(await search('本地阿花')), [wechatPhoneUser])
    assert.deepEqual(ids(await search(multiCommunityUser)), [multiCommunityUser])
    assert.deepEqual(ids(await search('未关联花花')), [unassignedUser])
    assert.equal((await search('隐藏昵称')).total, 0)
    assert.equal((await search('不应展示')).total, 0)
    assert.equal((await search('别的公众号资料')).total, 0)
    assert.deepEqual(ids(await search('%')), [likeSpecialUser])
    assert.deepEqual(ids(await search('_')), [likeSpecialUser])
    assert.deepEqual(ids(await search('\\')), [likeSpecialUser])
    assert.equal((await search(' 微信阿花 ')).total, 1)
    assert.equal((await search('no-match')).total, 0)

    // Empty/whitespace query values mean "no filter" and must not 400.
    assert.equal(parseList(await f.list({ keyword: '' })).total, totalUsers)
    assert.equal(parseList(await f.list({ keyword: '   ', role: '', community: '' })).total, totalUsers)

    const tooLong = await f.list({ keyword: 'x'.repeat(81) })
    assert.equal(tooLong.status, 400)
    assert.equal(errorCode(tooLong), API_ERROR_CODES.invalidRequest)
    for (const page of ['0', '10001']) {
      assert.equal((await f.list({ page })).status, 400)
    }
    for (const pageSize of ['0', '101', 'abc']) {
      assert.equal((await f.list({ pageSize })).status, 400)
    }
    assert.equal((await f.list({ role: 'superadmin' })).status, 400)
    assert.equal((await f.list({ community: 'none' })).status, 400)
    assert.equal((await f.list({ unexpected: '1' })).status, 400)
  } finally {
    await f.close()
  }
})

test('role, community and unassigned filters agree with the detail response', async () => {
  const f = await fixture()
  try {
    assert.equal(parseList(await f.list({ role: 'resident', pageSize: '100' })).total, 25)
    assert.deepEqual(
      parseList(await f.list({ role: 'operator', pageSize: '100' })).items.map((item) => item.id),
      [staffOperatorUser],
    )
    assert.deepEqual(
      parseList(await f.list({ role: 'admin', pageSize: '100' })).items.map((item) => item.id),
      [staffAdminUser],
    )
    assert.deepEqual(
      parseList(await f.list({ role: 'grid_worker', pageSize: '100' })).items.map((item) => item.id),
      [staffGridUser],
    )

    const communityAUsers = parseList(
      await f.list({ community: communityA, pageSize: '100' }),
    )
    assert.equal(communityAUsers.total, totalCommunityA)
    assert.ok(communityAUsers.items.every((item) => item.residentCommunities.length >= 1))
    assert.ok(communityAUsers.items.every((item) =>
      item.residentCommunities.some((community) => community.id === communityA)))

    const communityBUsers = parseList(await f.list({ community: communityB, pageSize: '100' }))
    assert.equal(communityBUsers.total, 2)
    assert.deepEqual(
      communityBUsers.items.map((item) => item.id).sort(),
      [multiCommunityUser, otherAppUser].sort(),
    )

    const unassigned = parseList(await f.list({ community: 'unassigned', pageSize: '100' }))
    assert.equal(unassigned.total, totalUnassigned)
    assert.deepEqual(
      unassigned.items.map((item) => item.id).sort(),
      [staffAdminUser, staffOperatorUser, staffGridUser, unassignedUser].sort(),
    )
    assert.ok(unassigned.items.every((item) => item.residentCommunities.length === 0))
    // The same person also matches a combined filter without duplicating rows.
    const combined = parseList(
      await f.list({ community: 'unassigned', role: 'operator', pageSize: '100' }),
    )
    assert.deepEqual(combined.items.map((item) => item.id), [staffOperatorUser])
    assert.equal(combined.total, 1)

    // List projection and detail projection must not disagree.
    for (const item of communityAUsers.items.slice(0, 5)) {
      const detail = parseDetail(await f.detail(item.id))
      assert.equal(detail.id, item.id)
      assert.equal(detail.staffRole, item.staffRole)
      assert.deepEqual(detail.identityMethods, item.identityMethods)
      assert.deepEqual(
        detail.residentCommunities.map((community) => community.id),
        item.residentCommunities.map((community) => community.id),
      )
    }
  } finally {
    await f.close()
  }
})

test('scope is authorized server-side: no session 401, out-of-scope accounts invisible and 404 on detail', async () => {
  const f = await fixture()
  try {
    for (const who of ['none', 'resident'] as const) {
      const denied = await f.list({}, who)
      assert.equal(denied.status, 401)
      assert.equal(errorCode(denied), API_ERROR_CODES.unauthorized)
      assert.equal((await f.detail(wechatPhoneUser, who)).status, 401)
    }

    for (const who of ['operator', 'grid'] as const) {
      const visible = parseList(await f.list({ pageSize: '100' }, who))
      assert.equal(visible.total, operatorVisible)
      const visibleIds = new Set(visible.items.map((item) => item.id))
      for (const allowed of [wechatPhoneUser, staffOperatorUser, staffGridUser, multiCommunityUser]) {
        assert.ok(visibleIds.has(allowed), `${who} should see ${allowed}`)
      }
      for (const hidden of [unassignedUser, otherAppUser, staffAdminUser]) {
        assert.equal(visibleIds.has(hidden), false, `${who} must not see ${hidden}`)
      }

      // A keyword cannot widen the scope, even when it names a hidden account.
      assert.equal(parseList(await f.list({ keyword: 'B社区居民' }, who)).total, 0)
      assert.equal(parseList(await f.list({ keyword: '别的公众号资料' }, who)).total, 0)
      assert.equal(parseList(await f.list({ keyword: '未关联花花' }, who)).total, 0)
      assert.ok(!(await f.list({ keyword: 'B社区居民' }, who)).raw.includes('B社区居民'))

      // An explicit out-of-scope community filter is rejected before counting.
      const denied = await f.list({ community: communityB }, who)
      assert.equal(denied.status, 403)
      assert.equal(errorCode(denied), API_ERROR_CODES.forbidden)
      assert.ok(!denied.raw.includes('B社区居民'))
      // `unassigned` is administrator-only; scoped staff see an honest empty page.
      const scopedUnassigned = parseList(await f.list({ community: 'unassigned' }, who))
      assert.equal(scopedUnassigned.total, 0)
      assert.deepEqual(scopedUnassigned.items, [])
      // Role filters cannot reach an account outside scope either.
      assert.equal(parseList(await f.list({ role: 'admin' }, who)).total, 0)

      // Direct detail ids are filtered exactly like the list: 404, not 403.
      for (const hidden of [unassignedUser, otherAppUser, staffAdminUser, uuid(99999)]) {
        assert.equal((await f.detail(hidden, who)).status, 404)
      }
      assert.equal((await f.detail('not-a-uuid', who)).status, 404)
      assert.equal((await f.detail(wechatPhoneUser, who)).status, 200)
      assert.equal((await f.detail(staffOperatorUser, who)).status, 200)
      assert.equal((await f.detail(staffGridUser, who)).status, 200)
    }

    // The admin account has no community link and stays invisible to operators.
    assert.equal((await f.detail(staffAdminUser, 'admin')).status, 200)
    assert.equal((await f.detail(uuid(99999), 'admin')).status, 404)
    assert.equal((await f.detail('not-a-uuid', 'admin')).status, 404)
  } finally {
    await f.close()
  }
})

test('scoped staff do not receive other-community relationships of otherwise visible users', async () => {
  const f = await fixture()
  try {
    // One resident belongs to A+B; the caller only has A authority.
    for (const who of ['operator', 'grid'] as const) {
      const list = parseList(await f.list({ pageSize: '100' }, who))
      const row = list.items.find((item) => item.id === multiCommunityUser)
      assert.ok(row)
      assert.deepEqual(row.residentCommunities.map((item) => item.id), [communityA])
      const detail = parseDetail(await f.detail(multiCommunityUser, who))
      assert.deepEqual(detail.residentCommunities.map((item) => item.id), [communityA])
      assert.ok(!(await f.detail(multiCommunityUser, who)).raw.includes('B 社区'))
    }

    // Another staff member may operate in B, but an A-scoped viewer must not
    // learn this unrelated authorization through the detail response.
    f.db.insert(staffCommunityAssignments).values({
      staffAccountId: f.staffIds.operator,
      communityId: communityB,
      assignmentKind: 'operator_scope',
      createdAt: date,
    }).run()
    const scoped = parseDetail(await f.detail(staffOperatorUser, 'grid'))
    assert.deepEqual(scoped.staffAccount?.communities.map((item) => item.id), [communityA])
    const admin = parseDetail(await f.detail(staffOperatorUser, 'admin'))
    assert.deepEqual(admin.staffAccount?.communities.map((item) => item.id), [communityA, communityB])
  } finally {
    await f.close()
  }
})

test('detail exposes identity, consent, resident membership and staff authority separately', async () => {
  const f = await fixture()
  try {
    const multi = parseDetail(await f.detail(multiCommunityUser))
    assert.equal(multi.displayName, '多社区昵称')
    assert.equal(multi.wechatNickname, '多社区昵称')
    assert.equal(multi.wechatAvatarUrl, 'https://wx.example/multi-new.png')
    assert.equal(multi.wechatProfileAuthorizedAt, at(60).toISOString())
    assert.equal(multi.wechatLinkedIdentityCount, 3)
    assert.deepEqual(multi.identityMethods, ['wechat'])
    assert.equal(multi.staffRole, null)
    assert.equal(multi.staffAccount, null)
    assert.equal(multi.maskedPhone, null)
    assert.equal(multi.wechatLinkedUnionId, false)
    // A consented profile that predates #256 still yields the profile object,
    // with every extra field explicitly null instead of an invented value.
    assert.deepEqual(multi.wechatProfile, {
      sex: null,
      country: null,
      province: null,
      city: null,
      updatedAt: null,
    })
    assert.deepEqual(multi.contact, { visibility: 'full', phone: null, address: null })
    assert.deepEqual(
      multi.residentCommunities.map((community) => community.id),
      [communityA, communityB],
    )
    assert.equal(multi.createdAt, at(7).toISOString())

    const wechatPhone = parseDetail(await f.detail(wechatPhoneUser))
    assert.deepEqual(wechatPhone.identityMethods, ['wechat', 'phone'])
    assert.equal(wechatPhone.maskedPhone, '138****8000')
    assert.equal(wechatPhone.wechatLinkedUnionId, true)
    assert.deepEqual(wechatPhone.wechatProfile, {
      sex: 'female',
      country: '中国',
      province: '浙江省',
      city: '杭州市',
      updatedAt: at(90).toISOString(),
    })
    assert.deepEqual(wechatPhone.contact, {
      visibility: 'full',
      phone: '13800138000',
      address: '杭州市西湖区文三路 100 号 3 幢 501 室',
    })

    const unconsented = parseDetail(await f.detail(unconsentedUser))
    assert.equal(unconsented.displayName, '普通居民')
    assert.equal(unconsented.wechatNickname, null)
    assert.equal(unconsented.wechatAvatarUrl, null)
    assert.equal(unconsented.wechatProfileAuthorizedAt, null)
    assert.equal(unconsented.wechatProfile, null)
    assert.equal(unconsented.wechatLinkedIdentityCount, 1)

    // An explicitly authorized profile of another public account is never shown
    // while that account is not the active one.
    const otherApp = parseDetail(await f.detail(otherAppUser))
    assert.equal(otherApp.displayName, 'B社区居民')
    assert.equal(otherApp.wechatNickname, null)
    assert.equal(otherApp.wechatAvatarUrl, null)
    assert.equal(otherApp.wechatProfileAuthorizedAt, null)
    assert.equal(otherApp.wechatProfile, null)
    assert.equal(otherApp.wechatLinkedIdentityCount, 1)

    const phoneOnly = parseDetail(await f.detail(phoneOnlyUser))
    assert.deepEqual(phoneOnly.identityMethods, ['phone'])
    assert.equal(phoneOnly.maskedPhone, '139****9000')
    assert.equal(phoneOnly.wechatLinkedIdentityCount, 0)
    assert.equal(phoneOnly.wechatLinkedUnionId, false)
    // A profile row with a null address is 未填写, not a masked value.
    assert.deepEqual(phoneOnly.contact, {
      visibility: 'full',
      phone: '13900139000',
      address: null,
    })

    const bare = parseDetail(await f.detail(bareUser))
    assert.deepEqual(bare.identityMethods, [])
    assert.equal(bare.maskedPhone, null)
    assert.equal(bare.wechatLinkedUnionId, false)
    assert.equal(bare.wechatProfile, null)
    assert.deepEqual(bare.contact, { visibility: 'full', phone: null, address: null })
    assert.equal(bare.staffAccount, null)
    assert.equal(bare.displayName, '开发登录用户')

    const staff = parseDetail(await f.detail(staffOperatorUser))
    assert.equal(staff.staffRole, 'operator')
    assert.deepEqual(staff.identityMethods, ['staff'])
    assert.equal(staff.staffAccount?.username, 'users-operator')
    assert.equal(staff.staffAccount?.status, 'active')
    assert.deepEqual(
      staff.staffAccount?.communities.map((community) => community.id),
      [communityA],
    )
    // Resident membership and staff authority are separate lists.
    assert.deepEqual(staff.residentCommunities, [])
  } finally {
    await f.close()
  }
})

test('no sensitive identifier or credential is exposed, and complete contact stays administrator-only', async () => {
  const f = await fixture()
  try {
    const listRaw = (await f.list({ pageSize: '100' })).raw
    const detailRaw = (await f.detail(multiCommunityUser)).raw
    const phoneDetailRaw = (await f.detail(wechatPhoneUser)).raw
    const scopedListRaw = (await f.list({ pageSize: '100' }, 'operator')).raw
    const scopedPhoneRaw = (await f.detail(wechatPhoneUser, 'operator')).raw
    const gridPhoneRaw = (await f.detail(wechatPhoneUser, 'grid')).raw

    // No device ever receives provider identifiers, credentials, or a full
    // contact value outside an administrator's detail read.
    for (const raw of [
      listRaw,
      detailRaw,
      scopedListRaw,
      scopedPhoneRaw,
      gridPhoneRaw,
    ]) {
      for (const fragment of [
        'openid-unassigned',
        'openid-authorized-a',
        'openid-multi-new',
        'openid-other-app',
        'openid',
        'unionid-authorized-a',
        'unionid',
        'test-only-unused-password-hash',
        'passwordHash',
        'password_hash',
        'tokenHash',
        'admin-directory-token',
        'operator-directory-token',
        'll_session',
        '13800138000',
        '13900139000',
        '文三路',
      ]) {
        assert.equal(raw.includes(fragment), false, `response leaked ${fragment}`)
      }
    }

    // The administrator's detail read is the only place the complete phone and
    // the resident-entered address appear; identifiers still never do.
    for (const fragment of [
      'openid-unassigned',
      'openid-authorized-a',
      'openid-multi-new',
      'openid-other-app',
      'openid',
      'unionid-authorized-a',
      'unionid',
      'test-only-unused-password-hash',
      'passwordHash',
      'password_hash',
      'tokenHash',
      'admin-directory-token',
      'll_session',
    ]) {
      assert.equal(phoneDetailRaw.includes(fragment), false, `admin detail leaked ${fragment}`)
    }
    assert.ok(phoneDetailRaw.includes('"phone":"13800138000"'))
    assert.ok(phoneDetailRaw.includes('文三路'))

    const parsed = JSON.parse(detailRaw) as Record<string, unknown>
    for (const forbidden of ['openId', 'unionId', 'phone', 'passwordHash', 'tokenHash']) {
      assert.equal(forbidden in parsed, false, `detail key ${forbidden} must not exist`)
    }
    assert.equal((parsed.maskedPhone as unknown), null)

    const scopedParsed = JSON.parse(scopedPhoneRaw) as Record<string, unknown>
    assert.equal(scopedParsed.maskedPhone, '138****8000')
    assert.deepEqual(scopedParsed.contact, {
      visibility: 'masked',
      phone: null,
      address: null,
    })
    assert.deepEqual(
      (JSON.parse(gridPhoneRaw) as Record<string, unknown>).contact,
      { visibility: 'masked', phone: null, address: null },
    )
  } finally {
    await f.close()
  }
})

test('switching the active public account switches the consented profile immediately', async () => {
  const f = await fixture()
  try {
    assert.equal(parseDetail(await f.detail(wechatPhoneUser)).wechatNickname, '微信阿花')
    assert.equal((await f.list({ keyword: '微信阿花' })).status, 200)
    assert.equal(parseList(await f.list({ keyword: '微信阿花' })).total, 1)
    assert.equal(parseDetail(await f.detail(otherAppUser)).wechatNickname, null)

    const next = seedWechatConfig(f.db, { appId: TEST_APP_ID_B, status: 'verified' })
    activateWechatConfig(f.db, next.id)

    assert.equal(parseDetail(await f.detail(wechatPhoneUser)).wechatNickname, null)
    assert.equal(parseDetail(await f.detail(wechatPhoneUser)).displayName, '本地阿花')
    assert.equal(parseDetail(await f.detail(otherAppUser)).wechatNickname, '别的公众号资料')
    assert.equal(parseDetail(await f.detail(multiCommunityUser)).displayName, 'B公众号多社区')
    assert.equal(parseList(await f.list({ keyword: '微信阿花' })).total, 0)
    assert.equal(parseList(await f.list({ keyword: '别的公众号资料' })).total, 1)
    assert.equal(parseList(await f.list({ pageSize: '100' })).total, totalUsers)
  } finally {
    await f.close()
  }
})

test('directory reads have no side effects on any identity, membership or session row', async () => {
  const f = await fixture()
  try {
    const before = f.tableCounts()
    await f.list({ pageSize: '100' })
    await f.list({ keyword: '微信阿花' })
    await f.list({ community: communityA })
    await f.list({ community: 'unassigned' })
    await f.list({ role: 'resident' })
    await f.list({ pageSize: '100' }, 'operator')
    await f.detail(multiCommunityUser)
    await f.detail(wechatPhoneUser)
    assert.deepEqual(f.tableCounts(), before)
  } finally {
    await f.close()
  }
})
