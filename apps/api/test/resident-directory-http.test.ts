import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { request as nodeRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { serve } from '@hono/node-server'
import {
  CRM_ROUTES,
  API_ERROR_CODES,
  residentDirectoryResponseSchema,
  type ResidentDirectoryResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import {
  communities, users, residentCommunityAssignments,
  staffAccounts, staffCommunityAssignments, sessions, wechatIdentities,
} from '../src/db/schema.js'
import { hashToken } from '../src/auth/security.js'
import { seedWechatConfig, TEST_APP_ID, TEST_APP_ID_B } from './wechat-fixtures.js'

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const date = new Date('2026-10-01T00:00:00.000Z')
const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
const communityA = uuid(9001)
const communityB = uuid(9002)
const totalA = 137
type Reply = { status: number; raw: string; body: Record<string, unknown> }

async function fixture() {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  seedWechatConfig(db)
  db.insert(communities).values([
    { id: communityA, name: 'A 社区', createdAt: date },
    { id: communityB, name: 'B 社区', createdAt: date },
  ]).run()

  const identities: Record<'admin' | 'operator' | 'grid', string> = {
    admin: 'directory-admin-secret',
    operator: 'directory-operator-secret',
    grid: 'directory-grid-secret',
  }
  const staffIds: Record<keyof typeof identities, string> = {
    admin: uuid(2001), operator: uuid(2002), grid: uuid(2003),
  }
  for (const [role, token] of Object.entries(identities) as Array<[keyof typeof identities, string]>) {
    const userId = uuid(role === 'admin' ? 3001 : role === 'operator' ? 3002 : 3003)
    db.insert(users).values({ id: userId, displayName: '工作人员', createdAt: date, updatedAt: date }).run()
    db.insert(staffAccounts).values({
      id: staffIds[role],
      userId,
      username: 'directory-' + role,
      passwordHash: 'test-only-unused',
      role: role === 'admin' ? 'admin' : role === 'operator' ? 'operator' : 'grid_worker',
      status: 'active', createdAt: date, updatedAt: date,
    }).run()
    db.insert(sessions).values({
      id: randomUUID(), userId, staffAccountId: staffIds[role],
      tokenHash: hashToken(token), csrfHash: hashToken('irrelevant-for-GET'),
      expiresAt: new Date(Date.now() + 3600_000), createdAt: date, lastSeenAt: date,
    }).run()
  }
  db.insert(staffCommunityAssignments).values([
    { staffAccountId: staffIds.operator, communityId: communityA, createdAt: date },
    { staffAccountId: staffIds.grid, communityId: communityA, createdAt: date },
  ]).run()

  const residents = Array.from({ length: totalA + 4 }, (_, index) => ({
    id: uuid(10_000 + index),
    displayName: index === 0 ? '本地阿华' : index === 1 ? '普通居民' :
      index === 2 ? '100%_特殊\\' : index === 3 ? null : `社区居民 ${String(index).padStart(3,'0')}`,
    createdAt: new Date(date.getTime() + index * 1000),
    updatedAt: date,
  }))
  db.insert(users).values(residents).run()
  db.insert(residentCommunityAssignments).values(residents.map((u, index) => ({
    userId: u.id,
    communityId: index < totalA ? communityA : communityB,
    createdAt: new Date(date.getTime() + index * 1000),
  }))).run()
  db.insert(wechatIdentities).values([
    { id: uuid(5001), userId: residents[0]!.id, appId: TEST_APP_ID,
      openId: 'authorized-1', nickname: '微信花花', avatarUrl: 'https://wx.example/avatar1.png',
      profileAuthorizedAt: new Date(date.getTime() + 50_000), createdAt: date },
    { id: uuid(5002), userId: residents[0]!.id, appId: TEST_APP_ID,
      openId: 'authorized-2', nickname: '旧微信昵称', avatarUrl: 'https://wx.example/avatar-old.png',
      profileAuthorizedAt: new Date(date.getTime() + 10_000), createdAt: date },
    { id: uuid(5003), userId: residents[1]!.id, appId: TEST_APP_ID,
      openId: 'not-authorized', nickname: '不应展示', avatarUrl: 'https://wx.example/private.png',
      profileAuthorizedAt: null, createdAt: date },
    { id: uuid(5004), userId: residents[2]!.id, appId: TEST_APP_ID_B,
      openId: 'other-account', nickname: '别的公众号资料', avatarUrl: 'https://wx.example/other.png',
      profileAuthorizedAt: new Date(date.getTime() + 5_000), createdAt: date },
  ]).run()
  const app = createApp({ db, config: loadConfig({ NODE_ENV:'test' }), logRequests: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port

  const get = (params: Record<string, string>, who: keyof typeof identities | 'none' = 'admin') =>
    new Promise<Reply>((resolve, reject) => {
      const url = new URL(CRM_ROUTES.residentList, base)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      const headers = who === 'none' ? {} : { cookie: 'll_session=' + identities[who] }
      const req = nodeRequest(url, { headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          try { resolve({ status: response.statusCode ?? 0, raw, body: JSON.parse(raw) as Record<string, unknown> }) }
          catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.end()
    })
  const close = async () => {
    await new Promise<void>((resolve,reject) => server.close((e) => e ? reject(e) : resolve()))
    sqlite.close()
  }
  return { db, sqlite, get, close, residents }
}

function parse(reply: Reply): ResidentDirectoryResponse {
  assert.equal(reply.status, 200, reply.raw)
  return residentDirectoryResponseSchema.parse(reply.body)
}

test('real TCP HTTP + migrated SQLite: 137 residents page fully without truncation, stable count and ordering', async () => {
  const f = await fixture()
  try {
    const observed: string[] = []
    for (let page = 1; page <= 4; page++) {
      const result = parse(await f.get({ communityId: communityA, page: String(page), pageSize:'50' }))
      assert.equal(result.total, totalA)
      assert.equal(result.page, page)
      assert.equal(result.pageSize, 50)
      assert.equal(result.items.length, page < 3 ? 50 : page === 3 ? 37 : 0)
      observed.push(...result.items.map(x => x.id))
    }
    assert.equal(new Set(observed).size, totalA)
    assert.deepEqual(new Set(observed), new Set(f.residents.slice(0,totalA).map(x => x.id)))
    // Existing community index serves the scoped read; no new table/index.
    const plan = f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT user_id FROM resident_community_assignments WHERE community_id = ?')
      .all(communityA) as Array<{ detail: string }>
    assert.ok(plan.some((row) => row.detail.includes('resident_community_community_idx')), JSON.stringify(plan))
    assert.equal(parse(await f.get({ communityId: communityB })).total, 4)
  } finally { await f.close() }
})

test('search is literal, scoped and only matches authorized current-app WeChat profile, local name and UUID', async () => {
  const f = await fixture()
  try {
    const search = async (keyword: string) => parse(await f.get({ communityId: communityA, keyword }))
    const wechat = await search('微信花花')
    assert.equal(wechat.total, 1)
    assert.deepEqual(wechat.items.map(x=>x.id), [f.residents[0]!.id])
    const profile = wechat.items[0]!
    assert.equal(profile.displayName, '微信花花')
    assert.equal(profile.localDisplayName, '本地阿华')
    assert.equal(profile.wechatAvatarUrl, 'https://wx.example/avatar1.png')
    assert.ok(profile.profileAuthorizedAt)
    assert.ok(!JSON.stringify(profile).includes('openid'))
    assert.ok(!JSON.stringify(profile).includes('access_token'))
    assert.equal((await search('本地阿华')).total,1)
    assert.deepEqual((await search(f.residents[0]!.id)).items.map(x=>x.id),[f.residents[0]!.id])
    assert.equal((await search('%')).total, 1)
    assert.equal((await search('_')).total, 1)
    assert.equal((await search('\\')).total, 1)
    assert.equal((await search('不应展示')).total, 0)
    assert.equal((await search('别的公众号资料')).total, 0)
    assert.equal((await search('本社区不应出现')).total, 0)
    const unconsented = (await search('普通居民')).items[0]!
    assert.equal(unconsented.displayName, '普通居民')
    assert.equal(unconsented.wechatNickname, null)
    assert.equal(unconsented.wechatAvatarUrl, null)
    assert.equal(unconsented.profileAuthorizedAt, null)
    assert.equal((await search(f.residents[3]!.id)).items[0]!.displayName, '微信用户')
    assert.equal((await search('  微信花花  ')).total, 1)
    assert.equal((await search('no-match')).total, 0)
  } finally { await f.close() }
})

test('scope authorization and bounded input return structured HTTP errors without leaking residents', async () => {
  const f = await fixture()
  try {
    const admin = parse(await f.get({ communityId:communityB }, 'admin'))
    assert.equal(admin.total,4)
    const grid = parse(await f.get({ communityId:communityA }, 'grid'))
    assert.equal(grid.total,totalA)
    assert.equal(parse(await f.get({ communityId:communityA }, 'operator')).total,totalA)
    for (const role of ['grid','operator'] as const) {
      const denied = await f.get({ communityId:communityB,keyword:'居民' }, role)
      assert.equal(denied.status,403)
      assert.equal((denied.body.error as {code:string}).code, API_ERROR_CODES.forbidden)
      assert.ok(!denied.raw.includes('社区居民 004'))
    }
    const noSession = await f.get({communityId:communityA},'none')
    assert.equal(noSession.status,401)
    assert.equal((noSession.body.error as {code:string}).code, API_ERROR_CODES.unauthorized)
    const invalidCases: Record<string, string>[] = [
      {}, {communityId:'not-uuid'}, {communityId:communityA,page:'0'},
      {communityId:communityA,pageSize:'101'},
      {communityId:communityA,page:'10001'},
      {communityId:communityA,keyword:'x'.repeat(81)},
    ]
    for (const params of invalidCases) {
      const invalid = await f.get(params)
      assert.equal(invalid.status,400,invalid.raw)
    }
    assert.equal((await f.get({communityId:uuid(99999)})).status,404)
  } finally { await f.close() }
})
