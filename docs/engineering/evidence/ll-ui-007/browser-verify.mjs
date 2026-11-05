/**
 * LL-UI-007 (/communities) browser evidence harness.
 *
 * Drives the real local admin + API stack in system Chrome through the DevTools
 * Protocol using only Node.js built-ins (global fetch/WebSocket). No browser
 * automation dependency or toolchain is installed. Every check records a
 * pass/fail entry in browser-results.json; screenshots live next to it.
 *
 * Usage:
 *   node browser-verify.mjs <output-dir>
 *
 * Required environment (defaults match `pnpm dev:local`):
 *   LL_ADMIN_ORIGIN, LL_API_ORIGIN, LL_ADMIN_USER, LL_ADMIN_PASSWORD,
 *   LL_SEED_PASSWORD, CHROME_PATH
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const ADMIN_ORIGIN = process.env.LL_ADMIN_ORIGIN ?? 'http://127.0.0.1:5174'
const API_ORIGIN = process.env.LL_API_ORIGIN ?? 'http://127.0.0.1:4080'
const ADMIN_USER = process.env.LL_ADMIN_USER ?? 'evidence.admin'
const ADMIN_PASSWORD = process.env.LL_ADMIN_PASSWORD ?? 'EvidenceAdminPass123'
const WORKER_PASSWORD = process.env.LL_SEED_PASSWORD ?? 'GridWorkerPass123'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
// A fixed DevTools port collides when several worktrees run evidence in
// parallel on the same Windows host: the second runner then drives the first
// runner's tab. Derive a per-process port and allow an explicit override.
const DEBUG_PORT = Number(process.env.LL_CDP_PORT ?? 9400 + (process.pid % 400))
const OUT_DIR = resolve(process.argv[2] ?? '.')

// Names are unique per run so this harness can be re-run against the same
// persistent local SQLite database instead of requiring a destructive reset.
const RUN_TAG = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-8)
const COMMUNITY_NEW = `验收社区-${RUN_TAG}`
const COMMUNITY_SECOND = `阳光社区-${RUN_TAG}`
const COMMUNITY_DUPLICATE = `重复提交-${RUN_TAG}`
const STAFF_USERNAME = `grid.${RUN_TAG}`
const STAFF_DISPLAY = `验收网格员${RUN_TAG}`

const results = []
const requests = []
let cdp

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) console.warn(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok   ${name}`)
}

function countRequests(method, suffix) {
  return requests.filter((item) => item.method === method && item.url.endsWith(suffix)).length
}

function cookieJar(setCookieHeaders) {
  const jar = {}
  for (const header of setCookieHeaders ?? []) {
    const pair = header.split(';')[0]
    const index = pair.indexOf('=')
    jar[pair.slice(0, index)] = pair.slice(index + 1)
  }
  return jar
}

async function apiLogin(username, password) {
  const csrfResponse = await fetch(`${API_ORIGIN}/auth/csrf`)
  if (!csrfResponse.ok) throw new Error(`csrf failed: ${csrfResponse.status}`)
  const csrf = await csrfResponse.json()
  const cookie = cookieJar(csrfResponse.headers.getSetCookie())
  cookie.ll_csrf = csrf.csrfToken
  const loginResponse = await fetch(`${API_ORIGIN}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf.csrfToken,
      cookie: Object.entries(cookie).map(([key, value]) => `${key}=${value}`).join('; '),
    },
    body: JSON.stringify({ username, password }),
  })
  if (!loginResponse.ok) {
    throw new Error(`login ${username} failed: ${loginResponse.status} ${await loginResponse.text()}`)
  }
  const session = await loginResponse.json()
  Object.assign(cookie, cookieJar(loginResponse.headers.getSetCookie()))
  return { cookie, csrfToken: session.csrfToken, session }
}

async function apiGet(cookie, path) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: { cookie: Object.entries(cookie).map(([key, value]) => `${key}=${value}`).join('; ') },
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function apiWrite(cookie, csrfToken, method, path, payload) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      cookie: Object.entries(cookie).map(([key, value]) => `${key}=${value}`).join('; '),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.lifecycle = []
    // Without a timer Node can silently exit 0 when the DevTools socket dies
    // while an eval promise is still pending.
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
      if (message.method) {
        if (message.method === 'Network.requestWillBeSent') {
          requests.push({
            url: message.params.request.url,
            method: message.params.request.method,
            timestamp: message.params.timestamp,
          })
        }
        if (
          message.method === 'Page.frameNavigated' ||
          message.method === 'Page.loadEventFired' ||
          message.method === 'Runtime.executionContextsCleared' ||
          message.method === 'Runtime.executionContextDestroyed' ||
          message.method === 'Inspector.detached' || message.method === 'Inspector.targetCrashed'
        ) {
          this.lifecycle.push({
            method: message.method,
            at: Date.now(),
            detail: message.params?.frame?.url ?? message.params?.executionContextId ?? '',
          })
        }
        for (const listener of this.listeners) listener(message)
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

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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

  async waitFor(expression, timeoutMs = 8000, intervalMs = 80) {
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
    console.warn('DIAG lifecycle', JSON.stringify(this.lifecycle.slice(-20)))
    try {
      console.warn(
        'DIAG state',
        JSON.stringify(
          await this.eval(
            '({ href: location.href, ready: document.readyState, hasT: typeof window.__t, drawers: document.querySelectorAll(".ant-drawer-open").length, text: document.body.innerText.slice(0, 160) })',
          ),
        ),
      )
    } catch (diagnosticError) {
      console.warn('DIAG state eval failed', diagnosticError.message)
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
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    })
    await sleep(120)
  }
}

const PAGE_HELPERS = String.raw`
  window.__t = {
    norm: (value) => (value ?? '').replace(/\s+/g, ''),
    visible(el) {
      if (!el) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    },
    list(selector, root = document) { return [...root.querySelectorAll(selector)] },
    byText(selector, text, root = document) {
      return this.list(selector, root).find((el) => this.norm(el.textContent).includes(this.norm(text)))
    },
    click(el) {
      if (!el) throw new Error('click target missing')
      el.scrollIntoView({ block: 'center', inline: 'center' })
      // Synthetic mouse events do not run Chrome's default focus action, so
      // focus the control explicitly. Otherwise Drawer's focus restore would
      // target a stale element and misrepresent real keyboard behaviour.
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }
      }
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      el.click()
      return true
    },
    // Opening an antd Select must stop at mousedown: a following synthetic
    // click would toggle the just-opened dropdown closed again.
    press(el) {
      if (!el) throw new Error('press target missing')
      el.scrollIntoView({ block: 'center', inline: 'center' })
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }
      }
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      return true
    },
    openDrawer() { return this.list('.ant-drawer').find((el) => el.classList.contains('ant-drawer-open')) },
    drawer() {
      const root = this.openDrawer()
      if (!root) throw new Error('no open drawer')
      return {
        root,
        body: root.querySelector('.ant-drawer-body'),
        footer: root.querySelector('.ant-drawer-footer'),
        title: this.norm(root.querySelector('.ant-drawer-title')?.textContent),
        rect: root.querySelector('.ant-drawer-content-wrapper')?.getBoundingClientRect(),
      }
    },
    clickButton(text, root = document) {
      return this.click(this.byText('button', text, root))
    },
    clickDrawerFooterButton(text) {
      return this.click(this.byText('button', text, this.drawer().footer))
    },
    clickDrawerClose() {
      return this.click(this.drawer().root.querySelector('.ant-drawer-close'))
    },
    setField(placeholderPart, value) {
      const drawer = this.openDrawer()
      const scope = drawer ?? document
      const field = this.list('input,textarea', scope).find((el) => (el.getAttribute('placeholder') ?? '').includes(placeholderPart))
      if (!field) throw new Error('field missing: ' + placeholderPart)
      const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new Event('change', { bubbles: true }))
      return field.value
    },
    fieldValue(placeholderPart) {
      const drawer = this.openDrawer()
      const field = this.list('input,textarea', drawer ?? document).find((el) => (el.getAttribute('placeholder') ?? '').includes(placeholderPart))
      return field ? field.value : null
    },
    selectCount() { return this.list('.ant-select', this.drawer().root).length },
    openSelect(index) {
      const select = this.list('.ant-select', this.drawer().root)[index]
      if (!select) throw new Error('select missing: ' + index)
      return this.press(select.querySelector('input') ?? select)
    },
    openCommunitySelect() {
      const card = this.list('.ant-card').find((el) => this.norm(el.textContent).startsWith('社区范围'))
      const select = card?.querySelector('.ant-select')
      if (!select) throw new Error('community selector missing')
      return this.press(select.querySelector('input') ?? select)
    },
    scrollVisibleDropdowns() {
      for (const dropdown of this.list('.ant-select-dropdown')) {
        if (dropdown.className.includes('hidden') || !this.visible(dropdown)) continue
        for (const node of dropdown.querySelectorAll('*')) {
          if (node.scrollHeight > node.clientHeight + 2 && node.clientHeight > 0) {
            node.scrollTop = node.scrollHeight
            node.dispatchEvent(new Event('scroll', { bubbles: true }))
          }
        }
      }
      return true
    },
    hasOption(label) {
      const dropdowns = this.list('.ant-select-dropdown').filter((el) => !el.className.includes('hidden') && this.visible(el))
      return dropdowns.some((dropdown) => Boolean(this.byText('.ant-select-item-option', label, dropdown)))
    },
    clickOption(label) {
      const all = this.list('.ant-select-dropdown')
      const dropdowns = all.filter((el) => !el.className.includes('hidden') && this.visible(el))
      const dropdown = dropdowns[dropdowns.length - 1]
      if (!dropdown) {
        throw new Error(
          'no open select dropdown: ' + JSON.stringify(all.map((el) => ({
            cls: el.className,
            visible: this.visible(el),
            active: el.contains(document.activeElement),
            text: this.norm(el.textContent).slice(0, 80),
          }))),
        )
      }
      const option = this.byText('.ant-select-item-option', label, dropdown)
      if (!option) throw new Error('option missing: ' + label)
      this.click(option)
      return true
    },
    selectTexts() {
      return this.list('.ant-drawer-open .ant-select').map((el) => this.norm(el.textContent))
    },
    dialogText() { return document.querySelector('.ant-modal-confirm')?.textContent ?? '' },
    confirmButton(text) {
      const dialog = document.querySelector('.ant-modal-confirm')
      if (!dialog) throw new Error('no confirm dialog')
      return this.click(this.byText('button', text, dialog))
    },
    toastText() { return this.norm(document.querySelector('.ant-message')?.textContent ?? '') },
    activeText() { return this.norm(document.activeElement?.textContent ?? '') },
    activeIsButton(text) { return document.activeElement === this.byText('button', text) },
    tableText() { return this.norm(document.body.textContent) },
    pageText() { return document.body.textContent ?? '' },
    layout(selector) {
      const el = document.querySelector(selector)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    },
    drawerLayout() {
      const drawer = this.drawer()
      const wrapper = drawer.root.querySelector('.ant-drawer-content-wrapper')
      const body = drawer.body
      const footer = drawer.footer
      const wrapperRect = wrapper.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const footerRect = footer?.getBoundingClientRect()
      return {
        title: drawer.title,
        wrapperWidth: Math.round(wrapperRect.width),
        wrapperLeft: Math.round(wrapperRect.left),
        wrapperRight: Math.round(wrapperRect.right),
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
        bodyOverflowX: body.scrollWidth > body.clientWidth + 1,
        bodyScrollHeight: body.scrollHeight,
        bodyClientHeight: body.clientHeight,
        footerVisible: footerRect ? footerRect.bottom <= window.innerHeight + 1 && footerRect.top >= 0 : false,
        footerBottom: footerRect ? Math.round(footerRect.bottom) : null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    },
    selectedCommunityText() {
      const card = this.list('.ant-card').find((el) => this.norm(el.textContent).startsWith('社区范围'))
      return this.norm(card?.querySelector('.ant-select')?.textContent ?? '')
    },
  };
  true
`

async function installHelpers() {
  await cdp.eval(PAGE_HELPERS)
}

async function gotoCommunities() {
  await cdp.send('Page.navigate', { url: `${ADMIN_ORIGIN}/communities` })
  await cdp.waitFor(`document.readyState === 'complete'`)
  await installHelpers()
  await cdp.waitFor(`[...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('新建社区')) || document.body.textContent.includes('登录')`)
  await sleep(400)
}

/**
 * Clicks an antd Select option, scrolling the dropdown if the wanted label is
 * appended below the currently rendered window (community lists grow).
 */
