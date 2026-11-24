// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import { MemoryRouter, Route, Routes } from 'react-router'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import type {
  ActivityAuditEntry,
  ActivityCommunityRef,
  ActivityRewardPlan,
  ActivityRuleVersion,
  AdminActivityDetail,
  AdminActivitySummary,
  ActivityVisualConfig,
  PurchaseRewardPlan,
} from '@sanchuang-dev/local-life-contracts'
import {
  ActivitiesPage,
  SHANGHAI_OFFSET_MINUTES,
  keyRulesFromForm,
  toFormValues,
  visualConfigFromForm,
} from './ActivitiesPage'

/**
 * These tests drive the real page with an explicitly stubbed `fetch`.
 *
 * Every test declares exactly which HTTP URLs it answers; anything else throws,
 * so a page that silently fell back to fake data would fail loudly. Success
 * responses use the same wire payloads the API produces, and error tests assert
 * the real error state instead of a success-looking placeholder.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A: ActivityCommunityRef = {
  id: '123e4567-e89b-42d3-a456-4266141740a1',
  name: '幸福社区',
}
const COMMUNITY_B: ActivityCommunityRef = {
  id: '123e4567-e89b-42d3-a456-4266141740b2',
  name: '阳光社区',
}
const ACTIVITY_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const VERSION_ID = '123e4567-e89b-42d3-a456-4266141740d4'
const AUDIT_ID = '123e4567-e89b-42d3-a456-4266141740e5'
const CSRF_TOKEN = 'csrf-token-for-activity-page-tests'

const PUBLIC_RULES = {
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到',
  purchase: '现场购买指定套餐',
  prizeClaim: '凭核销码领取，每人限一次',
}

/** Default visual config returned by the API when nothing was configured (#309). */
const DEFAULT_VISUAL_CONFIG: ActivityVisualConfig = {
  themeKey: 'community-green',
  heroImageUrl: null,
  promoTitle: null,
  promoSubtitle: null,
  posterImageUrl: null,
}

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

function detail(overrides: Partial<AdminActivityDetail> = {}): AdminActivityDetail {
  return {
    ...summary(),
    description: '面向本社区 60 岁以上居民的线下活动',
    publicRules: PUBLIC_RULES,
    currentRuleVersionId: VERSION_ID,
    rewardPlan: null,
    purchaseRewardPlan: null,
    visualConfig: DEFAULT_VISUAL_CONFIG,
    ...overrides,
  }
}

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
}

const OPERATOR_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    id: STAFF_ID,
    username: 'operator.a',
    role: 'operator',
    communities: [COMMUNITY_A],
  },
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

/** Stubs `fetch` with an explicit URL table; unknown URLs throw immediately. */
function stubApi(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function renderPage(session: AuthenticatedSession) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session, busy: false, error: null, onLogout: async () => undefined }}
        >
          <MemoryRouter initialEntries={['/activities']}>
            <Routes>
              <Route path="/activities/*" element={<ActivitiesPage />} />
            </Routes>
          </MemoryRouter>
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function calledUrls(calls: FetchCall[]): string[] {
  return calls.map((call) => call.url)
}

