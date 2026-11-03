import { render } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { vi } from 'vitest'
import { routes } from '../app/routes'
import { adminTheme } from '../app/theme'

/** Renders the real route tree with the same providers used by main.tsx. */
export function renderAdmin(initialPath = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] })
  const result = render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>,
  )
  return { ...result, router }
}

export const HEALTH_PAYLOAD = {
  status: 'ok' as const,
  service: 'local-life-api' as const,
  version: '0.1.0',
  uptimeSeconds: 125,
  timestamp: '2026-11-03T07:00:00.000Z',
}

/** Stubs only the real health endpoint; every other call fails loudly. */
export function mockHealthFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!url.endsWith('/api/healthz')) throw new Error(`unexpected fetch: ${url}`)
    return new Response(JSON.stringify(HEALTH_PAYLOAD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Sets a deterministic viewport width for the responsive shell. */
export function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
}
