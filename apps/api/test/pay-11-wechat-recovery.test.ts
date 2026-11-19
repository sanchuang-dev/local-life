import assert from 'node:assert/strict'
import { createCipheriv, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test, { type TestContext } from 'node:test'
import {
  PAYMENT_ROUTES, PAYMENT_WECHAT_ROUTES,
  paymentIntentCreateResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  communities, localOrders, localProducts, paymentIntents,
  paymentEvents, paymentOutbox, localOrderOnlineCompletions,
  ledgerEntries, wechatPayRecoveryChecks,
} from '../src/db/schema.js'
import {
  TEST_APPID, TEST_MCHID, TEST_MERCHANT_SERIAL,
  TEST_MERCHANT_PRIVATE_KEY_PEM, TEST_PLATFORM_KEY_ID,
  TEST_PLATFORM_PUBLIC_KEY_PEM, TEST_PLATFORM_PRIVATE_KEY,
  startFakeWechatServer, signWechatResponse,
  type CapturedWechatRequest, type FakeWechatResponse,
} from './fixtures/wechat-pay-test-support.js'

const MIGRATIONS = fileURLToPath(new URL('../db/migrations', import.meta.url))
const TOKEN = 'PAY11_TEST_ONLY_INTERNAL_TOKEN_DO_NOT_DEPLOY_ANYWHERE'
const API_KEY = '0123456789ABCDEF0123456789ABCDEF'
const ORIGIN = 'http://localhost:5173'
type App = ReturnType<typeof createApp>

interface World {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  directory: string
  dbPath: string
  config: ReturnType<typeof loadConfig>
  intentId: string
  merchantOrderNo: string
  orderId: string
  server: Awaited<ReturnType<typeof startFakeWechatServer>>
}
function cookieValue(response: Response, name: string): string {
  const cookies = response.headers.get('set-cookie') ?? ''
  const pair = cookies.split(/,(?=[^;,]+=)/u).map((c) => c.split(';')[0]?.trim() ?? '')
    .find((c) => c.startsWith(name + '='))
  assert.ok(pair)
  return pair
}
async function setup(
  t: TestContext,
  responder: (request: CapturedWechatRequest) => FakeWechatResponse,
): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'pay-11-'))
  const dbPath = join(directory, 'pay11.sqlite')
  writeFileSync(join(directory, 'merchant.pem'), TEST_MERCHANT_PRIVATE_KEY_PEM, { mode: 0o600 })
  writeFileSync(join(directory, 'platform.pem'), TEST_PLATFORM_PUBLIC_KEY_PEM, { mode: 0o600 })
  writeFileSync(join(directory, 'api-v3-key'), API_KEY, { mode: 0o600 })
  const server = await startFakeWechatServer(responder)
  const { db, sqlite } = createDatabase(dbPath, MIGRATIONS)
  t.after(async () => {
    try { sqlite.close() } catch { /* test may reopen the DB */ }
    await server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const config = loadConfig({
    NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true', PAYMENT_INTERNAL_TOKEN: TOKEN,
    WECHAT_PAY_MCHID: TEST_MCHID,
    WECHAT_PAY_APPID: TEST_APPID,
    WECHAT_PAY_MERCHANT_SERIAL_NO: TEST_MERCHANT_SERIAL,
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE: join(directory, 'merchant.pem'),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE: join(directory, 'platform.pem'),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID: TEST_PLATFORM_KEY_ID,
    WECHAT_PAY_NOTIFY_URL: 'https://local-life.example.test/api/payments/wechat/notify',
    WECHAT_PAY_API_BASE_URL: server.baseUrl,
    WECHAT_PAY_API_V3_KEY_FILE: join(directory, 'api-v3-key'),
  })
  const app = createApp({ db, config, logRequests: false })
  const csrf = await app.request('/auth/csrf')
  const csrfToken = (await csrf.json() as { csrfToken: string }).csrfToken
  const login = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      origin: ORIGIN, cookie: cookieValue(csrf, 'll_csrf'),
      'x-csrf-token': csrfToken, 'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: 'PAY-11 居民' }),
  })
  const loginText = await login.text()
  assert.equal(login.status, 200, loginText)
  const loginBody = JSON.parse(loginText) as { user: { id: string }; csrfToken: string }
  const userId = loginBody.user.id
  const cookie = cookieValue(login, 'll_session') + '; ' + cookieValue(login, 'll_csrf')
  const now = new Date()
  const communityId = randomUUID(), productId = randomUUID(), orderId = randomUUID()
  db.insert(communities).values({ id: communityId, name: 'PAY-11 片区', createdAt: now }).run()
  db.insert(localProducts).values({
    id: productId, communityId, name: 'PAY-11 小额测试商品',
    unitPriceCents: 3_980, status: 'on_shelf', createdAt: now, updatedAt: now,
  }).run()
  db.insert(localOrders).values({
    id: orderId, communityId, productId, residentUserId: userId,
    idempotencyKey: 'pay11-order-' + orderId,
    status: 'registered', recordSource: 'resident',
    productName: 'PAY-11 小额测试商品', unitPriceCents: 3_980,
    quantity: 1, totalCents: 3_980, couponDiscountCents: 0,
    couponId: null, note: null, createdByStaffId: null,
    attributedStaffId: null, sourceActivityId: null, sourceTeamId: null,
    verifiedByUserId: null, verifiedAt: null, verificationNote: null,
    createdAt: now, updatedAt: now,
  }).run()
  const response = await app.request(PAYMENT_ROUTES.createIntent, {
    method: 'POST',
    headers: {
      origin: ORIGIN, cookie, 'x-csrf-token': loginBody.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      localOrderId: orderId, channel: 'wechat_jsapi',
      idempotencyKey: 'pay11-intent-' + orderId,
    }),
  })
  const text = await response.text()
  assert.equal(response.status, 201, text)
  const intent = paymentIntentCreateResponseSchema.parse(JSON.parse(text)).intent
  return {
    app, db, sqlite, directory, dbPath, config, intentId: intent.id,
    merchantOrderNo: intent.merchantOrderNo, orderId, server,
  }
}