async function clickSelectOption(label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await cdp.eval(`__t.hasOption(${JSON.stringify(label)})`)) {
      await cdp.eval(`__t.clickOption(${JSON.stringify(label)})`)
      return true
    }
    await cdp.eval(`__t.scrollVisibleDropdowns()`)
    await sleep(350)
  }
  await cdp.eval(`__t.clickOption(${JSON.stringify(label)})`)
}

/**
 * Opens the main community selector and waits until the server-refreshed
 * options include `text`. The list refresh can still be in flight right after
 * a create, and an antd Select sometimes needs a second mousedown to open, so
 * retry with visible diagnostics instead of a single flaky attempt.
 */
async function openCommunitySelectWith(text) {
  let lastState
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await cdp.eval(`__t.openCommunitySelect()`)
    await sleep(400)
    // antd virtualises long option lists: newly appended communities at the
    // end are not in the DOM until the virtual list is scrolled.
    await cdp.eval(`(() => {
      for (const dropdown of __t.list('.ant-select-dropdown')) {
        const holder = dropdown.querySelector('.rc-virtual-list-holder');
        if (holder) {
          holder.scrollTop = holder.scrollHeight;
          holder.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        for (const node of dropdown.querySelectorAll('*')) {
          if (node.scrollHeight > node.clientHeight + 2 && node.clientHeight > 0) {
            node.scrollTop = node.scrollHeight;
            node.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
        }
      }
      return true;
    })()`)
    await sleep(350)
    lastState = await cdp.eval(`(() => {
      const dropdowns = __t.list('.ant-select-dropdown').filter((el) => !el.className.includes('hidden') && __t.visible(el));
      return {
        open: dropdowns.length,
        match: dropdowns.some((el) => __t.norm(el.textContent).includes(${JSON.stringify(text)})),
        options: dropdowns.map((el) => __t.norm(el.textContent)),
        details: dropdowns.map((el) => ({
          optionNodes: el.querySelectorAll('.ant-select-item-option').length,
          hasHolder: Boolean(el.querySelector('.rc-virtual-list-holder')),
        })),
      };
    })()`)
    if (lastState.open > 0 && lastState.match) return lastState
    await cdp.eval(
      `document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true })); true`,
    )
    await sleep(250)
  }
  throw new Error(
    `community selector never offered ${text}: ${JSON.stringify({
      open: lastState?.open,
      details: lastState?.details,
      options: lastState?.options?.map((options) => options.slice(0, 200)),
    })}`,
  )
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const admin = await apiLogin(ADMIN_USER, ADMIN_PASSWORD)
  check('admin API login succeeds', admin.session.staff?.role === 'admin', JSON.stringify(admin.session.staff))

  const profile = join(tmpdir(), `ll-ui-007-chrome-${Date.now()}`)
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
  let target
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
        if (version.webSocketDebuggerUrl) break
      } catch {
        // Chrome is still starting.
      }
      await sleep(150)
    }
    const created = await (
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })
    ).json()
    target = created
    cdp = await Cdp.connect(created.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Inspector.enable')
    await cdp.setViewport(1440, 900)
    await cdp.send('Network.setCookie', {
      name: 'll_session', value: admin.cookie.ll_session, url: `${ADMIN_ORIGIN}/`, path: '/', httpOnly: true, sameSite: 'Lax',
    })
    await cdp.send('Network.setCookie', {
      name: 'll_csrf', value: admin.cookie.ll_csrf, url: `${ADMIN_ORIGIN}/`, path: '/', httpOnly: false, sameSite: 'Lax',
    })

    // ---------- 1. Main area keeps only data and clear create entries ----------
    await gotoCommunities()
    await cdp.waitFor(`document.body.textContent.includes('社区居民')`)
    check('main area shows create entries', await cdp.eval(`['新建社区','新增账户'].every((text) => !!__t.byText('button', text))`))
    check('no drawer open on arrival', (await cdp.eval(`document.querySelectorAll('.ant-drawer-open').length`)) === 0)
    check(
      'create forms are not in the main area',
      await cdp.eval(`!__t.list('input').some((el) => (el.getAttribute('placeholder') ?? '').includes('例如：幸福社区') || (el.getAttribute('placeholder') ?? '').includes('工作人员姓名'))`),
    )
    check('main cards present', await cdp.eval(`['社区范围','后台账户','社区居民'].every((text) => document.body.textContent.includes(text))`))
    await cdp.screenshot('01-communities-1440-initial.png')
    const initialCommunityGets = countRequests('GET', '/api/admin/communities')
    const initialStaffGets = countRequests('GET', '/api/admin/staff')
    check('initial load reads both lists from the API', initialCommunityGets >= 1 && initialStaffGets >= 1, `${initialCommunityGets}/${initialStaffGets}`)

    // A create must not move the operator's scroll position or selection.
    await cdp.eval(`window.scrollTo(0, Math.min(220, Math.max(0, document.body.scrollHeight - window.innerHeight))); true`)
    await sleep(150)
    const scrollBeforeCreate = await cdp.eval(`window.scrollY`)
    const selectedBeforeCreate = await cdp.eval(`__t.selectedCommunityText()`)

    console.log('--- stage 2: community drawer ---')
    // ---------- 2. Community drawer: validation, real create, focus ----------
    await cdp.eval(`__t.clickButton('新建社区')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    let layout = await cdp.eval(`__t.drawerLayout()`)
    check('community drawer width is compact (<= 480)', layout.wrapperWidth <= 480, JSON.stringify(layout))
    check('community drawer fits 1440 viewport', !layout.documentOverflowX && layout.footerVisible, JSON.stringify(layout))
    check('community drawer footer action visible', layout.footerVisible)
    await cdp.screenshot('02-community-drawer-1440.png')

    await cdp.eval(`__t.setField('例如：幸福社区', 'x')`)
    await cdp.eval(`__t.clickDrawerFooterButton('创建社区')`)
    await cdp.waitFor(`!!document.querySelector('.ant-form-item-explain-error')`)
    check('invalid community name is blocked client-side', await cdp.eval(`document.querySelector('.ant-form-item-explain-error')?.textContent.includes('社区名称长度需为 2-60 个字符')`))
    check('invalid submit preserves typed value', (await cdp.eval(`__t.fieldValue('例如：幸福社区')`)) === 'x')
    check('invalid submit keeps drawer open', (await cdp.eval(`document.querySelectorAll('.ant-drawer-open').length`)) === 1)
    await cdp.screenshot('03-community-validation-error-1440.png')
    const communityPostsBefore = requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/admin/communities')).length
    await sleep(300)
    check(
      'invalid submit issues no POST',
      requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/admin/communities')).length === communityPostsBefore,
    )

    console.log('--- stage 2b: valid create ---')
    await cdp.eval(`__t.setField('例如：幸福社区', ${JSON.stringify(COMMUNITY_NEW)})`)
    await cdp.eval(`__t.clickDrawerFooterButton('创建社区')`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)
    await cdp.waitFor(`__t.toastText().includes('社区已创建')`)
    check('create community reports success', (await cdp.eval(`__t.toastText()`)).includes('社区已创建'))
    await cdp.waitFor(`__t.activeIsButton('新建社区')`)
    check('community drawer focus returns to trigger', await cdp.eval(`__t.activeIsButton('新建社区')`))
    const communitiesAfterCreate = await apiGet(admin.cookie, '/admin/communities')
    check(
      'created community persisted through the real API',
      communitiesAfterCreate.body.items.some((item) => item.name === COMMUNITY_NEW),
      JSON.stringify(communitiesAfterCreate.body.items.map((item) => item.name)),
    )
    check(
      'community create refreshes only the community list',
      countRequests('GET', '/api/admin/communities') === initialCommunityGets + 1
        && countRequests('GET', '/api/admin/staff') === initialStaffGets,
      `${countRequests('GET', '/api/admin/communities')} communities / ${countRequests('GET', '/api/admin/staff')} staff GETs`,
    )
    check(
      'community create preserves page scroll',
      Math.abs((await cdp.eval(`window.scrollY`)) - scrollBeforeCreate) <= 1,
      `scroll ${scrollBeforeCreate} -> ${await cdp.eval(`window.scrollY`)}`,
    )
    check(
      'community create preserves selected community',
      (await cdp.eval(`__t.selectedCommunityText()`)) === selectedBeforeCreate,
      `${selectedBeforeCreate} -> ${await cdp.eval(`__t.selectedCommunityText()`)}`,
    )
    // The new community lives in the server-backed selector options, not in
    // the main text until selected, so prove the refresh through the dropdown.
    await openCommunitySelectWith(COMMUNITY_NEW)
    check('created community appears in refreshed selector options', true)
    await cdp.screenshot('04b-community-select-after-create-1440.png')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(200)
    await cdp.screenshot('04-community-created-1440.png')

    // Second community must not move the current selection.
    const selectedBeforeSecond = await cdp.eval(`__t.selectedCommunityText()`)
    await cdp.eval(`__t.clickButton('新建社区')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    await cdp.eval(`__t.setField('例如：幸福社区', ${JSON.stringify(COMMUNITY_SECOND)})`)
    await cdp.eval(`__t.clickDrawerFooterButton('创建社区')`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)
    await sleep(500)
    const communitiesAfterSecond = await apiGet(admin.cookie, '/admin/communities')
    check(
      'second community persisted through the real API',
      communitiesAfterSecond.body.items.some((item) => item.name === COMMUNITY_SECOND),
      JSON.stringify(communitiesAfterSecond.body.items.map((item) => item.name)),
    )
    // Open the real selector to confirm the refreshed options contain the new community.
    await openCommunitySelectWith(COMMUNITY_SECOND)
    check('community selector options come from the refreshed API list', true)
    await cdp.screenshot('05-community-select-refreshed-1440.png')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(200)
    check(
      'creating a community keeps current community selection',
      (await cdp.eval(`__t.selectedCommunityText()`)) === selectedBeforeSecond,
      `${selectedBeforeSecond} -> ${await cdp.eval(`__t.selectedCommunityText()`)}`,
    )

    // Escape on a clean drawer closes it and restores focus. Headless CDP key
    // injection occasionally targets the browser chrome instead of the page, so
    // fall back to a DOM keydown on the focused control and record which path ran.
    await cdp.eval(`__t.clickButton('新建社区')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    await cdp.eval(`document.querySelector('.ant-drawer-open .ant-drawer-body input')?.focus(); true`)
    await cdp.waitFor(`!!document.activeElement?.closest('.ant-drawer-open')`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    let escapePath = 'cdp-key-event'
    try {
      await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`, 1500)
    } catch {
      escapePath = 'dom-keydown'
      await cdp.eval(
        `document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true })); true`,
      )
      await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`, 3000)
    }
    check('Escape closes a clean drawer', true, escapePath)
    await cdp.waitFor(`__t.activeIsButton('新建社区')`)
    check('focus returns after Escape', await cdp.eval(`__t.activeIsButton('新建社区')`))

    console.log('--- stage 3: staff drawer ---')
    // ---------- 3. Staff drawer: wider form, validation, real create ----------
    const communityGetsBeforeStaffCreate = countRequests('GET', '/api/admin/communities')
    const staffGetsBeforeStaffCreate = countRequests('GET', '/api/admin/staff')
    await cdp.eval(`__t.clickButton('新增账户')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    layout = await cdp.eval(`__t.drawerLayout()`)
    check('staff drawer is wider than community drawer', layout.wrapperWidth >= 500 && layout.wrapperWidth <= 640, JSON.stringify(layout))
    check('staff drawer fits 1440 viewport', !layout.documentOverflowX && layout.footerVisible, JSON.stringify(layout))
    check(
      'staff drawer exposes role and responsible community fields',
      await cdp.eval(`(() => { const text = __t.drawer().body.textContent; return text.includes('角色') && text.includes('负责社区') && __t.selectCount() >= 2 })()`),
    )
    await cdp.screenshot('06-staff-drawer-1440.png')

    await cdp.eval(`__t.clickDrawerFooterButton('创建账户')`)
    await cdp.waitFor(`!!document.querySelector('.ant-form-item-explain-error')`)
    check('staff form requires role and community', await cdp.eval(`document.body.textContent.includes('请选择角色') && document.body.textContent.includes('请选择至少一个负责社区')`))
    check('invalid staff submit keeps drawer open', (await cdp.eval(`document.querySelectorAll('.ant-drawer-open').length`)) === 1)
    await cdp.screenshot('07-staff-validation-error-1440.png')

    const staffPostsBefore = requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/admin/staff')).length
    await cdp.eval(`[
      __t.setField('3-32 位字母、数字、点、下划线或短横线', ${JSON.stringify(STAFF_USERNAME)}),
      __t.setField('工作人员姓名', ${JSON.stringify(STAFF_DISPLAY)}),
      __t.setField('至少 12 位，创建后请安全告知本人', ${JSON.stringify(WORKER_PASSWORD)})
    ]; true`)
    await cdp.eval(`__t.openSelect(0)`)
    await cdp.waitFor(`!!__t.list('.ant-select-dropdown').find((el) => !el.className.includes('hidden') && __t.visible(el))`)
    await sleep(300)
    await clickSelectOption('网格员')
    await sleep(250)
    await cdp.eval(`__t.openSelect(1)`)
    await cdp.waitFor(`!!__t.list('.ant-select-dropdown').find((el) => !el.className.includes('hidden') && __t.visible(el))`)
    await sleep(300)
    await clickSelectOption(COMMUNITY_NEW)
    await sleep(150)
    await cdp.eval(`__t.click(document.querySelector('.ant-drawer-open .ant-drawer-header'))`)
    await cdp.eval(`__t.clickDrawerFooterButton('创建账户')`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)
    await cdp.waitFor(`document.body.textContent.includes(${JSON.stringify(STAFF_USERNAME)})`)
    await cdp.waitFor(`__t.toastText().includes('后台账户已创建')`)
    check('create staff account reports success', (await cdp.eval(`__t.toastText()`)).includes('后台账户已创建'))
    check('created staff row comes from real API refresh', await cdp.eval(`document.body.textContent.includes(${JSON.stringify(STAFF_USERNAME)}) && document.body.textContent.includes(${JSON.stringify(STAFF_DISPLAY)})`))
    await cdp.waitFor(`__t.activeIsButton('新增账户')`)
    check('staff drawer focus returns to trigger', await cdp.eval(`__t.activeIsButton('新增账户')`))
    check(
      'staff create refreshes only the staff list',
      countRequests('GET', '/api/admin/staff') === staffGetsBeforeStaffCreate + 1
        && countRequests('GET', '/api/admin/communities') === communityGetsBeforeStaffCreate,
      `${countRequests('GET', '/api/admin/staff')} staff / ${countRequests('GET', '/api/admin/communities')} communities GETs`,
    )
    await cdp.screenshot('08-staff-created-1440.png')
    const staffPostsAfterCreate = requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/admin/staff')).length
    check('staff create issued exactly one POST', staffPostsAfterCreate === staffPostsBefore + 1, `${staffPostsBefore} -> ${staffPostsAfterCreate}`)

    console.log('--- stage 4: server failure ---')
    // ---------- 4. Server failure keeps input and drawer state ----------
    await cdp.eval(`__t.clickButton('新增账户')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    await cdp.eval(`[
      __t.setField('3-32 位字母、数字、点、下划线或短横线', ${JSON.stringify(STAFF_USERNAME)}),
      __t.setField('工作人员姓名', '重复账号'),
      __t.setField('至少 12 位，创建后请安全告知本人', 'AnotherPassword123')
    ]; true`)
    await cdp.eval(`__t.openSelect(0)`)
    await cdp.waitFor(`!!__t.list('.ant-select-dropdown').find((el) => !el.className.includes('hidden') && __t.visible(el))`)
    await sleep(300)
    await clickSelectOption('运营员')
    await sleep(250)
    await cdp.eval(`__t.openSelect(1)`)
    await cdp.waitFor(`!!__t.list('.ant-select-dropdown').find((el) => !el.className.includes('hidden') && __t.visible(el))`)
    await sleep(300)
    await clickSelectOption(COMMUNITY_NEW)
    await sleep(150)
    await cdp.eval(`__t.click(document.querySelector('.ant-drawer-open .ant-drawer-header'))`)
    await cdp.eval(`__t.clickDrawerFooterButton('创建账户')`)
    await cdp.waitFor(`!!document.querySelector('.ant-alert-error')`)
    check('real API 409 is surfaced inside the drawer', await cdp.eval(`document.querySelector('.ant-alert-error')?.textContent.includes('登录账号已存在')`))
    check('failed create keeps typed username', (await cdp.eval(`__t.fieldValue('3-32 位字母、数字、点、下划线或短横线')`)) === STAFF_USERNAME)
    check('failed create keeps drawer open', (await cdp.eval(`document.querySelectorAll('.ant-drawer-open').length`)) === 1)
    await cdp.screenshot('09-staff-duplicate-error-1440.png')

    console.log('--- stage 5: dirty close guard ---')
    // ---------- 5. Dirty close guard, cancel, clean close ----------
    await cdp.eval(`__t.clickDrawerClose()`)
    await cdp.waitFor(`!!document.querySelector('.ant-modal-confirm')`)
    check('dirty drawer close asks for confirmation', (await cdp.eval(`__t.dialogText()`)).includes('放弃已填写的账户信息'))
    await cdp.screenshot('10-dirty-close-confirm-1440.png')
    await cdp.eval(`__t.confirmButton('继续填写')`)
    await cdp.waitFor(`!document.querySelector('.ant-modal-confirm')`)
    check('continue editing keeps drawer open', (await cdp.eval(`document.querySelectorAll('.ant-drawer-open').length`)) === 1)
    check('continue editing keeps typed values', (await cdp.eval(`__t.fieldValue('3-32 位字母、数字、点、下划线或短横线')`)) === STAFF_USERNAME)

    const staffPostsBeforeDiscard = countRequests('POST', '/api/admin/staff')
    const staffRowsBeforeDiscard = (await apiGet(admin.cookie, '/admin/staff')).body.items.length
    await cdp.eval(`__t.clickDrawerFooterButton('取消')`)
    await cdp.waitFor(`!!document.querySelector('.ant-modal-confirm')`)
    await cdp.eval(`__t.confirmButton('放弃并关闭')`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)
    await sleep(300)
    check(
      'discarding a dirty form closes without creating',
      countRequests('POST', '/api/admin/staff') === staffPostsBeforeDiscard
        && (await apiGet(admin.cookie, '/admin/staff')).body.items.length === staffRowsBeforeDiscard,
    )
    await cdp.waitFor(`__t.activeIsButton('新增账户')`)
    check('focus returns after guarded close', await cdp.eval(`__t.activeIsButton('新增账户')`))
    await cdp.screenshot('11-dirty-close-discarded-1440.png')
    await cdp.eval(`__t.clickButton('新增账户')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    check('reopening after discard starts clean', (await cdp.eval(`__t.fieldValue('3-32 位字母、数字、点、下划线或短横线')`)) === '')
    await cdp.eval(`__t.clickDrawerFooterButton('取消')`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)
    check('clean cancel closes without confirmation', !(await cdp.eval(`!!document.querySelector('.ant-modal-confirm')`)))

    console.log('--- stage 6: duplicate click ---')
    // ---------- 6. Duplicate click guard against the real API ----------
    await cdp.eval(`__t.clickButton('新建社区')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    await cdp.eval(`__t.setField('例如：幸福社区', ${JSON.stringify(COMMUNITY_DUPLICATE)})`)
    await cdp.eval(`{
      const button = __t.byText('button', '创建社区', __t.drawer().footer);
      button.click(); button.click();
      true
    }`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`, 10000)
    await sleep(800)
    const communities = await apiGet(admin.cookie, '/admin/communities')
    check(
      'double click creates exactly one community',
      communities.body.items.filter((item) => item.name === COMMUNITY_DUPLICATE).length === 1,
      JSON.stringify(communities.body.items.map((item) => item.name)),
    )
    await cdp.screenshot('12-double-click-1440.png')

    console.log('--- stage 7: narrow viewports ---')
    // ---------- 7. Narrow viewports: no overflow, footer reachable ----------
    async function narrowCheck(label, width, height, opener, file) {
      await cdp.setViewport(width, height)
      const page = await cdp.eval(`__t.layout('body')`)
      check(`${label} main page has no horizontal overflow`, !page.horizontalOverflow, JSON.stringify(page))
      await cdp.eval(opener)
      await cdp.waitFor(`!!__t.openDrawer()`)
      const info = await cdp.eval(`__t.drawerLayout()`)
      check(`${label} drawer has no horizontal overflow`, !info.documentOverflowX && !info.bodyOverflowX, JSON.stringify(info))
      check(`${label} drawer footer stays inside viewport`, info.footerVisible, JSON.stringify(info))
      check(`${label} drawer fits viewport width`, info.wrapperWidth <= width, JSON.stringify(info))
      check(`${label} drawer body scrolls instead of clipping the form`, info.bodyScrollHeight >= info.bodyClientHeight, JSON.stringify(info))
      await cdp.screenshot(file)
      await cdp.eval(`__t.clickDrawerClose()`)
      await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)
      const trigger = label.includes('staff') ? '新增账户' : '新建社区'
      // rc-drawer restores focus when the close animation finishes, so wait
      // for it instead of sampling the active element too early.
      await cdp.waitFor(`__t.activeIsButton(${JSON.stringify(trigger)})`, 4000)
      check(`${label} focus returns to trigger`, await cdp.eval(`__t.activeIsButton(${JSON.stringify(trigger)})`))
    }

    await cdp.setViewport(1024, 800)
    await cdp.eval(`__t.clickButton('新建社区')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    let info = await cdp.eval(`__t.drawerLayout()`)
    check('1024 community drawer has no overflow', !info.documentOverflowX && !info.bodyOverflowX, JSON.stringify(info))
    check('1024 community drawer footer visible', info.footerVisible, JSON.stringify(info))
    await cdp.screenshot('13-community-drawer-1024.png')
    await cdp.eval(`__t.clickDrawerFooterButton('取消')`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)
    const page1024 = await cdp.eval(`__t.layout('body')`)
    check('1024 main page has no horizontal overflow', !page1024.horizontalOverflow, JSON.stringify(page1024))
    await cdp.eval(`__t.clickButton('新增账户')`)
    await cdp.waitFor(`!!__t.openDrawer()`)
    info = await cdp.eval(`__t.drawerLayout()`)
    check('1024 staff drawer has no overflow', !info.documentOverflowX && !info.bodyOverflowX, JSON.stringify(info))
    check('1024 staff drawer footer visible', info.footerVisible, JSON.stringify(info))
    await cdp.screenshot('13b-staff-drawer-1024.png')
    await cdp.eval(`__t.clickDrawerFooterButton('取消')`)
    await cdp.waitFor(`document.querySelectorAll('.ant-drawer-open').length === 0`)

    await narrowCheck('768 community', 768, 800, `__t.clickButton('新建社区')`, '14-community-drawer-768.png')
    await narrowCheck('768 staff', 768, 800, `__t.clickButton('新增账户')`, '15-staff-drawer-768.png')
    await narrowCheck('767 community', 767, 800, `__t.clickButton('新建社区')`, '16-community-drawer-767.png')
    await narrowCheck('375 community', 375, 812, `__t.clickButton('新建社区')`, '17-community-drawer-375.png')
    await narrowCheck('375 staff', 375, 812, `__t.clickButton('新增账户')`, '18-staff-drawer-375.png')
    await narrowCheck('320 community', 320, 640, `__t.clickButton('新建社区')`, '19-community-drawer-320.png')
    await narrowCheck('320 staff', 320, 640, `__t.clickButton('新增账户')`, '19b-staff-drawer-320.png')

    await cdp.setViewport(1440, 900)

    console.log('--- stage 8: permission boundary ---')
    // ---------- 8. Permission boundary: grid worker gets no write UI ----------
    const worker = await apiLogin(STAFF_USERNAME, WORKER_PASSWORD)
    check('grid worker API login succeeds', worker.session.staff?.role === 'grid_worker', JSON.stringify(worker.session.staff))
    const workerCommunities = await apiGet(worker.cookie, '/admin/communities')
    check('grid worker sees only assigned communities', workerCommunities.body.items.length === 1, JSON.stringify(workerCommunities.body))
    const forbiddenCreate = await apiWrite(worker.cookie, worker.csrfToken, 'POST', '/admin/communities', { name: '越权社区' })
    check('server rejects worker community create with 403', forbiddenCreate.status === 403, JSON.stringify(forbiddenCreate))
    const forbiddenStaff = await apiWrite(worker.cookie, worker.csrfToken, 'POST', '/admin/staff', {
      username: 'forbidden.user', displayName: '越权', password: 'ForbiddenPass123', role: 'operator', communityIds: [workerCommunities.body.items[0].id],
    })
    check('server rejects worker staff create with 403', forbiddenStaff.status === 403, JSON.stringify(forbiddenStaff))
    const anonymous = await apiGet({}, '/admin/communities')
    check('server rejects anonymous admin read with 401', anonymous.status === 401, JSON.stringify(anonymous))

    await cdp.send('Network.clearBrowserCookies')
    await cdp.send('Network.setCookie', {
      name: 'll_session', value: worker.cookie.ll_session, url: `${ADMIN_ORIGIN}/`, path: '/', httpOnly: true, sameSite: 'Lax',
    })
    await cdp.send('Network.setCookie', {
      name: 'll_csrf', value: worker.cookie.ll_csrf, url: `${ADMIN_ORIGIN}/`, path: '/', httpOnly: false, sameSite: 'Lax',
    })
    await cdp.send('Page.navigate', { url: `${ADMIN_ORIGIN}/communities` })
    await cdp.waitFor(`document.readyState === 'complete'`)
    await installHelpers()
    await cdp.waitFor(`document.body.textContent.includes('社区居民')`)
    await sleep(500)
    check('grid worker UI hides 新建社区', !(await cdp.eval(`!!__t.byText('button', '新建社区')`)))
    check('grid worker UI hides 新增账户', !(await cdp.eval(`!!__t.byText('button', '新增账户')`)))
    check('grid worker UI mounts no admin drawer', (await cdp.eval(`document.querySelectorAll('.ant-drawer').length`)) === 0)
    check('grid worker sees assigned community only', (await cdp.eval(`__t.selectedCommunityText()`)).includes(COMMUNITY_NEW))
    await cdp.screenshot('20-permission-grid-worker-1440.png')
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

  const summary = {
    generatedAt: new Date().toISOString(),
    runTag: RUN_TAG,
    adminOrigin: ADMIN_ORIGIN,
    apiOrigin: API_ORIGIN,
    checks: results,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    requests,
  }
  writeFileSync(join(OUT_DIR, 'browser-results.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`)
  if (summary.failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  try {
    writeFileSync(join(OUT_DIR, 'browser-results.json'), `${JSON.stringify({ error: String(error), checks: results, requests }, null, 2)}\n`)
  } catch {
    // Ignore secondary write failures.
  }
  process.exitCode = 1
})
