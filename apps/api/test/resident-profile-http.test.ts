import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
  RESIDENT_PROFILE_ROUTES,
  residentProfileResponseSchema,
} from '@sanchuang-dev/local-life-contracts'

import { createApp } from '../src/app.js'
import { hashToken } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  residentPhoneIdentities,
  residentProfiles,
  sessions,
  staffAccounts,
  users,
  wechatIdentities,
} from '../src/db/schema.js'

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ORIGIN = 'http://localhost:5173'

interface SeededSession {
  userId: string
  cookie: string
  csrfToken: string
}

function seedSession(
  db: AppDatabase,
  options: { displayName?: string; staff?: boolean } = {},
): SeededSession {
  const userId = randomUUID()
  const sessionId = randomUUID()
  const token = 'session-' + randomUUID()
  const csrfToken = 'csrf-' + randomUUID()
  const now = new Date()
  db.insert(users).values({
    id: userId,
    displayName: options.displayName ?? '资料测试居民',
    createdAt: now,
    updatedAt: now,
  }).run()
  let staffAccountId: string | null = null
  if (options.staff) {
    staffAccountId = randomUUID()
    db.insert(staffAccounts).values({
      id: staffAccountId,
      userId,
      username: 'profile.staff.' + userId.slice(0, 8),
      passwordHash: 'not-used-in-this-session-test',
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run()
  }
  db.insert(sessions).values({
    id: sessionId,
    userId,
    staffAccountId,
    tokenHash: hashToken(token),
    csrfHash: hashToken(csrfToken),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    createdAt: now,
    lastSeenAt: now,
  }).run()
  return {
    userId,
    csrfToken,
    cookie: `ll_session=${token}; ll_csrf=${csrfToken}`,
  }
}

function harness() {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_BASE_URL: ORIGIN,
    TRUSTED_ORIGINS: ORIGIN,
  })
  const app = createApp({ db, config, logRequests: false })
  return { db, sqlite, app }
}

function patchHeaders(session: SeededSession, overrides: { csrf?: string; origin?: string } = {}) {
  return {
    'content-type': 'application/json',
    cookie: session.cookie,
    'x-csrf-token': overrides.csrf ?? session.csrfToken,
    origin: overrides.origin ?? ORIGIN,
  }
}

test('resident profile persists address and reads only verified identity facts', async () => {
  const context = harness()
  try {
    const session = seedSession(context.db, { displayName: '张阿姨' })
    const now = new Date()
    context.db.insert(wechatIdentities).values({
      id: randomUUID(),
      userId: session.userId,
      appId: 'wx-profile-test-01',
      openId: 'openid-profile-test-01',
      unionId: null,
      nickname: '微信里的张阿姨',
      avatarUrl: 'https://wx.example.test/avatar/profile',
      sex: 2,
      province: '广东',
      city: '韶关',
      country: '中国',
      privilegeJson: '[]',
      profileAuthorizedAt: now,
      profileUpdatedAt: now,
      createdAt: now,
    }).run()
    context.db.insert(residentPhoneIdentities).values({
      id: randomUUID(),
      userId: session.userId,
      phone: '13800138000',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run()

    const initial = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      headers: { cookie: session.cookie },
    })
    assert.equal(initial.status, 200)
    const initialBody = residentProfileResponseSchema.parse(await initial.json())
    assert.equal(initialBody.userId, session.userId)
    assert.equal(initialBody.displayName, '张阿姨')
    assert.equal(initialBody.wechat?.nickname, '微信里的张阿姨')
    assert.equal(initialBody.wechat?.avatarUrl, 'https://wx.example.test/avatar/profile')
    assert.equal(initialBody.phone.maskedPhone, '138****8000')
    assert.equal(initialBody.contactAddress, null)

    const saved = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: patchHeaders(session),
      body: JSON.stringify({ contactAddress: '  韶关市武江区工业路 18 号  ' }),
    })
    assert.equal(saved.status, 200)
    const savedBody = residentProfileResponseSchema.parse(await saved.json())
    assert.equal(savedBody.contactAddress, '韶关市武江区工业路 18 号')
    assert.ok(savedBody.updatedAt)
    assert.equal(
      context.db.select().from(residentProfiles).where(eq(residentProfiles.userId, session.userId)).get()?.contactAddress,
      '韶关市武江区工业路 18 号',
    )
    assert.equal(
      context.db.select().from(residentPhoneIdentities).where(eq(residentPhoneIdentities.userId, session.userId)).get()?.phone,
      '13800138000',
      'saving address must not rewrite the verified phone identity',
    )

    const reloaded = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      headers: { cookie: session.cookie },
    })
    assert.equal(residentProfileResponseSchema.parse(await reloaded.json()).contactAddress, '韶关市武江区工业路 18 号')

    const cleared = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: patchHeaders(session),
      body: JSON.stringify({ contactAddress: '   ' }),
    })
    assert.equal(cleared.status, 200)
    assert.equal(residentProfileResponseSchema.parse(await cleared.json()).contactAddress, null)
  } finally {
    context.sqlite.close()
  }
})

test('resident profile enforces session, staff, CSRF, Origin, strict body and user isolation', async () => {
  const context = harness()
  try {
    const anonymous = await context.app.request(RESIDENT_PROFILE_ROUTES.profile)
    assert.equal(anonymous.status, 401)

    const staff = seedSession(context.db, { displayName: '后台人员', staff: true })
    const staffRead = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      headers: { cookie: staff.cookie },
    })
    assert.equal(staffRead.status, 403)
    const staffWrite = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: patchHeaders(staff),
      body: JSON.stringify({ contactAddress: '不应保存' }),
    })
    assert.equal(staffWrite.status, 403)

    const alice = seedSession(context.db, { displayName: '居民 A' })
    const bob = seedSession(context.db, { displayName: '居民 B' })

    const noCsrf = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: alice.cookie, origin: ORIGIN },
      body: JSON.stringify({ contactAddress: 'A 地址' }),
    })
    assert.equal(noCsrf.status, 403)

    const badOrigin = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: patchHeaders(alice, { origin: 'https://evil.example.test' }),
      body: JSON.stringify({ contactAddress: 'A 地址' }),
    })
    assert.equal(badOrigin.status, 403)

    const forgedUser = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: patchHeaders(alice),
      body: JSON.stringify({ contactAddress: 'A 地址', userId: bob.userId }),
    })
    assert.equal(forgedUser.status, 400)

    const tooLong = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: patchHeaders(alice),
      body: JSON.stringify({ contactAddress: '地'.repeat(201) }),
    })
    assert.equal(tooLong.status, 400)

    const aliceSaved = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      method: 'PATCH',
      headers: patchHeaders(alice),
      body: JSON.stringify({ contactAddress: 'A 的真实地址' }),
    })
    assert.equal(aliceSaved.status, 200)

    const bobRead = await context.app.request(RESIDENT_PROFILE_ROUTES.profile, {
      headers: { cookie: bob.cookie },
    })
    assert.equal(bobRead.status, 200)
    const bobBody = residentProfileResponseSchema.parse(await bobRead.json())
    assert.equal(bobBody.userId, bob.userId)
    assert.equal(bobBody.contactAddress, null)

    assert.equal(
      context.db.select().from(residentProfiles).where(eq(residentProfiles.userId, alice.userId)).get()?.contactAddress,
      'A 的真实地址',
    )
    assert.equal(
      context.db.select().from(residentProfiles).where(eq(residentProfiles.userId, bob.userId)).get(),
      undefined,
    )
  } finally {
    context.sqlite.close()
  }
})
