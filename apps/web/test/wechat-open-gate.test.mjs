import assert from 'node:assert/strict'
import test from 'node:test'
import { isWeChatBrowser, shouldShowWeChatGate } from '../src/components/auth/wechatEnvironment.ts'

const check = (overrides = {}) => shouldShowWeChatGate({
  userAgent: 'Mozilla/5.0 Chrome/123.0 Safari/537.36',
  pathname: '/community/activity/123',
  search: '?invite=abc',
  isDevelopment: false,
  ...overrides,
})

test('resident deep links opened outside WeChat show the copy-link gate', () => {
  assert.equal(check(), true)
  assert.equal(check({ pathname: '/login' }), true)
  assert.equal(check({ pathname: '/me' }), true)
})

test('WeChat internal browser keeps resident routes and OAuth untouched', () => {
  const userAgent = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 MicroMessenger/8.0.54'
  assert.equal(isWeChatBrowser(userAgent), true)
  assert.equal(check({ userAgent }), false)
})

test('staff workbench remains accessible from external desktop browsers', () => {
  assert.equal(check({ pathname: '/workbench' }), false)
  assert.equal(check({ pathname: '/workbench/leads' }), false)
  assert.equal(check({ pathname: '/workbench-other' }), true)
})

test('local-only preview switch never bypasses the gate in production', () => {
  assert.equal(check({ search: '?previewApp=1', isDevelopment: true }), false)
  assert.equal(check({ search: '?previewApp=1', isDevelopment: false }), true)
  assert.equal(check({ search: '?invite=abc', isDevelopment: true }), true)
  assert.equal(check({ search: '?invite=abc', isDevelopment: true, previewSessionEnabled: true }), false)
  assert.equal(check({ search: '?invite=abc', isDevelopment: false, previewSessionEnabled: true }), true)
})
