import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { primaryTabs } from '../src/components/shell/navigation.ts'
import { communityRootRedirect, activityDetailHref } from '../src/lib/communityHomeRoute.ts'

const page = readFileSync(join(import.meta.dirname, '../src/pages/MePage.tsx'), 'utf8')
const discovery = readFileSync(join(import.meta.dirname, '../src/pages/CommunityDiscoveryPage.tsx'), 'utf8')

test('Me community-activity shortcut leads to the same list as bottom Activity tab', () => {
  const activityTab = primaryTabs.find(({ key }) => key === 'activity')
  assert.ok(activityTab)
  assert.equal(activityTab.path, '/')
  assert.match(page, /key: 'activity', icon: CalendarCheck2, label: '社区活动'[^\n]*to: '\/'/)
  assert.doesNotMatch(page, /const activityHref =|to: activityHref/)
  assert.equal(communityRootRedirect('', { from: '/me' }), null)
  assert.match(discovery, /activities\.items\.map\(\(activity\) =>/)
})

test('activity detail links still use activity IDs, distinct from list entry', () => {
  const detail = activityDetailHref('abc')
  assert.notEqual(detail, '/')
  assert.match(detail, /activityId=abc/)
})
