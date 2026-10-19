/**
 * I02 (#21) browser regression for the migrated prototype.
 *
 * Setup:
 *   npm ci
 *   npm i --no-save playwright-core
 *   npm run build
 *   npm run preview -- --host 127.0.0.1 --port 4173
 * Run:
 *   node docs/migration/i02-verify.mjs
 *
 * Requires Chromium at /usr/bin/chromium unless CHROMIUM_PATH is set.
 * Prints the 375px control inventory, per-flow assertions, 375/320px overflow
 * checks, browser history/reload checks and collected console/page errors.
 */
import { chromium } from 'playwright-core'

const base = 'http://127.0.0.1:4173/local-life/#'
const routeStates = [
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
const results = []
const errors = []

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
page.on('console', (msg) => {
  if (msg.type() === 'error' && !msg.text().includes('favicon')) {
    errors.push(`console.error ${page.url()}: ${msg.text()}`)
  }
})
page.on('pageerror', (err) => errors.push(`pageerror ${page.url()}: ${err.message}`))

const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}
const hash = () => page.evaluate(() => location.hash.replace(/^#/, ''))
const at = async (route) => {
  await page.goto(base + route, { waitUntil: 'networkidle' })
  await page.waitForTimeout(60)
}
const clickLink = async (text) => {
  await page.locator('a', { hasText: text }).first().click()
  await page.waitForTimeout(120)
}
const clickButton = async (text) => {
  await page.locator('button', { hasText: text }).first().click()
  await page.waitForTimeout(120)
}
const clickBack = async () => {
  await page.locator('main a').filter({ hasText: /^返回/ }).first().click()
  await page.waitForTimeout(120)
}
const clickTab = async (text) => {
  await page.locator('nav[aria-label="示例底部导航"] a', { hasText: text }).click()
  await page.waitForTimeout(120)
}
const expectHash = async (name, expected) => {
  const actual = await hash()
  record(name, actual === expected, `${actual} (expected ${expected})`)
}
const statusText = async () => {
  const status = page.locator('[role="status"]')
  if ((await status.count()) === 0) return ''
  return (await status.first().textContent())?.replace(/\s+/g, ' ').trim() ?? ''
}

// 0. 375px inventory: count every visible control and reject horizontal overflow.
const inventory = { states: 0, controls: 0, links: 0, buttons: 0, inputs: 0 }
for (const route of routeStates) {
  await at(route)
  const info = await page.evaluate(() => {
    const main = document.querySelector('#main-content')
    const nav = document.querySelector('nav[aria-label="示例底部导航"]')
    const mainRect = main?.getBoundingClientRect()
    const navRect = nav?.getBoundingClientRect()
    const controls = [...document.querySelectorAll('a[href], button, input, select, textarea')].filter(
      (el) => el.getBoundingClientRect().width > 0,
    )
    return {
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth,
      mainOverflow: main ? main.scrollWidth > main.clientWidth : true,
      navGap: mainRect && navRect ? Math.round(navRect.top - mainRect.bottom) : -1,
      links: controls.filter((el) => el.tagName === 'A').length,
      buttons: controls.filter((el) => el.tagName === 'BUTTON').length,
      inputs: controls.filter((el) => el.tagName === 'INPUT').length,
      count: controls.length,
    }
  })
  inventory.states += 1
  inventory.controls += info.count
  inventory.links += info.links
  inventory.buttons += info.buttons
  inventory.inputs += info.inputs
  record(
    `375px no horizontal overflow / nav clear ${route} (${info.count} controls)`,
    !info.docOverflow && !info.bodyOverflow && !info.mainOverflow && info.navGap >= 0,
    JSON.stringify(info),
  )
}
console.log(`INVENTORY ${JSON.stringify(inventory)}`)

// 1. Home banner -> own activity -> back
await at('/')
await clickLink('查看活动')
await expectHash('home banner opens welfare-day activity', '/community/activity/welfare-day')
record('home banner activity entity matches', (await page.locator('h2').first().textContent())?.includes('周末便民服务日') ?? false)
await clickLink('返回首页')
await expectHash('activity returns to home with entry source', '/')

// 2. Home notice -> other notice keeps source
await at('/')
await clickLink('东片区计划停水')
await expectHash('home notice opens own detail', '/community/notice/water')
record('home notice back label is 返回首页', (await page.locator('a', { hasText: '返回首页' }).count()) === 1)
await clickLink('周六集体福利领取通知')
await expectHash('notice cross-link opens other notice', '/community/notice/welfare')
const otherBackLabel = await page.locator('a').filter({ hasText: /返回/ }).first().textContent()
record('notice cross-link keeps home source', (otherBackLabel ?? '').includes('返回首页'), otherBackLabel ?? '')
await clickBack()
await expectHash('notice back returns to home source', '/')

await at('/community/notice/water')
record('direct notice entity matches', (await page.locator('h1').textContent())?.includes('停水') ?? false)
record('direct notice falls back to community back label', (await page.locator('a', { hasText: '返回社区' }).count()) > 0)

// 3. Home broadcast -> back
await at('/')
await clickLink('查看广播')
await expectHash('home broadcast entry', '/community/broadcast')
await clickLink('返回首页')
await expectHash('broadcast back to home source', '/')

await at('/community/broadcast')
await clickButton('今晚 19:00')
await clickLink('查看广播对应活动')
await expectHash('broadcast activity link opens matching activity', '/community/activity/performance')
record('broadcast activity entity matches', (await page.locator('h2').first().textContent())?.includes('社区文艺演出') ?? false)
record(
  'broadcast activity back target is broadcast',
  (await page.locator('a').filter({ hasText: /返回/ }).first().textContent())?.includes('返回社区广播') ?? false,
)
await clickBack()
await expectHash('broadcast activity back to broadcast', '/community/broadcast')

// 4. Home activity card -> back
await at('/')
await clickLink('象棋友谊赛')
await expectHash('home activity card opens own detail', '/community/activity/chess')
record('home activity card entity matches', (await page.locator('h2').first().textContent())?.includes('象棋友谊赛') ?? false)
await clickLink('返回首页')
await expectHash('home activity detail back to home source', '/')

await at('/')
await clickLink('广场舞教学')
await expectHash('home dance card opens own detail', '/community/activity/dance')
record('home dance card entity matches', (await page.locator('h2').first().textContent())?.includes('广场舞教学') ?? false)
await clickLink('返回首页')
await expectHash('home dance detail back to home source', '/')

// 5. Health -> devices/lecture/assistant -> back
await at('/health')
await clickLink('我的设备')
await expectHash('health opens my devices', '/me/devices')
await clickLink('返回健康服务')
await expectHash('health device back to health', '/health')

await at('/health')
await clickLink('全部内容')
await expectHash('health opens lecture', '/health/lecture')
await clickLink('返回健康服务')
await expectHash('health lecture back to health', '/health')

await at('/health')
await clickLink('开始对话')
await expectHash('health opens assistant', '/health/assistant')
await clickLink('返回健康服务')
await expectHash('health assistant back to health', '/health')

await at('/health')
await clickLink('查看魔镜健康终端')
await expectHash('health opens mirror device', '/health/device')
await clickLink('返回健康服务')
await expectHash('health mirror back to health', '/health')

// 6. Life -> product -> demo redemption -> back
await at('/life')
await clickLink('时令水果篮')
await expectHash('life fruit card opens own product', '/life/product/fruit-basket')
record('life fruit entity matches', (await page.locator('h1').textContent())?.includes('时令水果篮') ?? false)
await clickLink('返回惠生活')
await expectHash('life fruit back to life', '/life')

await at('/life')
await clickLink('5 斤装大米')
await expectHash('life product card opens own product', '/life/product/rice-5kg')
await clickButton('模拟兑换')
const redemption = await statusText()
record('product demo redemption shows demo notice', redemption.includes('演示') && redemption.includes('不会'), redemption)
record('product page keeps demo balance disclaimer', (await page.locator('text=演示余额').count()) > 0)
await clickLink('返回惠生活')
await expectHash('life product back to life', '/life')

// 7. Exchange -> product keeps exchange source
await at('/life/exchange')
await clickLink('5 斤装大米')
await expectHash('exchange product opens own product', '/life/product/rice-5kg')
const productBack = await page.locator('a').filter({ hasText: /返回/ }).first().textContent()
record('exchange product back target is exchange', (productBack ?? '').includes('返回积分兑换'), productBack ?? '')
await clickBack()
await expectHash('exchange product back to exchange', '/life/exchange')

// 8. Exchange -> points keeps exchange source
await at('/life/exchange')
await clickLink('积分明细')
await expectHash('exchange points summary opens points', '/points')
const pointsBack = await page.locator('a').filter({ hasText: /返回/ }).first().textContent()
record('exchange points back target is exchange', (pointsBack ?? '').includes('返回积分兑换'), pointsBack ?? '')
await clickBack()
await expectHash('exchange points back to exchange', '/life/exchange')

// 9. Life -> points -> back
await at('/life')
await clickLink('积分明细')
await expectHash('life points summary opens points', '/points')
await clickLink('返回惠生活')
await expectHash('life points back to life', '/life')

// 10. Me -> points/gd/devices -> back
await at('/me')
await clickLink('我的积分')
await expectHash('me opens points', '/points')
await clickLink('返回我的')
await expectHash('me points back to me', '/me')

await at('/me')
await clickLink('广电服务')
await expectHash('me opens gd', '/gd')
await clickLink('返回我的')
await expectHash('me gd back to me', '/me')

await at('/me')
await clickLink('我的设备')
await expectHash('me opens devices', '/me/devices')
await clickLink('返回我的')
await expectHash('me devices back to me', '/me')

// 11. Points task links keep points source
await at('/points')
await clickLink('去兑换好礼')
await expectHash('points exchange CTA opens exchange', '/life/exchange')
const pointsExchangeBack = await page.locator('a').filter({ hasText: /返回/ }).first().textContent()
record('points exchange back target is points', (pointsExchangeBack ?? '').includes('返回我的积分'), pointsExchangeBack ?? '')
await clickBack()
await expectHash('points exchange back to points', '/points')

await at('/points')
await clickLink('完成健康讲堂 1 节')
await expectHash('points task opens lecture', '/health/lecture')
const taskLectureBack = await page.locator('a').filter({ hasText: /返回/ }).first().textContent()
record('points lecture task back target is points', (taskLectureBack ?? '').includes('返回我的积分'), taskLectureBack ?? '')
await clickBack()
await expectHash('points lecture task back to points', '/points')

await at('/points')
await clickLink('社区活动到场签到')
await expectHash('points task opens activity', '/community/activity')
const taskActivityBack = await page.locator('a').filter({ hasText: /返回/ }).first().textContent()
record('points activity task back target is points', (taskActivityBack ?? '').includes('返回我的积分'), taskActivityBack ?? '')
await clickBack()
await expectHash('points activity task back to points', '/points')

await at('/points')
await clickLink('绑定家庭健康设备')
await expectHash('points task opens devices', '/me/devices')
const taskDeviceBack = await page.locator('a').filter({ hasText: /返回/ }).first().textContent()
record('points device task back target is points', (taskDeviceBack ?? '').includes('返回我的积分'), taskDeviceBack ?? '')
await clickBack()
await expectHash('points device task back to points', '/points')

// 12. GD -> community broadcast -> back
await at('/gd')
const gdBroadcastLink = page.locator('a', { hasText: '查看社区广播' })
record('gd broadcast action is a real link', (await gdBroadcastLink.count()) === 1)
if ((await gdBroadcastLink.count()) === 1) {
  await gdBroadcastLink.first().click()
  await expectHash('gd broadcast link opens broadcast', '/community/broadcast')
  await clickBack()
  await expectHash('gd broadcast back to gd', '/gd')
} else {
  await clickButton('查看社区广播')
  record(
    'gd broadcast action is not fake pending',
    false,
    await statusText(),
  )
}

// 13. Bottom tabs
await at('/')
await clickTab('发现')
await expectHash('bottom tab opens discover', '/discover')
record(
  'discover tab is selected',
  (await page.locator('nav [aria-current="page"]').textContent())?.includes('发现') ?? false,
)
await clickTab('我的')
await expectHash('bottom tab opens me', '/me')
record(
  'me tab is selected',
  (await page.locator('nav [aria-current="page"]').textContent())?.includes('我的') ?? false,
)
await clickTab('首页')
await expectHash('bottom tab returns home', '/')
record(
  'home tab selected for subpage parent',
  (await page.locator('nav [aria-current="page"]').textContent())?.includes('首页') ?? false,
)

// 14. 404 recovery
await at('/unknown-route')
await clickLink('返回首页')
await expectHash('404 returns home', '/')
await at('/unknown-route')
await clickLink('浏览服务导览')
await expectHash('404 opens discover', '/discover')

// 15. browser back/forward + reload + direct hash
await at('/')
await clickLink('社区广播')
await expectHash('history entry broadcast', '/community/broadcast')
await page.goBack()
await page.waitForTimeout(120)
await expectHash('browser back returns home', '/')
await page.goForward()
await page.waitForTimeout(120)
await expectHash('browser forward returns broadcast', '/community/broadcast')

await at('/life/product/rice-5kg')
await page.reload({ waitUntil: 'networkidle' })
await expectHash('reload keeps product hash', '/life/product/rice-5kg')
record('reload keeps product entity', (await page.locator('h1').textContent())?.includes('5 斤装大米') ?? false)

// 16. Filters
await at('/community/broadcast')
await clickButton('今日广播')
record('broadcast today filter shows records', (await page.locator('article, [aria-expanded]').count()) > 0)
await clickButton('历史广播')
record('broadcast history filter shows empty state', (await page.locator('text=暂无历史广播记录').count()) === 1)
await clickButton('当前广播')
record('broadcast current filter restores record', (await page.locator('[aria-expanded]').count()) === 1)

await at('/community/culture')
await clickButton('粤曲')
record('culture unopened category shows empty state', (await page.locator('text=该门类暂无排期').count()) === 1)
await clickButton('书法')
record('culture calligraphy filter shows one course', (await page.locator('article').count()) === 1)
record('culture calligraphy content matches filter', (await page.locator('article h2').textContent())?.includes('书法') ?? false)

await at('/health/lecture')
await clickButton('直播')
record('lecture live filter shows one item', (await page.locator('article').count()) === 1)
record('lecture live content matches filter', (await page.locator('article h2').textContent())?.includes('直播') ?? false)
await clickButton('全部')
record('lecture all filter restores four items', (await page.locator('article').count()) === 4)

await at('/life/exchange')
await clickButton('米面粮油')
record('exchange rice filter shows one product', (await page.locator('a[href*="/life/product/"]').count()) === 1)
record('exchange rice content matches filter', (await page.locator('a[href*="/life/product/"]').textContent())?.includes('大米') ?? false)
await clickButton('广电权益')
record('exchange gd filter shows one product', (await page.locator('a[href*="/life/product/"]').count()) === 1)
record('exchange gd content matches filter', (await page.locator('a[href*="/life/product/"]').textContent())?.includes('广电') ?? false)
await clickButton('全部')
record('exchange all filter restores four products', (await page.locator('a[href*="/life/product/"]').count()) === 4)

// bottom-tab selection on sub-pages and 404
await at('/community/broadcast')
record('broadcast keeps home tab selected', (await page.locator('nav [aria-current="page"]').textContent())?.includes('首页') ?? false)
await at('/points')
record('points keeps me tab selected', (await page.locator('nav [aria-current="page"]').textContent())?.includes('我的') ?? false)
await at('/me/devices')
record('devices keeps me tab selected', (await page.locator('nav [aria-current="page"]').textContent())?.includes('我的') ?? false)
await at('/unknown-route')
record('404 has no selected bottom tab', (await page.locator('nav [aria-current="page"]').count()) === 0)

// 17. Demo action feedback
await at('/community/activity/performance')
await clickButton('扫码签到')
record('activity sign-in is demo notice', (await statusText()).includes('演示'))
await clickButton('设置活动提醒')
record('activity reminder is demo notice', (await statusText()).includes('演示'))

await at('/health/assistant')
await clickButton('发送')
record('assistant empty send is demo notice', (await statusText()).includes('演示'))
await page.locator('#assistant-input').fill('今天有什么活动')
await clickButton('发送')
record('assistant send is demo notice, not real reply', (await statusText()).includes('不会'))
await clickButton('我的积分有多少')
record('assistant quick question is demo notice', (await statusText()).includes('尚未接入'))

await at('/health/device')
await clickButton('绑定设备')
record('mirror bind is demo notice', (await statusText()).includes('不会'))

await at('/me/devices')
await clickButton('添加家庭健康设备')
record('add device is demo notice', (await statusText()).includes('不会'))

await at('/gd')
await clickButton('手机卡')
record('gd service is demo notice', (await statusText()).includes('尚未接入'))

await at('/')
await clickButton('学习服务')
record('home pending service is demo notice', (await statusText()).includes('尚未接入'))

await at('/me')
await clickButton('我的活动')
record('me activity stat is demo notice', (await statusText()).includes('尚未接入'))

await at('/life')
await clickButton('幸福里便利店')
record('life store row is demo notice', (await statusText()).includes('尚未接入'))
await clickButton('地图')
record('life map is demo notice', (await statusText()).includes('尚未接入'))

// 18. Bottom nav does not overlay the scroll content at max scroll
for (const route of ['/', '/community', '/health', '/life', '/me', '/points']) {
  await at(route)
  const layout = await page.evaluate(() => {
    const main = document.querySelector('#main-content')
    const nav = document.querySelector('nav[aria-label="示例底部导航"]')
    if (!main || !nav) return null
    main.scrollTop = main.scrollHeight
    const mainRect = main.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    const last = [...main.children].filter((el) => el.getBoundingClientRect().height > 0).at(-1)
    return {
      gap: Math.round(navRect.top - mainRect.bottom),
      lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
      mainBottom: Math.round(mainRect.bottom),
    }
  })
  record(
    `bottom nav clear of content at max scroll ${route}`,
    !!layout && layout.gap >= 0 && (layout.lastBottom ?? 0) <= (layout.mainBottom ?? 0) + 1,
    JSON.stringify(layout),
  )
}

// 19. 320px overflow + nav gap scan for every state.
await page.setViewportSize({ width: 320, height: 812 })
const narrowInventory = { states: 0, controls: 0 }
for (const route of routeStates) {
  await at(route)
  const info = await page.evaluate(() => {
    const main = document.querySelector('#main-content')
    const nav = document.querySelector('nav[aria-label="示例底部导航"]')
    const mainRect = main?.getBoundingClientRect()
    const navRect = nav?.getBoundingClientRect()
    const controls = [...document.querySelectorAll('a[href], button, input, select, textarea')].filter(
      (el) => el.getBoundingClientRect().width > 0,
    )
    return {
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth,
      mainOverflow: main ? main.scrollWidth > main.clientWidth : true,
      navGap: mainRect && navRect ? Math.round(navRect.top - mainRect.bottom) : -1,
      count: controls.length,
    }
  })
  narrowInventory.states += 1
  narrowInventory.controls += info.count
  record(
    `320px no horizontal overflow / nav clear ${route} (${info.count} controls)`,
    !info.docOverflow && !info.bodyOverflow && !info.mainOverflow && info.navGap >= 0,
    JSON.stringify(info),
  )
}
console.log(`INVENTORY_320 ${JSON.stringify(narrowInventory)}`)

const failed = results.filter((r) => !r.pass)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
if (failed.length) {
  console.log('FAILED', JSON.stringify(failed, null, 2))
  process.exitCode = 1
}
console.log('JS_ERRORS', JSON.stringify(errors, null, 2))
if (errors.length) process.exitCode = 1
await browser.close()