function encryptedNotification(world: World, overrides: {
  appid?: string; mchid?: string; amount?: number; tradeNo?: string;
  transactionId?: string; id?: string; ciphertext?: string; eventType?: string; successTime?: string;
} = {}) {
  const timestamp = Math.floor(Date.now() / 1_000).toString()
  const nonce = 'PAY11SIGNNONCE0123456789ABCDEF1234'
  const eventId = overrides.id ?? randomUUID()
  const transaction = JSON.stringify({
    appid: overrides.appid ?? TEST_APPID,
    mchid: overrides.mchid ?? TEST_MCHID,
    out_trade_no: overrides.tradeNo ?? world.merchantOrderNo,
    transaction_id: overrides.transactionId ?? '420000000020261119TESTPAY11TXN',
    trade_state: 'SUCCESS',
    success_time: overrides.successTime ?? new Date().toISOString(),
    amount: { total: overrides.amount ?? 3980, currency: 'CNY' },
  })
  const tagNonce = '123456789012'
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(API_KEY), Buffer.from(tagNonce))
  cipher.setAAD(Buffer.from('transaction'))
  const encrypted = Buffer.concat([
    cipher.update(transaction, 'utf8'), cipher.final(), cipher.getAuthTag(),
  ]).toString('base64')
  const body = JSON.stringify({
    id: eventId,
    create_time: new Date().toISOString(),
    event_type: overrides.eventType ?? 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: {
      original_type: 'transaction',
      algorithm: 'AEAD_AES_256_GCM',
      nonce: tagNonce, associated_data: 'transaction',
      ciphertext: overrides.ciphertext ?? encrypted,
    },
  })
  const headers = {
    'wechatpay-signature': signWechatResponse(TEST_PLATFORM_PRIVATE_KEY, timestamp, nonce, body),
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-serial': TEST_PLATFORM_KEY_ID,
    'content-type': 'application/json',
  }
  return { body, headers }
}

function notify(world: World, request: ReturnType<typeof encryptedNotification>) {
  return world.app.request(PAYMENT_WECHAT_ROUTES.notify, {
    method: 'POST', headers: request.headers, body: request.body,
  })
}
function internal(world: World, path: string) {
  return world.app.request(path, {
    method: 'POST', headers: { authorization: 'Bearer ' + TOKEN },
  })
}

function fakeQuery(world: World, tradeState: string, amount = 3980) {
  return JSON.stringify({
    appid: TEST_APPID, mchid: TEST_MCHID,
    out_trade_no: world.merchantOrderNo,
    transaction_id: '420000000020261119TESTPAY11TXN',
    trade_state: tradeState,
    success_time: new Date().toISOString(),
    amount: { total: amount, currency: 'CNY' },
  })
}

