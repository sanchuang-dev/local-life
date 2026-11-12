#!/usr/bin/env node
/**
 * LL-MVP-006 · H5/后台接线（t4 / a3-ui）的真实浏览器证据采集。
 *
 * 一个进程里做三件事，全部走真实 HTTP 与真实 Chrome（CDP）：
 *   1. 用真实管理员 API 建活动/发布，用真实 dev-login 建居民与三人团，签到，
 *      由管理员核验，再由队长领取一次性凭据码；
 *   2. 用真实 Chrome 打开每一条页面路径（375 / 320），记录
 *      documentScrollWidth / documentClientWidth / bodyScrollWidth / innerWidth，
 *      截图，并把每个断言写成机器可读 JSON；
 *   3. 管理台编辑抽屉「有/无奖励计划」两态、/activities/checkin 四个页签。
 *
 * 前置（不负责启动，避免脚本偷偷改环境）：
 *   - API   http://127.0.0.1:4081   （pnpm dev:local；AUTH_DEV_ENABLED=true）
 *   - H5    http://localhost:5222/local-life/
 *   - Admin http://localhost:5223/
 *   - Chrome --headless=new --remote-debugging-port=9222
 *
 * 用法：
 *   node verify.cjs --out <dir> --admin-session <token> --admin-csrf <token>
 *   （管理员会话由调用方用真实 /auth/login 或 bootstrap-admin 得到后传入，
 *     脚本不把凭据写进证据文件。）
 */

'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

const API = 'http://127.0.0.1:4082'
const WEB = 'http://localhost:5224/local-life/'
const ADMIN = 'http://localhost:5225/'
const CDP = 'http://127.0.0.1:9222'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const OUT_DIR = argOf('--out', '/tmp/ll-mvp-006-ui/out')
const SHOT_DIR = path.join(OUT_DIR, 'screenshots')
const ADMIN_SESSION = argOf('--admin-session', '')
const ADMIN_CSRF = argOf('--admin-csrf', '')
const RUN_TAG = argOf('--tag', new Date().toISOString().replace(/[:.]/g, '-'))

fs.mkdirSync(SHOT_DIR, { recursive: true })

/* ------------------------------ HTTP helpers ------------------------------ */

/** Minimal cookie-jar client: one instance == one authenticated identity. */
class Client {
  constructor(cookies = {}) {
    this.jar = { ...cookies }
  }

  cookieHeader() {
    return Object.entries(this.jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  request(method, urlPath, body) {
    const url = new URL(urlPath, API)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const headers = { accept: 'application/json' }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    const cookies = this.cookieHeader()
    if (cookies) headers.cookie = cookies
    const csrf = this.jar.ll_csrf
    if (csrf) headers['x-csrf-token'] = csrf
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            for (const raw of res.headers['set-cookie'] || []) {
              const [pair] = raw.split(';')
              const idx = pair.indexOf('=')
              this.jar[pair.slice(0, idx)] = pair.slice(idx + 1)
            }
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = text ? JSON.parse(text) : null
            } catch {
              json = null
            }
            resolve({ status: res.statusCode, json, text })
          })
        },
      )
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  get(p) {
    return this.request('GET', p)
  }
  post(p, b) {
    return this.request('POST', p, b ?? {})
  }
  patch(p, b) {
    return this.request('PATCH', p, b)
  }
}

const utcIso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z')
const days = (n) => new Date(Date.now() + n * 86400_000)

/* ------------------------------- CDP client ------------------------------- */

function getWs() {
  // 仓库里已有 ws；用绝对路径避免脚本位置影响解析。
  const candidates = [
    '/Users/tao/Desktop/workspace/new-local-life/local-life/node_modules/.pnpm/ws@8.22.1/node_modules/ws',
    'ws',
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      /* try next */
    }
  }
  throw new Error('ws 不可用：请安装或调整 candidates 路径')
}

const WebSocket = getWs()

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    events.push(msg)
  })
  return {
    ws,
    events,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const msgId = ++id
        pending.set(msgId, { resolve, reject })
        ws.send(JSON.stringify({ id: msgId, method, params }))
      }),
    ready: new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    }),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* --------------------------------- setup --------------------------------- */

const RESULTS = []
let assertionSeq = 0
function record(id, label, pass, evidence) {
  assertionSeq += 1
  RESULTS.push({ id, seq: assertionSeq, label, pass, evidence })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`${mark} ${id} ${label}`)
}

