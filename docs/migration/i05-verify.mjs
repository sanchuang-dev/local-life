/**
 * I05 (#27) bounded browser verification for the community scene cards.
 *
 * Setup:
 *   npm ci
 *   npm i --no-save --no-package-lock playwright-core
 *   npm run check
 *   npm run preview -- --host 127.0.0.1 --port 4173
 * Run:
 *   node docs/migration/i05-verify.mjs
 *
 * Requires Chromium at /usr/bin/chromium unless CHROMIUM_PATH is set.
 * Screenshots are written to /tmp/opencode/ and are not committed.
 */
import { chromium } from 'playwright-core'

const base = 'http://127.0.0.1:4173/local-life/#'
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-gpu'],
})

const results = []
const errors = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}
const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim()
const hash = (page) => page.evaluate(() => location.hash.replace(/^#/, ''))

async function at(page, route) {
  await page.goto(base + route, { waitUntil: 'networkidle' })
  await page.waitForTimeout(80)
}

async function sceneCard(page, prompt) {
  return page.locator('main a').filter({ hasText: prompt }).first()
}

async function inspectLayout(page, name, expectSceneCards = false) {
  const info = await page.evaluate(() => {
    const main = document.querySelector('#main-content')
    const nav = document.querySelector('nav[aria-label="主导航"]')
    const mainRect = main?.getBoundingClientRect()
    const navRect = nav?.getBoundingClientRect()
    const cards = [...document.querySelectorAll('main a')].filter((el) =>
      /下午一起下棋|晚上去跳舞/.test(el.textContent ?? ''),
    )
    return {
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth,
      mainOverflow: main ? main.scrollWidth > main.clientWidth : true,
      navGap: mainRect && navRect ? Math.round(navRect.top - mainRect.bottom) : -1,
      navVisible: !!nav && navRect ? navRect.height > 0 && navRect.bottom <= innerHeight + 1 : false,
      cards: cards.map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      }),
      viewport: { width: innerWidth, height: innerHeight },
    }
  })

  record(`${name} no document/body/main horizontal overflow`, !info.docOverflow && !info.bodyOverflow && !info.mainOverflow)
  record(`${name} bottom nav visible and adjacent to main`, info.navVisible && info.navGap === 0, `gap=${info.navGap}`)
  if (expectSceneCards) {
    record(
      `${name} scene cards stay inside viewport width`,
      info.cards.length === 2 && info.cards.every((card) => card.left >= 0 && card.right <= info.viewport.width),
      JSON.stringify(info.cards),
    )
  }
  return info
}

// ---- 375: content, order and interactions ---------------------------------
const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
page.on('console', (msg) => {
  if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(`console.error ${page.url()}: ${msg.text()}`)
})
page.on('pageerror', (err) => errors.push(`pageerror ${page.url()}: ${err.message}`))

await at(page, '/community')
const chess = await sceneCard(page, '下午一起下棋')
const dance = await sceneCard(page, '晚上去跳舞')
const chessText = normalize(await chess.textContent())
const danceText = normalize(await dance.textContent())
record('375 scene card 1 prompt/entity/time/place/tags', /下午一起下棋/.test(chessText) && /象棋友谊赛/.test(chessText) && /14:30/.test(chessText) && /社区活动室 1 楼/.test(chessText) && /棋牌/.test(chessText), chessText)
record('375 scene card 2 prompt/entity/time/place/tags', /晚上去跳舞/.test(danceText) && /广场舞教学/.test(danceText) && /19:00/.test(danceText) && /社区中心广场/.test(danceText) && /舞蹈/.test(danceText), danceText)
const chessHref = await chess.getAttribute('href')
const danceHref = await dance.getAttribute('href')
record('375 scene card routes match entities', (chessHref ?? '').endsWith('/community/activity/chess') && (danceHref ?? '').endsWith('/community/activity/dance'), `${chessHref} | ${danceHref}`)

