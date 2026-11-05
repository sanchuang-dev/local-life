#!/usr/bin/env node
/**
 * LL-MVP-006 (Issue #62) — 真实 Chrome 端到端 UI 证据（375 / 320）。
 *
 * 全部是真东西：
 *   - 真实 H5 / 管理台 dev server（Vite，/api 反代到真实 Hono API）
 *   - 真实 Chrome（--headless=new + CDP，不用 jsdom、不用 puppeteer 替身）
 *   - 真实 API + 真实 SQLite（场景全部先用 HTTP 造出来，再让浏览器读同一份数据）
 *
 * 断言的不是"页面能打开"，而是：
 *   - 页面文案里的数字与 API/SQL 里的数字一致；
 *   - 375 与 320 两种宽度下 documentElement.scrollWidth === clientWidth（横向不溢出）；
 *   - 明文凭据码只在领取当次出现，刷新后变成 ******XXXX；
 *   - 网格员页面输入真实码能核销、再核销一次得到真实失败文案；
 *   - 管理台抽屉「有 rewardPlan / 无 rewardPlan」两态与 API 一致。
 *
 * 用法：
 *   node docs/engineering/evidence/ll-mvp-006/r2/browser.cjs \
 *     [--api http://127.0.0.1:4091] [--web http://localhost:5241/local-life/] \
 *     [--admin http://localhost:5242/] [--cdp http://127.0.0.1:9333] \
 *     [--pass-file /tmp/ll-mvp-006-r2/admin-pass.txt] [--chrome <path>]
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const API = arg('api', 'http://127.0.0.1:4091')
const WEB = arg('web', 'http://localhost:5241/local-life/')
const ADMIN = arg('admin', 'http://localhost:5242/')
const CDP = arg('cdp', 'http://127.0.0.1:9333')
const PASS_FILE = arg('pass-file', '/tmp/ll-mvp-006-r2/admin-pass.txt')
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const OUT_DIR = arg('out', __dirname)
const SHOT_DIR = path.join(OUT_DIR, 'browser')
const OUT = path.join(OUT_DIR, 'r2-browser-runs.json')
const PROFILE = '/tmp/ll-mvp-006-r2/chrome-profile'

const RUNS = []
function rec(id, label, pass, evidence, data) {
  RUNS.push({ id, label, pass: Boolean(pass), evidence: String(evidence), ...(data ? { data } : {}) })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${label} :: ${evidence}`)
}

const utcIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

/* ------------------------------ HTTP client ------------------------------ */

class Client {
  constructor(base, name) {
    this.base = new URL(base)
    this.name = name
    this.cookies = new Map()
    this.csrf = null
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') || undefined
  }
  absorb(res) {
    for (const line of res.headers['set-cookie'] || []) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const key = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '') this.cookies.delete(key)
      else this.cookies.set(key, value)
    }
  }
  request(method, pathname, body) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.base.hostname,
          port: this.base.port,
          method,
          path: pathname,
          headers: {
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
            ...(this.header() ? { cookie: this.header() } : {}),
            ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
          },
          timeout: 30000,
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            this.absorb(res)
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
      req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${pathname}`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
  get(p) { return this.request('GET', p) }
  post(p, b) { return this.request('POST', p, b === undefined ? {} : b) }
}

/* --------------------------------- Chrome -------------------------------- */

const WebSocket = (() => {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules/.pnpm/ws@8.22.1/node_modules/ws'),
    'ws',
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      /* next */
    }
  }
  throw new Error('ws 不可用')
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} => ${res.status}`)
  return res.json()
}

