// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { ActivityDrawPool } from '@sanchuang-dev/local-life-contracts'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { DrawPoolDrawer } from './DrawPoolDrawer'

/**
 * Drives the real drawer with an explicitly stubbed fetch. Every URL must be
 * declared; an unexpected request fails loudly instead of falling back to demo
 * data.
 */

const ACTIVITY_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const COMMUNITY_ID = '123e4567-e89b-42d3-a456-4266141740a1'
const CSRF_TOKEN = 'csrf-token-for-draw-pool-tests'

const SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: '123e4567-e89b-42d3-a456-426614174000', displayName: '测试管理员' },
  staff: {
    id: '123e4567-e89b-42d3-a456-426614174001',
    username: 'testadmin',
    role: 'admin',
    communities: [],
  },
  csrfToken: CSRF_TOKEN,
}

function emptyPool(overrides: Partial<ActivityDrawPool> = {}): ActivityDrawPool {
  return {
    activityId: ACTIVITY_ID,
    activityStatus: 'published',
    community: { id: COMMUNITY_ID, name: '幸福社区' },
    configured: false,
    enabled: false,
    dailyDrawLimitPerResident: 0,
    noPrizeWeight: 0,
    prizes: [],
    totals: {
      totalQuantity: 0,
      remainingQuantity: 0,
      drawnQuantity: 0,
      enabledPrizeCount: 0,
    },
    updatedAt: null,
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderDrawer() {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <DrawPoolDrawer
          open
          activity={{
            id: ACTIVITY_ID,
            title: '银发社区欢乐季',
            community: { id: COMMUNITY_ID, name: '幸福社区' },
            status: 'published',
          }}
          session={SESSION}
          onClose={() => {}}
        />
      </AntdApp>
    </ConfigProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('DrawPoolDrawer', () => {
  it('states the honest unconfigured state without inventing prizes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith(`/api/admin/activities/${ACTIVITY_ID}/draw-pool`)) {
        return json(emptyPool())
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDrawer()

    expect(await screen.findByText('尚未创建抽奖配置，默认关闭')).toBeTruthy()
    expect(screen.getByText(/奖品池为空/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加真实商品奖品' })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('saves the real configuration with the optimistic token', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith(`/api/admin/activities/${ACTIVITY_ID}/draw-pool`)) {
        if (init?.method === 'POST') {
          calls.push({ url, body: JSON.parse(String(init.body)) })
          return json(
            emptyPool({
              configured: true,
              dailyDrawLimitPerResident: 2,
              noPrizeWeight: 10,
              updatedAt: '2026-11-10T10:00:00.000Z',
            }),
          )
        }
        return json(emptyPool())
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderDrawer()
    await screen.findByText('尚未创建抽奖配置，默认关闭')

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.body).toEqual({
      expectedUpdatedAt: null,
      enabled: false,
      dailyDrawLimitPerResident: 1,
      noPrizeWeight: 0,
    })
    expect(await screen.findByText('抽奖配置已保存，当前未启用')).toBeTruthy()
  })

  it('disables every write for an ended activity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith(`/api/admin/activities/${ACTIVITY_ID}/draw-pool`)) {
        return json(
          emptyPool({
            activityStatus: 'ended',
            configured: true,
            dailyDrawLimitPerResident: 2,
            updatedAt: '2026-11-10T10:00:00.000Z',
          }),
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ConfigProvider locale={zhCN} theme={adminTheme}>
        <AntdApp>
          <DrawPoolDrawer
            open
            activity={{
              id: ACTIVITY_ID,
              title: '已结束活动',
              community: { id: COMMUNITY_ID, name: '幸福社区' },
              status: 'ended',
            }}
            session={SESSION}
            onClose={() => {}}
          />
        </AntdApp>
      </ConfigProvider>,
    )

    expect(await screen.findByText('活动已结束')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存配置' })).toHaveProperty('disabled', true)
  })
})