/** Actions beyond the current lifecycle step stay available from the menu. */
async function chooseMoreAction(label: string) {
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
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

describe('ActivitiesPage real data rendering', () => {
  it('renders real server rows, status and frozen rule version with server-side paging', async () => {
    const calls = stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A, COMMUNITY_B] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    // The primary create action belongs to the DataPanel toolbar, not PageHeader.
    const activityPanel = screen.getByRole('region', { name: '活动列表' })
    expect(activityPanel.classList.contains('data-panel--fill')).toBe(true)
    const create = within(activityPanel).getByRole('button', { name: /新建活动/ })
    expect(create.closest('.data-panel-tools')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /新建活动/ })).toHaveLength(1)
    expect(screen.getByText('幸福社区')).toBeTruthy()
    expect(screen.getByText('已发布')).toBeTruthy()
    expect(screen.getByText('v2')).toBeTruthy()

    await waitFor(() => {
      const listUrl = calledUrls(calls).find((url) => url.startsWith('/api/admin/activities?'))
      expect(listUrl).toContain('page=1')
      expect(listUrl).toContain('pageSize=20')
    })
    expect(calledUrls(calls)).toContain('/api/admin/communities')
  })

  it('shows the real 403 error state instead of a fake empty success', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ error: { code: 'forbidden', message: '网格员无权管理活动' } }, 403)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('没有活动管理权限')).toBeTruthy()
    expect(screen.getByText('网格员无权管理活动')).toBeTruthy()
    expect(screen.queryByText('银发社区欢乐季')).toBeNull()
  })

  it('keeps the operator scoped to the assigned community and explains the real scope', async () => {
    const calls = stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText(/仅能查看与操作管理员分配的社区/)).toBeTruthy()
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    await waitFor(() => {
      const listUrl = calledUrls(calls).find((url) => url.startsWith('/api/admin/activities?'))
      expect(listUrl).toContain(`communityId=${COMMUNITY_A.id}`)
    })
  })

  it('shows the grid-worker lockout page without issuing any activity request', async () => {
    const calls = stubApi((url) => {
      throw new Error(`grid worker must not call the API: ${url}`)
    })

    renderPage(GRID_SESSION)

    expect(await screen.findByText('网格员没有活动管理权限')).toBeTruthy()
    expect(
      screen.getByText(/即使直接访问该地址，服务端同样会拒绝网格员的活动管理请求/),
    ).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('publishes only after the confirmation dialog and posts the real CSRF token', async () => {
    let published = false
    const calls = stubApi((url, init) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        const row = published
          ? summary({ status: 'published', ruleVersion: 1, updatedAt: '2026-11-03T02:00:00.000Z' })
          : summary({ status: 'draft', ruleVersion: null, publishedAt: null })
        return json({ items: [row], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/publish` && init?.method === 'POST') {
        published = true
        return json(
          detail({
            status: 'published',
            ruleVersion: 1,
            updatedAt: '2026-11-03T02:00:00.000Z',
            publishedAt: '2026-11-03T02:00:00.000Z',
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('草稿')).toBeTruthy()
    expect(screen.getByText('未冻结')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '发布' }))

    expect(await screen.findByText('发布后规则将冻结为 v1，居民端将读取该活动。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }))

    await waitFor(() => {
      expect(screen.getByText('已发布')).toBeTruthy()
    })

    const publishCall = calls.find((call) =>
      call.url.endsWith(`/admin/activities/${ACTIVITY_ID}/publish`),
    )
    expect(publishCall).toBeTruthy()
    expect(publishCall?.init?.method).toBe('POST')
    const publishHeaders = (publishCall?.init?.headers ?? {}) as Record<string, string>
    expect(publishHeaders['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(publishCall?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-02T02:00:00.000Z',
    })
    // The list is re-read from the server after the transition.
    expect(
      calledUrls(calls).filter((url) => url.startsWith('/api/admin/activities?')).length,
    ).toBeGreaterThanOrEqual(2)
  })
})

describe('Standalone activity editor routes', () => {
  it('preserves a draft form across all four tabs and saves through the existing PATCH contract', async () => {
    let patchBody: unknown
    stubApi((url, init) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({
          items: [summary({ status: 'draft', ruleVersion: null, publishedAt: null })],
          total: 1, page: 1, pageSize: 20,
        })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}` && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body))
        return json(detail({
          title: '社区活动新名称', status: 'draft', ruleVersion: null, publishedAt: null,
        }))
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        return json(detail({ status: 'draft', ruleVersion: null, publishedAt: null }))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    renderPage(ADMIN_SESSION)
    await screen.findByText('银发社区欢乐季')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const title = await screen.findByLabelText('活动标题')
    fireEvent.change(title, { target: { value: '社区活动新名称' } })
    expect((title as HTMLInputElement).value).toBe('社区活动新名称')
    fireEvent.click(screen.getByRole('tab', { name: '签到奖励' }))
    expect(screen.getByRole('tab', { name: '签到奖励' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: '消费奖励' }))
    expect(screen.getByRole('tab', { name: '消费奖励' }).getAttribute('aria-selected')).toBe('true')
    // The fourth tab shares the same Form: its values survive a tab round trip.
    fireEvent.click(screen.getByRole('tab', { name: '界面风格' }))
    expect(screen.getByRole('tab', { name: '界面风格' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: '节庆红' }))
    fireEvent.change(screen.getByLabelText('宣传标题（选填）'), {
      target: { value: '社区敬老欢乐季' },
    })
    fireEvent.click(screen.getByRole('tab', { name: '活动信息' }))
    expect((screen.getByLabelText('活动标题') as HTMLInputElement).value).toBe('社区活动新名称')
    fireEvent.click(screen.getByRole('tab', { name: '界面风格' }))
    expect(screen.getByRole('radio', { name: '节庆红' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('宣传标题（选填）') as HTMLInputElement).value).toBe(
      '社区敬老欢乐季',
    )
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(patchBody).toBeTruthy())
    expect(patchBody).toMatchObject({ title: '社区活动新名称' })
    expect(patchBody).toMatchObject({
      visualConfig: {
        themeKey: 'festival-red',
        heroImageUrl: null,
        promoTitle: '社区敬老欢乐季',
        promoSubtitle: null,
        posterImageUrl: null,
      },
    })
  })

  it('opens a new activity as a full page without an activity drawer', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [], total: 0, page: 1, pageSize: 20 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建活动/ }))
    expect(await screen.findByText('新建活动草稿')).toBeTruthy()
    expect(screen.getByRole('tablist', { name: '活动编辑区域' })).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(screen.getByRole('tab', { name: '界面风格' })).toBeTruthy()
    expect(document.querySelector('.activity-editor-page .ant-drawer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '← 返回活动列表' }))
    expect(await screen.findByText('活动管理')).toBeTruthy()
  })
})