class Browser {
  constructor(ws, options = {}) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.nav = 0
    this.defaultWait = options.defaultWait ?? 2500
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  static async launch({ port, chrome, profile }) {
    fs.rmSync(profile, { recursive: true, force: true })
    const proc = spawn(
      chrome,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--hide-scrollbars',
        '--window-size=375,812',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const errs = []
    proc.stderr.on('data', (d) => errs.push(String(d)))
    for (let i = 0; i < 100; i += 1) {
      try {
        await fetchJson(`http://127.0.0.1:${port}/json/version`)
        break
      } catch {
        await sleep(200)
        if (i === 99) throw new Error('Chrome 未启动:\n' + errs.join('').slice(-2000))
      }
    }
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`)
    const page = list.find((t) => t.type === 'page')
    if (!page) throw new Error('没有 page target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    const browser = new Browser(ws, {})
    browser.proc = proc
    await browser.send('Page.enable')
    await browser.send('Runtime.enable')
    await browser.send('Network.enable')
    return browser
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`JS 异常: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`)
    }
    return r.result.value
  }
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width <= 430,
    })
  }
  async cookies(cookieMap) {
    await this.send('Network.clearBrowserCookies')
    for (const [name, value] of Object.entries(cookieMap)) {
      await this.send('Network.setCookie', { name, value, domain: 'localhost', path: '/' })
    }
  }
  async open(url, wait = this.defaultWait, { hard = false } = {}) {
    this.nav += 1
    if (hard) {
      await this.send('Page.navigate', { url: 'about:blank' })
      await sleep(400)
    }
    await this.send('Page.navigate', { url: `${url}${url.includes('?') ? '&' : '?'}_r2=${this.nav}` })
    await sleep(wait)
  }
  async reload(wait = this.defaultWait) {
    await this.send('Page.reload', { ignoreCache: true })
    await sleep(wait)
  }
  async shot(name) {
    const s = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'))
    return `browser/${name}`
  }
  text() {
    return this.evaluate('document.body.innerText')
  }
  /**
   * Real layout numbers plus, for every element sticking out of the viewport,
   * whether it sits inside a deliberate horizontal scroller (a chip row). That
   * distinction is the difference between "the page overflows" and "a chip row
   * scrolls, which is the design".
   */
  metrics() {
    return this.evaluate(`(() => {
      const de = document.documentElement
      const overflowEls = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)
        })
      /**
       * An element sticking out of the viewport is only a defect when the user
       * cannot reach it: inside an overflow-x:auto scroller it is reachable by
       * scrolling; inside overflow-x:hidden it is clipped and lost.
       */
      const describe = (el) => {
        let parent = el.parentElement
        let scroller = null
        let clipper = null
        while (parent && parent !== document.body) {
          const style = getComputedStyle(parent)
          if (/auto|scroll/.test(style.overflowX) && scroller === null) {
            scroller = String(parent.className || parent.tagName).slice(0, 50)
            break
          }
          if (/hidden|clip/.test(style.overflowX) && clipper === null) {
            clipper = String(parent.className || parent.tagName).slice(0, 50)
          }
          parent = parent.parentElement
        }
        return {
          el: (el.className && String(el.className).slice(0, 50)) || el.tagName,
          horizontalScroller: scroller,
          clippedBy: clipper,
        }
      }
      // Count over EVERY overflowing element; only the printed sample is capped,
      // otherwise "5 inside a scroller" silently means "5 of the first 8".
      const allDescribed = overflowEls.map(describe)
      const described = allDescribed.slice(0, 8)
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
        overflow: de.scrollWidth > de.clientWidth + 1,
        overflowingCount: overflowEls.length,
        overflowingInsideScroller: allDescribed.filter((d) => d.horizontalScroller !== null).length,
        overflowingClipped: allDescribed.filter((d) => d.horizontalScroller === null && d.clippedBy !== null).length,
        overflowingUnreachable: allDescribed.filter((d) => d.horizontalScroller === null && d.clippedBy === null).length,
        overflowingElements: described,
      }
    })()`)
  }
  /** Click the first element whose trimmed innerText equals `label`. */
  async click(label, { tag = '*' } = {}) {
    return this.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)}
      const nodes = [...document.querySelectorAll(${JSON.stringify(tag)})]
      const hit = nodes.find((el) => (el.innerText || '').trim() === wanted && el.offsetParent !== null)
        || nodes.find((el) => (el.innerText || '').trim() === wanted)
      if (!hit) return { ok: false, reason: 'not-found' }
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return { ok: true, tag: hit.tagName, className: String(hit.className || '').slice(0, 80) }
    })()`)
  }
  /** Click the first element whose innerText *contains* `label`. */
  async clickContains(label, { tag = '*' } = {}) {
    return this.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)}
      const nodes = [...document.querySelectorAll(${JSON.stringify(tag)})]
        .filter((el) => (el.innerText || '').includes(wanted))
      // Prefer the deepest match so we hit the button, not its container.
      const hit = nodes.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
      if (!hit) return { ok: false, reason: 'not-found' }
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return { ok: true, tag: hit.tagName, text: (hit.innerText || '').slice(0, 60) }
    })()`)
  }
  async type(selector, value) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return { ok: false, reason: 'not-found' }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    })()`)
  }
  /** Snapshot the reward-plan form controls by their AntD `name` ids. */
  formValues(ids = [
    'rewardPlanEnabled',
    'rewardPrizeName',
    'rewardUnitCostYuan',
    'rewardQuantityPerTeam',
    'rewardTotalQuantity',
    'rewardBudgetYuan',
    'rewardClaimRecipient',
    'rewardRedemptionHours',
  ]) {
    return this.evaluate(`(() => {
      const ids = ${JSON.stringify(ids)}
      const out = {}
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) { out[id] = null; continue }
        out[id] = el.type === 'checkbox' || el.getAttribute('role') === 'switch'
          ? String(el.getAttribute('aria-checked') ?? el.checked)
          : el.value
      }
      const sw = document.querySelector('#rewardPlanEnabled')
      if (sw && out.rewardPlanEnabled === null) {
        out.rewardPlanEnabled = String(sw.getAttribute('aria-checked') ?? sw.checked)
      }
      return out
    })()`)
  }
  /** Scroll the containing block so `label` sits near the top of the viewport. */
  async scrollToText(label) {
    const moved = await this.evaluate(`(() => {
      const wanted = ${JSON.stringify(label)}
      const all = [...document.querySelectorAll('div,section,td,label,span,p')]
      const hit = all.find((el) => (el.innerText || '').includes(wanted) && el.getClientRects().length)
      if (!hit) return false
      hit.scrollIntoView({ block: 'start' })
      return true
    })()`)
    await sleep(600)
    return moved
  }
  async scrollBottom() {
    await this.evaluate(`(() => {
      const el = document.scrollingElement || document.documentElement
      el.scrollTop = el.scrollHeight
      for (const node of document.querySelectorAll('.app-content, .app-main, main')) {
        node.scrollTop = node.scrollHeight
      }
      return true
    })()`)
    await sleep(400)
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
    if (this.proc) this.proc.kill('SIGKILL')
  }
}