const order = await page.evaluate(() => {
  const scene = [...document.querySelectorAll('h2')].find((el) => el.textContent?.includes('社区生活场景'))
  const entries = [...document.querySelectorAll('h2')].find((el) => el.textContent === '社区入口')
  const activities = [...document.querySelectorAll('h2')].find((el) => el.textContent?.includes('正在发生的社区活动'))
  const notices = [...document.querySelectorAll('h2')].find((el) => el.textContent === '社区通知')
  return Boolean(
    scene && entries && activities && notices &&
      scene.compareDocumentPosition(entries) & Node.DOCUMENT_POSITION_FOLLOWING &&
      entries.compareDocumentPosition(activities) & Node.DOCUMENT_POSITION_FOLLOWING &&
      activities.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
})
record('375 hierarchy: scenes -> entries -> activities -> notices', order)
await inspectLayout(page, '375 /community', true)
await page.screenshot({ path: '/tmp/opencode/i05-community-375.png' })

await chess.click()
await page.waitForTimeout(150)
record('375 chess scene opens chess detail', (await hash(page)) === '/community/activity/chess', await hash(page))
record('375 chess detail title matches', /象棋友谊赛/.test(normalize(await page.locator('article h2').first().textContent())))
record('375 chess detail session matches', /今天 14:30–16:30/.test(normalize(await page.locator('main').textContent())))
record('375 chess detail back label', (await page.locator('main a').filter({ hasText: '返回社区' }).count()) > 0)
await page.screenshot({ path: '/tmp/opencode/i05-chess-375.png' })
await page.locator('main a').filter({ hasText: '返回社区' }).first().click()
await page.waitForTimeout(150)
record('375 chess detail returns to community', (await hash(page)) === '/community', await hash(page))

await (await sceneCard(page, '晚上去跳舞')).click()
await page.waitForTimeout(150)
record('375 dance scene opens dance detail', (await hash(page)) === '/community/activity/dance', await hash(page))
record('375 dance detail title matches', /广场舞教学/.test(normalize(await page.locator('article h2').first().textContent())))
record('375 dance detail session matches', /今天 19:00–20:00/.test(normalize(await page.locator('main').textContent())))
await page.locator('main a').filter({ hasText: '返回社区' }).first().click()
await page.waitForTimeout(150)
record('375 dance detail returns to community', (await hash(page)) === '/community', await hash(page))

// Direct detail visit keeps the community fallback.
await at(page, '/community/activity/chess')
record('direct chess visit returns to community', (await page.locator('main a').filter({ hasText: '返回社区' }).count()) > 0)
record('direct chess visit matches entity', /象棋友谊赛/.test(normalize(await page.locator('article h2').first().textContent())))

// Home activity cards keep their I01 home-return source.
await at(page, '/')
await page.locator('main a').filter({ hasText: '象棋友谊赛' }).first().click()
await page.waitForTimeout(150)
record('home chess card opens chess detail', (await hash(page)) === '/community/activity/chess', await hash(page))
record('home-sourced chess detail keeps 返回首页', (await page.locator('main a').filter({ hasText: '返回首页' }).count()) > 0)
await page.locator('main a').filter({ hasText: '返回首页' }).first().click()
await page.waitForTimeout(150)
record('home-sourced chess detail returns home', (await hash(page)) === '/', await hash(page))

// Existing community entries and notices stay reachable.
for (const [label, route, marker] of [
  ['社区广播', '/community/broadcast', '今日 4 条'],
  ['社区活动', '/community/activity/performance', '3 场示例'],
  ['党群文化中心', '/community/culture', '演示排期'],
]) {
  await at(page, '/community')
  await page.locator('main a').filter({ hasText: marker }).first().click()
  await page.waitForTimeout(150)
  record(`entry reachable: ${label} -> ${route}`, (await hash(page)) === route, await hash(page))
}
await at(page, '/community')
await page.locator('main a').filter({ hasText: '今晚 20:00–22:00 东片区计划停水' }).first().click()
await page.waitForTimeout(150)
record('notice reachable: water detail', (await hash(page)) === '/community/notice/water', await hash(page))

// Pending service feedback remains explicit.
await at(page, '/community')
await page.locator('main button').filter({ hasText: '助老服务' }).first().click()
await page.waitForTimeout(100)
const pending = normalize(await page.locator('[role="status"]').first().textContent())
record('pending entry shows demo feedback', /演示/.test(pending) && /助老服务/.test(pending), pending)

// ---- 375 / 320 layout sweep ------------------------------------------------
for (const width of [375, 320]) {
  const probe = await browser.newPage({ viewport: { width, height: 812 } })
  probe.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(`console.error ${probe.url()}: ${msg.text()}`)
  })
  probe.on('pageerror', (err) => errors.push(`pageerror ${probe.url()}: ${err.message}`))

  await at(probe, '/community')
  const info = await inspectLayout(probe, `${width} /community`, true)
  await probe.screenshot({ path: `/tmp/opencode/i05-community-${width}-top.png` })
  const scroll = await probe.evaluate(() => {
    const main = document.querySelector('#main-content')
    const nav = document.querySelector('nav[aria-label="主导航"]')
    if (!main || !nav) return { ok: false }
    main.scrollTop = main.scrollHeight
    const mainRect = main.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    const last = main.lastElementChild?.getBoundingClientRect()
    return {
      ok: !!last && last.bottom <= mainRect.bottom + 1 && navRect.top >= mainRect.bottom - 1,
      lastBottom: last ? Math.round(last.bottom) : -1,
      mainBottom: Math.round(mainRect.bottom),
      navTop: Math.round(navRect.top),
    }
  })
  record(`${width} /community scroll bottom not hidden by tab bar`, scroll.ok, JSON.stringify(scroll))
  record(`${width} /community scene card heights reasonable`, info.cards.every((card) => card.height >= 80 && card.height <= 200), JSON.stringify(info.cards))
  await probe.screenshot({ path: `/tmp/opencode/i05-community-${width}-bottom.png` })

  for (const route of ['/community/activity/chess', '/community/activity/dance']) {
    await at(probe, route)
    await inspectLayout(probe, `${width} ${route}`)
  }
  await probe.close()
}

await page.close()
await browser.close()

const failed = results.filter((result) => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`)
if (errors.length) console.log(`Runtime errors:\n${errors.join('\n')}`)
if (failed.length) {
  console.log(`Failures:\n${failed.map((result) => `${result.name} :: ${result.detail}`).join('\n')}`)
  process.exitCode = 1
}
