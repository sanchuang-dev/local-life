/**
 * LL-IDENTITY-001 (#171) — 管理台常驻社区只读展示的真实浏览器验证。
 *
 * 驱动真实 Vite dev server（ui worktree，apps/admin）+ 真实集成 API（lead worktree，
 * 127.0.0.1:4080，经 vite /api 代理）在系统 Chrome 里跑，只用 Node 内置模块通过
 * CDP 控制，无自动化库、无 mock、不拦截/改写任何产品请求。
 *
 * 真实覆盖：管理台登录（双提交 CSRF + 会话 Cookie）、GET /admin/users 的真实数据
 * （5 种归属形态）、列表列「常驻社区 / 历史归属」的渲染、详情抽屉、以及「无改绑入口」
 * 的 DOM 断言。
 *
 * 不声称：真实生产数据、真实微信/短信登录、admin_compliance_correction 绑定、
 * 移动端真机。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ADMIN_ORIGIN = process.env.LL_ADMIN_ORIGIN ?? 'http://127.0.0.1:5174'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DEBUG_PORT = Number(process.env.LL_CDP_PORT ?? 9531)
const OUT_DIR = resolve(process.argv[2] ?? '.')
const USERNAME = process.env.LL_ADMIN_USER ?? 'admin'
const PASSWORD = process.env.LL_ADMIN_PASSWORD ?? ''

mkdirSync(OUT_DIR, { recursive: true })

const results = []
const requests = []
let cdp

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
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

  async screenshot(name, fullPage = false) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    })
    writeFileSync(join(OUT_DIR, name), Buffer.from(shot.data, 'base64'))
    console.log(`shot ${name}`)
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    })
    await sleep(300)
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
    type(selector, value) {
      const el = document.querySelector(selector)
      if (!el) throw new Error('input missing: ' + selector)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    /** Every visible interactive control in scope, labelled by its own text. */
    controls(root = document) {
      return this.all('button, a[href], input, select, textarea, [role=button]', root)
        .filter((el) => this.visible(el))
        .map((el) => this.norm(el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('type') || ''))
        .filter(Boolean)
    },
    /** The detail drawer body (antd 6 renders it inside the users-drawer portal). */
    drawer() {
      return document.querySelector('.users-drawer .ant-drawer-body') || document.querySelector('.users-drawer')
    },
    drawerText() { return this.norm(this.drawer()?.innerText ?? '') },
    tableText() {
      const table = document.querySelector('.ant-table-tbody') || document.querySelector('table')
      return this.norm(table?.innerText ?? '')
    },
    /** Row cell text keyed by the account's display name. */
    row(name) {
      const tr = this.all('.ant-table-tbody tr').find((el) => this.norm(el.innerText).includes(this.norm(name)))
      return tr ? this.norm(tr.innerText) : null
    },
    openRow(name) {
      const tr = this.all('.ant-table-tbody tr').find((el) => this.norm(el.innerText).includes(this.norm(name)))
      if (!tr) throw new Error('row missing: ' + name)
      const button = [...tr.querySelectorAll('button')].find((el) => this.norm(el.textContent).includes('详情'))
      if (!button) throw new Error('detail action missing for: ' + name)
      return this.click(button)
    },
    layout() {
      return {
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    },
    path() { return location.pathname },
  };
  true