async function bootstrap() {
  if (!ADMIN_SESSION || !ADMIN_CSRF) {
    throw new Error('缺少 --admin-session / --admin-csrf：请先用真实管理员登录取得会话')
  }
  const admin = new Client({ ll_session: ADMIN_SESSION, ll_csrf: ADMIN_CSRF })
  const who = await admin.get('/auth/session')
  if (who.json?.staff?.role !== 'admin') {
    throw new Error(`管理员会话无效：${JSON.stringify(who.json)?.slice(0, 200)}`)
  }

  const community = await admin.post('/admin/communities', {
    name: `银发验收社区-${RUN_TAG.slice(-6)}`,
    code: `YJ${crypto.randomBytes(3).toString('hex')}`,
  })
  if (community.status !== 201) throw new Error(`建社区失败 ${community.status} ${community.text}`)
  const communityId = community.json.id

  // 网格员账户：现场核销用（真实 POST /admin/staff）
  const gridUser = `grid.${crypto.randomBytes(3).toString('hex')}`
  const gridPass = `Grid!${crypto.randomBytes(6).toString('hex')}`
  const gridStaff = await admin.post('/admin/staff', {
    username: gridUser,
    displayName: '网格员甲',
    password: gridPass,
    role: 'grid_worker',
    communityIds: [communityId],
  })
  if (gridStaff.status !== 201) throw new Error(`建网格员失败 ${gridStaff.status} ${gridStaff.text}`)

  const grid = new Client()
  await grid.get('/auth/csrf')
  const gridLogin = await grid.post('/auth/login', { username: gridUser, password: gridPass })
  if (gridLogin.status !== 200) throw new Error(`网格员登录失败 ${gridLogin.status}`)

  /** 建活动（带 rewardPlan）并发布。 */
  async function createActivity(title, plan, { withPlan = true } = {}) {
    const keyRules = {
      startsAt: utcIso(days(-1)),
      endsAt: utcIso(days(12)),
      location: '幸福社区党群服务中心',
      budgetCapCents: 400000,
      prizeQuantityCap: 120,
      publicRules: {
        eligibility: '本社区 60 岁以上居民',
        checkin: '到社区服务中心签到',
        purchase: '现场购买指定套餐',
        prizeClaim: '凭 10 位核销码领取',
      },
      ...(withPlan ? { rewardPlan: plan } : {}),
    }
    const created = await admin.post('/admin/activities', { communityId, title, keyRules })
    if (created.status !== 201) throw new Error(`建活动失败 ${created.status} ${created.text}`)
    const published = await admin.post(`/admin/activities/${created.json.id}/publish`, {
      expectedUpdatedAt: created.json.updatedAt,
    })
    if (published.status !== 200) throw new Error(`发布失败 ${published.status} ${published.text}`)
    return { ...published.json, communityId }
  }

  const planA = {
    prizeName: '东北大米 10 斤装',
    prizeUnitCostCents: 4500,
    prizeQuantityPerTeam: 3,
    totalPrizeQuantity: 30,
    budgetCapCents: 135000,
    claimRecipient: 'leader',
    checkinWindow: { opensAt: utcIso(days(-1)), closesAt: utcIso(days(12)) },
    redemptionValidHours: 72,
    notes: '社区仓库统一发放',
  }
  // 第二场：用于「未核验签到」对照（只核验 2/3）
  const planB = {
    prizeName: '手工饺子礼盒',
    prizeUnitCostCents: 5500,
    prizeQuantityPerTeam: 2,
    totalPrizeQuantity: 24,
    budgetCapCents: 132000,
    claimRecipient: 'any_member',
    checkinWindow: { opensAt: utcIso(days(-1)), closesAt: utcIso(days(12)) },
    redemptionValidHours: 24,
    notes: '现场领取',
  }
  const activityA = await createActivity(`银发验收主活动 ${RUN_TAG.slice(-6)}`, planA)
  const activityB = await createActivity(`银发验收未核验对照 ${RUN_TAG.slice(-6)}`, planB)
  const activityNoPlan = await createActivity(
    `银发验收无计划 ${RUN_TAG.slice(-6)}`,
    null,
    { withPlan: false },
  )

  /** 真实 dev-login 建一个居民，并按邀请码入团、签到。 */
  async function joinResident(activityId, name, inviteCode) {
    const client = new Client()
    await client.get('/auth/csrf')
    const login = await client.post('/auth/dev/login', { displayName: name, communityId })
    if (login.status !== 200) throw new Error(`dev login 失败 ${login.status}`)
    const join = await client.post(
      `/activities/${activityId}/participation`,
      inviteCode ? { inviteCode } : {},
    )
    if (join.status !== 200) throw new Error(`参与失败 ${join.status} ${join.text}`)
    const forNext = join.json.state?.team?.inviteCode ?? inviteCode ?? null
    const checkin = await client.post(`/activities/${activityId}/checkin`)
    return {
      name,
      userId: login.json.user.id,
      client,
      cookies: client.jar,
      teamId: join.json.state?.team?.id ?? null,
      inviteCodeForNext: forNext,
      checkinStatus: checkin.status,
      checkin: checkin.json?.checkin ?? null,
    }
  }

  // 活动 A：3 人成团，全部核验，队长领码
  const teamA = []
  let invite = null
  for (const name of ['张阿姨', '李大叔', '王奶奶']) {
    const person = await joinResident(activityA.id, name, invite)
    invite = person.inviteCodeForNext
    teamA.push(person)
  }
  // 活动 B：只核验 2 人，第三人保持未核验
  const teamB = []
  invite = null
  for (const name of ['周阿姨', '吴大爷', '郑奶奶']) {
    const person = await joinResident(activityB.id, name, invite)
    invite = person.inviteCodeForNext
    teamB.push(person)
  }

  async function checkinList(activityId) {
    return (await admin.get(`/admin/activities/${activityId}/checkins`)).json
  }

  for (const item of (await checkinList(activityA.id)).items) {
    await admin.post(`/admin/activities/${activityA.id}/checkins/${item.id}/verify`, {})
  }
  // B：只核验吴大爷/郑奶奶，周阿姨留待核验
  for (const item of (await checkinList(activityB.id)).items) {
    if (item.displayName !== '周阿姨') {
      await admin.post(`/admin/activities/${activityB.id}/checkins/${item.id}/verify`, {})
    }
  }

  // 队长领取：明文码只在这次响应里出现
  const claimA = await teamA[0].client.post(`/activities/${activityA.id}/rewards/claim`)
  if (claimA.status !== 200) throw new Error(`领奖失败 ${claimA.status} ${claimA.text}`)
  const codeA = claimA.json.code

  return {
    admin,
    grid,
    communityId,
    activities: {
      a: { id: activityA.id, title: activityA.title, prizeName: planA.prizeName, plan: planA },
      b: { id: activityB.id, title: activityB.title, prizeName: planB.prizeName, plan: planB },
      noPlan: { id: activityNoPlan.id, title: activityNoPlan.title },
    },
    teamA,
    teamB,
    codeA,
  }
}

