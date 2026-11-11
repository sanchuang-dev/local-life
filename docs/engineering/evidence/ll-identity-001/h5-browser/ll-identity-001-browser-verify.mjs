/**
 * LL-IDENTITY-001 (#171) resident H5 browser verification.
 *
 * Drives the real Vite dev server (ui worktree, base /local-life/, HashRouter)
 * against the real merged Hono API (lead worktree, TCP 4080) in system Chrome via
 * the DevTools Protocol, with Node.js built-ins only.
 *
 * Real: the H5 routes/components, the pre-existing resident site gate and its
 * login redirect, the API's resident-community status/confirm routes, the
 * dev-login session cookies and the CSRF double submit, the SQLite binding row,
 * and the browse-only community switch.
 *
 * Not claimed: a WeChat authorization (no credentials exist), SMS login, an
 * admin-correction binding, or the pending_review/conflict states with real data
 * (those are covered by the API/unit tests, not by this browser run). Anonymous
 * browsing is not reachable at all: `ResidentSiteGate` (pre-existing, unchanged by
 * #171) requires a resident session on every resident route, so 浏览自由 here means
 * browsing never creates or moves a permanent binding.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const WEB_ORIGIN = process.env.LL_WEB_ORIGIN ?? 'http://localhost:5173'
const WEB_BASE = process.env.LL_WEB_BASE ?? '/local-life/'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DEBUG_PORT = Number(process.env.LL_CDP_PORT ?? 9517)
const OUT_DIR = resolve(process.argv[2] ?? '.')
const BIND = '梧桐里社区'
const OTHER = '柳岸花城社区'
const BIND_ID = '3b16253c-cd91-437f-86b1-8bf553129d12'
const OTHER_ID = '7c1f0f2a-5b3d-4e6f-8a90-0b1c2d3e4f50'
// `__t.text()` strips whitespace, so the literal must be compared the same way.
const BIND_ADDRESS = '梧桐路 18 号社区服务站'
const BIND_ADDRESS_NORM = BIND_ADDRESS.replace(/\s+/g, '')
const BROWSE_NOTICE = '切换社区只改变你正在浏览的公开内容，不会改变你的常驻社区'
const SELF_SERVICE_WORDS = ['解绑', '重新绑定', '重绑', '切换常驻社区']

mkdirSync(OUT_DIR, { recursive: true })

const results = []
const requests = []
let cdp

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.keepAlive = setInterval(() => {}, 30_000)
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('socket closed'))
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
        requests.push({ url: message.params.request.url, method: message.params.request.method })
      }
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((done, reject) => {
      socket.addEventListener('open', done, { once: true })
      socket.addEventListener('error', () => reject(new Error(`cannot connect ${url}`)), { once: true })
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject })
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

  async waitFor(expression, timeoutMs = 30_000, intervalMs = 120) {
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
    await sleep(250)
  }
}

const HELPERS = String.raw`
  window.__t = {
    norm: (v) => (v ?? '').replace(/\s+/g, ''),
    all(sel, root = document) { return [...root.querySelectorAll(sel)] },
    visible(el) {
      if (!el) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    },
    text() { return this.norm(document.body.innerText) },
    has(text) { return this.text().includes(this.norm(text)) },
    control(text) {
      return this.all('button, a').find((el) => this.visible(el) && this.norm(el.textContent).includes(this.norm(text)))
    },
    click(el) {
      if (!el) throw new Error('click target missing')
      el.scrollIntoView({ block: 'center', inline: 'center' })
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      el.click()
      return true
    },
    clickText(text) { return this.click(this.control(text)) },
    pickCommunity(name) {
      const label = this.all('label').find((el) => this.norm(el.textContent).includes(this.norm(name)))
      if (!label) throw new Error('community option missing: ' + name)
      label.querySelector('input[type=radio]').click()
      return true
    },
    disabled(text) {
      const el = this.control(text)
      return el ? el.disabled === true || el.getAttribute('aria-disabled') === 'true' : null
    },
    /** Every visible interactive control, labelled by its own text. */
    controls() {
      return this.all('button, a[href], input, select, textarea, [role=button]')
        .filter((el) => this.visible(el))
        .map((el) => this.norm(el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('type') || ''))
        .filter(Boolean)
    },
    path() { return location.hash.replace(/^#/, '') },
    layout() {
      return {
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    },
  };
  true
`

function offendingControls(controls, words) {
  return controls.filter((label) => words.some((word) => label.includes(word)))
}

async function main() {
  const profile = join(tmpdir(), `ll-identity-001-chrome-${Date.now()}`)
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

  try {
    for (let attempt = 0; attempt < 140; attempt += 1) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
        if (version.webSocketDebuggerUrl) break
      } catch {
        // still starting
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
    await cdp.setViewport(375, 812)

    const url = (hash) => `${WEB_ORIGIN}${WEB_BASE}#${hash}`

    async function goto(hash, waitForText, timeout = 30_000) {
      await cdp.send('Page.navigate', { url: url(hash) })
      await cdp.waitFor(`document.readyState === 'complete'`, 25_000)
      await cdp.eval(HELPERS)
      if (waitForText) await cdp.waitFor(`__t.has(${JSON.stringify(waitForText)})`, timeout)
      await sleep(900)
    }

    const confirmTarget = `/me/community/confirm?communityId=${BIND_ID}`

    // ---- 1. Logged out: the confirm visit must go through the unified login
    //         and keep the exact target it was asked for ---------------------
    await goto(confirmTarget, '开发环境测试登录')
    const loginPath = await cdp.eval('__t.path()')
    check(
      'a logged-out confirm visit is sent to the unified login',
      loginPath.startsWith('/login?') && loginPath.includes('next='),
      loginPath.slice(0, 220),
    )
    check(
      'the login redirect preserves the confirm target and its communityId',
      decodeURIComponent(loginPath).includes(confirmTarget),
      'next target',
    )
    await cdp.screenshot('01-login-preserves-confirm-target-375.png')

    // ---- 2. Real dev login through the same unified entry -----------------
    await cdp.eval(`__t.clickText('开发环境测试登录')`)
    await cdp.waitFor(`__t.has('绑定后不可修改')`, 35_000)
    await sleep(1200)
    const reviewPath = await cdp.eval('__t.path()')
    check(
      'login returns to the confirmation page for the same community',
      reviewPath.startsWith('/me/community/confirm') && reviewPath.includes(BIND_ID),
      reviewPath.slice(0, 220),
    )
    const review = await cdp.eval(`__t.text()`)
    check('confirm page shows the community name', review.includes(BIND), 'name')
    check('confirm page shows the service address', review.includes(BIND_ADDRESS_NORM), 'address')
    check('confirm page states the binding cannot be changed', review.includes('绑定后不可修改'), 'irreversible')
    check(
      'confirm page states the resident H5 has no switch/unbind/rebind entry',
      review.includes('居民端没有切换、解绑或重绑入口'),
      'permanence copy',
    )
    const reviewControls = await cdp.eval('__t.controls()')
    check(
      'confirm page exposes no control that could unbind or rebind',
      offendingControls(reviewControls, SELF_SERVICE_WORDS).length === 0,
      JSON.stringify(offendingControls(reviewControls, SELF_SERVICE_WORDS)),
    )
    check(
      'the review step alone cannot submit a binding',
      !reviewControls.some((label) => label.includes('确认绑定为常驻社区')),
      'no submit on step 1',
    )
    await cdp.screenshot('02-confirm-review-step-375.png')

    // ---- 3. Two deliberate actions are required --------------------------
    await cdp.eval(`__t.clickText('我已了解，继续确认')`)
    await cdp.waitFor(`__t.has('我已确认这是我的常驻社区')`, 15_000)
    await sleep(600)
    check(
      'submit is disabled before the acknowledgement is ticked',
      (await cdp.eval(`__t.disabled('确认绑定为常驻社区')`)) === true,
      'disabled submit',
    )
    await cdp.screenshot('03-confirm-second-step-disabled-375.png')
    await cdp.eval(`(() => { document.querySelector('input[type=checkbox]').click(); return true })()`)
    await sleep(600)
    check(
      'submit becomes available after ticking the acknowledgement',
      (await cdp.eval(`__t.disabled('确认绑定为常驻社区')`)) === false,
      'enabled submit',
    )
    await cdp.screenshot('04-confirm-second-step-enabled-375.png')

    // ---- 4. Leave without confirming, then bind from the discovery page so
    //         the real "browse -> confirm" entry is exercised too -----------
    await goto('/', '先选一个要浏览的社区')
    const landing = await cdp.eval(`__t.text()`)
    check(
      'location is never presented as residence proof',
      landing.includes('不作居住证明') || landing.includes('作为居住证明'),
      'location notice',
    )
    await cdp.screenshot('05-discovery-unbound-375.png')

    await cdp.eval(`__t.clickText('手动选择社区')`)
    await cdp.waitFor(`__t.has('确认浏览这个社区')`, 20_000)
    const sheet = await cdp.eval(`__t.text()`)
    check('the picker is titled as a browsing choice', sheet.includes('选择要浏览的社区'), 'picker heading')
    check(
      'the picker states it never confirms or changes the permanent community',
      sheet.includes('这里只改变浏览的社区，不会确认或改变你的常驻社区'),
      'picker footer',
    )
    await cdp.screenshot('06-browse-picker-375.png')

    await cdp.eval(`__t.pickCommunity(${JSON.stringify(BIND)})`)
    await sleep(500)
    await cdp.eval(`__t.clickText('确认浏览这个社区')`)
    await cdp.waitFor(`__t.has('当前浏览社区')`, 25_000)
    await sleep(1600)
    const browsing = await cdp.eval(`__t.text()`)
    check('the browsed community is labelled as browsing', browsing.includes('当前浏览社区'), 'header')
    check('the browse-only rule is visible next to it', browsing.includes(BROWSE_NOTICE), 'browse notice')
    check('browsing a community did not create a binding', browsing.includes('尚未确认常驻社区'), 'card state')
    const browseControls = await cdp.eval('__t.controls()')
    check(
      'the unbound card offers the explicit first confirmation',
      browseControls.some((label) => label.includes('绑定为常驻社区')),
      'confirm CTA',
    )
    await cdp.screenshot('07-browsing-unbound-cta-375.png')

    // ---- 5. The real confirmation ----------------------------------------
    await cdp.eval(`__t.clickText('绑定为常驻社区')`)
    await cdp.waitFor(`__t.has('绑定后不可修改')`, 30_000)
    await sleep(1000)
    const fromBrowsePath = await cdp.eval('__t.path()')
    check(
      'the confirm page is entered for the browsed community',
      fromBrowsePath.startsWith('/me/community/confirm') && fromBrowsePath.includes(BIND_ID),
      fromBrowsePath.slice(0, 220),
    )
    await cdp.eval(`__t.clickText('我已了解，继续确认')`)
    await cdp.waitFor(`__t.has('我已确认这是我的常驻社区')`, 15_000)
    await cdp.eval(`(() => { document.querySelector('input[type=checkbox]').click(); return true })()`)
    await sleep(400)
    await cdp.eval(`__t.clickText('确认绑定为常驻社区')`)
    await cdp.waitFor(`__t.has('已确认常驻社区')`, 35_000)
    await sleep(1600)
    const confirmed = await cdp.eval(`__t.text()`)
    check('the confirmation succeeds against the real API', confirmed.includes(BIND), 'success copy')
    const confirmedControls = await cdp.eval('__t.controls()')
    check(
      'the success state offers no unbind/rebind control',
      offendingControls(confirmedControls, SELF_SERVICE_WORDS).length === 0,
      JSON.stringify(offendingControls(confirmedControls, SELF_SERVICE_WORDS)),
    )
    await cdp.screenshot('08-confirmed-375.png')

    // ---- 6. 我的 shows the permanent community read-only -----------------
    await goto('/me', '我的常驻社区')
    await sleep(1600)
    const me = await cdp.eval(`__t.text()`)
    check('我的 shows the confirmed permanent community', me.includes(BIND), 'me card')
    check('我的 shows the confirmation date', /确认于|确认日期/.test(me), 'date')
    const meControls = await cdp.eval('__t.controls()')
    check(
      '我的 offers no switch/unbind/rebind control',
      offendingControls(meControls, SELF_SERVICE_WORDS).length === 0,
      JSON.stringify(offendingControls(meControls, SELF_SERVICE_WORDS)),
    )
    check(
      '我的 links to the read-only detail page',
      meControls.some((label) => label.includes('我的常驻社区')),
      'detail link',
    )
    await cdp.screenshot('09-me-permanent-community-375.png')

    await goto('/me/community', '我的常驻社区')
    await sleep(1400)
    const meCommunity = await cdp.eval(`__t.text()`)
    check('我的常驻社区 names the confirmed binding', meCommunity.includes(BIND), 'binding name')
    const meCommunityControls = await cdp.eval('__t.controls()')
    check(
      '我的常驻社区 is read-only',
      offendingControls(meCommunityControls, SELF_SERVICE_WORDS).length === 0 &&
        !meCommunityControls.some((label) => label.includes('确认绑定为常驻社区')),
      JSON.stringify(meCommunityControls),
    )
    await cdp.screenshot('10-my-community-page-375.png')

    // ---- 7. Browsing another community changes only browsing -------------
    await goto('/', '当前浏览社区')
    await sleep(1400)
    const home = await cdp.eval(`__t.text()`)
    check('the discovery page shows the confirmed permanent community', home.includes(BIND), 'permanent card')

    await cdp.eval(`__t.clickText('切换浏览社区')`)
    await cdp.waitFor(`__t.has('确认浏览这个社区')`, 20_000)
    await cdp.eval(`__t.pickCommunity(${JSON.stringify(OTHER)})`)
    await sleep(500)
    await cdp.eval(`__t.clickText('确认浏览这个社区')`)
    await cdp.waitFor(`__t.has(${JSON.stringify(OTHER)})`, 25_000)
    await sleep(2000)
    const other = await cdp.eval(`__t.text()`)
    check('the browsed community switched', other.includes(OTHER), 'browsing other')
    check('the permanent community did not change', other.includes(BIND), 'binding preserved')
    check(
      'the page explains that browsing does not change the permanent community',
      other.includes(BROWSE_NOTICE) || other.includes('不会改变你的常驻社区'),
      'browse-vs-binding copy',
    )
    await cdp.screenshot('11-browsing-other-community-375.png')

    await goto('/me/community', '我的常驻社区')
    await sleep(1400)
    const stillBound = await cdp.eval(`__t.text()`)
    check(
      'the binding survives a browse-only switch',
      stillBound.includes(BIND) && !stillBound.includes(OTHER),
      'binding after browsing elsewhere',
    )

    // ---- 8. A second permanent binding is refused ------------------------
    await goto(`/me/community/confirm?communityId=${OTHER_ID}`, '常驻社区')
    await sleep(2000)
    const second = await cdp.eval(`__t.text()`)
    const secondControls = await cdp.eval('__t.controls()')
    check(
      'a second permanent binding cannot be confirmed from the H5',
      !secondControls.some((label) => label.includes('确认绑定为常驻社区')),
      'no confirm action',
    )
    check('the refusal names the existing permanent community', second.includes(BIND), 'refusal copy')
    await cdp.screenshot('12-second-binding-refused-375.png')

    // ---- 9. The confirm page never invents a community -------------------
    await goto('/me/community/confirm', '确认常驻社区')
    await sleep(1500)
    const noId = await cdp.eval(`__t.text()`)
    const noIdControls = await cdp.eval('__t.controls()')
    check(
      'without a communityId the confirm page defaults to nothing',
      noId.includes('没有可确认的社区') &&
        !noIdControls.some((label) => label.includes('确认绑定为常驻社区')),
      'no default community',
    )
    await cdp.screenshot('13-confirm-without-community-375.png')

    // ---- 10. 320px narrow device ----------------------------------------
    await cdp.setViewport(320, 640)
    for (const [hash, waitFor, shot, label] of [
      ['/', '当前浏览社区', '14-discovery-320.png', 'discovery'],
      ['/me', '我的常驻社区', '15-me-320.png', '我的'],
      ['/me/community', '我的常驻社区', '16-my-community-320.png', '我的常驻社区'],
      [`/me/community/confirm?communityId=${OTHER_ID}`, '常驻社区', '17-confirm-refused-320.png', 'confirm refusal'],
    ]) {
      await goto(hash, waitFor)
      await sleep(1400)
      const layout = await cdp.eval(`__t.layout()`)
      check(`320px ${label} page has no horizontal overflow`, !layout.overflow, JSON.stringify(layout))
      await cdp.screenshot(shot)
    }

    // ---- 11. Exactly one confirm request in the whole run ---------------
    const confirmCalls = requests.filter((r) => r.url.includes('/api/resident-community/confirm'))
    check('exactly one confirm request was sent in this run', confirmCalls.length === 1, JSON.stringify(confirmCalls))

    const failed = results.filter((r) => !r.ok)
    writeFileSync(join(OUT_DIR, 'browser-results.json'), JSON.stringify({ results, requests }, null, 2))
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    clearInterval(cdp?.keepAlive)
    chrome.kill()
  }
}

await main()
