/**
 * I02 (#21) full control sweep for the migrated prototype.
 *
 * Setup is the same as docs/migration/i02-verify.mjs. This script clicks every
 * visible internal link (checks the resulting hash and that the target is not
 * 404) and every visible button (checks navigation, filter/expand state or a
 * role=status demo notice). Buttons that start in a selected filter state are
 * counted as skipped because clicking them is a by-design no-op.
 */
import { chromium } from 'playwright-core'

const base = 'http://127.0.0.1:4173/local-life/#'
const routes = [
  '/',
  '/gd',
  '/community',
  '/community/broadcast',
  '/community/activity',
  '/community/activity/performance',
  '/community/activity/chess',
  '/community/activity/welfare-day',
  '/community/activity/dance',
  '/community/activity/missing',
  '/community/culture',
  '/community/notice/water',
  '/community/notice/missing',
  '/health',
  '/health/assistant',
  '/health/device',
  '/health/lecture',
  '/life',
  '/life/exchange',
  '/life/product/rice-5kg',
  '/life/product/missing',
  '/points',
  '/me/devices',
  '/discover',
  '/me',
  '/unknown-route',
]

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
const jsErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') jsErrors.push(`console.error ${page.url()}: ${msg.text()}`)
})
page.on('pageerror', (err) => jsErrors.push(`pageerror ${page.url()}: ${err.message}`))

const failures = []
let linksChecked = 0
let linksSkipped = 0
let buttonsChecked = 0
let buttonsSkipped = 0
let notices = 0

const go = async (route) => {
  await page.goto(base + route, { waitUntil: 'networkidle' })
  // Hash-only navigations do not recreate the document; reload so pending
  // notices and filter state from the previous probe cannot leak forward.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(40)
}
const currentHash = () => page.evaluate(() => location.hash.replace(/^#/, ''))

for (const route of routes) {
  await go(route)
  const links = page.locator('a[href]')
  const linkCount = await links.count()
  for (let i = 0; i < linkCount; i += 1) {
    const link = links.nth(i)
    if (!(await link.isVisible())) {
      linksSkipped += 1
      continue
    }
    const href = (await link.getAttribute('href')) ?? ''
    if (!href.startsWith('#')) {
      linksSkipped += 1
      continue
    }
    const expected = href.slice(1)
    const text = ((await link.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    await link.click()
    await page.waitForTimeout(90)
    linksChecked += 1
    const actual = await currentHash()
    const notFound = (await page.locator('h1', { hasText: '这个页面还不存在' }).count()) > 0
    if (actual !== expected || notFound) {
      failures.push({ kind: 'link', route, text, expected, actual, notFound })
    }
    await go(route)
  }
}

for (const route of routes) {
  await go(route)
  const buttons = page.locator('button')
  const buttonCount = await buttons.count()
  for (let i = 0; i < buttonCount; i += 1) {
    const button = buttons.nth(i)
    if (!(await button.isVisible())) {
      buttonsSkipped += 1
      continue
    }
    const text = ((await button.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    const before = await page.evaluate(() => {
      const main = document.querySelector('#main-content')
      return {
        hash: location.hash,
        text: main?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 400) ?? '',
        status: document.querySelector('[role="status"]')?.textContent?.trim() ?? '',
      }
    })
    const pressed = await button.getAttribute('aria-pressed')
    const selected = await button.getAttribute('aria-selected')
    if (pressed === 'true' || selected === 'true') {
      buttonsSkipped += 1
      continue
    }
    await button.click()
    await page.waitForTimeout(140)
    const after = await page.evaluate(() => {
      const main = document.querySelector('#main-content')
      return {
        hash: location.hash,
        text: main?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 400) ?? '',
        status: document.querySelector('[role="status"]')?.textContent?.trim() ?? '',
        expanded: [...document.querySelectorAll('[aria-expanded="true"]')].length,
      }
    })
    buttonsChecked += 1
    if (after.status) notices += 1
    const changed =
      after.hash !== before.hash ||
      after.status !== before.status ||
      after.text !== before.text ||
      after.expanded > 0
    if (!changed) {
      failures.push({ kind: 'button', route, text, before, after })
    }
    if (after.status && !/演示|待接入|尚未接入|示例/.test(after.status)) {
      failures.push({ kind: 'button-notice-wording', route, text, status: after.status })
    }
    await go(route)
  }
}

console.log(
  JSON.stringify(
    {
      linksChecked,
      linksSkipped,
      buttonsChecked,
      buttonsSkipped,
      buttonsWithNotice: notices,
      failures,
      jsErrors,
    },
    null,
    2,
  ),
)
if (failures.length || jsErrors.length) process.exitCode = 1
await browser.close()
