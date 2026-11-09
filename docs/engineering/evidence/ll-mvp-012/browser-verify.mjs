/**
 * LL-MVP-012 (#123) browser evidence harness — activity H5 WeChat login.
 *
 * Drives the real H5 dev server (Vite, clean-path base) against the real Hono API
 * over a real TCP listener in system Chrome, through the DevTools Protocol with
 * only Node.js built-ins (global fetch / WebSocket). No browser automation
 * dependency is installed.
 *
 * What is real here:
 * - the resident page, the `微信授权登录` button and the start URL the page builds;
 * - the API's activity lookup, community derivation, OAuth state row and cookies;
 * - the callback: state consumption, identity creation, community assignment,
 *   session cookie and the return-to redirect — the browser performs the callback
 *   navigation itself, so the nonce cookie and the 302 are genuine.
 *
 * What is NOT real, and is not claimed: a WeChat authorization. This repository
 * has no AppID/AppSecret, so nothing is sent to `open.weixin.qq.com`; the host is
 * blocked in the browser and the token exchange is answered by the evidence
 * server's in-process fake at the `fetch` boundary.
 *
 * Usage:
 *   node browser-verify.mjs [output-dir]
 *
 * Environment (defaults match the seeded evidence database):
 *   LL_WEB_ORIGIN, LL_API_ORIGIN, LL_EVIDENCE_ACTIVITY, LL_EVIDENCE_DRAFT_ACTIVITY,
 *   LL_EVIDENCE_COMMUNITY, LL_EVIDENCE_OTHER_COMMUNITY, CHROME_PATH, LL_CDP_PORT
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const WEB_ORIGIN = process.env.LL_WEB_ORIGIN ?? 'http://127.0.0.1:5173'
const API_ORIGIN = process.env.LL_API_ORIGIN ?? 'http://127.0.0.1:4080'
const ACTIVITY_ID = process.env.LL_EVIDENCE_ACTIVITY ?? '2a94e2c3-0a8c-4197-a260-25fcc4259270'
const DRAFT_ACTIVITY_ID = process.env.LL_EVIDENCE_DRAFT_ACTIVITY ?? 'a25e8edf-03e2-4528-9673-7ba312afd9a3'
const COMMUNITY_ID = process.env.LL_EVIDENCE_COMMUNITY ?? '817bd09e-6b14-41f7-b672-6450ae77dad9'
const OTHER_COMMUNITY_ID = process.env.LL_EVIDENCE_OTHER_COMMUNITY ?? '2f0aa7b4-8a8f-479e-baba-13aaa00d7774'
const INVITE = process.env.LL_EVIDENCE_INVITE ?? '0123456789abcdef0123456789abcdef'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
// A fixed DevTools port collides when several worktrees run evidence in parallel.
const DEBUG_PORT = Number(process.env.LL_CDP_PORT ?? 9400 + (process.pid % 400))
const OUT_DIR = resolve(process.argv[2] ?? '.')

const IPHONE_WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003129) NetType/WIFI Language/zh_CN'

const results = []
const requests = []
const responses = []
let cdp

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) console.warn(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok   ${name}`)
}

function headerValue(headers, name) {
  if (!headers) return null
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value
  }
  return null
}

async function snapshot() {
  const response = await fetch(`${API_ORIGIN}/__evidence/snapshot`)
  if (!response.ok) throw new Error(`snapshot failed: ${response.status}`)
  return response.json()
}

async function resetEvidenceDatabase() {
  const response = await fetch(`${API_ORIGIN}/__evidence/reset`)
  if (!response.ok) throw new Error(`reset failed: ${response.status}`)
  return response.json()
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.keepAlive = setInterval(() => {}, 30_000)
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('DevTools socket closed before the command completed'))
      }
      this.pending.clear()
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`))
        else done(message.result)
        return
      }
      if (message.method === 'Network.requestWillBeSent') {
        requests.push({
          url: message.params.request.url,
          method: message.params.request.method,
          resourceType: message.params.type,
          redirectFrom: message.params.redirectResponse ? message.params.redirectResponse.url : null,
        })
        // A redirecting response is delivered here rather than as its own
        // `responseReceived` event, so record it to keep every 302 observable.
        if (message.params.redirectResponse) {
          responses.push({
            url: message.params.redirectResponse.url,
            status: message.params.redirectResponse.status,
            headers: message.params.redirectResponse.headers,
            mimeType: message.params.redirectResponse.mimeType,
          })
        }
      }
      if (message.method === 'Network.responseReceived') {
        responses.push({
          url: message.params.response.url,
          status: message.params.response.status,
          headers: message.params.response.headers,
          mimeType: message.params.response.mimeType,
        })
      }
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolvePromise, reject) => {
      socket.addEventListener('open', resolvePromise, { once: true })
      socket.addEventListener('error', () => reject(new Error(`cannot connect ${url}`)), { once: true })
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        `page eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      )
    }
    return result.result.value
  }

  async waitFor(expression, timeoutMs = 10_000, intervalMs = 80) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression)
        if (last) return last
      } catch (error) {
        last = error.message
      }
      await sleep(intervalMs)
    }
    throw new Error(`timeout waiting for ${expression} (last: ${JSON.stringify(last)})`)
  }

  async waitUntil(predicate, label, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(100)
    }
    throw new Error(`timeout waiting for ${label}`)
  }

  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
    console.log(`shot ${name}`)
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    })
    await sleep(120)
  }

  async cookies() {
    const { cookies } = await this.send('Network.getAllCookies')
    return cookies
  }
}

const PAGE_HELPERS = String.raw`
  window.__t = {
    norm: (value) => (value ?? '').replace(/\s+/g, ''),
    list(selector, root = document) { return [...root.querySelectorAll(selector)] },
    visible(el) {
      if (!el) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    },
    byText(selector, text, root = document) {
      return this.list(selector, root).find((el) => this.visible(el) && this.norm(el.textContent).includes(this.norm(text)))
    },
    bodyText() { return this.norm(document.body.innerText) },
    click(el) {
      if (!el) throw new Error('click target missing')
      el.scrollIntoView({ block: 'center', inline: 'center' })
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }
      }
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      el.click()
      return true
    },
    clickButton(text) { return this.click(this.byText('button', text)) },
    hasButton(text) { return Boolean(this.byText('button', text)) },
    layout() {
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    },
  };
  true
`

let profile

async function launchChrome() {
  profile = join(tmpdir(), `ll-mvp-012-chrome-${Date.now()}`)
  mkdirSync(profile, { recursive: true })
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
      if (version.webSocketDebuggerUrl) break
    } catch {
      // Chrome is still starting.
    }
    await sleep(150)
  }

  const target = await (
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
  ).json()
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  // A WeChat authorization must never be attempted for real: the app has no
  // credentials, and this evidence run only needs the URL the page asked for.
  await cdp.send('Network.setBlockedURLs', { urls: ['*open.weixin.qq.com*'] })
  // The card and the login button only exist in a WeChat in-app browser.
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: IPHONE_WECHAT_UA,
    platform: 'iPhone',
    acceptLanguage: 'zh-CN,zh;q=0.9',
  })
  await cdp.setViewport(375, 812)
  return chrome
}

function activityUrl(extra = '') {
  return `${WEB_ORIGIN}/?activityId=${ACTIVITY_ID}${extra}`
}

async function navigate(url) {
  await cdp.send('Page.navigate', { url })
  await cdp.waitFor(`document.readyState === 'complete'`, 15_000)
  await cdp.eval(PAGE_HELPERS)
}

/** Navigate to the activity page and wait for the server-backed activity card. */
async function gotoActivity(url) {
  await navigate(url)
  await cdp.waitFor(`__t.bodyText().includes('三人团')`, 15_000)
  await sleep(300)
}

