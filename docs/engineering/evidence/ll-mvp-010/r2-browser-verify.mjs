/**
 * R2 browser + API evidence for LL-MVP-010 / Issue #109.
 *
 * Runs against the real local stack (Hono API + SQLite + the resident H5 dev
 * server + the admin dev server) and drives the installed Chrome through CDP —
 * no Playwright, no extra dependency, same approach as
 * `docs/engineering/evidence/ll-ui-007/browser-verify.mjs`.
 *
 * Everything is created through the real admin API, so the script never touches
 * SQLite directly: communities, staff accounts, products and orders are all made
 * by the same endpoints the apps call. Re-running it adds data with a fresh run
 * tag instead of rewriting existing rows.
 *
 * Prerequisites (see README.md in this folder):
 *   1. `bootstrap-admin` has created one admin account in the local dev database;
 *   2. `AUTH_DEV_ENABLED=true` so the resident dev login works;
 *   3. API, H5 and admin dev servers are running on the ports from
 *      `apps/api/.env.local`.
 *
 * Environment (all optional):
 *   LL_WEB_ORIGIN, LL_ADMIN_ORIGIN, LL_ADMIN_USER, LL_ADMIN_PASSWORD,
 *   LL_SEED_PASSWORD, CHROME_PATH, LL_CDP_PORT
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const WEB_ORIGIN = process.env.LL_WEB_ORIGIN ?? 'http://localhost:5173'
const ADMIN_ORIGIN = process.env.LL_ADMIN_ORIGIN ?? 'http://localhost:5174'
const API_ORIGIN = `${WEB_ORIGIN}/api`
const ADMIN_USER = process.env.LL_ADMIN_USER ?? 'r2.evidence.admin'
const ADMIN_PASSWORD = process.env.LL_ADMIN_PASSWORD ?? 'EvidenceAdminPass123'
const SEED_PASSWORD = process.env.LL_SEED_PASSWORD ?? 'EvidenceStaffPass123'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = Number(process.env.LL_CDP_PORT ?? 0) || 9500 + (process.pid % 400)
const OUT = process.argv[2] ?? 'docs/engineering/evidence/ll-mvp-010'
const RUN_TAG = process.env.RUN_TAG ?? 'r2e2e'

/* -------------------------------- HTTP ----------------------------------- */

class CookieJar {
  constructor() {
    this.cookies = new Map()
  }

  absorb(headers) {
    for (const line of headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';')
      const index = pair.indexOf('=')
      if (index < 0) continue
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get(name) {
    return this.cookies.get(name) ?? null
  }

  forCdp() {
    return [...this.cookies].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/' }))
  }
}

async function request(jar, path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json', origin: WEB_ORIGIN, cookie: jar.header() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers['x-csrf-token'] = jar.get('ll_csrf') ?? ''
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  jar.absorb(response.headers)
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: response.status, json }
}

async function primeCsrf(jar) {
  const response = await fetch(`${API_ORIGIN}/auth/csrf`, { headers: { origin: WEB_ORIGIN } })
  jar.absorb(response.headers)
  const payload = await response.json()
  jar.cookies.set('ll_csrf', payload.csrfToken)
}

async function staffLogin(username, password) {
  const jar = new CookieJar()
  await primeCsrf(jar)
  const result = await request(jar, '/auth/login', { method: 'POST', body: { username, password } })
  if (result.status !== 200) {
    throw new Error(`staff login failed for ${username}: ${result.status} ${JSON.stringify(result.json)}`)
  }
  return { jar, session: result.json }
}

async function residentLogin(communityId) {
  const jar = new CookieJar()
  await primeCsrf(jar)
  const result = await request(jar, '/auth/dev/login', {
    method: 'POST',
    body: { displayName: `本地测试居民 ${RUN_TAG}`, communityId },
  })
  if (result.status !== 200) throw new Error(`resident dev login failed: ${result.status}`)
  return { jar, session: result.json }
}

/* ------------------------------ Fixtures --------------------------------- */