describe('ActivitiesPage compact action column', () => {
  it.each([
    { status: 'draft', primary: '发布', secondary: false },
    { status: 'published', primary: '暂停', secondary: true },
    { status: 'paused', primary: '恢复', secondary: true },
    { status: 'ended', primary: null, secondary: false },
  ] as const)('shows only applicable actions for $status', async ({ status, primary, secondary }) => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary({ status })], total: 1, page: 1, pageSize: 20 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    renderPage(ADMIN_SESSION)
    await screen.findByText('银发社区欢乐季')
    const active = screen.getByRole('button', { name: status === 'ended' ? '查看' : '编辑' })
    expect(active).toBeTruthy()
    for (const label of ['发布', '暂停', '恢复']) {
      expect(Boolean(screen.queryByRole('button', { name: label }))).toBe(label === primary)
    }
    expect(screen.queryByRole('button', { name: '结束' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    expect(await screen.findByRole('menuitem', { name: '规则版本' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '今日抽奖' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '审计' })).toBeTruthy()
    expect(Boolean(screen.queryByRole('menuitem', { name: '结束' }))).toBe(secondary)
  })

  it('keeps irreversible end behind the original confirmation, not a direct request', async () => {
    const calls = stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    renderPage(ADMIN_SESSION)
    await screen.findByText('银发社区欢乐季')
    await chooseMoreAction('结束')
    expect(await screen.findByText('结束后活动不可恢复，居民端将显示「已结束」。')).toBeTruthy()
    expect(calls.filter(({ init }) => init?.method === 'POST')).toHaveLength(0)
  })
})

describe('ActivitiesPage read-only drawers', () => {
  it('renders the frozen rule versions with no edit or delete control', async () => {
    const version: ActivityRuleVersion = {
      id: VERSION_ID,
      activityId: ACTIVITY_ID,
      version: 1,
      snapshot: {
        startsAt: '2026-12-01T02:00:00.000Z',
        endsAt: '2026-12-01T10:00:00.000Z',
        location: '幸福社区党群服务中心',
        budgetCapCents: 987_654,
        prizeQuantityCap: 4_321,
        publicRules: PUBLIC_RULES,
      },
      createdByUserId: USER_ID,
      createdAt: '2026-11-02T02:00:00.000Z',
    }
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rule-versions`) {
        return json({ items: [version] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()

    await chooseMoreAction('规则版本')

    expect(await screen.findByText('只读快照，不可编辑或删除')).toBeTruthy()
    // Scope to the real Ant Design drawer section, not the list behind it.
    const drawer = screen
      .getByText('只读快照，不可编辑或删除')
      .closest('.ant-drawer-section') as HTMLElement | null
    expect(drawer).toBeTruthy()
    expect(within(drawer!).getByText('v1')).toBeTruthy()
    expect(within(drawer!).getByText('幸福社区党群服务中心')).toBeTruthy()
    expect(within(drawer!).queryByRole('button', { name: '编辑' })).toBeNull()
    expect(within(drawer!).queryByRole('button', { name: '删除' })).toBeNull()
  })

  it('renders the audit timeline from the real audit endpoint', async () => {
    const entries: ActivityAuditEntry[] = [
      {
        id: AUDIT_ID,
        event: 'activity.published',
        actorUserId: USER_ID,
        actorDisplayName: '测试管理员',
        targetId: ACTIVITY_ID,
        metadata: { status: 'published' },
        createdAt: '2026-11-02T02:00:00.000Z',
      },
    ]
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/audit`) {
        return json({ items: entries })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()

    await chooseMoreAction('审计')

    expect(await screen.findByText('发布活动')).toBeTruthy()
    expect(screen.getByText('操作者：测试管理员')).toBeTruthy()
    expect(screen.getByText('{"status":"published"}')).toBeTruthy()
  })
})

describe('ActivitiesPage in-flight detail race', () => {
  it('returns to a usable create form after closing an edit while the detail request is in flight', async () => {
    let settleDetail: ((response: Response) => void) | undefined
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({
          items: [summary({ status: 'draft', ruleVersion: null, publishedAt: null })],
          total: 1,
          page: 1,
          pageSize: 20,
        })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        // Answer only after the assertions: this reproduces an operator closing
        // the drawer while the server is still replying to the detail request.
        return new Promise<Response>((resolve) => {
          settleDetail = resolve
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(await screen.findByText('正在读取活动详情…')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '← 返回活动列表' }))

    fireEvent.click(screen.getByRole('button', { name: /新建活动/ }))

    // The superseded detail request must not leave the create drawer spinning.
    expect(await screen.findByText('新建活动草稿')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('正在读取活动详情…')).toBeNull())
    expect(screen.getByText('保存草稿')).toBeTruthy()
    expect(screen.getByText('参与资格')).toBeTruthy()

    // A late answer is ignored by the request guard and cannot flip the state.
    settleDetail?.(json(detail({ status: 'draft' })))
    await waitFor(() => expect(screen.queryByText('正在读取活动详情…')).toBeNull())
  })
})