/**
 * Click the login entry and return the start URL the page actually requested plus
 * the API's 302. Both come from the network log, not from re-deriving the URL in
 * test code, so the assertion is about what the page did.
 */
async function clickWechatLogin() {
  await cdp.waitFor(`__t.hasButton('微信授权登录')`, 12_000)
  const before = requests.length
  const responsesBefore = responses.length
  await cdp.eval(`__t.clickButton('微信授权登录')`)
  await cdp.waitUntil(
    () => requests.slice(before).some((item) => item.url.includes('/api/auth/wechat/start')),
    'the page to request /api/auth/wechat/start',
  )
  const startRequest = requests
    .slice(before)
    .find((item) => item.url.includes('/api/auth/wechat/start'))
  await cdp.waitUntil(
    () => responses.slice(responsesBefore).some((item) => item.url.includes('/api/auth/wechat/start') && item.status === 302),
    'the API to answer the login start with a 302',
  )
  const startResponse = responses
    .slice(responsesBefore)
    .find((item) => item.url.includes('/api/auth/wechat/start') && item.status === 302)
  return { startRequest, startResponse }
}

/** Complete the only step a real WeChat would perform: come back with a code. */
async function navigateCallback(state) {
  const responsesBefore = responses.length
  const callbackUrl = `${WEB_ORIGIN}/api/auth/wechat/callback?code=evidence-browser-${Date.now()}&state=${encodeURIComponent(
    state,
  )}`
  await cdp.send('Page.navigate', { url: callbackUrl })
  await cdp.waitUntil(
    () =>
      responses
        .slice(responsesBefore)
        .some((item) => item.url.includes('/api/auth/wechat/callback') && item.status === 302),
    'the callback to answer with 302',
  )
  const callbackResponse = responses
    .slice(responsesBefore)
    .find((item) => item.url.includes('/api/auth/wechat/callback') && item.status === 302)
  await cdp.waitFor(`document.readyState === 'complete'`, 15_000)
  await cdp.eval(PAGE_HELPERS)
  return callbackResponse
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const reset = await resetEvidenceDatabase()
  check('evidence database starts without resident attribution', reset.reset === true, JSON.stringify(reset))
  const baseline = await snapshot()
  check(
    'baseline has no assignment, identity or participation',
    baseline.assignments.length === 0
      && baseline.identities.length === 0
      && baseline.counts.participations === 0
      && baseline.counts.teams === 0,
    JSON.stringify(baseline.counts),
  )

  const chrome = await launchChrome()
  try {
    console.log('--- stage 1: unauthenticated activity page ---')
    await gotoActivity(activityUrl(`&invite=${INVITE}`))
    check(
      'activity page renders the server-backed three-seat team card',
      await cdp.eval(`__t.bodyText().includes('三人团')`),
      await cdp.eval(`__t.bodyText().slice(0, 120)`),
    )
    check(
      'unauthenticated card asks the resident to log in first',
      await cdp.eval(`__t.bodyText().includes('登录后报名三人团') || __t.bodyText().includes('登录后')`),
    )
    check('WeChat login entry is offered', await cdp.eval(`__t.hasButton('微信授权登录')`))
    check(
      'login entry states that login does not auto-join',
      await cdp.eval(`__t.bodyText().includes('登录成功不会自动报名')`),
    )
    check(
      'logged-out page offers no participation confirm',
      !(await cdp.eval(`__t.hasButton('确认参与本活动') || __t.hasButton('确认接受邀请并参与')`)),
    )
    await cdp.screenshot('01-activity-login-375.png')

    console.log('--- stage 2: the login request the page builds ---')
    const { startRequest, startResponse } = await clickWechatLogin()
    const startUrl = new URL(startRequest.url)
    check(
      'login entry requests the API start route',
      startUrl.pathname === '/api/auth/wechat/start',
      startRequest.url,
    )
    check(
      'start request carries the loaded activityId',
      startUrl.searchParams.get('activityId') === ACTIVITY_ID,
      startUrl.search,
    )
    check(
      'start request never carries a communityId',
      !startUrl.searchParams.has('communityId'),
      startUrl.search,
    )
    const returnTo = startUrl.searchParams.get('returnTo')
    check(
      'start request keeps the activity and invite in the return target',
      Boolean(returnTo)
        && returnTo.includes(`activityId=${ACTIVITY_ID}`)
        && returnTo.includes(`invite=${INVITE}`),
      String(returnTo),
    )
    check('start request is a top-level navigation', startRequest.resourceType === 'Document', startRequest.resourceType)

    const location = headerValue(startResponse.headers, 'location')
    check('API answers the login start with 302', startResponse.status === 302, JSON.stringify(startResponse.status))
    const authorizeUrl = new URL(location)
    check(
      'the 302 goes to the WeChat authorization endpoint',
      authorizeUrl.origin === 'https://open.weixin.qq.com'
        && authorizeUrl.pathname === '/connect/oauth2/authorize',
      location,
    )
    check(
      'authorization redirect_uri points at this origin callback',
      authorizeUrl.searchParams.get('redirect_uri') === `${WEB_ORIGIN}/api/auth/wechat/callback`,
      String(authorizeUrl.searchParams.get('redirect_uri')),
    )
    check(
      'authorization URL carries no communityId',
      !authorizeUrl.searchParams.has('communityId'),
      authorizeUrl.search,
    )
    const state = authorizeUrl.searchParams.get('state')
    check('authorization URL carries a one-time state', Boolean(state), String(state))

    const cookiesAfterStart = await cdp.cookies()
    const nonceCookie = cookiesAfterStart.find((item) => item.name === 'll_oauth_nonce')
    check(
      'API stored a state-bound nonce cookie in the browser',
      Boolean(nonceCookie?.value) && nonceCookie.httpOnly === true,
      JSON.stringify({ httpOnly: nonceCookie?.httpOnly, path: nonceCookie?.path }),
    )

    const stateRow = (await snapshot()).oauthStates.find((item) => item.consumed === false)
    check(
      'the stored OAuth state already carries the derived community',
      stateRow?.communityId === COMMUNITY_ID,
      JSON.stringify(stateRow),
    )

    console.log('--- stage 3: callback consumes the verified state ---')
    const callbackResponse = await navigateCallback(state)
    const callbackLocation = headerValue(callbackResponse.headers, 'location')
    check(
      'callback returns to the original activity link with auth=success',
      Boolean(callbackLocation)
        && callbackLocation.startsWith(activityUrl())
        && callbackLocation.includes('auth=success'),
      String(callbackLocation),
    )
    check(
      'returned link keeps activityId and invite',
      Boolean(callbackLocation)
        && callbackLocation.includes(`activityId=${ACTIVITY_ID}`)
        && callbackLocation.includes(`invite=${INVITE}`),
      String(callbackLocation),
    )
    check(
      'browser session cookie is set by the callback',
      (await cdp.cookies()).some((item) => item.name === 'll_session' && item.httpOnly === true),
    )
    await cdp.waitFor(`__t.bodyText().includes('微信登录成功') || __t.bodyText().includes('确认参与')`, 15_000)
    await sleep(500)
    await cdp.eval(PAGE_HELPERS)
    check(
      'authenticated page presents the WeChat login success notice',
      await cdp.eval(`__t.bodyText().includes('微信登录成功')`),
      await cdp.eval(`__t.bodyText().slice(0, 200)`),
    )
    check(
      'success notice states participation still needs an explicit confirm',
      await cdp.eval(`__t.bodyText().includes('不会自动报名')`),
    )
    check(
      'participation confirm is still available and was not auto-submitted',
      await cdp.eval(`__t.hasButton('确认参与本活动') || __t.hasButton('确认接受邀请并参与')`),
      await cdp.eval(`__t.bodyText().slice(0, 200)`),
    )
    check(
      'address bar no longer replays the one-off auth marker',
      !(await cdp.eval(`location.href.includes('auth=success')`)),
      await cdp.eval(`location.href`),
    )
    const returnedUrl = await cdp.eval(`location.href`)
    check(
      'address bar keeps the activity and invite context',
      String(returnedUrl).includes(`activityId=${ACTIVITY_ID}`) && String(returnedUrl).includes(`invite=${INVITE}`),
      String(returnedUrl),
    )
    await cdp.screenshot('02-activity-logged-in-375.png')

    console.log('--- stage 4: what the login wrote in the database ---')
    const afterLogin = await snapshot()
    check(
      'exactly one resident community assignment exists after login',
      afterLogin.assignments.length === 1,
      JSON.stringify(afterLogin.assignments),
    )
    check(
      'the assignment is the activity owner community, derived server-side',
      afterLogin.assignments[0]?.communityId === COMMUNITY_ID,
      JSON.stringify(afterLogin.assignments[0] ?? null),
    )
    check(
      'a single resident identity was created for the WeChat openid',
      afterLogin.identities.length === 1 && afterLogin.identities[0].appId === 'wx1234567890abcdef',
      JSON.stringify(afterLogin.identities),
    )
    check(
      'login created no participation, team, invitation, check-in, reward or order',
      afterLogin.counts.participations === 0
        && afterLogin.counts.teams === 0
        && afterLogin.counts.invitations === 0
        && afterLogin.counts.checkins === 0
        && afterLogin.counts.rewards === 0
        && afterLogin.counts.orders === 0,
      JSON.stringify(afterLogin.counts),
    )
    check(
      'the token exchange ran exactly once through the faked fetch boundary',
      afterLogin.wechatTokenCalls.length === 1,
      JSON.stringify(afterLogin.wechatTokenCalls),
    )

    console.log('--- stage 5: duplicate login is idempotent ---')
    await cdp.send('Network.clearBrowserCookies')
    await gotoActivity(activityUrl(`&invite=${INVITE}`))
    check('cleared session returns to the login entry', await cdp.eval(`__t.hasButton('微信授权登录')`))
    const second = await clickWechatLogin()
    const secondState = new URL(headerValue(second.startResponse.headers, 'location')).searchParams.get('state')
    check('second login gets a fresh one-time state', Boolean(secondState) && secondState !== state)
    await navigateCallback(secondState)
    await cdp.waitFor(`__t.bodyText().includes('微信登录成功') || __t.bodyText().includes('确认参与')`, 15_000)
    await sleep(400)
    const afterSecondLogin = await snapshot()
    check(
      'duplicate login keeps exactly one assignment',
      afterSecondLogin.assignments.length === 1,
      JSON.stringify(afterSecondLogin.assignments),
    )
    check(
      'duplicate login keeps exactly one resident identity',
      afterSecondLogin.identities.length === 1,
      JSON.stringify(afterSecondLogin.identities),
    )
    check(
      'duplicate login still created no participation or team',
      afterSecondLogin.counts.participations === 0 && afterSecondLogin.counts.teams === 0,
      JSON.stringify(afterSecondLogin.counts),
    )
    check(
      'the first OAuth state was consumed exactly once and never replayed',
      afterSecondLogin.oauthStates.filter((item) => item.consumed).length === 2,
      JSON.stringify(afterSecondLogin.oauthStates.map((item) => item.consumed)),
    )

    console.log('--- stage 6: client-supplied community input is refused ---')
    const forged = await cdp.eval(`(async () => {
      const response = await fetch('/api/auth/wechat/start?activityId=${ACTIVITY_ID}&communityId=${OTHER_COMMUNITY_ID}', { credentials: 'include', redirect: 'manual' });
      return { status: response.status, body: await response.text() };
    })()`)
    check(
      'the API refuses a client-supplied communityId with 400',
      forged.status === 400,
      JSON.stringify(forged),
    )
    check(
      'the refusal explains attribution comes from the activity only',
      String(forged.body).includes('社区归属只能由活动上下文推导'),
      String(forged.body),
    )
    const draft = await cdp.eval(`(async () => {
      const response = await fetch('/api/auth/wechat/start?activityId=${DRAFT_ACTIVITY_ID}', { credentials: 'include', redirect: 'manual' });
      return { status: response.status, body: await response.text() };
    })()`)
    check('the API refuses a non-public activity with 400', draft.status === 400, JSON.stringify(draft))
    check(
      'the refusal does not reveal why the activity is unavailable',
      String(draft.body).includes('活动不存在或不可公开访问'),
      String(draft.body),
    )
    const afterRefusals = await snapshot()
    check(
      'refused logins created no extra assignment or state community',
      afterRefusals.assignments.length === 1
        && afterRefusals.oauthStates.length === 2,
      JSON.stringify({ assignments: afterRefusals.assignments.length, states: afterRefusals.oauthStates.length }),
    )
    // Render the refusal as a real document so the screenshot is the browser's
    // own view of the API answer, not a re-typed message.
    await navigate(`${WEB_ORIGIN}/api/auth/wechat/start?activityId=${DRAFT_ACTIVITY_ID}`)
    check(
      'the refusal document is what a stale link would actually show',
      await cdp.eval(`document.body.innerText.includes('活动不存在或不可公开访问')`),
      await cdp.eval(`document.body.innerText.slice(0, 160)`),
    )
    await cdp.screenshot('03-refused-activity-375.png')

    console.log('--- stage 7: narrow layout ---')
    await gotoActivity(activityUrl(`&invite=${INVITE}`))
    await cdp.waitFor(`__t.bodyText().includes('三人团')`, 15_000)
    const wide = await cdp.eval(`__t.layout()`)
    check('375px viewport has no horizontal overflow', !wide.horizontalOverflow, JSON.stringify(wide))
    await cdp.setViewport(320, 568)
    await sleep(400)
    await cdp.eval(PAGE_HELPERS)
    const narrow = await cdp.eval(`__t.layout()`)
    check('320px viewport has no horizontal overflow', !narrow.horizontalOverflow, JSON.stringify(narrow))
    check(
      '320px viewport still shows the activity title and team card',
      await cdp.eval(`__t.bodyText().includes('三人团')`),
    )
    await cdp.screenshot('04-activity-logged-in-320.png')
    await cdp.setViewport(375, 812)
  } finally {
    try {
      await Promise.race([cdp?.send('Browser.close'), sleep(3000)])
    } catch {
      // Browser may already be gone.
    }
    clearInterval(cdp?.keepAlive)
    chrome.kill()
    await sleep(400)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // Windows may still hold a handle; the temp profile is disposable.
    }
  }

  const finalSnapshot = await snapshot()
  const summary = {
    generatedAt: new Date().toISOString(),
    issue: 'LL-MVP-012 (#123)',
    webOrigin: WEB_ORIGIN,
    apiOrigin: API_ORIGIN,
    userAgent: IPHONE_WECHAT_UA,
    activityId: ACTIVITY_ID,
    communityId: COMMUNITY_ID,
    invite: INVITE,
    realWechatAuthorization: false,
    realWechatAuthorizationNote:
      'No AppID/AppSecret exists and nothing was sent to open.weixin.qq.com (the host is blocked in the browser). '
      + 'The token exchange is answered by the evidence server in-process fake at the fetch boundary; everything '
      + 'after the code exchange (state consumption, identity, assignment, session, redirect) is production code.',
    checks: results,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    finalSnapshot,
    requests,
  }
  writeFileSync(join(OUT_DIR, 'browser-results.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`)
  if (summary.failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  try {
    writeFileSync(
      join(OUT_DIR, 'browser-results.json'),
      `${JSON.stringify({ error: String(error), checks: results, requests }, null, 2)}\n`,
    )
  } catch {
    // Ignore secondary write failures.
  }
  process.exitCode = 1
})
