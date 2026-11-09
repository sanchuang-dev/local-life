/**
 * LL-MVP-011 resident WeChat profile consent browser evidence.
 *
 * Requires the disposable API + Vite servers and seeded fake provider from the
 * README. The browser uses a WeChat user agent, but the real WeChat authorize
 * host is intercepted at the browser request boundary. No external OAuth is
 * attempted and no real credential is used.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const WEB = process.env.LL_WEB_ORIGIN ?? 'http://127.0.0.1:5181'
const API = process.env.LL_API_ORIGIN ?? 'http://127.0.0.1:4181'
const DATABASE = process.env.LL_EVIDENCE_DATABASE
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG_PORT = Number(process.env.LL_CDP_PORT ?? 9431)
const OUT = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)))
const APP_ID = 'wx1234567890abcdef'
const APP_OPENID = `ll-mvp-011-${randomUUID()}`
const WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003129) NetType/WIFI Language/zh_CN'

if (!DATABASE) throw new Error('LL_EVIDENCE_DATABASE is required')
mkdirSync(OUT, { recursive: true })

const apiRequire = createRequire(join(ROOT, 'apps/api/package.json'))
const Database = apiRequire('better-sqlite3')
const db = new Database(DATABASE)
const results = []
const authorizeRequests = []
const profileStartResponses = []
let chrome
let socket
let chromeProfile
let cdp

function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  assert.ok(ok, name)
}

function wait(ms) {
  return sleep(ms)
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

async function waitForDebugger() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const tabs = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const tab = tabs.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (tab) return tab
    } catch {
      // Chrome has not opened its debugging endpoint yet.
    }
    await wait(100)
  }
  throw new Error('Chrome DevTools endpoint did not become ready')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
        else pending.resolve(message.result)
        return
      }
      if (message.method === 'Fetch.requestPaused') {
        const url = message.params.request.url
        if (url.startsWith('https://open.weixin.qq.com/')) {
          authorizeRequests.push(url)
          void this.send('Fetch.failRequest', {
            requestId: message.params.requestId,
            errorReason: 'Aborted',
          }).catch(() => {})
        } else {
          void this.send('Fetch.continueRequest', { requestId: message.params.requestId }).catch(() => {})
        }
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response
        if (response.url.includes('/auth/wechat/profile/start')) {
          profileStartResponses.push({ status: response.status, url: response.url })
        }
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 8_000)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    }
    return response.result.value
  }

  async waitFor(expression, label, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression)
        if (value) return value
      } catch {
        // Navigation can temporarily detach the execution context.
      }
      await wait(100)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  async viewport(width, height = 812) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    })
    await wait(150)
  }

  async screenshot(name) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    writeFileSync(join(OUT, name), Buffer.from(result.data, 'base64'))
  }

  async navigate(url) {
    await this.send('Page.navigate', { url })
    await this.waitFor('document.readyState === "complete"', 'document load')
  }
}

async function main() {
  chromeProfile = join(tmpdir(), `ll-mvp-011-chrome-${process.pid}`)
  mkdirSync(chromeProfile, { recursive: true })
  chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${chromeProfile}`,
    `--user-agent=${WECHAT_UA}`,
    '--window-size=375,812',
    'about:blank',
  ], { stdio: 'ignore' })

  const tab = await waitForDebugger()
  socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome WebSocket open timeout')), 8_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome WebSocket failed')) }, { once: true })
  })
  cdp = new Cdp(socket)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.viewport(375)
  await cdp.navigate(`${WEB}/me`)

  await cdp.waitFor(
    `document.body.innerText.includes('登录本地生活')`,
    'resident login entry',
  )
  await cdp.waitFor(
    `[...document.querySelectorAll('button')].some((item) => item.innerText.includes('开发测试登录'))`,
    'development resident login button',
  )
  const loginClicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.includes('开发测试登录'))
    if (!button) return false
    button.scrollIntoView({ block: 'center' })
    button.click()
    return true
  })()`)
  record('real browser can use the local resident test login', loginClicked)
  await cdp.waitFor(
    `document.body.innerText.includes('居民账户 · 已登录')`,
    'authenticated resident session',
  )
  const session = await cdp.evaluate(`fetch('/api/auth/session', { credentials: 'include' }).then((response) => response.json())`)
  record('browser session is authenticated', session.authenticated === true && Boolean(session.user?.id))
  const userId = session.user.id

  db.prepare(`
    INSERT INTO wechat_identities
      (id, user_id, app_id, open_id, union_id, nickname, avatar_url, profile_authorized_at, created_at)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
  `).run(randomUUID(), userId, APP_ID, APP_OPENID, Date.now())

  await cdp.navigate(`${WEB}/me`)
  await cdp.waitFor(`document.body.innerText.includes('尚未授权。是否同步由你决定')`, 'unconsented profile state')
  const consentButton = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === '授权同步')
    if (!button) return false
    const rect = button.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== 'hidden'
  })()`)
  record('explicit profile-consent button is visible in WeChat browser', consentButton)
  await cdp.screenshot('01-profile-consent-375.png')

  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://open.weixin.qq.com/*', requestStage: 'Request' }],
  })
  const clicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === '授权同步')
    if (!button) return false
    button.scrollIntoView({ block: 'center' })
    button.click()
    return true
  })()`)
  record('resident click starts the profile authorization action', clicked)
  const deadline = Date.now() + 5_000
  while (authorizeRequests.length === 0 && Date.now() < deadline) await wait(100)
  console.log('profile-start', JSON.stringify({
    href: await cdp.evaluate('location.href'),
    responseStatuses: profileStartResponses.map((item) => item.status),
    interceptedAuthorizeRequests: authorizeRequests.length,
  }))
  const authorizeUrl = authorizeRequests[0]
  record('WeChat authorize request was intercepted before leaving the test browser', Boolean(authorizeUrl))
  const parsedAuthorize = authorizeUrl ? new URL(authorizeUrl) : null
  record('explicit click requests snsapi_userinfo', parsedAuthorize?.searchParams.get('scope') === 'snsapi_userinfo')
  record('authorize request uses the configured AppID', parsedAuthorize?.searchParams.get('appid') === APP_ID)
  record('profile start API returned HTTP 200', profileStartResponses.some((response) => response.status === 200))

  const stateRow = db.prepare(`
    SELECT purpose, user_id, config_id, consumed_at
      FROM oauth_states
     WHERE purpose = 'profile'
     ORDER BY created_at DESC
     LIMIT 1
  `).get()
  record('OAuth state is bound to the current resident', stateRow?.purpose === 'profile' && stateRow.user_id === userId)
  record('OAuth state pins the initiating WeChat config version', Boolean(stateRow?.config_id))
  record('uncompleted browser authorization has not consumed its state', stateRow?.consumed_at === null)
  await cdp.send('Fetch.disable')

  // The HTTP+SQLite test proves callback persistence. Here we seed the exact
  // persisted shape so the real H5 can prove its refresh/render behavior.
  db.prepare(`
    UPDATE wechat_identities
       SET nickname = ?, avatar_url = ?, profile_authorized_at = ?
     WHERE user_id = ? AND app_id = ? AND open_id = ?
  `).run(
    '测试微信昵称',
    `${WEB}/favicon.svg`,
    Date.now(),
    userId,
    APP_ID,
    APP_OPENID,
  )

  await cdp.navigate(`${WEB}/me`)
  await cdp.waitFor(`document.body.innerText.includes('微信昵称：测试微信昵称')`, 'persisted profile display')
  await cdp.waitFor(
    `[...document.images].some((image) => image.src.endsWith('/favicon.svg') && image.complete && image.naturalWidth > 0)`,
    'persisted avatar image load',
  )
  record('H5 renders the persisted avatar URL',
    await cdp.evaluate(`[...document.images].some((image) => image.src.endsWith('/favicon.svg') && image.complete && image.naturalWidth > 0)`))
  record('H5 displays the persisted WeChat nickname without replacing platform displayName',
    await cdp.evaluate(`document.querySelector('h1')?.innerText === '本地测试居民'`))
  record('H5 offers refresh after profile consent has been saved',
    await cdp.evaluate(`document.body.innerText.includes('已获得你的授权，可在这里更新微信资料。') && [...document.querySelectorAll('button')].some((item) => item.innerText.trim() === '更新资料')`))
  await cdp.screenshot('02-profile-authorized-375.png')

  await cdp.viewport(320)
  const narrowLayout = await cdp.evaluate(`({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, height: window.innerHeight })`)
  record('320px H5 layout has no horizontal overflow', narrowLayout.width === 320 && narrowLayout.scrollWidth <= 321, JSON.stringify(narrowLayout))
  await cdp.screenshot('03-profile-authorized-320.png')

  await cdp.viewport(375)
  await cdp.navigate(`${WEB}/me?wechat_profile=cancelled`)
  await cdp.waitFor(`document.body.innerText.includes('你已取消微信资料授权，当前登录状态不受影响。')`, 'cancelled authorization feedback')
  const afterCancel = await cdp.evaluate(`({
    query: location.search,
    loggedIn: document.body.innerText.includes('居民账户 · 已登录'),
  })`)
  record('cancelled feedback is shown and the one-off query marker is removed',
    !afterCancel.query.includes('wechat_profile') && afterCancel.loggedIn, JSON.stringify(afterCancel))
  await cdp.screenshot('04-profile-cancelled-375.png')

  const finalSession = await cdp.evaluate(`fetch('/api/auth/session', { credentials: 'include' }).then((response) => response.json())`)
  record('cancelling profile consent leaves the resident session intact', finalSession.authenticated === true && finalSession.user?.id === userId)

  writeFileSync(join(OUT, 'browser-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    webOrigin: WEB,
    apiOrigin: API,
    viewportCssPixels: [375, 320],
    externalWechatAuthorization: 'blocked before network; no real WeChat credentials used',
    results,
    screenshots: [
      '01-profile-consent-375.png',
      '02-profile-authorized-375.png',
      '03-profile-authorized-320.png',
      '04-profile-cancelled-375.png',
    ],
  }, null, 2) + '\n')
}

try {
  await main()
} finally {
  try { db.close() } catch { /* already closed */ }
  try { socket?.close() } catch { /* already closed */ }
  if (chrome && !chrome.killed) {
    chrome.kill('SIGTERM')
    await Promise.race([new Promise((resolvePromise) => chrome.once('exit', resolvePromise)), wait(2_000)])
  }
  if (chromeProfile) rmSync(chromeProfile, { recursive: true, force: true })

}