test('PAY-11 authentic signed AES-GCM notification confirms exactly once and cannot be spoofed', async (t) => {
  const w = await setup(t, () => ({ status: 200, body: '{}' }))
  const notification = encryptedNotification(w)
  const invalidSig = await notify(w, {
    body: notification.body,
    headers: { ...notification.headers, 'wechatpay-signature': 'forged' },
  })
  assert.equal(invalidSig.status, 401)
  const oldStamp = String(Math.floor(Date.now() / 1000) - 3600)
  const old = await notify(w, {
    body: notification.body,
    headers: {
      ...notification.headers,
      'wechatpay-timestamp': oldStamp,
      'wechatpay-signature': signWechatResponse(TEST_PLATFORM_PRIVATE_KEY, oldStamp,
        notification.headers['wechatpay-nonce'], notification.body),
    },
  })
  assert.equal(old.status, 401)
  const badCipher = encryptedNotification(w, { ciphertext: 'QUJDREVGR0hJSktMTU5PUA==' })
  assert.equal((await notify(w, badCipher)).status, 400)
  const wrongApp = encryptedNotification(w, { appid: 'wxWRONG000000000000' })
  assert.equal((await notify(w, wrongApp)).status, 409)
  const intent = w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()
  assert.equal(intent?.status, 'pending')

  const okay = await notify(w, notification)
  assert.equal(okay.status, 200, await okay.text())
  assert.equal((await notify(w, notification)).status, 200)
  const after = w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()
  assert.equal(after?.status, 'paid')
  assert.equal(after?.simulated, false)
  assert.equal(w.db.select().from(paymentOutbox).all().length, 1)
  assert.equal(w.db.select().from(localOrderOnlineCompletions).all().length, 1)
  const realReceipts = w.db.select().from(ledgerEntries)
    .where(eq(ledgerEntries.sourceSystem, 'online_payment')).all()
  assert.equal(realReceipts.length, 1)
  assert.equal(realReceipts[0]?.simulated, false, 'WeChat receipts must be real, not Mock')

  // PAY-03 cannot convert a real success into a second completion or ledger.
  const mismatch = encryptedNotification(w, { amount: 3979 })
  assert.equal((await notify(w, mismatch)).status, 409)
  assert.equal(w.db.select().from(paymentOutbox).all().length, 1)
  assert.equal(w.db.select().from(localOrderOnlineCompletions).all().length, 1)
  assert.equal(w.db.select().from(ledgerEntries)
    .where(eq(ledgerEntries.sourceSystem, 'online_payment')).all().length, 1)
  assert.ok(w.db.select().from(paymentEvents).all().length >= 1)
})

test('PAY-11 verified NOTPAY -> close acknowledgment -> verified CLOSED, never direct close', async (t) => {
  let state = 'NOTPAY'
  let world: World
  const w = await setup(t, (request) => {
    if (request.method === 'POST' && request.url.endsWith('/close')) {
      state = 'CLOSED'
      return { status: 204, body: '' }
    }
    return { status: 200, body: fakeQuery(world, state) }
  })
  world = w
  const closePath = PAYMENT_WECHAT_ROUTES.close.replace(':paymentIntentId', w.intentId)
  const result = await internal(w, closePath)
  const content = await result.text()
  assert.equal(result.status, 200, content)
  assert.equal((JSON.parse(content) as { outcome: string }).outcome, 'closed')
  const order = w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()
  assert.equal(order?.status, 'closed')
  assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
  const checks = w.db.select().from(wechatPayRecoveryChecks).all()
  assert.deepEqual(checks.map((item) => item.operation), ['query', 'close', 'post_close_query'])
  assert.equal(checks[1]?.result, 'request_sent')
  assert.equal(w.server.requests.filter((x) => x.method === 'POST').length, 1)
})

test('PAY-11 missing signatures / unknown provider results never close or mark paid', async (t) => {
  let world: World
  const w = await setup(t, () => ({
    status: 200, body: fakeQuery(world, 'SUCCESS'), omitSignatureHeaders: true,
  }))
  world = w
  const closePath = PAYMENT_WECHAT_ROUTES.close.replace(':paymentIntentId', w.intentId)
  assert.equal((await internal(w, closePath)).status, 202)
  assert.equal(w.server.requests.length, 1)
  assert.equal(w.server.requests[0]?.method, 'GET')
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status, 'pending')
  assert.equal(w.db.select().from(wechatPayRecoveryChecks).all()[0]?.result, 'uncertain')
})

