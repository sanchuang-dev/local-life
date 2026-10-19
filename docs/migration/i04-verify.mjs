/**
 * I04 (#26) home sections browser verification.
 *
 * Setup:
 *   npm ci
 *   npm i --no-save playwright-core
 *   npm run build
 *   npm run preview -- --host 127.0.0.1 --port 4173
 *   # Optional: install a CJK font (e.g. fonts-noto-cjk) for readable screenshots.
 * Run:
 *   node docs/migration/i04-verify.mjs
 *
 * Requires Chromium at /usr/bin/chromium unless CHROMIUM_PATH is set.
 * Screenshots are written to docs/engineering/evidence/i04/.
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = 'http://127.0.0.1:4173/local-life/#'
const evidenceDir = 'docs/engineering/evidence/i04'
const results = []
const errors = []

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-gpu'],
})

const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}

const attachDiagnostics = (page) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) {
      errors.push(`console.error ${page.url()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', (err) => errors.push(`pageerror ${page.url()}: ${err.message}`))
}

const hash = (page) => page.evaluate(() => location.hash.replace(/^#/, ''))
const at = async (page, route) => {
  await page.goto(base + route, { waitUntil: 'networkidle' })
  await page.waitForTimeout(80)
}
const expectHash = async (page, name, expected) => {
  const actual = await hash(page)
  record(name, actual === expected, `${actual} (expected ${expected})`)
}
const clickHomeLink = async (page, text) => {
  await page.locator('main a', { hasText: text }).first().click()
  await page.waitForTimeout(140)
}
const clickBackLabel = async (page, label) => {
  await page.locator('main a').filter({ hasText: label }).first().click()
  await page.waitForTimeout(140)
}
const checkNoOverflow = async (page, label) => {
  const info = await page.evaluate(() => {
    const main = document.querySelector('#main-content')
    const nav = document.querySelector('nav[aria-label="主导航"]')
    const mainRect = main?.getBoundingClientRect()
    const navRect = nav?.getBoundingClientRect()
    return {
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth,
      mainOverflow: main ? main.scrollWidth > main.clientWidth : true,
      navGap: mainRect && navRect ? Math.round(navRect.top - mainRect.bottom) : -1,
      mainScrollHeight: main?.scrollHeight ?? 0,
      mainClientHeight: main?.clientHeight ?? 0,
    }
  })
  record(
    `${label} no horizontal overflow / nav flush`,
    !info.docOverflow && !info.bodyOverflow && !info.mainOverflow && info.navGap === 0,
    JSON.stringify(info),
  )
  return info
}
const scrollSectionToTop = async (page, title) => {
  await page.locator('section', { hasText: title }).first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(120)
}

await mkdir(evidenceDir, { recursive: true })

/* ------------------------------------------------------------ 375 x 812 */
const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
attachDiagnostics(page)

await at(page, '/')
await page.screenshot({ path: `${evidenceDir}/home-top-375.png` })

const homeCopy = await page.locator('#main-content').innerText()
for (const text of ['我的积分', '今天听一点健康', '惠生活', '2680', '中老年人夏季血压波动的日常观察', '时令水果篮']) {
  record(`375px home renders ${text}`, homeCopy.includes(text))
}

await scrollSectionToTop(page, '我的积分')
await page.screenshot({ path: `${evidenceDir}/home-points-375.png` })
await checkNoOverflow(page, '375px points section')

await scrollSectionToTop(page, '今天听一点健康')
await page.screenshot({ path: `${evidenceDir}/home-health-375.png` })
await checkNoOverflow(page, '375px health section')

await scrollSectionToTop(page, '惠生活')
await page.screenshot({ path: `${evidenceDir}/home-life-375.png` })
const lifeSectionVisible = await page.locator('section', { hasText: '进入惠生活' }).isVisible()
record('375px life section is visible after scrolling', lifeSectionVisible)
await page.evaluate(() => {
  const main = document.querySelector('#main-content')
  if (main) main.scrollTop = main.scrollHeight
})
await page.waitForTimeout(120)
const atBottom = await page.evaluate(() => {
  const main = document.querySelector('#main-content')
  return main ? main.scrollTop + main.clientHeight >= main.scrollHeight - 1 : false
})
record('375px home scrolls to the end without covering the tab bar', atBottom)
await page.screenshot({ path: `${evidenceDir}/home-bottom-375.png` })

// Points entry: heading action and card detail both route to the single page.
await at(page, '/')
await clickHomeLink(page, '去赚积分')
await expectHash(page, 'home heading opens points', '/points')
record('points heading entity matches', (await page.locator('h1').textContent())?.includes('我的积分') ?? false)
record('points shows shared demo balance', (await page.locator('main').innerText()).includes('2680'))
await clickBackLabel(page, '返回首页')
await expectHash(page, 'points back-to-home label returns home', '/')