/* --------------------------- browser measurement -------------------------- */

const PAGE_PROBE = `(() => {
  const de = document.documentElement
  /**
   * 页面级横向溢出只可能由「没有任何祖先裁剪」的元素造成。祖先若为
   * overflow-x: hidden/auto/scroll，元素会被裁剪或进入该祖先自己的滚动区，
   * 既不会撑宽 document，也不构成页面溢出——antd 的 Tabs 就是这样把多余的
   * 页签收进「更多」下拉。这里把两种情况分开统计，避免把可用的溢出菜单
   * 误判为布局缺陷。
   */
  const clippingAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return p
    }
    return null
  }
  const pastViewport = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.right > de.clientWidth + 1
    })
  const overflowing = pastViewport
    .filter((el) => clippingAncestor(el) === null)
    .slice(0, 8)
    .map((el) => el.tagName + '.' + String(el.className).slice(0, 60)
      + ' right=' + Math.round(el.getBoundingClientRect().right))
  const clippedByScroller = pastViewport
    .filter((el) => clippingAncestor(el) !== null)
    .slice(0, 8)
    .map((el) => el.tagName + '.' + String(el.className).slice(0, 46)
      + ' right=' + Math.round(el.getBoundingClientRect().right))
  const smallTaps = [...document.querySelectorAll('a,button,[role=button]')]
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.height < 44
    })
    .slice(0, 8)
    .map((el) => el.tagName + ' h=' + Math.round(el.getBoundingClientRect().height)
      + ' ' + el.textContent.trim().slice(0, 20))
  return {
    innerWidth: window.innerWidth,
    documentClientWidth: de.clientWidth,
    documentScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    hasHorizontalOverflow: de.scrollWidth > de.clientWidth + 1,
    overflowing,
    clippedByScroller,
    smallTaps,
    hash: location.hash,
    text: document.body.innerText,
  }
})()`

async function makeBrowser() {
  const version = await fetch(`${CDP}/json/version`).then((r) => r.json())
  const list = await fetch(`${CDP}/json/list`).then((r) => r.json())
  const target = list.find((t) => t.type === 'page')
  if (!target) throw new Error('CDP 没有可用的 page target')
  const cdp = connectCdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800))
    return r.result.value
  }

  const setCookies = async (cookies) => {
    await cdp.send('Network.clearBrowserCookies')
    for (const [name, value] of Object.entries(cookies)) {
      await cdp.send('Network.setCookie', { name, value, domain: 'localhost', path: '/' })
    }
  }

  /**
   * hash 变化是 same-document 导航，React 不会重新挂载；切换身份或复用同一
   * URL 时必须先回 about:blank 做一次真正的文档加载，否则量到的是上一个
   * 身份的 React 状态。
   */
  const open = async (url, { forceReload = false } = {}) => {
    if (forceReload) {
      await cdp.send('Page.navigate', { url: 'about:blank' })
      await sleep(400)
    }
    await cdp.send('Page.navigate', { url })
    await sleep(4000)
  }

  const viewport = (width, height) =>
    cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width <= 430,
    })

  /**
   * 截图只覆盖视口，而管理台/H5 的实际滚动发生在内部容器（.app-content /
   * 移动端 shell 的滚动区），因此「页面顶部」的截图拍不到断言里的内容。
   * 这里先记录容器初始 scrollTop，需要时滚到目标文本所在位置再截，截完还原。
   */
  const shot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'))
    return `screenshots/${name}`
  }

  /** 滚动容器，含 antd Layout 内容区与移动端 shell 的滚动区。 */
  const scrollRoot = () =>
    evaluate(`(() => {
      const candidates = [
        document.querySelector('.app-content'),
        document.querySelector('.app-main'),
        document.scrollingElement,
      ].filter(Boolean)
      return candidates.length
        ? candidates.map((e) => e.className || e.tagName).map(String)
        : []
    })()`)

  /**
   * 把包含指定文本的元素滚入视口，并返回它在视口内的矩形。
   * 截图只覆盖视口，所以「证据截图里能看到这行字」必须用矩形实测，
   * 不能只靠调用过 scrollIntoView 就宣称拍到。
   */
  const scrollToText = async (needle) => {
    const result = await evaluate(`(() => {
      const el = [...document.querySelectorAll('body *')]
        .filter((e) => e.children.length === 0 && e.textContent.includes(${JSON.stringify(needle)}))
        .pop()
      if (!el) return { status: 'NOT_FOUND' }
      el.scrollIntoView({ block: 'center' })
      return { status: 'scrolled' }
    })()`)
    await sleep(700)
    if (result.status !== 'scrolled') return result
    const rect = await evaluate(`(() => {
      const el = [...document.querySelectorAll('body *')]
        .filter((e) => e.children.length === 0 && e.textContent.includes(${JSON.stringify(needle)}))
        .pop()
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
        right: Math.round(r.right),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0
          && r.right <= window.innerWidth,
      }
    })()`)
    // 始终返回对象，避免把字符串当对象挂属性（Object.assign 会产生包装对象，
    // 使 `=== 'ok'` 悄悄变成 false）。
    return { status: rect && rect.inViewport ? 'ok' : 'OUT_OF_VIEWPORT', rect }
  }

  const clickText = async (text) => {
    const clicked = await evaluate(`(() => {
      const want = ${JSON.stringify(text.replace(/\s+/g, ''))}
      const el = [...document.querySelectorAll('button,a,[role=button],[role=tab]')]
        .find((e) => e.textContent.replace(/\\s+/g, '').includes(want))
      if (!el) return 'NOT_FOUND'
      el.click()
      return el.tagName + ':' + el.textContent.trim().slice(0, 24)
    })()`)
    await sleep(1500)
    return clicked
  }

  return {
    cdp,
    evaluate,
    setCookies,
    open,
    viewport,
    shot,
    scrollRoot,
    scrollToText,
    clickText,
    chromeVersion: version.Browser,
  }
}

