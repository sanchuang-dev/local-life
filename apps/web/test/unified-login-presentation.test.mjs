import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const base = join(import.meta.dirname, '../src')
const view = readFileSync(join(base, 'components/auth/UnifiedLoginView.tsx'), 'utf8')
const route = readFileSync(join(base, 'pages/ResidentLoginPage.tsx'), 'utf8')

test('WeChat login promotes local community life instead of repeating login instructions', () => {
  assert.match(view, /欢迎来到<span[^>]*>本地生活<\/span>/)
  assert.match(view, /社区活动 · 本地好物 · 居民福利/)
  assert.match(view, /images\/wechat-gate-neighborhood\.webp/)
  assert.match(view, /import\.meta\.env\.BASE_URL/)
  assert.match(view, /进入本地生活/)
  assert.doesNotMatch(view, /推荐登录方式|欢迎回到|社区生活服务入口/)
})

test('one real authorization action retains disabled/error states, OTP alternate and OAuth return', () => {
  assert.match(view, /disabled=\{!wechatEnabled\}/)
  assert.match(view, /onClick=\{onWechatLogin\}/)
  assert.match(view, /微信授权暂不可用/)
  assert.match(view, /通过微信确认身份，完成后返回原页面；不会自动报名或下单/)
  assert.match(view, /\{phoneForm\}/)
  assert.match(view, /setUsePhone\(true\)/)
  assert.match(view, /setUsePhone\(false\)/)
  assert.match(view, /onClick=\{onRetry\}/)
  assert.match(view, /onClick=\{onContinue\}/)
  assert.match(route, /buildResidentWechatLoginRequest\(/)
  assert.match(route, /saveActivityLoginContext\(request\.context\)/)
  assert.match(route, /window\.location\.assign\(request\.url\)/)
  assert.match(route, /<OpenInWeChatPage/)
})