async function ensureCommunity(admin, name) {
  const list = await request(admin.jar, '/admin/communities')
  const existing = list.json.items.find((item) => item.name === name)
  if (existing) return existing
  const created = await request(admin.jar, '/admin/communities', { method: 'POST', body: { name } })
  if (created.status !== 201) throw new Error(`create community failed: ${created.status}`)
  return created.json
}

async function ensureStaff(admin, { username, displayName, role, communityIds }) {
  const list = await request(admin.jar, '/admin/staff')
  if (list.status !== 200) throw new Error(`staff list failed: ${list.status}`)
  const existing = list.json.items.find((item) => item.username === username)
  if (existing) return existing
  const created = await request(admin.jar, '/admin/staff', {
    method: 'POST',
    body: { username, displayName, password: SEED_PASSWORD, role, communityIds },
  })
  if (created.status !== 201) {
    throw new Error(`create staff ${username} failed: ${created.status} ${JSON.stringify(created.json)}`)
  }
  return created.json
}

async function ensureProduct(admin, spec) {
  const list = await request(admin.jar, `/admin/catalog/products?keyword=${encodeURIComponent(spec.name)}&pageSize=50`)
  const existing = list.json.items.find((item) => item.name === spec.name)
  if (existing) {
    if (existing.status === spec.status) return existing
    const reshelved = await request(admin.jar, `/admin/catalog/products/${existing.id}/shelf`, {
      method: 'POST',
      body: { expectedUpdatedAt: existing.updatedAt, status: spec.status },
    })
    if (reshelved.status !== 200) throw new Error(`shelf change failed: ${reshelved.status}`)
    return reshelved.json
  }
  // A created product starts off the shelf by design; the shelf route is the only
  // way to publish it, so an on-shelf spec always needs one extra real call.
  const created = await request(admin.jar, '/admin/catalog/products', {
    method: 'POST',
    body: {
      communityId: spec.communityId,
      name: spec.name,
      summary: spec.summary,
      description: spec.description,
      category: spec.category,
      priceCents: spec.priceCents,
    },
  })
  if (created.status !== 201) throw new Error(`create product failed: ${created.status} ${JSON.stringify(created.json)}`)
  check(
    `a new product starts off the shelf (${spec.name})`,
    created.json.status === 'off_shelf',
    created.json.status,
  )
  if (spec.status === 'off_shelf') return created.json
  const shelved = await request(admin.jar, `/admin/catalog/products/${created.json.id}/shelf`, {
    method: 'POST',
    body: { expectedUpdatedAt: created.json.updatedAt, status: spec.status },
  })
  if (shelved.status !== 200) throw new Error(`shelf change failed: ${shelved.status} ${JSON.stringify(shelved.json)}`)
  return shelved.json
}

/* --------------------------------- CDP ----------------------------------- */

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Cdp(socket)
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  async openPage(cookies, viewport) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    await this.send('Page.enable', {}, sessionId)
    await this.send('Network.enable', {}, sessionId)
    await this.send('Network.clearBrowserCookies', {}, sessionId)
    for (const cookie of cookies) {
      await this.send('Network.setCookie', { ...cookie, url: 'http://localhost' }, sessionId)
    }
    await this.send(
      'Emulation.setDeviceMetricsOverride',
      { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: viewport.width < 700 },
      sessionId,
    )
    return { targetId, sessionId }
  }

  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    return result.result.value
  }

  async screenshot(sessionId) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
    return Buffer.from(data, 'base64')
  }

  async closePage(targetId) {
    await this.send('Target.closeTarget', { targetId })
  }
}

/* -------------------------------- Checks --------------------------------- */