/* ---------------------------------- Seed --------------------------------- */

const S = {}      // scenario ids
const GRID = {}   // real staff credentials used for the UI re-login check
const CLIENTS = {} // reusable API identities

async function staffLogin(username, password, name) {
  const c = new Client(API, name)
  const csrf = await c.get('/auth/csrf')
  c.csrf = csrf.json.csrfToken
  const res = await c.post('/auth/login', { username, password })
  if (res.status !== 200) throw new Error(`${name} 登录失败 ${res.status} ${res.text}`)
  c.csrf = c.cookies.get('ll_csrf') || csrf.json.csrfToken
  return c
}

async function residentLogin(displayName, communityId) {
  const c = new Client(API, displayName)
  const csrf = await c.get('/auth/csrf')
  c.csrf = csrf.json.csrfToken
  const res = await c.post('/auth/dev/login', { displayName, communityId })
  if (res.status !== 200) throw new Error(`${displayName} dev login 失败 ${res.status} ${res.text}`)
  c.csrf = c.cookies.get('ll_csrf') || csrf.json.csrfToken
  c.userId = res.json.user.id
  return c
}

const PLAN = {
  prizeName: '社区小礼品',
  prizeUnitCostCents: 2500,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 10,
  budgetCapCents: 100000,
  claimRecipient: 'leader',
  checkinWindow: { opensAt: utcIso(-30 * 60 * 1000), closesAt: utcIso(3 * 60 * 60 * 1000) },
  redemptionValidHours: 24,
}

async function createActivity(admin, communityId, title, plan) {
  const keyRules = {
    startsAt: utcIso(-60 * 60 * 1000),
    endsAt: utcIso(6 * 60 * 60 * 1000),
    location: '验收现场 · 党群服务中心',
    budgetCapCents: 100000,
    prizeQuantityCap: 20,
    publicRules: {
      eligibility: '本社区 60 岁以上居民',
      checkin: '到社区服务中心现场签到，并由工作人员核验',
      purchase: '无需消费',
      prizeClaim: '三人成团且三人全部核验签到后，由队长领取 10 位核销码',
    },
    ...(plan ? { rewardPlan: plan } : {}),
  }
  const created = await admin.post('/admin/activities', {
    communityId,
    title,
    summary: `LL-MVP-006 浏览器验收「${title}」`,
    description: '本活动由验收脚本通过真实管理 API 创建，用于浏览器端到端取证。',
    keyRules,
  })
  if (created.status !== 201) throw new Error(`建活动失败 ${created.status} ${created.text}`)
  const published = await admin.post(`/admin/activities/${created.json.id}/publish`, {
    expectedUpdatedAt: created.json.updatedAt,
  })
  if (published.status !== 200) throw new Error(`发布失败 ${published.status} ${published.text}`)
  return published.json
}