test('PAY-11 verified query SUCCESS and duplicate notification converge one paid event', async (t) => {
  let world: World
  const w = await setup(t, () => ({ status: 200, body: fakeQuery(world, 'SUCCESS') }))
  world = w
  const path = PAYMENT_WECHAT_ROUTES.query.replace(':paymentIntentId', w.intentId)
  const response = await internal(w, path)
  assert.equal(response.status, 200, await response.text())
  assert.equal(w.db.select().from(paymentOutbox).all().length, 1)
  const notification = encryptedNotification(w)
  assert.equal((await notify(w, notification)).status, 200)
  assert.equal(w.db.select().from(paymentOutbox).all().length, 1)
  assert.equal(w.db.select().from(localOrderOnlineCompletions).all().length, 1)
})

test('PAY-11 internal query and close require server token, no public paid shortcut', async (t) => {
  const w = await setup(t, () => ({ status: 200, body: '{}' }))
  for (const route of [PAYMENT_WECHAT_ROUTES.query, PAYMENT_WECHAT_ROUTES.close]) {
    const path = route.replace(':paymentIntentId', w.intentId)
    assert.equal((await w.app.request(path, { method: 'POST' })).status, 401)
  }
  assert.equal((await w.app.request(PAYMENT_WECHAT_ROUTES.recover, { method: 'POST' })).status, 401)
  const noKeyApp = createApp({
    db: w.db,
    config: {
      ...w.config, wechatPay: { ...w.config.wechatPay!, apiV3Key: undefined },
    },
    logRequests: false,
  })
  const notification = encryptedNotification(w)
  assert.equal((await noKeyApp.request(PAYMENT_WECHAT_ROUTES.notify, {
    method: 'POST', body: notification.body, headers: notification.headers,
  })).status, 503)
})

test('PAY-11 paidAt records transaction success_time, not later notification time', async (t) => {
  const w = await setup(t, () => ({ status: 200, body: '{}' }))
  const successTime = new Date(Date.now() - 60000).toISOString()
  assert.equal((await notify(w, encryptedNotification(w, { successTime }))).status, 200)
  const intent = w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()
  assert.equal(intent?.paidAt?.toISOString(), successTime)
})

test('PAY-11 accepts official EV-prefixed event ids and survives restart/replay', async (t) => {
  const w = await setup(t, () => ({ status: 200, body: '{}' }))
  const notification = encryptedNotification(w, { id: 'EV-2018022511223320873' })
  assert.equal((await notify(w, notification)).status, 200)
  const reopened = createDatabase(w.dbPath, MIGRATIONS)
  t.after(() => reopened.sqlite.close())
  const newApp = createApp({ db: reopened.db, config: w.config, logRequests: false })
  const retry = await newApp.request(PAYMENT_WECHAT_ROUTES.notify, {
    method: 'POST', headers: notification.headers, body: notification.body,
  })
  assert.equal(retry.status, 200, await retry.text())
  assert.equal(reopened.db.select().from(paymentOutbox).all().length, 1)
  assert.equal(reopened.db.select().from(localOrderOnlineCompletions).all().length, 1)
})

test('PAY-11 close 204 with unconfirmed NOTPAY response cannot mark local intent closed', async (t) => {
  let world: World
  const w = await setup(t, (request) => {
    if (request.method === 'POST' && request.url.endsWith('/close')) {
      return { status: 204, body: '' }
    }
    return { status: 200, body: fakeQuery(world, 'NOTPAY') }
  })
  world = w
  const closePath = PAYMENT_WECHAT_ROUTES.close.replace(':paymentIntentId', w.intentId)
  const result = await internal(w, closePath)
  assert.equal(result.status, 200)
  const data = await result.json() as { outcome: string; tradeState: string }
  assert.equal(data.outcome, 'pending')
  assert.equal(data.tradeState, 'NOTPAY')
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status,
    'confirming')
  assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
  assert.equal(w.db.select().from(wechatPayRecoveryChecks).all()[1]?.result, 'request_sent')
})

test('PAY-11 signed query with wrong amount is an immutable anomaly, never a paid fact', async (t) => {
  let world: World
  const w = await setup(t, () => ({
    status: 200, body: fakeQuery(world, 'SUCCESS', 3_979),
  }))
  world = w
  const path = PAYMENT_WECHAT_ROUTES.query.replace(':paymentIntentId', w.intentId)
  const response = await internal(w, path)
  assert.equal(response.status, 409, await response.text())
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status,
    'pending')
  assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
  const { paymentReviewExceptions } = await import('../src/db/schema.js')
  assert.ok(w.db.select().from(paymentReviewExceptions).all().some((row) =>
    row.kind === 'amount_mismatch' && row.paymentIntentId === w.intentId))
})

