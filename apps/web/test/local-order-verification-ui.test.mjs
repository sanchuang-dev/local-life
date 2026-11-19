import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * H5 verification surface contract.
 *
 * apps/web has no DOM test harness (its suite is source-level), so this test
 * pins the user-visible controls/copy and the service boundary that the API
 * tests exercise end to end. It deliberately does not pretend to be a rendered
 * interaction test; the browser/interaction gap is reported in the PR.
 */
const root = join(import.meta.dirname, '..', 'src')
const detail = readFileSync(
  join(root, 'pages/workbench/WorkbenchLocalOrderDetailPage.tsx'),
  'utf8',
)
const list = readFileSync(
  join(root, 'pages/workbench/WorkbenchLocalOrdersPage.tsx'),
  'utf8',
)
const service = readFileSync(join(root, 'services/localOrders.ts'), 'utf8')
const hook = readFileSync(join(root, 'hooks/useStaffLocalOrders.ts'), 'utf8')

test('workbench detail exposes phone verification without inventing contact data', () => {
  assert.match(detail, /电话核验/)
  assert.match(detail, /核验备注/)
  assert.match(detail, /submitVerification\('verify'\)/)
  assert.match(detail, /submitVerification\('reject'\)/)
  assert.match(detail, /居民未提供联系电话/)
  assert.match(detail, /order\.residentContact\.phone/)
  assert.match(detail, /tel:\$\{order\.residentContact\.phone\}/)
  assert.match(detail, /isGridWorker && order\.status === 'pending_review'/)
  // Verification is not presented as payment or settlement.
  assert.match(detail, /不代表收款/)
  assert.doesNotMatch(detail, /只能由运营人员在后台完成/)
})

test('workbench list makes pending verification easy to reach', () => {
  assert.match(list, /待核验/)
  assert.match(list, /pending_review/)
  assert.doesNotMatch(list, /人工核验由运营人员完成/)
})

test('H5 uses the scoped staff verification endpoint and shared request schema', () => {
  assert.match(service, /verifyStaffLocalOrder/)
  assert.match(service, /LOCAL_ORDER_ROUTES\.staffOrderVerify/)
  assert.match(service, /localOrderVerifyRequestSchema/)
  assert.match(hook, /useStaffOrderVerification/)
  assert.match(hook, /verifyStaffLocalOrder/)
})