await at(page, '/')
await clickHomeLink(page, '积分明细')
await expectHash(page, 'home balance card opens points', '/points')
await clickBackLabel(page, '返回首页')
await expectHash(page, 'points card back returns home', '/')

// Health lecture entry and back target.
await at(page, '/')
await clickHomeLink(page, '睡前十分钟拉伸')
await expectHash(page, 'home health entry opens lecture', '/health/lecture')
record('lecture entity matches', (await page.locator('h1').textContent())?.includes('健康讲堂') ?? false)
record(
  'lecture keeps the home source label',
  (await page.locator('main a').filter({ hasText: '返回首页' }).count()) > 0,
)
await clickBackLabel(page, '返回首页')
await expectHash(page, 'lecture returns home', '/')

// Life module entry via heading action.
await at(page, '/')
await clickHomeLink(page, '进入惠生活')
await expectHash(page, 'home life action opens life module', '/life')
record('life module entity matches', (await page.locator('h1').textContent())?.includes('惠生活') ?? false)
await page.locator('nav[aria-label="主导航"] a', { hasText: '首页' }).click()
await page.waitForTimeout(120)
await expectHash(page, 'bottom tab returns home from life', '/')

// Product detail from home keeps its own entity and returns home.
await at(page, '/')
await clickHomeLink(page, '时令水果篮')
await expectHash(page, 'home product card opens its own detail', '/life/product/fruit-basket')
record('product entity matches', (await page.locator('h1').textContent())?.includes('时令水果篮') ?? false)
record('product detail keeps demo balance', (await page.locator('main').innerText()).includes('演示余额'))
await clickBackLabel(page, '返回首页')
await expectHash(page, 'product back returns home', '/')

// Bottom tabs still available from the home bottom.
await at(page, '/')
await page.evaluate(() => {
  const main = document.querySelector('#main-content')
  if (main) main.scrollTop = main.scrollHeight
})
await page.waitForTimeout(120)
for (const [label, expected] of [
  ['社区', '/community'],
  ['健康', '/health'],
  ['惠生活', '/life'],
  ['我的', '/me'],
]) {
  await page.locator('nav[aria-label="主导航"] a', { hasText: label }).click()
  await page.waitForTimeout(120)
  await expectHash(page, `375px bottom tab ${label}`, expected)
  await page.locator('nav[aria-label="主导航"] a', { hasText: '首页' }).click()
  await page.waitForTimeout(120)
}
await page.close()

/* ------------------------------------------------------------ 320 x 812 */
const narrow = await browser.newPage({ viewport: { width: 320, height: 812 } })
attachDiagnostics(narrow)
await at(narrow, '/')
await narrow.screenshot({ path: `${evidenceDir}/home-top-320.png` })

const narrowCopy = await narrow.locator('#main-content').innerText()
for (const text of ['我的积分', '今天听一点健康', '惠生活', '时令水果篮']) {
  record(`320px home renders ${text}`, narrowCopy.includes(text))
}

await scrollSectionToTop(narrow, '我的积分')
await checkNoOverflow(narrow, '320px points section')
await scrollSectionToTop(narrow, '今天听一点健康')
await checkNoOverflow(narrow, '320px health section')
await scrollSectionToTop(narrow, '惠生活')
await checkNoOverflow(narrow, '320px life section')
await narrow.evaluate(() => {
  const main = document.querySelector('#main-content')
  if (main) main.scrollTop = main.scrollHeight
})
await narrow.waitForTimeout(120)
const narrowBottom = await narrow.evaluate(() => {
  const main = document.querySelector('#main-content')
  return main ? main.scrollTop + main.clientHeight >= main.scrollHeight - 1 : false
})
record('320px home scrolls to the end without covering the tab bar', narrowBottom)
await narrow.screenshot({ path: `${evidenceDir}/home-bottom-320.png` })

await at(narrow, '/')
await clickHomeLink(narrow, '5 斤装大米')
await expectHash(narrow, '320px product card opens its own detail', '/life/product/rice-5kg')
record('320px product entity matches', (await narrow.locator('h1').textContent())?.includes('5 斤装大米') ?? false)
await clickBackLabel(narrow, '返回首页')
await expectHash(narrow, '320px product back returns home', '/')
await narrow.close()

await browser.close()

const failed = results.filter((item) => !item.pass)
console.log(`SUMMARY ${results.length - failed.length}/${results.length} passed`)
console.log(`JS_ERRORS ${errors.length}`)
for (const error of errors) console.log(`JS_ERROR ${error}`)
if (failed.length > 0) {
  for (const item of failed) console.log(`FAILED ${item.name} :: ${item.detail}`)
  process.exitCode = 1
}
if (errors.length > 0) process.exitCode = 1