describe('ActivitiesPage Asia/Shanghai form time', () => {
  it('keeps the form on Shanghai wall time instead of the browser zone', () => {
    const values = toFormValues(detail())
    expect(values.range?.[0]?.utcOffset()).toBe(SHANGHAI_OFFSET_MINUTES)
    expect(values.range?.[0]?.format('YYYY-MM-DD HH:mm')).toBe('2026-12-01 10:00')
    expect(values.range?.[1]?.format('YYYY-MM-DD HH:mm')).toBe('2026-12-01 18:00')

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.startsAt).toBe('2026-12-01T02:00:00.000Z')
      expect(result.keyRules.endsAt).toBe('2026-12-01T10:00:00.000Z')
    }
  })

  it('treats a picker value built in a non-Shanghai zone as Shanghai wall time', () => {
    // 10:00 / 18:00 on a New York (-05:00) picker value. The label promises
    // Shanghai time, so the submitted instants must be 02:00Z / 10:00Z.
    const pickedStart = dayjs('2026-12-01T15:00:00.000Z').utcOffset(-300)
    const pickedEnd = dayjs('2026-12-01T23:00:00.000Z').utcOffset(-300)
    expect(pickedStart.format('YYYY-MM-DD HH:mm')).toBe('2026-12-01 10:00')
    expect(pickedEnd.format('YYYY-MM-DD HH:mm')).toBe('2026-12-01 18:00')

    const values = toFormValues(detail({ startsAt: pickedStart.toISOString(), endsAt: pickedEnd.toISOString() }))
    values.range = [pickedStart, pickedEnd]

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.startsAt).toBe('2026-12-01T02:00:00.000Z')
      expect(result.keyRules.endsAt).toBe('2026-12-01T10:00:00.000Z')
    }
  })
})

