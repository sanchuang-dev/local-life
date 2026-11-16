import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const src = join(import.meta.dirname, '../src')
const read = (path) => readFileSync(join(src, path), 'utf8')
const orders = read('pages/MyOrdersPage.tsx')
const rewards = read('pages/MyRewardsPage.tsx')
const empty = read('components/common/EmptyState.tsx')
const artwork = read('components/activity/ActivityArtwork.tsx')

test('public empty state supports centered illustrations while keeping inline activity use', () => {
  assert.match(empty, /layout\?: 'inline' \| 'centered'/)
  assert.match(empty, /layout = 'inline'/)
  // Shared empty states are content, not a nested card: both layouts stay unboxed.
  const shell = empty.split('const centered =')[1]?.split('{illustration}')[0]
  assert.ok(shell)
  assert.doesNotMatch(shell, /\bbg-white\b|\bborder\b|\brounded-\w+/)
  assert.match(empty, /\{action\}/)
  assert.match(artwork, /'thumbnail' \| 'empty' \| 'page'/)
  assert.match(artwork, /import\.meta\.env\.BASE_URL/)
})

test('rewards empty and filtered states use shared presentation, without unlaunched CTAs', () => {
  assert.match(rewards, /\{noRewards \? \(\s*<EmptyState/)
  assert.equal((rewards.match(/<EmptyState\b/g) ?? []).length, 3)
  assert.match(rewards, /title="暂无奖励记录"/)
  assert.match(rewards, /title="当前筛选下没有奖励"/)
  assert.match(rewards, /title="当前筛选下没有消费券"/)
  assert.doesNotMatch(rewards, /去看看社区活动|to="\/community\/activity"/)
  assert.match(rewards, /wallet\.state\.status === 'unauthenticated'/)
  assert.match(rewards, /wallet\.state\.status === 'error'/)
  assert.match(rewards, /<DrawWalletSection entries=\{drawEntries\}/)
  assert.match(rewards, /<CouponWalletCard key=\{coupon\.id\}/)
  assert.match(rewards, /<RewardWalletCard key=\{entry\.activityId\}/)
  assert.match(rewards, /onChange=\{\(value\) => setBucket/)
})

test('orders empty state has no speculative product link, but keeps real filtering and records', () => {
  assert.match(orders, /\{state\.status === 'empty' \? \(\s*<EmptyState/)
  assert.match(orders, /title=\{status \? '当前筛选下没有订单' : '还没有登记过订单'\}/)
  assert.match(orders, /action=\{status \? \(/)
  assert.match(orders, /onClick=\{\(\) => setStatus\(''\)\}/)
  assert.doesNotMatch(orders, /去惠生活看看本地商品/)
  assert.match(orders, /\{state\.status === 'ready' \? \(/)
  assert.match(orders, /<OrderRow key=\{order\.id\}/)
  assert.match(orders, /onClick=\{loadMore\}/)
  assert.match(orders, /onClick=\{reload\}/)
  assert.match(orders, /to=\{`\/me\/orders\/\$\{order\.id\}`\}/)
  assert.match(orders, /state\.status === 'unauthenticated'/)
  assert.match(orders, /state\.status === 'error'/)
})