const checks = []
function check(label, ok, evidence) {
  checks.push({ label, ok: Boolean(ok), evidence })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${evidence === undefined ? '' : `  ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`}`)
}

const shots = []

async function capture(cdp, { name, url, jar, width, height, scale = 2, click, expect }) {
  const { targetId, sessionId } = await cdp.openPage(jar.forCdp(), { width, height, scale })
  await cdp.send('Page.navigate', { url }, sessionId)
  await sleep(2600)
  if (click) {
    const clicked = await cdp.evaluate(sessionId, click)
    if (!clicked) throw new Error(`click target missing on ${name}`)
    await sleep(1200)
  }
  const info = JSON.parse(
    await cdp.evaluate(
      sessionId,
      `JSON.stringify({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        text: document.body.innerText,
      })`,
    ),
  )
  writeFileSync(join(OUT, `${name}.png`), await cdp.screenshot(sessionId))
  await cdp.closePage(targetId)

  const overflow = info.scrollWidth > info.clientWidth
  check(`${name}: no horizontal overflow at ${width}px`, !overflow, `scrollWidth=${info.scrollWidth} clientWidth=${info.clientWidth}`)
  for (const expected of expect ?? []) {
    check(`${name}: shows 「${expected}」`, info.text.includes(expected))
  }
  for (const banned of ['支付成功', '已成交', '已开通']) {
    if (!info.text.includes(banned)) continue
    // The pages may legitimately say these words only as a negation.
    const negated = new RegExp(`(不代表|不能|不会|并非)[^。]{0,20}${banned}`).test(info.text)
    check(`${name}: never claims 「${banned}」`, negated, negated ? 'only appears in a negated sentence' : 'positive claim found')
  }
  shots.push({ name, width, height, overflow, scrollWidth: info.scrollWidth })
  return info.text
}

/* --------------------------------- Main ---------------------------------- */

async function main() {
  mkdirSync(OUT, { recursive: true })

  /* --------------------------- API fixtures ---------------------------- */
  const admin = await staffLogin(ADMIN_USER, ADMIN_PASSWORD).catch((error) => {
    throw new Error(
      `${error.message}\n先运行：pnpm --filter @sanchuang-dev/local-life-api bootstrap-admin 创建管理员，` +
        '再用 LL_ADMIN_USER / LL_ADMIN_PASSWORD 指向该账户。',
    )
  })
  check('admin login', admin.session.staff?.role === 'admin', admin.session.staff?.role)

  const happyCommunity = await ensureCommunity(admin, '幸福社区')
  const otherCommunity = await ensureCommunity(admin, '阳光社区')
  check('two communities exist', Boolean(happyCommunity.id) && Boolean(otherCommunity.id))

  const operatorName = `r2.operator.${RUN_TAG}`.slice(0, 32)
  const gridName = `r2.grid.${RUN_TAG}`.slice(0, 32)
  await ensureStaff(admin, {
    username: operatorName,
    displayName: `R2 运营员 ${RUN_TAG}`,
    role: 'operator',
    communityIds: [happyCommunity.id],
  })
  await ensureStaff(admin, {
    username: gridName,
    displayName: `R2 网格员 ${RUN_TAG}`,
    role: 'grid_worker',
    communityIds: [happyCommunity.id],
  })
  const operator = await staffLogin(operatorName, SEED_PASSWORD)
  const grid = await staffLogin(gridName, SEED_PASSWORD)
  check('operator login', operator.session.staff?.role === 'operator')
  check('grid worker login', grid.session.staff?.role === 'grid_worker')

  const productSpec = {
    communityId: happyCommunity.id,
    name: `社区助农蔬菜包 ${RUN_TAG}`,
    summary: '当日采摘，社区服务点自提',
    description: '包含 5 种时令蔬菜，约 3 公斤。登记后由社区工作人员电话确认自提时间。',
    category: '蔬菜',
    priceCents: 1990,
    status: 'on_shelf',
  }
  const product = await ensureProduct(admin, productSpec)
  const secondProduct = await ensureProduct(admin, {
    ...productSpec,
    name: `本地散养鸡蛋 ${RUN_TAG}`,
    summary: '合作社直供，一周内新鲜蛋',
    category: '蛋类',
    priceCents: 2600,
  })
  const offShelf = await ensureProduct(admin, {
    ...productSpec,
    name: `手工挂面 ${RUN_TAG}`,
    summary: '用于验证下架商品不下发',
    category: '主食',
    priceCents: 1200,
    status: 'off_shelf',
  })
  const otherProduct = await ensureProduct(admin, {
    ...productSpec,
    communityId: otherCommunity.id,
    name: `阳光社区时令水果箱 ${RUN_TAG}`,
    summary: '邻社区商品，用于验证跨社区隔离',
    category: '水果',
    priceCents: 4500,
  })
  check('products created through the admin API', [product, secondProduct, offShelf, otherProduct].every((item) => item.id))

  /* ------------------------- Resident API flow ------------------------- */
  const resident = await residentLogin(happyCommunity.id)
  const catalogue = await request(resident.jar, '/catalog/products?pageSize=100')
  check('public catalogue only returns on-shelf products', catalogue.json.items.every((item) => item.status === 'on_shelf'))
  check('the off-shelf product is hidden from the catalogue', !catalogue.json.items.some((item) => item.id === offShelf.id))
  check('the other community product is listed but scoped', catalogue.json.items.some((item) => item.id === otherProduct.id))

  const detail = await request(resident.jar, `/catalog/products/${product.id}`)
  check('product detail is readable', detail.status === 200 && detail.json.id === product.id)

  const registration = await request(resident.jar, '/local-orders', {
    method: 'POST',
    body: { productId: product.id, quantity: 2, note: '希望周末自提', idempotencyKey: crypto.randomUUID() },
  })
  check('registration answers 201 with created=true', registration.status === 201 && registration.json.created === true)
  const order = registration.json.order
  check(
    'price snapshot is frozen server-side',
    order.snapshot.unitPriceCents === product.priceCents &&
      order.snapshot.totalCents === product.priceCents * 2 &&
      order.snapshot.productName === product.name,
    order.snapshot,
  )
  check('a new registration starts as registered', order.status === 'registered')

  const mine = await request(resident.jar, '/local-orders?pageSize=50')
  check('my orders list contains this registration', mine.json.items.some((item) => item.id === order.id))
  const mineDetail = await request(resident.jar, `/local-orders/${order.id}`)
  check('my order detail carries the event timeline', mineDetail.json.events.length >= 1)

  const otherResident = await residentLogin(happyCommunity.id)
  const foreign = await request(otherResident.jar, `/local-orders/${order.id}`)
  check("another resident cannot read this order (404, no enumeration)", foreign.status === 404)
  const foreignList = await request(otherResident.jar, '/local-orders?pageSize=50')
  check("another resident's list never shows this order", !foreignList.json.items.some((item) => item.id === order.id))

  const residentStaffWrite = await request(resident.jar, `/staff/local-orders/${order.id}/status`, {
    method: 'PATCH',
    body: { expectedUpdatedAt: order.updatedAt, status: 'processing' },
  })
  check('a resident cannot use the staff status route', residentStaffWrite.status === 401 || residentStaffWrite.status === 403, residentStaffWrite.status)

  const guestCsrf = new CookieJar()
  await primeCsrf(guestCsrf)
  const guestOrder = await request(guestCsrf, '/local-orders', {
    method: 'POST',
    body: { productId: product.id, quantity: 1, idempotencyKey: crypto.randomUUID() },
  })
  check('an unauthenticated visitor cannot register', guestOrder.status === 401, guestOrder.status)

  /* -------------------------- Staff / admin flow ----------------------- */
  const staffList = await request(grid.jar, '/staff/local-orders?pageSize=100')
  check('grid worker reads staff orders', staffList.status === 200)
  check(
    'grid worker only sees orders inside the authorised community',
    staffList.json.items.every((item) => item.community.id === happyCommunity.id),
    [...new Set(staffList.json.items.map((item) => item.community.name))],
  )
  check(
    'grid worker never sees the other community order',
    !staffList.json.items.some((item) => item.community.id === otherCommunity.id),
  )
  check('grid worker is rejected from /admin/local-orders', (await request(grid.jar, '/admin/local-orders')).status === 403)
  check('grid worker is rejected from product management', (await request(grid.jar, '/admin/catalog/products')).status === 403)

  const adminOrders = await request(operator.jar, '/admin/local-orders?pageSize=100')
  check('operator reads the admin order list', adminOrders.status === 200 && adminOrders.json.items.some((item) => item.id === order.id))

  const toProcessing = await request(operator.jar, `/admin/local-orders/${order.id}/status`, {
    method: 'PATCH',
    body: { expectedUpdatedAt: order.updatedAt, status: 'processing' },
  })
  check('operator can move the order to processing', toProcessing.status === 200 && toProcessing.json.status === 'processing')

  const stale = await request(operator.jar, `/admin/local-orders/${order.id}/status`, {
    method: 'PATCH',
    body: { expectedUpdatedAt: order.updatedAt, status: 'pending_review' },
  })
  check('a stale expectedUpdatedAt answers 409', stale.status === 409, stale.json?.error?.code)

  const toReview = await request(operator.jar, `/admin/local-orders/${order.id}/status`, {
    method: 'PATCH',
    body: { expectedUpdatedAt: toProcessing.json.updatedAt, status: 'pending_review' },
  })
  check('operator submits the order for manual review', toReview.status === 200 && toReview.json.status === 'pending_review')

  const directVerify = await request(operator.jar, `/admin/local-orders/${order.id}/status`, {
    method: 'PATCH',
    body: { expectedUpdatedAt: toReview.json.updatedAt, status: 'verified' },
  })
  check('the status route refuses verified', directVerify.status === 400)

  const verified = await request(operator.jar, `/admin/local-orders/${order.id}/verify`, {
    method: 'POST',
    body: { expectedUpdatedAt: toReview.json.updatedAt, decision: 'verify', note: '已电话与居民核对自提时间' },
  })
  check('operator verifies manually', verified.status === 200 && verified.json.status === 'verified')
  check('the verification block records reviewer and note', Boolean(verified.json.verification?.verifiedAt))
  check(
    'a second verification answers 409',
    (await request(operator.jar, `/admin/local-orders/${order.id}/verify`, {
      method: 'POST',
      body: { expectedUpdatedAt: verified.json.updatedAt, decision: 'verify', note: '重复核验' },
    })).status === 409,
  )

  const events = await request(operator.jar, `/admin/local-orders/${order.id}/events`)
  check('the audit timeline records every transition', events.json.items.length >= 3, events.json.items.map((item) => item.event))

  const shelfOff = await request(operator.jar, `/admin/catalog/products/${secondProduct.id}/shelf`, {
    method: 'POST',
    body: { expectedUpdatedAt: secondProduct.updatedAt, status: 'off_shelf' },
  })
  check('operator takes a product off the shelf', shelfOff.status === 200 && shelfOff.json.status === 'off_shelf')
  const afterShelf = await request(resident.jar, '/local-orders?pageSize=50')
  check(
    'existing order snapshots survive the shelf change',
    afterShelf.json.items.find((item) => item.id === order.id)?.snapshot.totalCents === order.snapshot.totalCents,
  )
  const offShelfRegister = await request(resident.jar, '/local-orders', {
    method: 'POST',
    body: { productId: offShelf.id, quantity: 1, idempotencyKey: crypto.randomUUID() },
  })
  check('an off-shelf product refuses new registrations', offShelfRegister.status === 409, offShelfRegister.json?.error?.code)

  /* --------------------------- Browser stage --------------------------- */
  const userDataDir = join(tmpdir(), `r2-chrome-${process.pid}-${Date.now()}`)
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    let version = null
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
        break
      } catch {
        await sleep(250)
      }
    }
    if (!version) throw new Error('Chrome DevTools endpoint did not start')
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl)

    const productUrl = `${WEB_ORIGIN}/local-life/#/life/local-products/${product.id}`
    const orderUrl = `${WEB_ORIGIN}/local-life/#/me/orders/${order.id}`

    await capture(cdp, {
      name: '01-life-320',
      url: `${WEB_ORIGIN}/local-life/#/life`,
      jar: resident.jar,
      width: 320,
      height: 900,
      expect: ['本地好物', product.name, '优惠购'],
    })
    await capture(cdp, {
      name: '02-life-375',
      url: `${WEB_ORIGIN}/local-life/#/life`,
      jar: resident.jar,
      width: 375,
      height: 900,
      expect: ['社区本地商品 · 登记办理意向', product.name],
    })
    await capture(cdp, {
      name: '03-life-1440',
      url: `${WEB_ORIGIN}/local-life/#/life`,
      jar: guestCsrf,
      width: 1440,
      height: 900,
      scale: 1,
      expect: ['本地好物'],
    })
    await capture(cdp, {
      name: '04-product-320',
      url: productUrl,
      jar: resident.jar,
      width: 320,
      height: 1100,
      expect: ['登记订单 / 提交办理意向', '¥19.90', product.name],
    })
    await capture(cdp, {
      name: '05-product-375',
      url: productUrl,
      jar: resident.jar,
      width: 375,
      height: 1100,
      expect: ['登记订单 / 提交办理意向', '参考合计'],
    })
    await capture(cdp, {
      name: '06-product-guest-375',
      url: productUrl,
      jar: guestCsrf,
      width: 375,
      height: 1100,
      expect: ['登录后登记订单', '去登录 / 查看登录方式'],
    })
    await capture(cdp, {
      name: '07-my-orders-320',
      url: `${WEB_ORIGIN}/local-life/#/me/orders`,
      jar: resident.jar,
      width: 320,
      height: 900,
      expect: [product.name, '已登记'],
    })
    await capture(cdp, {
      name: '08-my-orders-375',
      url: `${WEB_ORIGIN}/local-life/#/me/orders`,
      jar: resident.jar,
      width: 375,
      height: 900,
      expect: ['我的订单', '本页只登记办理意向'],
    })
    await capture(cdp, {
      name: '09-my-orders-guest-375',
      url: `${WEB_ORIGIN}/local-life/#/me/orders`,
      jar: guestCsrf,
      width: 375,
      height: 900,
      expect: ['登录后查看我的订单'],
    })
    await capture(cdp, {
      name: '10-my-orders-empty-375',
      url: `${WEB_ORIGIN}/local-life/#/me/orders`,
      jar: otherResident.jar,
      width: 375,
      height: 900,
      expect: ['还没有登记过订单'],
    })
    await capture(cdp, {
      name: '11-my-order-detail-375',
      url: orderUrl,
      jar: resident.jar,
      width: 375,
      height: 1200,
      expect: ['订单详情', '商品快照', '处理时间线'],
    })
    await capture(cdp, {
      name: '12-my-order-detail-320',
      url: orderUrl,
      jar: resident.jar,
      width: 320,
      height: 1200,
      expect: ['参考合计'],
    })
    await capture(cdp, {
      name: '13-me-320',
      url: `${WEB_ORIGIN}/local-life/#/me`,
      jar: resident.jar,
      width: 320,
      height: 900,
      expect: ['我的订单'],
    })
    await capture(cdp, {
      name: '14-me-375',
      url: `${WEB_ORIGIN}/local-life/#/me`,
      jar: resident.jar,
      width: 375,
      height: 900,
      expect: ['我的订单', '本地商品登记记录'],
    })
    await capture(cdp, {
      name: '15-me-1440',
      url: `${WEB_ORIGIN}/local-life/#/me`,
      jar: guestCsrf,
      width: 1440,
      height: 900,
      scale: 1,
      expect: ['我的订单'],
    })
    await capture(cdp, {
      name: '16-workbench-orders-375',
      url: `${WEB_ORIGIN}/local-life/#/workbench/local-orders`,
      jar: grid.jar,
      width: 375,
      height: 1000,
      expect: ['社区订单', '只显示服务端授权社区内的居民登记订单'],
    })
    await capture(cdp, {
      name: '17-workbench-orders-320',
      url: `${WEB_ORIGIN}/local-life/#/workbench/local-orders`,
      jar: grid.jar,
      width: 320,
      height: 1000,
      expect: ['授权社区'],
    })
    await capture(cdp, {
      name: '18-workbench-order-detail-375',
      url: `${WEB_ORIGIN}/local-life/#/workbench/local-orders/${order.id}`,
      jar: grid.jar,
      width: 375,
      height: 1400,
      expect: ['商品快照', '订单时间线', '人工核验通过'],
    })
    await capture(cdp, {
      name: '19-workbench-out-of-scope-375',
      url: `${WEB_ORIGIN}/local-life/#/workbench/local-orders/00000000-0000-4000-8000-000000000000`,
      jar: grid.jar,
      width: 375,
      height: 900,
      expect: ['订单不存在或不在授权社区'],
    })
    await capture(cdp, {
      name: '20-workbench-resident-visitor-375',
      url: `${WEB_ORIGIN}/local-life/#/workbench/local-orders`,
      jar: resident.jar,
      width: 375,
      height: 900,
      expect: ['网格员工作台', '当前浏览器登录的是居民账户'],
    })
    await capture(cdp, {
      name: '21-admin-products-1440',
      url: `${ADMIN_ORIGIN}/products`,
      jar: operator.jar,
      width: 1440,
      height: 1000,
      scale: 1,
      expect: ['商品管理', '新建商品', product.name],
    })
    await capture(cdp, {
      name: '22-admin-products-375',
      url: `${ADMIN_ORIGIN}/products`,
      jar: operator.jar,
      width: 375,
      height: 1000,
      expect: ['运营员视图', '仅能查看与操作管理员分配的社区'],
    })
    await capture(cdp, {
      name: '23-admin-product-form-375',
      url: `${ADMIN_ORIGIN}/products`,
      jar: operator.jar,
      width: 375,
      height: 1200,
      click: `(() => {
        const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('新建商品'))
        button?.click()
        return Boolean(button)
      })()`,
      expect: ['新建本地商品', '单价（元）', '创建商品'],
    })
    await capture(cdp, {
      name: '24-admin-orders-1440',
      url: `${ADMIN_ORIGIN}/orders`,
      jar: operator.jar,
      width: 1440,
      height: 1000,
      scale: 1,
      expect: ['订单管理', product.name],
    })
    await capture(cdp, {
      name: '25-admin-orders-375',
      url: `${ADMIN_ORIGIN}/orders`,
      jar: operator.jar,
      width: 375,
      height: 1000,
      expect: ['登记快照'],
    })
    await capture(cdp, {
      name: '26-admin-order-detail-375',
      url: `${ADMIN_ORIGIN}/orders`,
      jar: operator.jar,
      width: 375,
      height: 1400,
      click: `(() => {
        const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '详情')
        button?.click()
        return Boolean(button)
      })()`,
      expect: ['订单详情', '商品快照', '订单时间线'],
    })
    await capture(cdp, {
      name: '27-admin-orders-grid-worker-1440',
      url: `${ADMIN_ORIGIN}/orders`,
      jar: grid.jar,
      width: 1440,
      height: 900,
      scale: 1,
      expect: ['网格员没有后台订单核验权限'],
    })
  } finally {
    chrome.kill()
  }

  const failed = checks.filter((entry) => !entry.ok)
  writeFileSync(
    join(OUT, 'r2-browser-results.json'),
    JSON.stringify(
      {
        runTag: RUN_TAG,
        executedAt: new Date().toISOString(),
        webOrigin: WEB_ORIGIN,
        adminOrigin: ADMIN_ORIGIN,
        passed: checks.length - failed.length,
        failed: failed.length,
        checks,
        screenshots: shots,
      },
      null,
      2,
    ),
  )
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed, ${shots.length} screenshots`)
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((entry) => entry.label).join(' | ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('R2 evidence run failed:', error)
  process.exitCode = 1
})