describe('ActivitiesPage audit timeline deprecations', () => {
  it('renders audit items without the deprecated items.children warning', async () => {
    const entries: ActivityAuditEntry[] = [
      {
        id: AUDIT_ID,
        event: 'activity.published',
        actorUserId: USER_ID,
        actorDisplayName: '测试管理员',
        targetId: ACTIVITY_ID,
        metadata: { status: 'published' },
        createdAt: '2026-11-02T02:00:00.000Z',
      },
    ]
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/audit`) {
        return json({ items: entries })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    await chooseMoreAction('审计')
    expect(await screen.findByText('发布活动')).toBeTruthy()

    const messages = errorSpy.mock.calls.map((call) => call.map(String).join(' '))
    expect(messages.some((message) => message.includes('items.children'))).toBe(false)
    errorSpy.mockRestore()
  })
})

describe('ActivitiesPage reward plan form (LL-MVP-006)', () => {
  const PLAN: ActivityRewardPlan = {
    prizeName: '10 斤装东北大米',
    prizeUnitCostCents: 4_500,
    prizeQuantityPerTeam: 3,
    totalPrizeQuantity: 60,
    budgetCapCents: 270_000,
    claimRecipient: 'leader',
    checkinWindow: {
      opensAt: '2026-12-01T02:00:00.000Z',
      closesAt: '2026-12-01T06:00:00.000Z',
    },
    redemptionValidHours: 72,
    notes: '社区仓库统一发放',
  }

  it('round-trips a stored plan through the form without changing it', () => {
    const values = toFormValues(detail({ rewardPlan: PLAN }))
    expect(values.rewardPlanEnabled).toBe(true)
    expect(values.rewardPrizeName).toBe('10 斤装东北大米')
    expect(values.rewardUnitCostYuan).toBe(45)
    expect(values.rewardQuantityPerTeam).toBe(3)
    expect(values.rewardTotalQuantity).toBe(60)
    expect(values.rewardBudgetYuan).toBe(2700)
    expect(values.rewardClaimRecipient).toBe('leader')
    expect(values.rewardRedemptionHours).toBe(72)
    // The pickers are Asia/Shanghai wall clocks, same as the activity window.
    expect(values.rewardCheckinRange?.[0]?.format('YYYY-MM-DD HH:mm')).toBe('2026-12-01 10:00')
    expect(values.rewardCheckinRange?.[1]?.format('YYYY-MM-DD HH:mm')).toBe('2026-12-01 14:00')

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.rewardPlan).toEqual(PLAN)
    }
  })

  it('keeps the plan out of the payload when the activity has no plan', () => {
    const values = toFormValues(detail({ rewardPlan: null }))
    expect(values.rewardPlanEnabled).toBe(false)

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Absent key: the server keeps whatever plan it holds (nothing here), and
      // an ordinary location edit cannot silently clear a frozen plan.
      expect('rewardPlan' in result.keyRules).toBe(false)
    }
  })

  it('clears the plan only when the operator turns a stored plan off', () => {
    const values = toFormValues(detail({ rewardPlan: PLAN }))
    values.rewardPlanEnabled = false

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Explicit null is the destructive state; it must never come from a
      // form that simply could not read the current plan.
      expect(result.keyRules.rewardPlan).toBeNull()
    }
  })

  it('omits the key for a plain edit that does not touch the plan', () => {
    const values = toFormValues(detail({ rewardPlan: PLAN }))
    values.location = '幸福社区文化广场'
    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.location).toBe('幸福社区文化广场')
      expect(result.keyRules.rewardPlan).toEqual(PLAN)
    }
  })

  it('rejects a plan whose budget cannot cover one team', () => {
    const values = toFormValues(detail({ rewardPlan: PLAN }))
    values.rewardBudgetYuan = 100 // 10000 cents < 4500 * 3
    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/奖励计划不符合共享契约|budgetCapCents/)
    }
  })

  it('rejects a plan whose stock cannot cover one team', () => {
    const values = toFormValues(detail({ rewardPlan: PLAN }))
    values.rewardTotalQuantity = 2
    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/奖励计划不符合共享契约|totalPrizeQuantity/)
    }
  })

  it('rejects a check-in window that ends before it starts', () => {
    const values = toFormValues(detail({ rewardPlan: PLAN }))
    const start = values.rewardCheckinRange?.[0]
    values.rewardCheckinRange = [start ?? null, start ?? null]
    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/签到窗口/)
    }
  })

  it('requires a prize name when the plan is enabled', () => {
    const values = toFormValues(detail({ rewardPlan: null }))
    values.rewardPlanEnabled = true
    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/奖品名称/)
    }
  })

  it('shows the frozen plan in the rule-version drawer', async () => {
    const version: ActivityRuleVersion = {
      id: VERSION_ID,
      activityId: ACTIVITY_ID,
      version: 1,
      snapshot: {
        startsAt: '2026-12-01T02:00:00.000Z',
        endsAt: '2026-12-01T10:00:00.000Z',
        location: '幸福社区党群服务中心',
        budgetCapCents: 987_654,
        prizeQuantityCap: 4_321,
        publicRules: PUBLIC_RULES,
        rewardPlan: PLAN,
      },
      createdByUserId: USER_ID,
      createdAt: '2026-11-02T02:00:00.000Z',
    }
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rule-versions`) {
        return json({ items: [version] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    await chooseMoreAction('规则版本')

    expect(await screen.findByText('只读快照，不可编辑或删除')).toBeTruthy()
    expect(screen.getByText(/10 斤装东北大米/)).toBeTruthy()
    expect(screen.getByText(/总库存 60/)).toBeTruthy()
  })

  it('states that an activity without a plan cannot serve rewards', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({
          items: [summary({ status: 'draft', ruleVersion: null, publishedAt: null })],
          total: 1,
          page: 1,
          pageSize: 20,
        })
      }
      // A draft has no rule version yet; the plan can only come from the
      // admin detail, which is exactly why `rewardPlan` was added to it.
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        return json(
          detail({ status: 'draft', ruleVersion: null, publishedAt: null, rewardPlan: null }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    fireEvent.click(screen.getByRole('tab', { name: '签到奖励' }))
    expect(await screen.findByText(/未启用签到奖励/)).toBeTruthy()
    expect(screen.getByText(/不能参与该活动的奖励签到和领奖/)).toBeTruthy()
  })
})

describe('ActivitiesPage purchase reward plan form (LL-PUR-002)', () => {
  const PURCHASE_PLAN: PurchaseRewardPlan = {
    thresholdCents: 20_000,
    couponFaceValueCents: 2_000,
    maxRewardedTeams: 50,
  }

  it('round-trips a stored plan through the form without changing it', () => {
    const values = toFormValues(detail({ purchaseRewardPlan: PURCHASE_PLAN }))
    expect(values.purchaseRewardEnabled).toBe(true)
    expect(values.purchaseThresholdYuan).toBe(200)
    expect(values.purchaseCouponFaceValueYuan).toBe(20)
    expect(values.purchaseMaxRewardedTeams).toBe(50)

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.purchaseRewardPlan).toEqual(PURCHASE_PLAN)
    }
  })

  it('keeps the key out when the activity has no consumption plan', () => {
    const values = toFormValues(detail({ purchaseRewardPlan: null }))
    expect(values.purchaseRewardEnabled).toBe(false)

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Absent key: the server keeps whatever plan it holds (nothing here), so
      // an ordinary edit cannot invent a zero-value plan.
      expect('purchaseRewardPlan' in result.keyRules).toBe(false)
    }
  })

  it('clears the plan only when the operator turns a stored plan off', () => {
    const values = toFormValues(detail({ purchaseRewardPlan: PURCHASE_PLAN }))
    values.purchaseRewardEnabled = false

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.purchaseRewardPlan).toBeNull()
    }
  })

  it('preserves the plan on an unrelated edit', () => {
    const values = toFormValues(detail({ purchaseRewardPlan: PURCHASE_PLAN }))
    values.location = '幸福社区文化广场'

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.location).toBe('幸福社区文化广场')
      expect(result.keyRules.purchaseRewardPlan).toEqual(PURCHASE_PLAN)
    }
  })

  it('rejects a total coupon budget above the shared contract cap', () => {
    const values = toFormValues(detail({ purchaseRewardPlan: PURCHASE_PLAN }))
    // ¥1000 × 3 people × 400 teams = ¥1,200,000, above the ¥1,000,000 cap.
    values.purchaseCouponFaceValueYuan = 1000
    values.purchaseMaxRewardedTeams = 400

    const result = keyRulesFromForm(values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/消费奖励规则不符合共享契约|maxRewardedTeams/)
    }
  })

  it('rejects non-integer team counts and missing threshold amounts', () => {
    const values = toFormValues(detail({ purchaseRewardPlan: PURCHASE_PLAN }))
    values.purchaseMaxRewardedTeams = 2.5

    let result = keyRulesFromForm(values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/奖励团队数量上限/)
    }

    values.purchaseMaxRewardedTeams = 50
    values.purchaseThresholdYuan = null
    result = keyRulesFromForm(values)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toMatch(/团队实付门槛/)
    }
  })

  it('echoes the stored plan instead of editing a frozen published plan', () => {
    const values = toFormValues(
      detail({ status: 'published', purchaseRewardPlan: PURCHASE_PLAN }),
    )
    // The fields are not editable in this state; even a stale/rogue value must
    // not submit a plan change that the API would reject with 409.
    values.purchaseCouponFaceValueYuan = 999

    const result = keyRulesFromForm(values, {
      purchaseRewardLocked: true,
      purchaseRewardPlanBaseline: PURCHASE_PLAN,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keyRules.purchaseRewardPlan).toEqual(PURCHASE_PLAN)
    }
  })

  it('omits a frozen plan that does not exist', () => {
    const values = toFormValues(detail({ status: 'paused', purchaseRewardPlan: null }))

    const result = keyRulesFromForm(values, {
      purchaseRewardLocked: true,
      purchaseRewardPlanBaseline: null,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect('purchaseRewardPlan' in result.keyRules).toBe(false)
    }
  })

  it('shows the frozen snapshot instead of editable fields after publication', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        return json(detail({ purchaseRewardPlan: PURCHASE_PLAN }))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    expect(await screen.findByText('消费组团奖励已冻结')).toBeTruthy()
    expect(screen.getByText(/团队实付门槛 ¥200\.00 · 每人券面额 ¥20\.00/)).toBeTruthy()
    expect(screen.getByText(/团队券总预算 ¥3000\.00/)).toBeTruthy()
    expect(screen.queryByText('启用消费奖励')).toBeNull()
  })

  it('keeps the consumption fields editable for a draft', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({
          items: [summary({ status: 'draft', ruleVersion: null, publishedAt: null })],
          total: 1,
          page: 1,
          pageSize: 20,
        })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        return json(
          detail({
            status: 'draft',
            ruleVersion: null,
            publishedAt: null,
            purchaseRewardPlan: PURCHASE_PLAN,
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    fireEvent.click(screen.getByRole('tab', { name: '消费奖励' }))
    expect(await screen.findByText('启用消费奖励')).toBeTruthy()
    expect(screen.queryByText('消费组团奖励已冻结')).toBeNull()
    expect(screen.getByText('¥3000.00')).toBeTruthy()
  })

  it('saves a draft plan through the real PATCH payload', async () => {
    let patchBody: unknown
    stubApi((url, init) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({
          items: [summary({ status: 'draft', ruleVersion: null, publishedAt: null })],
          total: 1,
          page: 1,
          pageSize: 20,
        })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}` && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body))
        return json(
          detail({
            status: 'draft',
            ruleVersion: null,
            publishedAt: null,
            purchaseRewardPlan: {
              thresholdCents: 30_000,
              couponFaceValueCents: 5_000,
              maxRewardedTeams: 10,
            },
          }),
        )
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        return json(
          detail({
            status: 'draft',
            ruleVersion: null,
            publishedAt: null,
            purchaseRewardPlan: null,
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    fireEvent.click(screen.getByRole('tab', { name: '消费奖励' }))
    fireEvent.click(await screen.findByRole('switch', { name: '启用消费奖励' }))
    fireEvent.change(await screen.findByLabelText('团队实付门槛（元）'), {
      target: { value: '300' },
    })
    fireEvent.change(screen.getByLabelText('每人券面额（元）'), {
      target: { value: '50' },
    })
    fireEvent.change(screen.getByLabelText('奖励团队数量上限'), {
      target: { value: '10' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(patchBody).toBeTruthy())
    expect(patchBody).toMatchObject({
      keyRules: {
        purchaseRewardPlan: {
          thresholdCents: 30_000,
          couponFaceValueCents: 5_000,
          maxRewardedTeams: 10,
        },
      },
    })
  })

  it('shows the plan in the frozen rule-version drawer', async () => {
    const version: ActivityRuleVersion = {
      id: VERSION_ID,
      activityId: ACTIVITY_ID,
      version: 1,
      snapshot: {
        startsAt: '2026-12-01T02:00:00.000Z',
        endsAt: '2026-12-01T10:00:00.000Z',
        location: '幸福社区党群服务中心',
        budgetCapCents: 987_654,
        prizeQuantityCap: 4_321,
        publicRules: PUBLIC_RULES,
        purchaseRewardPlan: PURCHASE_PLAN,
      },
      createdByUserId: USER_ID,
      createdAt: '2026-11-02T02:00:00.000Z',
    }
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}/rule-versions`) {
        return json({ items: [version] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    await chooseMoreAction('规则版本')

    expect(await screen.findByText('只读快照，不可编辑或删除')).toBeTruthy()
    expect(screen.getByText(/团队实付门槛 ¥200\.00 · 每人券面额 ¥20\.00/)).toBeTruthy()
  })
})

describe('ActivitiesPage visual style tab (LL-ACT-VIS-001)', () => {
  const STORED_VISUAL: ActivityVisualConfig = {
    themeKey: 'warm-gold',
    heroImageUrl: 'https://cdn.example.com/hero.jpg',
    promoTitle: '暖阳敬老月',
    promoSubtitle: '健康讲座与义诊',
    posterImageUrl: 'https://cdn.example.com/poster.jpg',
  }

  it('maps the stored visual config onto the form and validates through the shared contract', () => {
    const values = toFormValues(detail({ visualConfig: STORED_VISUAL }))
    expect(values.visualThemeKey).toBe('warm-gold')
    expect(values.visualHeroImageUrl).toBe('https://cdn.example.com/hero.jpg')
    expect(values.visualPromoTitle).toBe('暖阳敬老月')
    expect(values.visualPromoSubtitle).toBe('健康讲座与义诊')
    expect(values.visualPosterImageUrl).toBe('https://cdn.example.com/poster.jpg')

    const roundTrip = visualConfigFromForm(values)
    expect(roundTrip.ok).toBe(true)
    if (roundTrip.ok) {
      expect(roundTrip.visualConfig).toEqual(STORED_VISUAL)
    }

    // Only choosing a theme is a valid visual configuration.
    const themeOnly = visualConfigFromForm({
      ...values,
      visualThemeKey: 'health-blue',
      visualHeroImageUrl: '',
      visualPromoTitle: '',
      visualPromoSubtitle: '',
      visualPosterImageUrl: '',
    })
    expect(themeOnly.ok).toBe(true)
    if (themeOnly.ok) {
      expect(themeOnly.visualConfig).toEqual({
        themeKey: 'health-blue',
        heroImageUrl: null,
        promoTitle: null,
        promoSubtitle: null,
        posterImageUrl: null,
      })
    }

    // An unknown theme or a non-http(s) URL never reaches the write request.
    const badTheme = visualConfigFromForm({
      ...values,
      visualThemeKey: 'neon-pink' as never,
    })
    expect(badTheme.ok).toBe(false)
    if (!badTheme.ok) expect(badTheme.message).toMatch(/themeKey/)

    const badUrl = visualConfigFromForm({
      ...values,
      visualHeroImageUrl: 'javascript:alert(1)',
    })
    expect(badUrl.ok).toBe(false)
    if (!badUrl.ok) expect(badUrl.message).toMatch(/heroImageUrl/)

    // Blank copy clears instead of inventing content.
    const cleared = visualConfigFromForm({
      ...values,
      visualThemeKey: 'community-green',
      visualHeroImageUrl: '  ',
      visualPromoTitle: '',
      visualPromoSubtitle: '   ',
      visualPosterImageUrl: '',
    })
    expect(cleared.ok).toBe(true)
    if (cleared.ok) {
      expect(cleared.visualConfig).toEqual(DEFAULT_VISUAL_CONFIG)
    }
  })

  it('previews the live form values and all four themes instead of a hard-coded sample', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        return json(detail())
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('tab', { name: '界面风格' }))

    const preview = document.querySelector('.activity-preview-phone') as HTMLElement | null
    expect(preview).toBeTruthy()
    // Real activity title + location from the loaded detail, not sample copy.
    expect(within(preview!).getByText('银发社区欢乐季')).toBeTruthy()
    expect(within(preview!).getByText('幸福社区党群服务中心')).toBeTruthy()
    // A published activity's preview CTA follows its real status.
    expect(within(preview!).getByText('立即参与活动')).toBeTruthy()
    expect(preview!.getAttribute('data-theme')).toBe('community-green')

    // All four palettes are selectable and repaint the preview.
    for (const [label, key] of [
      ['节庆红', 'festival-red'],
      ['健康蓝', 'health-blue'],
      ['暖阳金', 'warm-gold'],
      ['社区绿', 'community-green'],
    ] as const) {
      fireEvent.click(screen.getByRole('radio', { name: label }))
      expect(screen.getByRole('radio', { name: label }).getAttribute('aria-checked')).toBe('true')
      await waitFor(() => expect(preview!.getAttribute('data-theme')).toBe(key))
    }

    fireEvent.change(screen.getByLabelText('宣传标题（选填）'), {
      target: { value: '重阳节社区专场' },
    })
    await waitFor(() => expect(within(preview!).getByText('重阳节社区专场')).toBeTruthy())
    // The activity title is still visible when no promo title is typed.
    fireEvent.change(screen.getByLabelText('宣传标题（选填）'), { target: { value: '' } })
    await waitFor(() => expect(within(preview!).getByText('银发社区欢乐季')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('宣传副标题（选填）'), {
      target: { value: '免费量血压与健康咨询' },
    })
    await waitFor(() =>
      expect(within(preview!).getByText('免费量血压与健康咨询')).toBeTruthy(),
    )

    // The poster preview is separate and never claims a share happened.
    const poster = screen.getByLabelText('宣传海报预览')
    expect(within(poster).getByText('填写海报 URL 后在此预览')).toBeTruthy()
    expect(screen.queryByText(/已分享/)).toBeNull()
    expect(within(poster).queryByRole('button')).toBeNull()
  })

  it('saves a published activity visual-only change without a rule version and re-reads the detail', async () => {
    let patchBody: unknown
    let detailGets = 0
    let currentDetail = detail({ visualConfig: DEFAULT_VISUAL_CONFIG })
    const patchedDetail = detail({
      visualConfig: {
        themeKey: 'health-blue',
        heroImageUrl: null,
        promoTitle: '健康义诊专场',
        promoSubtitle: null,
        posterImageUrl: null,
      },
    })
    stubApi((url, init) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}` && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body))
        currentDetail = patchedDetail
        return json(patchedDetail)
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        detailGets += 1
        return json(currentDetail)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('tab', { name: '界面风格' }))
    fireEvent.click(screen.getByRole('radio', { name: '健康蓝' }))
    fireEvent.change(screen.getByLabelText('宣传标题（选填）'), {
      target: { value: '健康义诊专场' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(patchBody).toBeTruthy())
    // Visual-only PATCH: no keyRules, so the frozen reward/rules stay untouched.
    expect(patchBody).toEqual({
      expectedUpdatedAt: '2026-11-02T02:00:00.000Z',
      visualConfig: {
        themeKey: 'health-blue',
        heroImageUrl: null,
        promoTitle: '健康义诊专场',
        promoSubtitle: null,
        posterImageUrl: null,
      },
    })
    expect(screen.queryByText('修改已发布规则将生成新版本')).toBeNull()
    expect(await screen.findByText('活动已更新')).toBeTruthy()
    // The editor re-reads the server detail after a successful save.
    await waitFor(() => expect(detailGets).toBeGreaterThanOrEqual(2))
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '健康蓝' }).getAttribute('aria-checked')).toBe('true'),
    )
    expect((screen.getByLabelText('宣传标题（选填）') as HTMLInputElement).value).toBe(
      '健康义诊专场',
    )
  })

  it('clears artwork, reports image load failures and blocks a non-http(s) URL', async () => {
    let patchBody: unknown
    let patchCalls = 0
    stubApi((url, init) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({
          items: [summary({ status: 'draft', ruleVersion: null, publishedAt: null })],
          total: 1, page: 1, pageSize: 20,
        })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}` && init?.method === 'PATCH') {
        patchCalls += 1
        patchBody = JSON.parse(String(init.body))
        return json(
          detail({
            status: 'draft',
            ruleVersion: null,
            publishedAt: null,
            visualConfig: DEFAULT_VISUAL_CONFIG,
          }),
        )
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) {
        return json(
          detail({
            status: 'draft',
            ruleVersion: null,
            publishedAt: null,
            visualConfig: STORED_VISUAL,
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('tab', { name: '界面风格' }))

    const heroInput = (await screen.findByLabelText('活动头图 URL')) as HTMLInputElement
    expect(heroInput.value).toBe('https://cdn.example.com/hero.jpg')
    const heroPreview = screen.getByAltText('头图链接预览') as HTMLImageElement
    expect(heroPreview.getAttribute('src')).toBe('https://cdn.example.com/hero.jpg')
    fireEvent.error(heroPreview)
    expect(await screen.findByText('头图加载失败')).toBeTruthy()

    // An invalid URL fails both the inline field and the save; nothing is posted.
    fireEvent.change(heroInput, { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(
      (await screen.findAllByText(/请输入以 http:\/\/ 或 https:\/\/ 开头的可访问图片地址/)).length,
    ).toBeGreaterThan(0)
    expect(patchCalls).toBe(0)

    // Restore a valid URL, then clear it: the save sends an explicit null.
    fireEvent.change(heroInput, { target: { value: 'https://cdn.example.com/hero-v2.jpg' } })
    fireEvent.click(screen.getByRole('button', { name: '清空头图' }))
    expect((screen.getByLabelText('活动头图 URL') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '清空海报' }))
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(patchBody).toBeTruthy())
    expect(patchBody).toMatchObject({
      visualConfig: {
        themeKey: 'warm-gold',
        heroImageUrl: null,
        promoSubtitle: '健康讲座与义诊',
        posterImageUrl: null,
      },
    })
  })

  it('warns before leaving an editor with unsaved visual changes', async () => {
    stubApi((url) => {
      if (url.startsWith('/api/admin/communities')) return json({ items: [COMMUNITY_A] })
      if (url.startsWith('/api/admin/activities?')) {
        return json({ items: [summary()], total: 1, page: 1, pageSize: 20 })
      }
      if (url === `/api/admin/activities/${ACTIVITY_ID}`) return json(detail())
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('银发社区欢乐季')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('tab', { name: '界面风格' }))
    fireEvent.click(screen.getByRole('radio', { name: '暖阳金' }))

    fireEvent.click(screen.getByRole('button', { name: '← 返回活动列表' }))
    expect((await screen.findAllByText('放弃未保存的修改？')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    await waitFor(() => expect(screen.queryAllByText('放弃未保存的修改？')).toHaveLength(0))
    expect(screen.getByRole('button', { name: '保存修改' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '暖阳金' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '← 返回活动列表' }))
    fireEvent.click((await screen.findAllByRole('button', { name: '放弃修改' }))[0])
    expect(await screen.findByText('活动管理')).toBeTruthy()
  })
})