async function seed() {
  const adminPass = fs.readFileSync(PASS_FILE, 'utf8').trim()
  const admin = await staffLogin('r2.verify', adminPass, 'admin')
  CLIENTS.admin = admin

  const community = await admin.post('/admin/communities', { name: '浏览器验收社区' })
  if (community.status !== 201) throw new Error(`建社区 ${community.status} ${community.text}`)
  S.communityId = community.json.id

  const gridUser = `r2ui.${crypto.randomBytes(3).toString('hex')}`
  const gridPass = 'r2-grid-worker-2026'
  const grid = await admin.post('/admin/staff', {
    username: gridUser,
    displayName: '验收网格员',
    password: gridPass,
    role: 'grid_worker',
    communityIds: [S.communityId],
  })
  if (grid.status !== 201) throw new Error(`建网格员 ${grid.status} ${grid.text}`)
  CLIENTS.grid = await staffLogin(gridUser, gridPass, 'grid')

  // Creation order matters: the admin pages order by `updatedAt` desc, so the
  // LAST created activity is the one the 报名与核销 page auto-selects.
  S.noPlan = await createActivity(admin, S.communityId, '浏览器验收 · 无奖励计划', null)
  S.main = await createActivity(admin, S.communityId, '浏览器验收 · 有奖励计划', PLAN)
  GRID.username = gridUser
  GRID.password = gridPass

  S.r1 = await residentLogin('验收张阿姨', S.communityId)
  S.r2 = await residentLogin('验收李大叔', S.communityId)
  S.r3 = await residentLogin('验收王奶奶', S.communityId)

  // 三人团：队长 R1 发起，R2/R3 用真实邀请码加入。
  const first = await S.r1.post(`/activities/${S.main.id}/participation`, {})
  if (first.status !== 200) throw new Error(`参与失败 ${first.status} ${first.text}`)
  const code = first.json.state.team.inviteCode
  for (const member of [S.r2, S.r3]) {
    const res = await member.post(`/activities/${S.main.id}/participation`, { inviteCode: code })
    if (res.status !== 200) throw new Error(`加入失败 ${res.status} ${res.text}`)
  }
  for (const member of [S.r1, S.r2, S.r3]) {
    const res = await member.post(`/activities/${S.main.id}/checkin`, {})
    if (res.status !== 200) throw new Error(`签到失败 ${res.status} ${res.text}`)
  }
  const list = await CLIENTS.grid.get(`/admin/activities/${S.main.id}/checkins`)
  for (const item of list.json.items) {
    const res = await CLIENTS.grid.post(
      `/admin/activities/${S.main.id}/checkins/${item.id}/verify`, {})
    if (res.status !== 200) throw new Error(`核验失败 ${res.status} ${res.text}`)
  }
  const state = await S.r1.get(`/activities/${S.main.id}/rewards`)
  if (state.status !== 200 || state.json.eligible !== true) {
    throw new Error(`场景不合格：${state.status} ${state.text.slice(0, 300)}`)
  }
  S.teamId = state.json.teamId
  S.maskedBeforeClaim = null
  return { admin, grid }
}

/* -------------------------------- Scenarios ------------------------------- */

const WEB_URL = (hash) => `${WEB}#${hash}`
const ADMIN_URL = (hash) => `${ADMIN}#${hash}`