test('PAY-11 wrong merchant response signature does not become payment evidence', async (t) => {
  let world: World
  const w = await setup(t, () => ({
    status: 200, body: JSON.stringify({
      ...JSON.parse(fakeQuery(world, 'SUCCESS')) as Record<string, unknown>,
      mchid: 'another_merchant',
    }),
  }))
  world = w
  const path = PAYMENT_WECHAT_ROUTES.query.replace(':paymentIntentId', w.intentId)
  const response = await internal(w, path)
  assert.equal(response.status, 202)
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status,
    'pending')
  assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
})

test('PAY-11 PAYERROR is reported as failed, not incorrectly represented as pending', async (t) => {
  let world: World
  const w = await setup(t, () => ({ status: 200, body: fakeQuery(world, 'PAYERROR') }))
  world = w
  const path = PAYMENT_WECHAT_ROUTES.query.replace(':paymentIntentId', w.intentId)
  const response = await internal(w, path)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { outcome: string }).outcome, 'failed')
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status,
    'failed')
  assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
})

test('PAY-11 refund is a typed review boundary, not a new paid or refund write', async (t) => {
  let world: World
  const w = await setup(t, () => ({ status: 200, body: fakeQuery(world, 'REFUND') }))
  world = w
  const path = PAYMENT_WECHAT_ROUTES.query.replace(':paymentIntentId', w.intentId)
  const response = await internal(w, path)
  assert.equal(response.status, 202)
  assert.equal((await response.json() as { outcome: string }).outcome, 'needs_review')
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status,
    'pending')
  assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
  assert.equal(w.db.select().from(wechatPayRecoveryChecks).all()[0]?.detailCode,
    'refund_requires_manual_review')
})

test('PAY-11 due recovery scans pending records after reconnect and converges once', async (t) => {
  let world: World
  const w = await setup(t, () => ({ status: 200, body: fakeQuery(world, 'SUCCESS') }))
  world = w
  const reopened = createDatabase(w.dbPath, MIGRATIONS)
  t.after(() => reopened.sqlite.close())
  const { recoverDueWechatPayments } = await import('../src/wechat-pay/recovery-service.js')
  // Local time advances beyond the frozen intent deadline; the query is still
  // the only authority for payment state, not the expiration clock.
  const future = new Date(Date.now() + 60 * 60 * 1000)
  const result = await recoverDueWechatPayments(reopened.db, w.config.wechatPay!, 10, future)
  assert.equal(result.checked, 1)
  assert.equal(result.results[0]?.outcome, 'paid')
  assert.equal(reopened.db.select().from(paymentOutbox).all().length, 1)
  const repeat = await recoverDueWechatPayments(reopened.db, w.config.wechatPay!, 10, future)
  assert.equal(repeat.checked, 0)
  assert.equal(reopened.db.select().from(paymentOutbox).all().length, 1)
})

test('PAY-11 verified late payment after closed intent stays in review, never rewrites terminal state', async (t) => {
  let world: World
  const w = await setup(t, (request) => ({
    status: 200,
    body: fakeQuery(world, request.index === 0 ? 'CLOSED' : 'SUCCESS'),
  }))
  world = w
  const path = PAYMENT_WECHAT_ROUTES.query.replace(':paymentIntentId', w.intentId)
  assert.equal((await internal(w, path)).status, 200)
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status,
    'closed')
  const late = await internal(w, path)
  assert.equal(late.status, 409)
  assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, w.intentId)).get()?.status,
    'closed')
  assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
})

test('PAY-11 simultaneous trusted query and signed callback converge one outbox payment', async (t) => {
  let world: World
  const w = await setup(t, () => ({
    status: 200, body: fakeQuery(world, 'SUCCESS'), delayMs: 20,
  }))
  world = w
  const path = PAYMENT_WECHAT_ROUTES.query.replace(':paymentIntentId', w.intentId)
  const [notifyResult, queryResult] = await Promise.all([
    notify(w, encryptedNotification(w)),
    internal(w, path),
  ])
  assert.equal(notifyResult.status, 200)
  assert.equal(queryResult.status, 200)
  assert.equal(w.db.select().from(paymentOutbox).all().length, 1)
  assert.equal(w.db.select().from(localOrderOnlineCompletions).all().length, 1)
})