`

const REBIND_WORDS = ['改绑', '解绑', '重新绑定', '重绑', '切换常驻社区', '转移常驻', '设为常驻', '代确认']

async function main() {
  const profile = join(tmpdir(), `ll-identity-001-admin-chrome-${Date.now()}`)
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
    for (let attempt = 0; attempt < 160; attempt += 1) {
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
    await cdp.setViewport(1440, 900)

    async function goto(path, waitForText, timeout = 30_000) {
      await cdp.send('Page.navigate', { url: `${ADMIN_ORIGIN}${path}` })
      await cdp.waitFor(`document.readyState === 'complete'`, 25_000)
      await cdp.eval(HELPERS)
      if (waitForText) await cdp.waitFor(`__t.has(${JSON.stringify(waitForText)})`, timeout)
      await sleep(900)
    }

    // ---- 1. sign in for real (double-submit CSRF + session cookie) ----------
    await goto('/', '管理员')
    check('管理台登录页可达（真实 Vite dev server）', true, ADMIN_ORIGIN)
    await cdp.eval(`__t.type('input[autocomplete=username]', ${JSON.stringify(USERNAME)})`)
    await cdp.eval(`__t.type('input[autocomplete=current-password]', ${JSON.stringify(PASSWORD)})`)
    await cdp.screenshot('01-admin-login-1440.png')
    await cdp.eval(`__t.clickText('登录')`)
    await cdp.waitFor(`__t.path() === '/' && !__t.has('登录账号')`, 30_000)
    check('真实账号登录成功并进入后台布局', true)

    // ---- 2. the users page lists the five real relation shapes -------------
    await goto('/users', '常驻社区')
    check('用户管理页打开', await cdp.eval(`__t.path() === '/users'`), '/users')

    const pageText = await cdp.eval('__t.text()')
    check(
      '页头写明只读：常驻社区由居民本人确认、管理台不可代为变更',
      pageText.includes('常驻社区由居民本人确认，管理台只读展示，不可代为变更'),
    )
    check(
      '页头把历史归属与「已确认」分开：历史归属只是观察记录，不代表已确认',
      pageText.includes('历史归属只是观察记录，不代表已确认'),
    )
    check('列名为「常驻社区 / 历史归属」', pageText.includes('常驻社区/历史归属') || pageText.includes('常驻社区 / 历史归属'))
    await cdp.screenshot('02-users-list-1440.png', true)

    const confirmedRow = await cdp.eval(`__t.row('陈梧桐')`)
    check(
      '已确认居民显示「已确认常驻」+ 绿色「常驻：梧桐里社区」',
      confirmedRow !== null && confirmedRow.includes('已确认常驻') && confirmedRow.includes('常驻：梧桐里社区'),
      confirmedRow ?? 'row missing',
    )

    const historicalRow = await cdp.eval(`__t.row('林柳岸')`)
    check(
      '单条历史归属显示「历史归属（未确认）」而不是已确认常驻社区',
      historicalRow !== null &&
        historicalRow.includes('历史归属（未确认）') &&
        !historicalRow.includes('已确认常驻'),
      historicalRow ?? 'row missing',
    )
    check(
      '单条历史归属的社区名带「历史归属：」前缀，没有被写成「常驻：」',
      historicalRow !== null &&
        historicalRow.includes('历史归属：柳岸花城社区') &&
        !historicalRow.includes('常驻：'),
    )

    const pendingRow = await cdp.eval(`__t.row('周双记')`)
    check(
      '两条历史归属标记为「历史待核查」并且没有任何已确认措辞',
      pendingRow !== null && pendingRow.includes('历史待核查') && !pendingRow.includes('已确认常驻'),
      pendingRow ?? 'row missing',
    )

    const noneRow = await cdp.eval(`__t.row('吴空白')`)
    check(
      '无任何关系的账号显示「未关联社区」',
      noneRow !== null && noneRow.includes('未关联社区'),
      noneRow ?? 'row missing',
    )

    const conflictRow = await cdp.eval(`__t.row('郑冲突')`)
    check(
      '确认与历史记录不一致的账号既显示已确认常驻社区又标出「常驻社区冲突」',
      conflictRow !== null &&
        conflictRow.includes('已确认常驻') &&
        conflictRow.includes('常驻：梧桐里社区') &&
        conflictRow.includes('常驻社区冲突'),
      conflictRow ?? 'row missing',
    )

    // ---- 3. no rebind affordance anywhere on the list ---------------------
    const listControls = await cdp.eval('__t.controls()')
    const listOffenders = listControls.filter((label) => REBIND_WORDS.some((word) => label.includes(word)))
    check('列表页没有任何改绑/解绑/重绑/转移控件', listOffenders.length === 0, JSON.stringify(listOffenders))
    check(
      '列表页行操作只有「详情」',
      listControls.filter((label) => label === '详情').length >= 5 &&
        !listControls.some((label) => label.includes('编辑')),
      JSON.stringify(listControls.slice(0, 20)),
    )

    // ---- 4. detail drawer: historical account ----------------------------
    await cdp.eval(`__t.openRow('林柳岸')`)
    await cdp.waitFor(`__t.drawerText().includes('居民常驻社区')`, 20_000)
    await sleep(700)
    const historicalDrawer = await cdp.eval('__t.drawerText()')
    check(
      '抽屉区段标题声明只读：#171 只读',
      historicalDrawer.includes('居民常驻社区（#171只读）') || historicalDrawer.includes('居民常驻社区（#171 只读）'),
    )
    check(
      '抽屉明确写出尚未确认常驻社区、历史记录不能当作常驻社区',
      historicalDrawer.includes('尚未确认常驻社区') && historicalDrawer.includes('不能当作常驻社区'),
    )
    check(
      '抽屉历史行标注「（只读，不代表已确认）」',
      historicalDrawer.includes('历史社区归属（只读，不代表已确认）'),
    )
    check(
      '抽屉历史行同时显示「历史归属（未确认）」与记录日期',
      historicalDrawer.includes('历史归属（未确认）') && /20\d\d[年/]\d{1,2}/.test(historicalDrawer),
    )
    check(
      '抽屉脚注声明没有改绑、解绑或代确认入口',
      historicalDrawer.includes('后台没有改绑、解绑或代确认入口'),
    )
    const drawerControls = await cdp.eval(`__t.controls(__t.drawer())`)
    const drawerOffenders = drawerControls.filter((label) => REBIND_WORDS.some((word) => label.includes(word)))
    check('抽屉内没有任何改绑/解绑/代确认控件', drawerOffenders.length === 0, JSON.stringify(drawerOffenders))
    check(
      '抽屉内没有表单与提交按钮（只读）',
      (await cdp.eval(`__t.drawer().querySelectorAll('form, button[type=submit]').length`)) === 0,
    )
    await cdp.screenshot('03-drawer-historical-1440.png')

    // close the drawer (antd close button is the only icon button)
    await cdp.eval(`__t.drawer().closest('.ant-drawer')?.querySelector('.ant-drawer-close')?.click(); true`)
    await sleep(600)

    // ---- 5. detail drawer: pending_review account ------------------------
    await cdp.eval(`__t.openRow('周双记')`)
    await cdp.waitFor(`__t.drawerText().includes('历史待核查')`, 20_000)
    await sleep(700)
    const pendingDrawer = await cdp.eval('__t.drawerText()')
    check(
      '待核查抽屉标出「历史待核查」并说明需人工核查、不视为已确认常驻社区',
      pendingDrawer.includes('历史待核查') &&
        pendingDrawer.includes('需人工核查归属') &&
        pendingDrawer.includes('不视为已确认常驻社区'),
    )
    const pendingControls = await cdp.eval(`__t.controls(__t.drawer())`)
    const pendingOffenders = pendingControls.filter((label) => REBIND_WORDS.some((word) => label.includes(word)))
    check(
      '待核查抽屉没有「帮他选一个」之类的代选控件',
      pendingOffenders.length === 0 &&
        (await cdp.eval(`__t.drawer().querySelectorAll('input[type=radio], input[type=checkbox], select').length`)) === 0 &&
        !pendingDrawer.includes('帮他选'),
      JSON.stringify(pendingControls),
    )
    await cdp.screenshot('04-drawer-pending-review-1440.png')
    await cdp.eval(`__t.drawer().closest('.ant-drawer')?.querySelector('.ant-drawer-close')?.click(); true`)
    await sleep(600)

    // ---- 6. detail drawer: confirmed account ----------------------------
    await cdp.eval(`__t.openRow('陈梧桐')`)
    await cdp.waitFor(`__t.drawerText().includes('居民常驻社区')`, 20_000)
    await sleep(700)
    const confirmedDrawer = await cdp.eval('__t.drawerText()')
    check(
      '已确认账号抽屉显示已确认常驻社区、确认日期与来源「本人在居民端确认」',
      confirmedDrawer.includes('已确认常驻社区') &&
        confirmedDrawer.includes('本人在居民端确认') &&
        confirmedDrawer.includes('梧桐里社区') &&
        /20\d\d年/.test(confirmedDrawer),
    )
    const confirmedControls = await cdp.eval(`__t.controls(__t.drawer())`)
    check(
      '已确认账号抽屉同样没有改绑/解绑入口（只读说明里出现「改绑」不算控件）',
      confirmedControls.filter((label) => REBIND_WORDS.some((word) => label.includes(word))).length === 0,
      JSON.stringify(confirmedControls),
    )
    await cdp.screenshot('05-drawer-confirmed-1440.png')
    await cdp.eval(`__t.drawer().closest('.ant-drawer')?.querySelector('.ant-drawer-close')?.click(); true`)
    await sleep(600)

    // ---- 7. detail drawer: real conflict --------------------------------
    await cdp.eval(`__t.openRow('郑冲突')`)
    await cdp.waitFor(`__t.drawerText().includes('常驻社区冲突')`, 20_000)
    await sleep(700)
    const conflictDrawer = await cdp.eval('__t.drawerText()')
    check(
      '冲突账号抽屉标出「常驻社区冲突」并说明历史记录与确认不一致',
      conflictDrawer.includes('常驻社区冲突') && conflictDrawer.includes('不一致'),
      conflictDrawer.slice(0, 400),
    )
    await cdp.screenshot('06-drawer-conflict-1440.png')

    // ---- 8. the old back-office route must not offer a rebind either -----
    const adminUsersRequests = requests.filter((entry) => entry.url.includes('/admin/users'))
    check(
      '列表与详情都通过真实 GET /admin/users 读取（有真实网络请求）',
      adminUsersRequests.length >= 2,
      `${adminUsersRequests.length} 个请求`,
    )
    check(
      '整轮没有发出任何写请求（POST/PUT/PATCH/DELETE 到 /admin 或 /resident-community）',
      requests.every(
        (entry) =>
          entry.method === 'GET' ||
          !/\/admin|\/resident-community|\/crm/.test(entry.url) ||
          entry.url.includes('/auth/'),
      ),
      JSON.stringify(requests.filter((entry) => entry.method !== 'GET').map((entry) => `${entry.method} ${entry.url}`)),
    )

    const layout = await cdp.eval('__t.layout()')
    check('1440 宽无横向溢出', layout.overflow === false, JSON.stringify(layout))

    writeFileSync(
      join(OUT_DIR, 'browser-results.json'),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          adminOrigin: ADMIN_ORIGIN,
          checks: results,
          passed: results.filter((result) => result.ok).length,
          total: results.length,
          requests,
        },
        null,
        2,
      )}\n`,
    )
    const passed = results.filter((result) => result.ok).length
    console.log(`\n${passed}/${results.length} checks passed`)
    if (passed !== results.length) process.exitCode = 1
  } finally {
    clearInterval(cdp?.keepAlive)
    try {
      cdp?.socket.close()
    } catch {
      // ignore
    }
    chrome.kill()
  }
}

main().catch((error) => {
  console.error(error)
  writeFileSync(
    join(OUT_DIR, 'browser-results.json'),
    `${JSON.stringify({ failedAt: new Date().toISOString(), error: String(error), checks: results }, null, 2)}\n`,
  )
  process.exitCode = 1
})