async function run() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const { admin } = await seed()
  rec('seed.scenario', '用真实 API 造场景：1 个有奖励计划的活动（三人团 3/3、3 条已核验签到）+ 1 个无计划活动',
    true,
    `main=${S.main.id.slice(0, 8)} noPlan=${S.noPlan.id.slice(0, 8)} team=${S.teamId.slice(0, 8)} eligible=true`)

  const browser = await Browser.launch({ port: Number(new URL(CDP).port), chrome: CHROME, profile: PROFILE })
  const results = { viewport: {}, storage: {} }

  const cookieMap = (client) => Object.fromEntries(client.cookies.entries())

  /* ---------------- 375: 居民活动页 → 领取 → 明文码 ---------------- */
  await browser.viewport(375, 812)
  await browser.cookies(cookieMap(S.r1))
  await browser.open(WEB_URL(`/community/activity/silver-neighborhood?activityId=${S.main.id}`), 4200, { hard: true })
  let text = await browser.text()
  let metrics = await browser.metrics()
  const hasProgress = /团队奖励/.test(text) && /有效签到/.test(text) && /3\/3/.test(text)
  const seatText = /已成团|3 \/ 3/.test(text)
  rec('ui375.campaign', 'H5 活动页 375px 打开真实活动：团队进度来自服务端，横向不溢出',
    hasProgress && seatText && metrics.scrollWidth === metrics.clientWidth,
    `scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth} overflow=${metrics.overflow} hasProgress=${hasProgress}`)
  results.viewport['375-campaign'] = metrics
  results.storage.campaignShot = await browser.shot('375-campaign-claimable.png')

  // The claim button is rendered only when claimableByMe.
  const claimClick = await browser.clickContains('领取奖励凭据', { tag: 'button' })
  await sleep(2500)
  text = await browser.text()
  const issued = (text.match(/\b[0-9A-HJKMNP-TV-Z]{10}\b/g) || []).filter((c) => !/^3\d{9}$/.test(c))
  const newest = issued.sort((a, b) => text.indexOf(b) - text.indexOf(a))[0] || null
  const codeShown = /仅在本次显示|请截图保存/.test(text)
  rec('ui375.claim', 'H5 点击「领取奖励凭据」真的调用 API：页面出现 10 位核销码 + 一次性提示',
    claimClick.ok && codeShown && newest !== null && newest.length === 10,
    `click=${JSON.stringify(claimClick)} codeLen=${newest ? newest.length : 0} promptShown=${codeShown}`)
  // 明文码只在截图里保留（它当场就已被核销、且数据库是 /tmp 的一次性库）；
  // JSON 里只留前 4 + 后 4，避免把可用凭据写进版本库。
  results.storage.redeemedCodeRedacted = newest ? `${newest.slice(0, 4)}**${newest.slice(-4)}` : null
  results.storage.claimShot = await browser.shot('375-claim-plaintext.png')

  // The plaintext must match the server-side hash, i.e. it is the real code.
  const hash = crypto.createHash('sha256').update(newest || '', 'utf8').digest('hex')
  const dbRow = await admin.get(`/admin/activities/${S.main.id}/rewards`)
  const adminMasked = dbRow.json.grants[0]?.credentialMaskedCode ?? null
  rec('ui375.codeMatchesServer', '页面上的明文码与后台投影的掩码尾号一致（同一份真实凭据）',
    Boolean(adminMasked) && newest && adminMasked === `******${newest.slice(-4)}` && hash.length === 64,
    `pageCodeTail=${newest ? newest.slice(-4) : null} adminMasked=${adminMasked} sha256=${hash.slice(0, 12)}…`)

  /* ---------------- 375: 刷新后明文消失、只剩掩码 ---------------- */
  await browser.reload(4000)
  text = await browser.text()
  const afterReloadCode = (text.match(/\b[0-9A-HJKMNP-TV-Z]{10}\b/g) || []).filter((c) => !/^3\d{9}$/.test(c))
  const maskedShown = text.includes(`******${(newest || '').slice(-4)}`)
  rec('ui375.reloadMasked', '刷新后明文码不再出现，页面只显示 ******XXXX 掩码（服务端只存哈希）',
    afterReloadCode.length === 0 && maskedShown,
    `leftoverCodes=${afterReloadCode.length} masked=${maskedShown} pattern=${`******${(newest || '').slice(-4)}`}`)
  results.storage.reloadShot = await browser.shot('375-after-reload-masked.png')

  /* ---------------- 375: 我的奖励 ---------------- */
  await browser.open(WEB_URL('/me/rewards'), 3800)
  text = await browser.text()
  metrics = await browser.metrics()
  const walletMasked = text.includes(`******${(newest || '').slice(-4)}`)
  const walletBucket = /已核销|待核销|可领取|争议|作废/.test(text)
  rec('ui375.wallet', '我的奖励页 375px：显示同一条凭据掩码与奖励状态，横向不溢出',
    walletMasked && walletBucket && metrics.scrollWidth === metrics.clientWidth,
    `masked=${walletMasked} bucket=${walletBucket} scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`)
  results.viewport['375-wallet'] = metrics
  results.storage.walletShot = await browser.shot('375-my-rewards.png')

  /* ---------------- 375: 网格员核销（真实核销 + 重复核销失败） ---------------- */
  await browser.cookies(cookieMap(CLIENTS.grid))
  await browser.open(WEB_URL('/workbench/verify'), 3600, { hard: true })
  text = await browser.text()
  const onRedeemTab = /核销凭据码/.test(text)
  const inputOk = await browser.type('#redeem-code', newest || '')
  await sleep(300)
  const submitClick = await browser.clickContains('确认核销', { tag: 'button' })
  await sleep(3200)
  text = await browser.text()
  metrics = await browser.metrics()
  const redeemedOk = /核销成功，奖品已交付/.test(text)
  rec('ui375.gridRedeem', '网格员页面输入真实码后核销成功：UI 反映的是服务端核销结果',
    onRedeemTab && inputOk.ok && redeemedOk && metrics.scrollWidth === metrics.clientWidth,
    `tab=${onRedeemTab} input=${JSON.stringify(inputOk)} submit=${JSON.stringify(submitClick)} success=${redeemedOk} scrollWidth=${metrics.scrollWidth}/${metrics.clientWidth}`)
  results.viewport['375-workbench'] = metrics
  results.storage.redeemShot = await browser.shot('375-workbench-redeemed.png')

  // Same code again must fail with the real error, not a fake success.
  const retype = await browser.type('#redeem-code', newest || '')
  await sleep(300)
  const secondClick = await browser.clickContains('确认核销', { tag: 'button' })
  await sleep(3000)
  text = await browser.text()
  const duplicateMsg = /该奖励已核销|已核销，无法|不能重复|已被核销/.test(text)
  const successGone = !/核销成功，奖品已交付/.test(text)
  rec('ui375.gridDuplicate', '同一码第二次核销在 UI 上得到真实失败文案（不是假成功）',
    retype.ok && duplicateMsg && successGone,
    `retype=${retype.ok} click=${secondClick.ok} duplicateMessage=${duplicateMsg} successCleared=${successGone}`)
  results.storage.duplicateShot = await browser.shot('375-workbench-duplicate.png')

  // Server-side truth: the grant really is redeemed exactly once.
  const overview = await admin.get(`/admin/activities/${S.main.id}/rewards`)
  rec('ui375.serverTruth', 'UI 操作在服务端留下且仅留下一次核销（grant=redeemed、库存 redeemed=1）',
    overview.json.counts.grantsRedeemed === 1 &&
      overview.json.stock.redeemedQuantity === 1 &&
      overview.json.stock.redeemedBudgetCents === 2500,
    `grantsRedeemed=${overview.json.counts.grantsRedeemed} redeemedQty=${overview.json.stock.redeemedQuantity} redeemedBudget=${overview.json.stock.redeemedBudgetCents}`)

  /* -------- 375: 网格员退出后重新登录，页面数据仍然成立（服务端为准） -------- */
  await browser.cookies({})
  await browser.open(WEB_URL('/workbench/verify'), 3600, { hard: true })
  text = await browser.text()
  const loginShown = /网格员工作台/.test(text) && /登录工作台/.test(text)
  await browser.type('#workbench-username', GRID.username)
  await browser.type('#workbench-password', GRID.password)
  await sleep(300)
  const loginClick = await browser.clickContains('登录工作台', { tag: 'button' })
  await sleep(3800)
  text = await browser.text()
  const reloggedIn = /现场核验核销/.test(text) && /验收网格员/.test(text)
  // 页面文案只证明渲染；再让浏览器自己走一次同源 /api，证明会话真的在服务端生效。
  const sessionProbe = await browser.evaluate(`fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => ({ authenticated: j.authenticated, username: j.staff ? j.staff.username : null, role: j.staff ? j.staff.role : null }))
    .catch((e) => ({ error: String(e) }))`)
  // 授权社区内的签到列表应当可读；活动管理必须 403 —— 会话真的带上了服务端角色。
  const allowed = await browser.evaluate(`fetch('/api/admin/activities/${S.main.id}/checkins', { credentials: 'include', cache: 'no-store' })
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .then((x) => { let j = null; try { j = JSON.parse(x.body) } catch {} ; return { status: x.status, count: j && j.counts ? j.counts.total : null, items: j && j.items ? j.items.length : null, raw: x.status === 200 ? null : x.body.slice(0, 160) } })
    .catch((e) => ({ error: String(e) }))`)
  const denied = await browser.evaluate(`fetch('/api/admin/activities?page=1&pageSize=5', { credentials: 'include', cache: 'no-store' })
    .then(async (r) => ({ status: r.status, body: await r.text() }))
    .then((x) => { let j = null; try { j = JSON.parse(x.body) } catch {} ; return { status: x.status, code: j && j.error ? j.error.code : null, raw: x.body.slice(0, 120) } })
    .catch((e) => ({ error: String(e) }))`)
  const settingsOk = { allowed, denied }
  rec('ui375.relogin', '网格员清空会话后用真实账号密码重新登录：页面恢复，同源 /api 会话在服务端真的生效',
    loginShown && loginClick.ok && reloggedIn &&
      sessionProbe.authenticated === true && sessionProbe.username === GRID.username &&
      allowed.status === 200 && allowed.items === 3 &&
      denied.status === 403 && denied.code === 'forbidden',
    `loginPage=${loginShown} click=${loginClick.ok} sessionRestored=${reloggedIn} probe=${JSON.stringify(sessionProbe)} scopedRead=${JSON.stringify(allowed)} activityManage=${JSON.stringify(denied)}`)
  results.storage.reloginShot = await browser.shot('375-workbench-relogin.png')

  // Cross-check that the redeemed state survived the staff re-login.
  const afterRelogin = await CLIENTS.admin.get(`/admin/activities/${S.main.id}/rewards`)
  rec('ui375.reloginConsistency', '重新登录后管理台/H5 与库内状态一致：同一 grant 仍为 redeemed，库存未被二次占用',
    afterRelogin.json.counts.grantsRedeemed === 1 &&
      afterRelogin.json.stock.redeemedQuantity === 1,
    `grantsRedeemed=${afterRelogin.json.counts.grantsRedeemed} redeemedQty=${afterRelogin.json.stock.redeemedQuantity}`)

  /* ---------------- 管理台「活动管理」抽屉两态 ---------------- */
  const clickRowAction = (titleFragment, actionLabel) =>
    browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll('tr')]
      const row = rows.find((tr) => (tr.innerText || '').includes(${JSON.stringify(titleFragment)}))
      if (!row) return { ok: false, reason: 'row-not-found' }
      const btn = [...row.querySelectorAll('button')]
        .find((b) => (b.innerText || '').trim() === ${JSON.stringify(actionLabel)})
      if (!btn) return { ok: false, reason: 'action-not-found' }
      btn.scrollIntoView({ block: 'center' })
      btn.click()
      return { ok: true }
    })()`)
  await browser.cookies(cookieMap(admin))
  await browser.viewport(1440, 900)
  await browser.open(ADMIN_URL('/activities'), 4200, { hard: true })
  text = await browser.text()
  const listOk = /活动管理/.test(text) && text.includes('浏览器验收 · 有奖励计划')
  const editWithPlan = await clickRowAction('浏览器验收 · 有奖励计划', '编辑')
  await sleep(2800)
  text = await browser.text()
  const planForm = await browser.formValues()
  const planFieldsShown =
    planForm.rewardPlanEnabled === 'true' &&
    planForm.rewardPrizeName === PLAN.prizeName &&
    Number(String(planForm.rewardUnitCostYuan).replace(/[^0-9.]/g, '')) === PLAN.prizeUnitCostCents / 100 &&
    Number(String(planForm.rewardTotalQuantity).replace(/[^0-9]/g, '')) === PLAN.totalPrizeQuantity
  rec('admin.drawerWithPlan', '管理台编辑抽屉（有 rewardPlan）读回冻结的计划：开关已配置且奖品名称/成本/库存与计划一致',
    listOk && editWithPlan.ok && planFieldsShown,
    `list=${listOk} open=${editWithPlan.ok} switch=${planForm.rewardPlanEnabled} prize=${JSON.stringify(planForm.rewardPrizeName)} unitYuan=${JSON.stringify(planForm.rewardUnitCostYuan)} total=${JSON.stringify(planForm.rewardTotalQuantity)}`)
  await browser.scrollToText('奖励履约计划')
  results.storage.drawerWithPlanShot = await browser.shot('admin-desktop-drawer-with-plan.png')
  // Close the drawer.
  const closeDrawer = await browser.evaluate(`(() => {
    const btn = document.querySelector('.ant-drawer-close')
    if (!btn) return { ok: false }
    btn.click()
    return { ok: true }
  })()`)
  await sleep(1500)
  void closeDrawer

  // The no-plan activity: open its drawer and confirm the plan fields are empty.
  const pickNoPlan = await clickRowAction('浏览器验收 · 无奖励计划', '编辑')
  await sleep(2800)
  text = await browser.text()
  const noPlanForm = await browser.formValues()
  const noPlanEmpty =
    noPlanForm.rewardPlanEnabled === 'false' &&
    !noPlanForm.rewardPrizeName &&
    !noPlanForm.rewardTotalQuantity
  const planHint = /关闭表示该活动没有正式奖品/.test(text)
  rec('admin.drawerNoPlan', '管理台编辑抽屉（无 rewardPlan）开关为未配置、计划字段不渲染，不伪造默认值',
    pickNoPlan.ok && noPlanEmpty && planHint,
    `open=${JSON.stringify(pickNoPlan)} switch=${noPlanForm.rewardPlanEnabled} prize=${JSON.stringify(noPlanForm.rewardPrizeName)} total=${JSON.stringify(noPlanForm.rewardTotalQuantity)} hint=${planHint}`)
  await browser.scrollToText('奖励履约计划')
  results.storage.drawerNoPlanShot = await browser.shot('admin-desktop-drawer-no-plan.png')

  /* ---------------- 375: 管理台「报名与核销」四个页签 ---------------- */
  await browser.open(ADMIN_URL('/activities/checkin'), 4200)
  text = await browser.text()
  const tabs = ['签到核验', '奖励列表', '核销记录', '异常处理']
  const tabOk = tabs.every((t) => text.includes(t))
  const overviewNumbers = text.includes('社区小礼品')
  rec('admin.checkinTabs', '报名与核销页四个页签齐全，且读取到真实奖励计划与库存',
    tabOk && overviewNumbers,
    `tabs=${tabOk} realPlanShown=${overviewNumbers}`)
  const tabShots = []
  for (const [i, label] of tabs.entries()) {
    const clicked = await browser.clickContains(label, { tag: 'div[role="tab"], button' })
    await sleep(1400)
    tabShots.push(await browser.shot(`admin-desktop-checkin-tab-${i + 1}.png`))
    void clicked
  }
  results.storage.tabShots = tabShots
  const afterTabs = await browser.text()
  rec('admin.checkinTabsContent', '四个页签逐一渲染真实数据（核验计数、奖励授予、核销记录、异常）',
    /已核验|待核验/.test(afterTabs) && /已核销/.test(afterTabs),
    `hasVerifyCounts=${/已核验|待核验/.test(afterTabs)} hasRedeemed=${/已核销/.test(afterTabs)}`)

  /* ------------------------ 320: 同样四条页面 ------------------------ */
  await browser.viewport(320, 720)
  const narrow = [
    ['320-campaign', '/community/activity/silver-neighborhood?activityId=' + S.main.id, '居民活动页', S.r1],
    ['320-wallet', '/me/rewards', '我的奖励', S.r1],
    ['320-workbench', '/workbench/verify', '网格员核销页', CLIENTS.grid],
  ]
  for (const [id, hash, label, identity] of narrow) {
    await browser.cookies(cookieMap(identity))
    await browser.open(WEB_URL(hash), 4000, { hard: true })
    const m = await browser.metrics()
    const t = await browser.text()
    results.viewport[id] = m
    rec(`ui${id.startsWith('320') ? '320' : '375'}.${id}`, `${label} 320px 无横向溢出、内容真实渲染`,
      m.scrollWidth === m.clientWidth && t.length > 200 && !/加载失败|请求失败/.test(t),
      `scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} overflowEls=${m.overflowingCount} textLen=${t.length}`)
    await browser.shot(`${id}.png`)
  }
  await browser.viewport(320, 720)
  await browser.cookies(cookieMap(admin))
  await browser.open(ADMIN_URL('/activities/checkin'), 4200)
  const adminNarrow = await browser.metrics()
  const adminText = await browser.text()
  results.viewport['320-admin'] = adminNarrow
  // AntD tabs normally degrade to a "more" dropdown when they do not fit; record
  // whether the 4th tab is still reachable at 320 instead of assuming it is.
  const tabs320 = await browser.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.ant-tabs-tab')].map((t) => {
      const r = t.getBoundingClientRect()
      return { text: (t.innerText || '').trim(), right: Math.round(r.right), width: Math.round(r.width) }
    })
    const more = document.querySelector('.ant-tabs-nav-more, .ant-tabs-nav-operations button')
    return { tabs, moreButton: more ? (more.innerText || more.getAttribute('aria-label') || 'more') : null }
  })()`)
  // The 4 reward tabs plus the admin shell's own nav tabs are all `.ant-tabs-tab`,
  // so count only ours and let AntD's overflow dropdown count as "reachable".
  const ourTabs = tabs320.tabs.filter((t) =>
    ['签到核验', '奖励列表', '核销记录', '异常处理'].some((label) => t.text.includes(label)),
  )
  const tabsReachable =
    ourTabs.length === 4 && (tabs320.moreButton !== null || ourTabs.every((t) => t.right <= 320))
  rec('ui320.adminCheckin', '管理台「报名与核销」320px：文档不横向溢出，页签 4 个仍在可达范围内',
    adminNarrow.scrollWidth === adminNarrow.clientWidth && adminText.includes('报名与核销') && tabsReachable,
    `scrollWidth=${adminNarrow.scrollWidth} clientWidth=${adminNarrow.clientWidth} overflowEls=${adminNarrow.overflowingCount} insideScroller=${adminNarrow.overflowingInsideScroller} rewardTabs=${ourTabs.length} allInViewport=${ourTabs.every((t) => t.right <= 320)} moreButton=${JSON.stringify(tabs320.moreButton)} tabs=${JSON.stringify(ourTabs.map((t) => t.text + '@' + t.right))}`)
  await browser.shot('320-admin-checkin.png')

  browser.close()

  const failed = RUNS.filter((r) => !r.pass)
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    api: API,
    web: WEB,
    admin: ADMIN,
    cdp: CDP,
    scenario: {
      communityId: S.communityId,
      mainActivityId: S.main.id,
      noPlanActivityId: S.noPlan.id,
      teamId: S.teamId,
    },
    viewportMetrics: results.viewport,
    screenshots: results.storage,
    totals: { checks: RUNS.length, passed: RUNS.length - failed.length, failed: failed.length },
    failedIds: failed.map((r) => r.id),
    runs: RUNS,
  }, null, 2) + '\n')
  console.log(`\n${RUNS.length - failed.length}/${RUNS.length} browser checks passed; wrote ${OUT}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('DRIVER ERROR:', error)
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    driverError: String(error && error.stack ? error.stack : error),
    runs: RUNS,
    failedIds: RUNS.filter((r) => !r.pass).map((r) => r.id),
  }, null, 2) + '\n')
  process.exit(2)
})
