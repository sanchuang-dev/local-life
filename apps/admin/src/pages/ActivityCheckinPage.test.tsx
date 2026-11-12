// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import type {
  ActivityCheckin,
  ActivityCommunityRef,
  AdminActivityCheckinList,
  AdminActivityRewardOverview,
  AdminActivitySummary,
} from '@sanchuang-dev/local-life-contracts'
import { ActivityCheckinPage } from './ActivityCheckinPage'

/**
 * The 报名与核销 page is driven through a stubbed `fetch` whose URL table is
 * explicit: any unlisted request throws, so a page that invented data (or hit an
 * endpoint it should not) fails loudly. Error tests assert the real server error
 * state, and the no-plan test asserts we never render a table of zeros for an
 * activity the server says has no frozen plan.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A: ActivityCommunityRef = {
  id: '123e4567-e89b-42d3-a456-4266141740a1',
  name: '幸福社区',
}
const ACTIVITY_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const CHECKIN_ID = '123e4567-e89b-42d3-a456-4266141740h8'.replace('h', 'b')
const CSRF_TOKEN = 'csrf-token-for-checkin-page-tests'

function summary(overrides: Partial<AdminActivitySummary> = {}): AdminActivitySummary {
  return {
    id: ACTIVITY_ID,
    title: '银发社区欢乐季',
    summary: '秋季社区敬老活动',
    community: COMMUNITY_A,
    status: 'published',
    startsAt: '2026-12-01T02:00:00.000Z',
    endsAt: '2026-12-01T10:00:00.000Z',
    location: '幸福社区党群服务中心',
    budgetCapCents: 987_654,
    prizeQuantityCap: 4_321,
    ruleVersion: 2,
    createdAt: '2026-11-01T02:00:00.000Z',
    updatedAt: '2026-11-02T02:00:00.000Z',
    publishedAt: '2026-11-02T02:00:00.000Z',
    ...overrides,
  }
}

const PLAN = {
  prizeName: '10 斤装东北大米',
  prizeUnitCostCents: 4_500,
  prizeQuantityPerTeam: 3,
  totalPrizeQuantity: 60,
  budgetCapCents: 270_000,
  claimRecipient: 'leader' as const,
  checkinWindow: {
    opensAt: '2026-12-01T02:00:00.000Z',
    closesAt: '2026-12-01T06:00:00.000Z',
  },
  redemptionValidHours: 72,
  notes: '社区仓库统一发放',
}

function checkin(overrides: Partial<ActivityCheckin> = {}): ActivityCheckin {
  return {
    id: CHECKIN_ID,
    activityId: ACTIVITY_ID,
    userId: USER_ID,
    displayName: '张阿姨',
    teamId: '123e4567-e89b-42d3-a456-4266141740f6',
    status: 'valid',
    seatNo: 1,
    note: null,
    checkedInAt: '2026-12-01T02:10:00.000Z',
    verifiedAt: null,
    verifiedByStaffId: null,
    revokedAt: null,
    revokedByStaffId: null,
    revokeReason: null,
    ...overrides,
  }
}

function checkinList(items: ActivityCheckin[]): AdminActivityCheckinList {
  const valid = items.filter((item) => item.status === 'valid')
  return {
    activityId: ACTIVITY_ID,
    items,
    counts: {
      valid: valid.length,
      verified: valid.filter((item) => item.verifiedAt !== null).length,
      pendingVerification: valid.filter((item) => item.verifiedAt === null).length,
      revoked: items.filter((item) => item.status === 'revoked').length,
    },
  }
}

function overview(overrides: Partial<AdminActivityRewardOverview> = {}): AdminActivityRewardOverview {
  const grants = overrides.grants ?? []
  return {
    activityId: ACTIVITY_ID,
    activityStatus: 'published',
    ruleVersion: 2,
    planSource: 'rule_version_snapshot',
    planConfigured: true,
    plan: PLAN,
    stock: {
      activityId: ACTIVITY_ID,
      ruleVersion: 2,
      ruleVersionId: '123e4567-e89b-42d3-a456-4266141740i9'.replace('i', 'c'),
      prizeName: PLAN.prizeName,
      unitCostCents: PLAN.prizeUnitCostCents,
      totalQuantity: PLAN.totalPrizeQuantity,
      claimedQuantity: 3,
      redeemedQuantity: 0,
      budgetCapCents: PLAN.budgetCapCents,
      committedBudgetCents: 13_500,
      redeemedBudgetCents: 0,
      availableQuantity: PLAN.totalPrizeQuantity - 3,
      remainingBudgetCents: PLAN.budgetCapCents - 13_500,
      updatedAt: '2026-11-02T02:00:00.000Z',
    },
    counts: {
      checkinsValid: 1,
      checkinsVerified: 0,
      checkinsPendingVerification: 1,
      checkinsRevoked: 0,
      grantsTotal: grants.length,
      grantsGranted: grants.filter((row) => row.grant.status === 'granted').length,
      grantsRedeemed: grants.filter((row) => row.grant.status === 'redeemed').length,
      grantsRevoked: grants.filter((row) => row.grant.status === 'revoked').length,
      grantsDisputed: grants.filter((row) => row.grant.status === 'disputed').length,
      grantsReversed: grants.filter((row) => row.grant.status === 'reversed').length,
      codesActive: grants.filter((row) => row.credentialStatus === 'active').length,
      codesRedeemed: grants.filter((row) => row.credentialStatus === 'redeemed').length,
    },
    grants,
    ...overrides,
  }
}

const NO_PLAN_OVERVIEW: AdminActivityRewardOverview = {
  activityId: ACTIVITY_ID,
  activityStatus: 'published',
  ruleVersion: 2,
  planSource: 'none',
  planConfigured: false,
  plan: null,
  stock: null,
  counts: {
    checkinsValid: 0,
    checkinsVerified: 0,
    checkinsPendingVerification: 0,
    checkinsRevoked: 0,
    grantsTotal: 0,
    grantsGranted: 0,
    grantsRedeemed: 0,
    grantsRevoked: 0,
    grantsDisputed: 0,
    grantsReversed: 0,
    codesActive: 0,
    codesRedeemed: 0,
  },
  grants: [],
}

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
}

const GRID_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    id: STAFF_ID,
    username: 'grid.a',
    role: 'grid_worker',
    communities: [COMMUNITY_A],
  },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface FetchCall {
  url: string
  init?: RequestInit
}

function stubApi(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return handler(url, init)
    }),
  )
  return calls
}

function renderPage(session: AuthenticatedSession) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session, busy: false, error: null, onLogout: async () => undefined }}
        >
          <ActivityCheckinPage />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1024,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ActivityCheckinPage permissions', () => {
  it('refuses grid workers without issuing any fulfilment request', async () => {
    const calls = stubApi((url) => {
      throw new Error(`grid worker must not call the API: ${url}`)
    })

    renderPage(GRID_SESSION)

    expect(await screen.findByText('网格员没有报名与核销权限')).toBeTruthy()
    expect(screen.getByText(/服务端同样会拒绝网格员的奖励履约请求/)).toBeTruthy()
    expect(calls).toEqual([])
  })
})

describe('ActivityCheckinPage real data', () => {
  it('renders the frozen plan, stock and check-in counts from the server', async () => {
    const calls = stubApi((url) => {
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 50 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rewards`) {
        return json(overview())
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/checkins`) {
        return json(checkinList([checkin()]))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('冻结的奖励计划')).toBeTruthy()
    expect(screen.getAllByText('10 斤装东北大米').length).toBeGreaterThan(0)
    expect(screen.getByText('¥45.00')).toBeTruthy()
    expect(screen.getByText('仅队长')).toBeTruthy()
    expect(screen.getByText('72 小时')).toBeTruthy()
    // Real check-in row plus the real "not verified yet" badge.
    expect(await screen.findByText('张阿姨')).toBeTruthy()
    expect(screen.getByText('待核验')).toBeTruthy()
    // Server counts, not computed client-side.
    expect(screen.getByText('已核验 0 · 待核验 1')).toBeTruthy()

    await waitFor(() => {
      const urls = calls.map((call) => call.url)
      expect(urls).toContain(`/api/admin/activities/${ACTIVITY_ID}/rewards`)
      expect(urls).toContain(`/api/admin/activities/${ACTIVITY_ID}/checkins`)
    })
  })

  it('says the reward plan is missing instead of showing a table of zeros', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 50 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rewards`) {
        return json(NO_PLAN_OVERVIEW)
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/checkins`) {
        return json(checkinList([]))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('该活动未配置奖励计划')).toBeTruthy()
    expect(screen.getByText(/不会回退读取活动表里的可变字段/)).toBeTruthy()
    // No fabricated statistics for an activity that has no plan.
    expect(screen.queryByText('冻结的奖励计划')).toBeNull()
    expect(screen.queryByText('有效签到')).toBeNull()
    expect(screen.queryByText('剩余库存')).toBeNull()
  })

  it('renders the real 403 instead of a fake empty success', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 50 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rewards`) {
        return json({ error: { code: 'forbidden', message: '该社区不在你的授权范围内' } }, 403)
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/checkins`) {
        return json({ error: { code: 'forbidden', message: '该社区不在你的授权范围内' } }, 403)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('奖励履约数据加载失败')).toBeTruthy()
    expect(screen.getByText(/没有该社区的核销权限：该社区不在你的授权范围内/)).toBeTruthy()
    expect(screen.queryByText('冻结的奖励计划')).toBeNull()
  })

  it('posts the verify request with the real CSRF token and refreshes', async () => {
    let verified = false
    const calls = stubApi((url, init) => {
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 50 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rewards`) {
        return json(overview())
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/checkins`) {
        return json(checkinList([checkin(verified ? { verifiedAt: '2026-12-01T03:00:00.000Z' } : {})]))
      }
      if (
        url === `/api/admin/activities/${ACTIVITY_ID}/checkins/${CHECKIN_ID}/verify` &&
        init?.method === 'POST'
      ) {
        verified = true
        return json(checkin({ verifiedAt: '2026-12-01T03:00:00.000Z' }))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    const verifyButton = await screen.findByRole('button', { name: /核\s*验/ })
    // The click starts an async request; flush it inside act so the resulting
    // state update is not lost when the assertion below resolves first.
    await act(async () => {
      verifyButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/verify'))
      expect(post).toBeTruthy()
      const headers = post?.init?.headers as Record<string, string> | undefined
      expect(headers?.['x-csrf-token']).toBe(CSRF_TOKEN)
    })
    // The list is re-read from the server after the write, not patched locally.
    await waitFor(() => {
      const reads = calls.filter(
        (call) => call.url === `/api/admin/activities/${ACTIVITY_ID}/checkins`,
      )
      expect(reads.length).toBeGreaterThan(1)
    })
  })

  it('shows the server reason when a revoke is rejected', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 50 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rewards`) {
        return json(overview())
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/checkins`) {
        return json(checkinList([checkin()]))
      }
      if (url.endsWith('/revoke')) {
        return json({ error: { code: 'not_found', message: '签到不存在' } }, 404)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    const revokeButton = await screen.findByRole('button', { name: /撤\s*销/ })
    await act(async () => {
      revokeButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const dialog = await screen.findByRole('dialog')
    const textarea = within(dialog).getAllByRole('textbox')[0]
    fireEvent.change(textarea, { target: { value: '现场核对发现代签' } })
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('button', { name: /确认提交/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )

    fireEvent.click(within(dialog).getByRole('button', { name: /确认提交/ }))

    expect(await screen.findByText(/对象不存在或已失效：签到不存在/)).toBeTruthy()
  })
})