/** 在给定身份下量一条页面并截图。 */
async function measurePage(browser, { id, label, url, cookies, width, height = 812, forceReload = true, shot: wantShot = true }) {
  await browser.viewport(width, height)
  await browser.setCookies(cookies)
  await browser.open(url, { forceReload })
  const probe = await browser.evaluate(PAGE_PROBE)
  const shotPath = wantShot ? await browser.shot(`${id}-${width}.png`) : null
  const pass =
    !probe.hasHorizontalOverflow &&
    probe.documentScrollWidth === probe.documentClientWidth &&
    probe.overflowing.length === 0
  record(id, label, pass, {
    url,
    viewport: `${width}x${height}`,
    innerWidth: probe.innerWidth,
    documentClientWidth: probe.documentClientWidth,
    documentScrollWidth: probe.documentScrollWidth,
    bodyScrollWidth: probe.bodyScrollWidth,
    hasHorizontalOverflow: probe.hasHorizontalOverflow,
    overflowingElements: probe.overflowing,
    clippedByScroller: probe.clippedByScroller,
    smallTapTargets: probe.smallTaps,
    hash: probe.hash,
    screenshot: shotPath,
    textExcerpt: probe.text.replace(/\n{2,}/g, '\n').slice(0, 1500),
  })
  return probe
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log(`LL-MVP-006 UI 证据采集 · ${RUN_TAG}`)
  const setup = await bootstrap()
  const browser = await makeBrowser()
  console.log(`Chrome ${browser.chromeVersion}`)

  const resident = setup.teamA[0].cookies // 队长：可见凭据与团队奖励
  const unverified = setup.teamB[0].cookies // 周阿姨：未核验
  const verified = setup.teamB[1].cookies // 吴大爷：已核验
  const adminCookies = { ll_session: ADMIN_SESSION, ll_csrf: ADMIN_CSRF }

  /* ---- 1. 居民 H5：活动页 / 我的奖励 / 网格员现场核验，375 与 320 ---- */
  const campaignUrl = `${WEB}#/community/activity/silver-neighborhood?activityId=${setup.activities.a.id}`
  for (const width of [375, 320]) {
    const p = await measurePage(browser, {
      id: `ui-${width}-campaign`,
      label: `${width} 银发活动页（真实签到/团队奖励/凭据）无横向溢出`,
      url: campaignUrl,
      cookies: resident,
      width,
    })
    record(`ui-${width}-campaign-real`, '活动页展示真实签到与团队奖励数据', 
      p.text.includes('已核验') && p.text.includes('团队奖励') && p.text.includes('我的奖励凭据'),
      {
        hasVerifiedCheckin: p.text.includes('已核验'),
        hasTeamReward: p.text.includes('团队奖励'),
        hasCredential: p.text.includes('我的奖励凭据'),
        maskedCode: (p.text.match(/\*{6}[A-Z0-9]{4}/) || [null])[0],
      })
    record(`ui-${width}-campaign-demo`, '抽奖/大奖/阶梯仍明确标注为演示',
      p.text.includes('奖品与抽取均为前端演示，不代表真实发放') &&
        p.text.includes('奖品仅作活动示例') &&
        p.text.includes('示例奖品 · 非真实库存'),
      {
        lotteryDemo: p.text.includes('奖品与抽取均为前端演示，不代表真实发放'),
        finalPrizeDemo: p.text.includes('奖品仅作活动示例'),
        giftDemo: p.text.includes('示例奖品 · 非真实库存'),
      })
  }

  for (const width of [375, 320]) {
    const p = await measurePage(browser, {
      id: `ui-${width}-rewards`,
      label: `${width} 我的奖励页无横向溢出`,
      url: `${WEB}#/me/rewards`,
      cookies: resident,
      width,
    })
    record(`ui-${width}-rewards-buckets`, '我的奖励按服务端状态分桶',
      p.text.includes('已核销') && p.text.includes('待领取') && p.text.includes('待达成'),
      {
        hasRedeemed: p.text.includes('已核销'),
        hasClaimable: p.text.includes('待领取'),
        hasPending: p.text.includes('待达成'),
        maskedCode: (p.text.match(/\*{6}[A-Z0-9]{4}/) || [null])[0],
      })
  }

  for (const width of [375, 320]) {
    await measurePage(browser, {
      id: `ui-${width}-verify`,
      label: `${width} 网格员现场核验页无横向溢出`,
      url: `${WEB}#/workbench/verify`,
      cookies: setup.grid.jar,
      width,
    })
  }

  /* ---- 2. 未核验 vs 已核验 对照（同一团队，同一活动） ---- */
  const campaignB = `${WEB}#/community/activity/silver-neighborhood?activityId=${setup.activities.b.id}`
  const unv = await measurePage(browser, {
    id: 'ui-375-unverified',
    label: '375 未核验签到显示「待核验」',
    url: campaignB,
    cookies: unverified,
    width: 375,
    shot: false,
  })
  const unvShot = await browser.scrollToText('待核验')
  await browser.shot('ui-375-unverified-375.png')
  record('ui-375-unverified-copy', '未核验签到不得显示为已签到（截图内可见）',
    unv.text.includes('待核验') && !unv.text.includes('签到已由工作人员现场核验'),
    {
      hasPendingLabel: unv.text.includes('待核验'),
      claimsVerified: unv.text.includes('签到已由工作人员现场核验'),
      labelInViewport: unvShot.status,
      labelRect: unvShot.rect,
      progressLine: (unv.text.match(/有效签到\n\d\/\d/) || [null])[0],
      excerpt: unv.text.slice(unv.text.indexOf('我的签到'), unv.text.indexOf('我的签到') + 420),
    })

  const ver = await measurePage(browser, {
    id: 'ui-375-verified',
    label: '375 已核验签到显示「已核验」并计入进度',
    url: campaignB,
    cookies: verified,
    width: 375,
    shot: false,
  })
  const verShot = await browser.scrollToText('签到已由工作人员现场核验，计入团队奖励进度。')
  await browser.shot('ui-375-verified-375.png')
  record('ui-375-verified-copy', '已核验签到文案与未核验不同',
    ver.text.includes('签到已由工作人员现场核验') &&
      ver.text.includes('待核验') === false,
    {
      claimsVerified: ver.text.includes('签到已由工作人员现场核验'),
      labelInViewport: verShot.status,
      labelRect: verShot.rect,
      progressLine: (ver.text.match(/有效签到\n\d\/\d/) || [null])[0],
      excerpt: ver.text.slice(ver.text.indexOf('我的签到'), ver.text.indexOf('我的签到') + 420),
    })
  const unvProgress = (unv.text.match(/有效签到\n(\d)\/(\d)/) || []).slice(1, 3)
  const verProgress = (ver.text.match(/有效签到\n(\d)\/(\d)/) || []).slice(1, 3)
  record('ui-375-progress-excludes-unverified', '未核验签到不计入团队奖励进度',
    unvProgress[0] === '2' && verProgress[0] === '2' && verProgress[1] === '3',
    { unverifiedViewProgress: unvProgress, verifiedViewProgress: verProgress })

  /* ---- 3. 领码 → 10 位明文 → 刷新只剩尾号 ---- */
  // 活动 A 的队长在 bootstrap 已领过码；这里用页面重新读取，验证「刷新后只剩尾号」。
  const afterReload = await measurePage(browser, {
    id: 'ui-375-credential-after-reload',
    label: '375 刷新后凭据只显示尾号',
    url: campaignUrl,
    cookies: resident,
    width: 375,
  })
  const masked = (afterReload.text.match(/\*{6}[A-Z0-9]{4}/) || [null])[0]
  const codeShot = await browser.scrollToText('我的奖励凭据')
  await browser.shot('ui-375-credential-after-reload-375.png')
  record('ui-claim-code-shape', '领取当次返回 10 位凭据码（0-9/A-Z，无 I/L/O/U）',
    typeof setup.codeA === 'string' &&
      /^[0-9A-HJKMNP-TV-Z]{10}$/.test(setup.codeA),
    { code: setup.codeA, length: setup.codeA.length })
  record('ui-credential-masked-after-reload', '刷新后明文码不再出现，只显示 ******尾号',
    afterReload.text.includes('******') &&
      !afterReload.text.includes(setup.codeA) &&
      masked !== null &&
      masked.slice(-4) === setup.codeA.slice(-4),
    {
      plaintextStillVisible: afterReload.text.includes(setup.codeA),
      maskedCodeInViewport: codeShot.status,
      maskedCodeRect: codeShot.rect,
      maskedCode: masked,
      codeTail: setup.codeA.slice(-4),
      displayedTail: masked ? masked.slice(-4) : null,
    })

  /* ---- 4. 网格员真实核销：成功 / 重复 / 未知码 ---- */
  await browser.viewport(375, 812)
  await browser.setCookies(setup.grid.jar)
  await browser.open(`${WEB}#/workbench/verify`, { forceReload: true })
  const typeCode = async (code) =>
    browser.evaluate(`(() => {
      const input = document.querySelector('input')
      if (!input) return 'NO_INPUT'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(code)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`)
  // 活动 B 故意留 1 人未核验：领奖必须被服务端以 409 拒绝，而不是发出凭据。
  const claimB = await setup.teamB[0].client.post(`/activities/${setup.activities.b.id}/rewards/claim`)
  record('ui-claim-blocked-by-unverified', '团队仅 2/3 已核验时领奖被服务端拒绝（未核验不计入）',
    claimB.status === 409 && claimB.json?.error?.code === 'reward_unavailable',
    {
      status: claimB.status,
      errorCode: claimB.json?.error?.code ?? null,
      message: claimB.json?.error?.message ?? null,
      issuedCode: claimB.json?.code ?? null,
    })

  // 核销用活动 A 队长的真实码（bootstrap 领取，此刻仍是 granted 未核销）。
  const codeB = setup.codeA
  if (codeB) {
    await typeCode(codeB)
    await sleep(600)
    await browser.shot('ui-375-redeem-typed.png')
    await browser.clickText('确认核销')
    await sleep(3000)
    const ok = await browser.evaluate(PAGE_PROBE)
    const receiptScroll = await browser.scrollToText('核销成功，奖品已交付。')
    record('ui-375-redeem-success', '网格员输码核销成功并显示真实回执',
      ok.text.includes('核销成功') && receiptScroll.status === 'ok', {
        excerpt: ok.text.slice(ok.text.indexOf('核销成功'), ok.text.indexOf('核销成功') + 320).replace(/\n{2,}/g, '\n'),
        receiptInViewport: receiptScroll.status,
        receiptRect: receiptScroll.rect ?? null,
        screenshot: await browser.shot('ui-375-redeem-success.png'),
      })

    // 重复核销：服务端 409，页面按 error.code 给文案
    await typeCode(codeB)
    await sleep(500)
    await browser.clickText('确认核销')
    await sleep(3000)
    const dup = await browser.evaluate(PAGE_PROBE)
    const dupScroll = await browser.scrollToText('该核销码已被核销')
    record('ui-375-redeem-duplicate', '重复核销被服务端拒绝并给出真实原因',
      /已被核销|已核销/.test(dup.text) && !dup.text.includes('核销成功，奖品已交付。'), {
        excerpt: dup.text.slice(dup.text.indexOf('核销凭据码'), dup.text.indexOf('核销凭据码') + 500).replace(/\n{2,}/g, '\n'),
        errorInViewport: dupScroll.status,
        errorRect: dupScroll.rect ?? null,
        screenshot: await browser.shot('ui-375-redeem-duplicate.png'),
      })

    // 未知码：404 redemption_code_invalid
    await typeCode('ZZZZZZZZZZ')
    await sleep(500)
    await browser.clickText('确认核销')
    await sleep(2500)
    const bad = await browser.evaluate(PAGE_PROBE)
    const badScroll = await browser.scrollToText('核销码无效')
    record('ui-375-redeem-invalid', '未知码返回真实无效提示（不伪造成功）',
      bad.text.includes('核销码无效') && badScroll.status === 'ok', {
        excerpt: bad.text.slice(bad.text.indexOf('核销凭据码'), bad.text.indexOf('核销凭据码') + 520).replace(/\n{2,}/g, '\n'),
        errorInViewport: badScroll.status,
        errorRect: badScroll.rect ?? null,
        screenshot: await browser.shot('ui-375-redeem-invalid.png'),
      })
  }

  /* ---- 5. 管理台 /activities/checkin ---- */
  for (const width of [1440, 375, 320]) {
    const p = await measurePage(browser, {
      id: `admin-${width}-checkin`,
      label: `管理台 /activities/checkin ${width} 无横向溢出`,
      url: `${ADMIN}#/activities/checkin`,
      cookies: adminCookies,
      width,
      height: width === 1440 ? 900 : 812,
    })
    if (width === 1440) {
      // 切换到有奖励计划的活动
      const switched = await browser.evaluate(`(() => {
        const opt = [...document.querySelectorAll('.ant-select-item-option')]
        return opt.length
      })()`)
      record('admin-checkin-page', '管理台核销台渲染真实数据（四个页签 + 冻结计划）',
        p.text.includes('报名与核销') && p.text.includes('签到与奖励'), {
          tabs: ['签到核验', '奖励列表', '核销记录', '异常处理'].filter((t) => p.text.includes(t)),
          hasPlanCardOrWarning:
            p.text.includes('冻结的奖励计划') || p.text.includes('该活动未配置奖励计划'),
          optionCountBeforeOpen: switched,
          textExcerpt: p.text.slice(0, 1200).replace(/\n{2,}/g, '\n'),
        })
    }
  }

  /* ---- 5b. 窄屏下管理台页签必须仍可达（antd「更多」下拉） ---- */
  for (const width of [375, 320]) {
    await browser.viewport(width, 812)
    await browser.setCookies(adminCookies)
    await browser.open(`${ADMIN}#/activities/checkin`, { forceReload: true })
    const reach = await browser.evaluate(`(() => {
      const wraps = [...document.querySelectorAll('.ant-tabs-nav-wrap')]
      const inner = wraps.find((w) => w.textContent.includes('签到核验'))
      if (!inner) return { ok: false, reason: 'NO_INNER_TABS' }
      const nav = inner.closest('.ant-tabs-nav')
      const more = nav.querySelector('.ant-tabs-nav-more')
      const hidden = [...nav.querySelectorAll('.ant-tabs-tab')]
        .filter((t) => t.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map((t) => t.textContent.trim().slice(0, 20))
      if (!hidden.length) return { ok: true, hidden, dropdownItems: null, note: '所有页签直接可见' }
      if (!more) return { ok: false, reason: 'NO_MORE_BUTTON', hidden }
      for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
        more.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
      }
      return { ok: true, hidden, moreRight: Math.round(more.getBoundingClientRect().right) }
    })()`)
    await sleep(1200)
    const dropdown = await browser.evaluate(`[...document.querySelectorAll('.ant-tabs-dropdown-menu-item')].map((e) => e.textContent.trim())`)
    const inner = await browser.evaluate(`(() => {
      const wraps = [...document.querySelectorAll('.ant-tabs-nav-wrap')]
      const w = wraps.find((x) => x.textContent.includes('签到核验'))
      const nav = w && w.closest('.ant-tabs-nav')
      return nav ? [...nav.querySelectorAll('.ant-tabs-tab')]
        .filter((t) => t.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map((t) => t.textContent.trim()) : []
    })()`)
    const covered = inner.every((label) =>
      dropdown.some((d) => d.startsWith(label.replace(/（.*$/, '').trim())),
    )
    record(`admin-${width}-tabs-reachable`,
      `${width} 管理台被裁剪的页签都能从「更多」下拉进入`,
      reach.ok === true && (inner.length === 0 || covered),
      { hiddenTabs: inner, dropdownItems: dropdown, covered, detail: reach })
  }

  /* ---- 6. 管理台编辑抽屉：有 / 无计划两态 ---- */
  const drawerProbe = `(() => {
    const drawer = document.querySelector('.ant-drawer-open') || document.querySelector('.ant-drawer')
    if (!drawer) return { open: false }
    const items = [...drawer.querySelectorAll('.ant-form-item')]
    const values = {}
    for (const it of items) {
      const label = (it.querySelector('.ant-form-item-label') || {}).textContent || ''
      const inputs = [...it.querySelectorAll('input')]
      if (!label || !inputs.length) continue
      values[label.trim()] = inputs.map((i) => i.value).join(' | ')
    }
    const sw = drawer.querySelector('.ant-switch')
    return {
      open: true,
      switchOn: sw ? sw.classList.contains('ant-switch-checked') : null,
      values,
      text: drawer.innerText,
      textareas: [...drawer.querySelectorAll('textarea')].map((t) => t.value),
    }
  })()`

  async function openEditorFor(title) {
    await browser.setCookies(adminCookies)
    await browser.open(`${ADMIN}#/activities`, { forceReload: true })
    const opened = await browser.evaluate(`(() => {
      const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes(${JSON.stringify(title)}))
      if (!row) return 'NO_ROW'
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.replace(/\\s+/g, '') === '编辑')
      if (!btn) return 'NO_BTN'
      btn.click()
      return 'ok'
    })()`)
    await sleep(3000)
    return opened
  }

  await browser.viewport(1440, 900)
  await openEditorFor(setup.activities.a.title)
  const withPlan = await browser.evaluate(drawerProbe)
  const plan = setup.activities.a.plan
  const backfilled =
    withPlan.open === true &&
    withPlan.switchOn === true &&
    withPlan.values['奖品名称'] === plan.prizeName &&
    withPlan.values['单件成本（元）'] === (plan.prizeUnitCostCents / 100).toFixed(2) &&
    withPlan.values['每团奖品数量'] === String(plan.prizeQuantityPerTeam) &&
    withPlan.values['奖品总库存（份）'] === String(plan.totalPrizeQuantity) &&
    withPlan.values['奖励预算上限（元）'] === (plan.budgetCapCents / 100).toFixed(2) &&
    withPlan.values['核销有效期（小时）'] === String(plan.redemptionValidHours)
  record('admin-drawer-plan-backfill', '编辑抽屉从 detail.rewardPlan 回填全部字段（无只读降级）',
    backfilled, { switchOn: withPlan.switchOn, values: withPlan.values, textareas: withPlan.textareas })
  // 抽屉内容高于视口，先滚到奖励计划分区再截图，否则拍不到回填的字段值
  await browser.evaluate(`(() => {
    const d = document.querySelector('.ant-drawer-open') || document.querySelector('.ant-drawer')
    const body = d && d.querySelector('.ant-drawer-body')
    const anchor = d && [...d.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent.includes('奖品总库存'),
    )
    if (anchor) anchor.scrollIntoView({ block: 'center' })
    else if (body) body.scrollTop = body.scrollHeight
    return anchor ? 'ok' : 'fallback'
  })()`)
  await sleep(800)
  const drawerShotWithPlan = await browser.shot('admin-drawer-with-plan.png')

  // 无修改直接保存：不得发出任何 PATCH，也不得凭空生成新规则版本
  const noopMark = browser.cdp.events.length
  await browser.evaluate(`(() => {
    const b = [...document.querySelectorAll('.ant-drawer-open button')]
      .find((x) => x.textContent.replace(/\\s+/g, '') === '保存修改')
    if (!b) return 'NO_SAVE'
    b.closest('form').requestSubmit(b)
    return 'submitted'
  })()`)
  await sleep(2500)
  const noopPatches = browser.cdp.events.slice(noopMark).filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.method === 'PATCH',
  )
  const noopText = await browser.evaluate(PAGE_PROBE)
  const noopVersion = await setup.admin.get(`/admin/activities/${setup.activities.a.id}`)
  record('admin-noop-save-no-patch', '无修改直接保存不发 PATCH、不生成新规则版本',
    noopPatches.length === 0 &&
      noopText.text.includes('没有需要保存的修改') &&
      noopVersion.json?.ruleVersion === 1,
    {
      patchCount: noopPatches.length,
      noticeShown: noopText.text.includes('没有需要保存的修改'),
      ruleVersionBeforeEdit: noopVersion.json?.ruleVersion,
    })

  // 只改「举办地点」保存 → PATCH 必须原样带 rewardPlan
  const markIndex = browser.cdp.events.length
  await browser.evaluate(`(() => {
    const item = [...document.querySelectorAll('.ant-drawer-open .ant-form-item')]
      .find((i) => ((i.querySelector('.ant-form-item-label') || {}).textContent || '').trim() === '举办地点')
    if (!item) return 'NO_ITEM'
    const input = item.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '幸福社区文化广场（证据采集）')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  await sleep(700)
  await browser.evaluate(`(() => {
    const b = [...document.querySelectorAll('.ant-drawer-open button')]
      .find((x) => x.textContent.replace(/\\s+/g, '') === '保存修改')
    if (!b) return 'NO_SAVE'
    b.closest('form').requestSubmit(b)
    return 'submitted'
  })()`)
  await sleep(2500)
  const confirmText = await browser.evaluate(`(() => {
    const m = document.querySelector('.ant-modal-confirm')
    return m ? m.innerText : null
  })()`)
  if (confirmText) {
    await browser.evaluate(`(() => {
      const b = [...document.querySelectorAll('.ant-modal-confirm button')]
        .find((x) => x.textContent.includes('生成'))
      if (b) b.click()
      return 1
    })()`)
    await sleep(4000)
  }
  const patchEvents = browser.cdp.events.slice(markIndex).filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.request.method === 'PATCH',
  )
  const patchBody = patchEvents.length ? JSON.parse(patchEvents[0].params.request.postData) : null
  const echoed = patchBody?.keyRules?.rewardPlan ?? null
  record('admin-patch-echoes-plan', '仅改地点保存时 keyRules.rewardPlan 原样回传（绝不发 null）',
    patchBody !== null &&
      patchBody.keyRules !== undefined &&
      echoed !== null &&
      echoed.prizeName === plan.prizeName &&
      echoed.prizeUnitCostCents === plan.prizeUnitCostCents &&
      echoed.totalPrizeQuantity === plan.totalPrizeQuantity &&
      echoed.claimRecipient === plan.claimRecipient,
    {
      confirmDialog: confirmText,
      patchBody,
      echoedPlan: echoed,
      screenshot: drawerShotWithPlan,
    })

  // 服务端复核：计划仍在，规则版本 +1
  const afterEdit = await setup.admin.get(`/admin/activities/${setup.activities.a.id}`)
  const overviewAfter = await setup.admin.get(`/admin/activities/${setup.activities.a.id}/rewards`)
  record('admin-plan-survives-edit', '保存后服务端仍保有奖励计划与库存',
    afterEdit.json?.rewardPlan?.prizeName === plan.prizeName &&
      overviewAfter.json?.planConfigured === true &&
      overviewAfter.json?.planSource === 'rule_version_snapshot' &&
      overviewAfter.json?.stock?.totalQuantity === plan.totalPrizeQuantity,
    {
      ruleVersion: afterEdit.json?.ruleVersion,
      rewardPlan: afterEdit.json?.rewardPlan,
      planConfigured: overviewAfter.json?.planConfigured,
      planSource: overviewAfter.json?.planSource,
      stock: overviewAfter.json?.stock && {
        totalQuantity: overviewAfter.json.stock.totalQuantity,
        claimedQuantity: overviewAfter.json.stock.claimedQuantity,
        availableQuantity: overviewAfter.json.stock.availableQuantity,
      },
    })

  // 无计划活动：不能出现空表单
  await openEditorFor(setup.activities.noPlan.title)
  const noPlan = await browser.evaluate(drawerProbe)
  await browser.evaluate(`(() => {
    const d = document.querySelector('.ant-drawer-open') || document.querySelector('.ant-drawer')
    const anchor = d && [...d.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent.includes('未配置奖励计划'),
    )
    if (anchor) anchor.scrollIntoView({ block: 'center' })
    return anchor ? 'ok' : 'fallback'
  })()`)
  await sleep(800)
  const noPlanShot = await browser.shot('admin-drawer-no-plan.png')
  record('admin-drawer-no-plan', '无计划活动显示「未配置奖励计划」告警而不是空表单',
    noPlan.open === true && noPlan.switchOn === false && noPlan.text.includes('未配置奖励计划'),
    { switchOn: noPlan.switchOn, excerpt: noPlan.text.slice(noPlan.text.indexOf('奖励履约计划'), noPlan.text.indexOf('奖励履约计划') + 420).replace(/\n{2,}/g, '\n'), screenshot: noPlanShot })

  /* ------------------------------- 收尾 ------------------------------- */

  const summary = {
    runTag: RUN_TAG,
    generatedAt: new Date().toISOString(),
    environment: {
      chrome: browser.chromeVersion,
      api: API,
      web: WEB,
      admin: ADMIN,
      driver: 'Chrome DevTools Protocol（裸 CDP over ws，无 puppeteer）',
      viewports: ['375x812@2x', '320x812@2x', '1440x900@1x（管理台）'],
    },
    setup: {
      communityId: setup.communityId,
      activities: setup.activities,
      teams: {
        a: setup.teamA.map((p) => ({ name: p.name, userId: p.userId, teamId: p.teamId })),
        b: setup.teamB.map((p) => ({ name: p.name, userId: p.userId, teamId: p.teamId })),
      },
      // 只铸造过一次明文码：活动 A 队长领奖。活动 B 故意留 1 人未核验，
      // 领奖被服务端 409 拒绝，因此没有第二个码；核销步骤复用 A 的码。
      mintedPlaintextCodes: [setup.codeA],
      redeemedCode: codeB,
    },
    totals: {
      assertions: RESULTS.length,
      passed: RESULTS.filter((r) => r.pass).length,
      failed: RESULTS.filter((r) => !r.pass).length,
    },
    assertions: RESULTS,
  }
  fs.writeFileSync(path.join(OUT_DIR, 'browser-runs.json'), JSON.stringify(summary, null, 2))
  console.log(`\n${summary.totals.passed}/${summary.totals.assertions} PASS → ${path.join(OUT_DIR, 'browser-runs.json')}`)
  browser.cdp.ws.close()
  if (summary.totals.failed > 0) {
    console.log('FAILED assertions:')
    for (const r of RESULTS.filter((x) => !x.pass)) console.log(`  - ${r.id} ${r.label}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
