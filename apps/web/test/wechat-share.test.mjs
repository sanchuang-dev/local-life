import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWechatActivityShareData, configureWechatActivityShare, isWechatBrowser,
} from '../src/components/activity/wechatShare.ts'

const id = '3b16253c-cd91-437f-86b1-8bf553129d12'
const invite = '1234567890abcdef1234567890abcdef'
const link = `https://local.proto.3cgroup.cn/community/activity/silver-neighborhood?activityId=${id}&invite=${invite}`
const signature = { appId: 'wx1234567890abcdef', timestamp: 1730000000, nonceStr: 'abcd'.repeat(8), signature: 'a'.repeat(40) }
globalThis.window = { setTimeout, clearTimeout }

test('share content uses exact source URL and cover URL respects MVP/Pages base', () => {
  assert.ok(isWechatBrowser('Mozilla/5.0 iPhone MicroMessenger/8.0'))
  assert.equal(isWechatBrowser('Mozilla/5.0 Chrome/125'), false)
  const data = createWechatActivityShareData(
    { title: '真实银发活动', summary: '和街坊一起参加活动。' }, link,
    'https://local.proto.3cgroup.cn', '/',
  )
  assert.deepEqual(data, {
    title: '真实银发活动', desc: '和街坊一起参加活动。',
    link, imgUrl: 'https://local.proto.3cgroup.cn/images/silver-neighborhood-hero.webp',
  })
  assert.equal(new URL(data.link).searchParams.get('activityId'), id)
  assert.equal(new URL(data.link).searchParams.get('invite'), invite)
  assert.equal(createWechatActivityShareData(
    { title: 'Pages 活动', summary: null }, link,
    'https://sanchuang-dev.github.io', '/local-life/',
  ).imgUrl, 'https://sanchuang-dev.github.io/local-life/images/silver-neighborhood-hero.webp')
})

test('JS-SDK metadata follows the current activity visual config, including fallbacks', () => {
  const origin = 'https://local.proto.3cgroup.cn'
  const configured = createWechatActivityShareData(
    {
      title: '社区健康筛查',
      summary: '免费测血压。',
      visualConfig: {
        themeKey: 'health-blue',
        heroImageUrl: 'https://cdn.example.com/hero.jpg',
        posterImageUrl: 'https://cdn.example.com/poster.jpg',
        promoTitle: '健康筛查进社区',
        promoSubtitle: '本周六上午，先到先得',
      },
    },
    link,
    origin,
    '/',
  )
  assert.equal(configured.title, '健康筛查进社区')
  assert.equal(configured.desc, '本周六上午，先到先得')
  assert.equal(configured.imgUrl, 'https://cdn.example.com/poster.jpg')
  // Invitation/activity parameters are the same real URL, untouched.
  assert.equal(configured.link, link)
  assert.equal(new URL(configured.link).searchParams.get('activityId'), id)
  assert.equal(new URL(configured.link).searchParams.get('invite'), invite)

  const heroOnly = createWechatActivityShareData(
    {
      title: '社区健康筛查',
      summary: null,
      visualConfig: {
        themeKey: 'health-blue',
        heroImageUrl: 'https://cdn.example.com/hero.jpg',
        posterImageUrl: null,
        promoTitle: '  ',
        promoSubtitle: null,
      },
    },
    link,
    origin,
    '/',
  )
  assert.equal(heroOnly.title, '社区健康筛查')
  assert.equal(heroOnly.desc, '来社区一起参加活动，认识更多街坊。')
  assert.equal(heroOnly.imgUrl, 'https://cdn.example.com/hero.jpg')

  // A historical activity without visual config keeps the original artwork.
  const legacy = createWechatActivityShareData(
    { title: '历史银发活动', summary: '和街坊一起参加活动。' },
    link,
    origin,
    '/',
  )
  assert.equal(legacy.title, '历史银发活动')
  assert.equal(legacy.desc, '和街坊一起参加活动。')
  assert.equal(legacy.imgUrl, 'https://local.proto.3cgroup.cn/images/silver-neighborhood-hero.webp')
})

test('real service configures friend + timeline cards with identical invitation URL', async () => {
  const calls = []
  let ready
  const sdk = {
    ready: (cb) => { ready = cb },
    error: () => {},
    config: (arg) => { calls.push(['config', arg]); queueMicrotask(ready) },
    updateAppMessageShareData: (arg) => calls.push(['friend', arg]),
    updateTimelineShareData: (arg) => calls.push(['timeline', arg]),
  }
  const data = createWechatActivityShareData({ title: '真实活动', summary: '活动摘要' }, link, 'https://local.proto.3cgroup.cn', '/')
  await configureWechatActivityShare(sdk, signature, data, () => true, () => assert.fail('SDK failed'))
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0][1], {
    debug: false, ...signature,
    jsApiList: ['updateAppMessageShareData', 'updateTimelineShareData'],
  })
  assert.deepEqual(
    Object.fromEntries(Object.entries(calls[1][1]).filter(([k]) => k !== 'fail')),
    data,
  )
  assert.deepEqual(
    Object.fromEntries(Object.entries(calls[2][1]).filter(([k]) => k !== 'fail')),
    { title: data.title, link: data.link, imgUrl: data.imgUrl },
  )
})

test('SDK errors are surfaced; stale wx.ready cannot register an old invitation', async () => {
  let ready
  let errorCallback
  const calls = []
  let failed = 0
  const sdk = {
    ready: (cb) => { ready = cb },
    error: (cb) => { errorCallback = cb },
    config: () => {},
    updateAppMessageShareData: (arg) => calls.push(arg),
    updateTimelineShareData: (arg) => calls.push(arg),
  }
  const data = { title: '活动', desc: '活动摘要', link, imgUrl: 'https://local.proto.3cgroup.cn/images/silver-neighborhood-hero.webp' }
  let active = true
  const old = configureWechatActivityShare(sdk, signature, data, () => active, () => { failed++ })
  active = false
  ready()
  await old
  assert.equal(calls.length, 0)
  errorCallback()
  assert.equal(failed, 0)

  const broken = configureWechatActivityShare(sdk, signature, data, () => true, () => { failed++ })
  errorCallback({ errMsg: 'config: invalid signature' })
  await assert.rejects(broken)
  assert.equal(failed, 1)
})
