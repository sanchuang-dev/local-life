import assert from 'node:assert/strict'
import test from 'node:test'
import { communityLocationSheetCopy } from '../src/lib/communityLocationCopy.ts'

test('community sheet never shows an unexplained "未获取位置"', () => {
  const idle = communityLocationSheetCopy('idle', '')
  assert.equal(idle.title, '尚未使用定位')
  assert.match(idle.detail, /手动选择/)
  assert.equal(idle.action, '定位附近')

  const locating = communityLocationSheetCopy('locating', '')
  assert.equal(locating.action, '定位中…')

  const success = communityLocationSheetCopy('success', '')
  assert.equal(success.title, '已获取位置')
  assert.equal(success.action, '重新定位')
})

test('community sheet keeps the failure reason and retry entry visible', () => {
  const reason = '微信定位初始化失败，请稍后重试或手动选择社区'
  const failed = communityLocationSheetCopy('error', reason)
  assert.equal(failed.title, '定位未成功')
  assert.equal(failed.detail, reason)
  assert.equal(failed.action, '重新定位')

  const fallback = communityLocationSheetCopy('error', '')
  assert.ok(fallback.detail.length > 0)
  assert.match(fallback.detail, /手动选择/)
})
