// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type {
  WechatAdminConfigResponse,
  WechatConfigSummary,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { renderAdmin } from '../test/render-admin'
import { WechatSettingsPage } from './WechatSettingsPage'

/**
 * These tests drive the real 系统管理 → 微信公众号 page with an explicitly
 * stubbed `fetch`.
 *
 * Only the HTTP boundary is mocked: every request URL is declared per test, an
 * unexpected URL throws, and the wire payloads follow the frozen shared
 * contracts. The page logic, AntD form state, CSRF header construction and error
 * rendering are the real implementations.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const CONFIG_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const SECOND_CONFIG_ID = '123e4567-e89b-42d3-a456-4266141740d4'
const APP_ID = 'wx1234567890abcdef'
const SECOND_APP_ID = 'wxabcdef1234567890'
const APP_SECRET = 'Fake-AppSecret-For-Ui-Tests-0123456789'
const CSRF_TOKEN = 'csrf-token-for-wechat-page-tests'
const REDIRECT_URI = 'http://localhost:5173/api/auth/wechat/callback'
const CONFIG_URL = '/api/admin/wechat/config'
const SAVE_URL = '/api/admin/wechat/config/candidates'
const VERIFY_URL = `/api/admin/wechat/config/${CONFIG_ID}/verify`
const ACTIVATE_URL = `/api/admin/wechat/config/${CONFIG_ID}/activate`
const CREATED_AT = '2026-11-01T02:00:00.000Z'
const UPDATED_AT = '2026-11-02T02:00:00.000Z'
const VERIFIED_AT = '2026-11-02T03:00:00.000Z'
const ACTIVATED_AT = '2026-11-03T02:00:00.000Z'

function summary(overrides: Partial<WechatConfigSummary> = {}): WechatConfigSummary {
  return {
    id: CONFIG_ID,
    appId: APP_ID,
    accountType: 'official',
    status: 'draft',
    keyId: 'v1',
    lastErrorCode: null,
    verifiedAt: null,
    activatedAt: null,
    retiredAt: null,
    createdByUserId: USER_ID,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  }
}

function config(overrides: Partial<WechatAdminConfigResponse> = {}): WechatAdminConfigResponse {
  return {
    state: 'unconfigured',
    active: null,
    candidate: null,
    recent: [],
    masterKeyAvailable: true,
    keyId: 'v1',
    redirectUri: REDIRECT_URI,
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
  staff: { id: STAFF_ID, username: 'operator.a', role: 'operator', communities: [] },
}

const GRID_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: { id: STAFF_ID, username: 'grid.a', role: 'grid_worker', communities: [] },
}

interface FetchCall {
  url: string
  init?: RequestInit
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorEnvelope(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status)
}

/** Stubs `fetch` with an explicit handler; every call is recorded. */
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
          <WechatSettingsPage />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function fillSaveForm(appId = APP_ID, secret = APP_SECRET) {
  fireEvent.change(screen.getByLabelText('AppID'), { target: { value: appId } })
  fireEvent.click(screen.getByRole('radio', { name: '正式号' }))
  fireEvent.change(screen.getByLabelText('AppSecret'), { target: { value: secret } })
}

function stateTagText(): string {
  return screen.getByTestId('wechat-state-tag').textContent ?? ''
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

describe('WechatSettingsPage loading and read-only state', () => {
  it('shows a real loading state until the config endpoint answers', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    stubApi(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )

    renderPage(ADMIN_SESSION)

    expect(screen.getByText('正在读取公众号配置状态…')).toBeTruthy()
    expect(screen.queryByTestId('wechat-state-tag')).toBeNull()

    resolveFetch?.(json(config()))
    expect(await screen.findByTestId('wechat-state-tag')).toBeTruthy()
  })

  it('renders the honest unconfigured state, encryption key id and read-only callback URL', async () => {
    stubApi((url) => {
      if (url === CONFIG_URL) return json(config())
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    await screen.findByTestId('wechat-state-tag')
    expect(stateTagText()).toContain('未配置')
    expect(screen.getByText('加密已就绪')).toBeTruthy()
    expect(screen.getByTestId('wechat-key-id').textContent).toBe('v1')

    // The callback URL is a server-derived value: displayed, copyable, not editable.
    expect(screen.getByTestId('wechat-callback-url').textContent).toBe(REDIRECT_URI)
    expect(screen.getByRole('button', { name: '复制回调地址' })).toBeTruthy()
    expect(screen.queryByDisplayValue(REDIRECT_URI)).toBeNull()
    expect(screen.queryByRole('textbox', { name: /回调/ })).toBeNull()

    expect(screen.getByTestId('wechat-active-card').textContent).toContain(
      '当前没有已启用的公众号配置',
    )
    expect(screen.getByTestId('wechat-candidate-card').textContent).toContain(
      '没有待验证或已验证的候选配置',
    )

    const secret = screen.getByLabelText('AppSecret') as HTMLInputElement
    expect(secret.value).toBe('')
    expect(secret.type).toBe('password')
    expect(secret.getAttribute('autocomplete')).toBe('new-password')
  })

  it('renders the active configuration with account type, verification time and no secret', async () => {
    const active = summary({
      status: 'active',
      verifiedAt: VERIFIED_AT,
      activatedAt: ACTIVATED_AT,
    })
    stubApi((url) => {
      if (url === CONFIG_URL)
        return json(
          config({ state: 'active', active, recent: [active] }),
        )
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    await screen.findByTestId('wechat-state-tag')
    expect(stateTagText()).toContain('已启用')

    const activeCard = screen.getByTestId('wechat-active-card')
    expect(within(activeCard).getByText(APP_ID)).toBeTruthy()
    expect(within(activeCard).getByText('正式号')).toBeTruthy()
    expect(within(activeCard).getByText('已启用')).toBeTruthy()
    expect(screen.getByTestId('wechat-active-verified-at').textContent).not.toBe('—')
    expect(screen.getByTestId('wechat-candidate-card').textContent).toContain(
      '没有待验证或已验证的候选配置',
    )

    // The page never receives or renders the secret.
    expect(document.body.textContent).not.toContain(APP_SECRET)
    expect((screen.getByLabelText('AppSecret') as HTMLInputElement).value).toBe('')
  })

  it('warns explicitly when the active ciphertext cannot be decrypted', async () => {
    const active = summary({
      status: 'active',
      lastErrorCode: 'decrypt_failed',
      verifiedAt: VERIFIED_AT,
      activatedAt: ACTIVATED_AT,
    })
    stubApi((url) => {
      if (url === CONFIG_URL) return json(config({ state: 'active', active, recent: [active] }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('已启用配置当前不可用')).toBeTruthy()
    expect(
      screen.getByText(/虽标记为已启用，但服务端无法用当前主密钥解密已保存的 AppSecret/),
    ).toBeTruthy()
  })

  it('disables every write when the server master key is unavailable', async () => {
    stubApi((url) => {
      if (url === CONFIG_URL)
        return json(config({ masterKeyAvailable: false, keyId: 'v1' }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('凭证加密主密钥不可用')).toBeTruthy()
    expect(screen.getByText('主密钥不可用')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '保存为待验证配置' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByLabelText('AppID') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('WechatSettingsPage candidate lifecycle', () => {
  it('describes a draft candidate and blocks activation until verification passes', async () => {
    stubApi((url) => {
      if (url === CONFIG_URL)
        return json(config({ state: 'draft', candidate: summary({ status: 'draft' }) }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    await screen.findByTestId('wechat-state-tag')
    expect(stateTagText()).toContain('待验证')
    const candidateCard = screen.getByTestId('wechat-candidate-card')
    expect(within(candidateCard).getByText(APP_ID)).toBeTruthy()
    expect(within(candidateCard).getByText('正式号')).toBeTruthy()
    expect(screen.getByTestId('wechat-candidate-verified-at').textContent).toBe('—')
    expect(screen.getByText('启用前需先通过测试连接')).toBeTruthy()
    expect((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    expect((screen.getByRole('button', { name: '启用配置' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('renders a verified candidate with an enabled activation action', async () => {
    const candidate = summary({ status: 'verified', verifiedAt: VERIFIED_AT })
    stubApi((url) => {
      if (url === CONFIG_URL) return json(config({ state: 'verified', candidate }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    await screen.findByTestId('wechat-state-tag')
    expect(stateTagText()).toContain('已验证')
    expect(screen.getByTestId('wechat-candidate-verified-at').textContent).not.toBe('—')
    expect((screen.getByRole('button', { name: '启用配置' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    expect(screen.queryByText('启用前需先通过测试连接')).toBeNull()
  })

  it('renders a failed verification with the redacted reason and keeps activation blocked', async () => {
    const candidate = summary({ status: 'failed', lastErrorCode: 'invalid_app_secret' })
    stubApi((url) => {
      if (url === CONFIG_URL) return json(config({ state: 'failed', candidate }))
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    await screen.findByTestId('wechat-state-tag')
    expect(stateTagText()).toContain('验证失败')
    const candidateCard = screen.getByTestId('wechat-candidate-card')
    expect(within(candidateCard).getByText('验证失败')).toBeTruthy()
    expect(within(candidateCard).getByText('微信拒绝该 AppSecret（AppSecret 无效）')).toBeTruthy()
    expect(within(candidateCard).getByText('invalid_app_secret')).toBeTruthy()
    expect((screen.getByRole('button', { name: '启用配置' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('WechatSettingsPage save/verify/activate requests', () => {
  it('POSTs appId/accountType/appSecret with the session CSRF token, then clears the secret', async () => {
    let postCall: FetchCall | undefined
    let configCalls = 0
    let current = config()
    stubApi((url, init) => {
      if (url === CONFIG_URL) {
        configCalls += 1
        return json(current)
      }
      if (url === SAVE_URL && init?.method === 'POST') {
        postCall = { url, init }
        const candidate = summary({ status: 'draft' })
        current = config({ state: 'draft', candidate })
        return json({ config: candidate })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    await screen.findByTestId('wechat-state-tag')

    fillSaveForm()
    expect((screen.getByLabelText('AppSecret') as HTMLInputElement).value).toBe(APP_SECRET)

    fireEvent.click(screen.getByRole('button', { name: '保存为待验证配置' }))

    await waitFor(() => expect(postCall).toBeTruthy())
    expect(postCall?.init?.method).toBe('POST')
    const headers = (postCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(postCall?.init?.body))).toEqual({
      appId: APP_ID,
      appSecret: APP_SECRET,
      accountType: 'official',
    })

    await waitFor(() => expect(stateTagText()).toContain('待验证'))
    expect(configCalls).toBeGreaterThanOrEqual(2)
    // The typed secret is cleared only after a real success response.
    await waitFor(() =>
      expect((screen.getByLabelText('AppSecret') as HTMLInputElement).value).toBe(''),
    )
    expect(document.body.textContent).not.toContain(APP_SECRET)
  })

  it('shows the real server error on save failure and does not pretend success', async () => {
    const calls = stubApi((url, init) => {
      if (url === CONFIG_URL) return json(config())
      if (url === SAVE_URL && init?.method === 'POST') {
        return errorEnvelope(
          'wechat_config_invalid',
          'AppID 格式不正确：应为 wx 开头的 18 位字母数字（如 wx1234567890abcdef）',
          400,
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    await screen.findByTestId('wechat-state-tag')

    fillSaveForm()
    fireEvent.click(screen.getByRole('button', { name: '保存为待验证配置' }))

    expect(await screen.findByText('保存公众号凭证失败')).toBeTruthy()
    expect(
      screen.getByText(
        'AppID 格式不正确：应为 wx 开头的 18 位字母数字（如 wx1234567890abcdef）',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/已保存候选配置/)).toBeNull()
    // Failure keeps the typed values so the admin can correct and retry.
    expect((screen.getByLabelText('AppSecret') as HTMLInputElement).value).toBe(APP_SECRET)
    expect(calls.filter((call) => call.url === SAVE_URL)).toHaveLength(1)
  })

  it('calls the real verify endpoint with expectedUpdatedAt and reports a failure honestly', async () => {
    let verifyCall: FetchCall | undefined
    let current = config({ state: 'draft', candidate: summary({ status: 'draft' }) })
    stubApi((url, init) => {
      if (url === CONFIG_URL) return json(current)
      if (url === VERIFY_URL && init?.method === 'POST') {
        verifyCall = { url, init }
        const failed = summary({ status: 'failed', lastErrorCode: 'invalid_app_secret' })
        current = config({ state: 'failed', candidate: failed })
        return errorEnvelope(
          'wechat_config_verify_failed',
          'AppSecret 无效（微信 errcode 40125）',
          409,
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    await screen.findByTestId('wechat-state-tag')

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText('测试连接失败')).toBeTruthy()
    expect(screen.getByText('AppSecret 无效（微信 errcode 40125）')).toBeTruthy()
    const headers = (verifyCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(verifyCall?.init?.body))).toEqual({ expectedUpdatedAt: UPDATED_AT })

    await waitFor(() => expect(stateTagText()).toContain('验证失败'))
    expect(screen.queryByText('测试连接成功')).toBeNull()
  })

  it('reports a successful verify without claiming WeChat device-level acceptance', async () => {
    let current = config({ state: 'draft', candidate: summary({ status: 'draft' }) })
    stubApi((url, init) => {
      if (url === CONFIG_URL) return json(current)
      if (url === VERIFY_URL && init?.method === 'POST') {
        const verified = summary({ status: 'verified', verifiedAt: VERIFIED_AT })
        current = config({ state: 'verified', candidate: verified })
        return json({ verified: true, config: verified })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    await screen.findByTestId('wechat-state-tag')

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText('测试连接成功')).toBeTruthy()
    expect(
      screen.getByText(/凭证验证只证明能换取 access_token，不等于微信内真机 OAuth 授权验收/),
    ).toBeTruthy()
    await waitFor(() => expect(stateTagText()).toContain('已验证'))
  })

  it('activates only after the confirmation dialog, posting expectedUpdatedAt and confirm:true', async () => {
    let activateCall: FetchCall | undefined
    let current = config({
      state: 'verified',
      candidate: summary({ status: 'verified', verifiedAt: VERIFIED_AT }),
    })
    stubApi((url, init) => {
      if (url === CONFIG_URL) return json(current)
      if (url === ACTIVATE_URL && init?.method === 'POST') {
        activateCall = { url, init }
        const active = summary({
          status: 'active',
          verifiedAt: VERIFIED_AT,
          activatedAt: ACTIVATED_AT,
        })
        current = config({ state: 'active', active, recent: [active] })
        return json({ active, previous: null })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    await screen.findByTestId('wechat-state-tag')

    fireEvent.click(screen.getByRole('button', { name: '启用配置' }))

    const dialog = await screen.findByRole('dialog')
    // antd renders the confirm title in both the modal header and the confirm
    // body, so assert presence instead of uniqueness.
    expect(within(dialog).getAllByText('确认启用该微信公众号配置？').length).toBeGreaterThan(0)
    const target = within(dialog).getByTestId('wechat-activate-target')
    expect(target.textContent).toContain(APP_ID)
    expect(target.textContent).toContain('正式号')
    expect(activateCall).toBeUndefined()

    fireEvent.click(within(dialog).getByRole('button', { name: '确认启用' }))

    await waitFor(() => expect(activateCall).toBeTruthy())
    expect(activateCall?.init?.method).toBe('POST')
    const headers = (activateCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(activateCall?.init?.body))).toEqual({
      expectedUpdatedAt: UPDATED_AT,
      confirm: true,
    })

    expect(await screen.findByText('公众号配置已启用')).toBeTruthy()
    await waitFor(() => expect(stateTagText()).toContain('已启用'))
    expect(
      within(screen.getByTestId('wechat-active-card')).getByText(APP_ID),
    ).toBeTruthy()
  })

  it('explains the runtime switch before replacing an already active account', async () => {
    const oldActive = summary({
      id: CONFIG_ID,
      appId: APP_ID,
      status: 'active',
      verifiedAt: VERIFIED_AT,
      activatedAt: ACTIVATED_AT,
    })
    const candidate = summary({
      id: SECOND_CONFIG_ID,
      appId: SECOND_APP_ID,
      status: 'verified',
      verifiedAt: VERIFIED_AT,
    })
    let activateCall: FetchCall | undefined
    let current = config({ state: 'active', active: oldActive, candidate })
    stubApi((url, init) => {
      if (url === CONFIG_URL) return json(current)
      if (url === `/api/admin/wechat/config/${SECOND_CONFIG_ID}/activate` && init?.method === 'POST') {
        activateCall = { url, init }
        const active = summary({
          id: SECOND_CONFIG_ID,
          appId: SECOND_APP_ID,
          status: 'active',
          verifiedAt: VERIFIED_AT,
          activatedAt: ACTIVATED_AT,
        })
        current = config({ state: 'active', active, recent: [active, oldActive] })
        return json({ active, previous: oldActive })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    await screen.findByTestId('wechat-state-tag')

    fireEvent.click(screen.getByRole('button', { name: '更换配置' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText('确认更换微信公众号配置？').length).toBeGreaterThan(0)
    const target = within(dialog).getByTestId('wechat-activate-target')
    expect(target.textContent).toContain(SECOND_APP_ID)
    expect(target.textContent).toContain('正式号')
    expect(
      within(dialog).getByText(/新发起的微信登录使用新公众号/),
    ).toBeTruthy()
    expect(within(dialog).getByText(/在途授权仍使用原配置/)).toBeTruthy()
    expect(within(dialog).getByText(/不同 AppID 的微信身份不会合并/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '确认更换' }))

    await waitFor(() => expect(activateCall).toBeTruthy())
    expect(JSON.parse(String(activateCall?.init?.body))).toEqual({
      expectedUpdatedAt: UPDATED_AT,
      confirm: true,
    })
    await waitFor(() =>
      expect(
        within(screen.getByTestId('wechat-active-card')).getByText(SECOND_APP_ID),
      ).toBeTruthy(),
    )
  })

  it('shows the real API error when the initial read fails', async () => {
    stubApi((url) => {
      if (url === CONFIG_URL) {
        return errorEnvelope('forbidden', '只有管理员可以管理微信公众号配置', 403)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('无法读取公众号配置')).toBeTruthy()
    expect(screen.getByText('只有管理员可以管理微信公众号配置')).toBeTruthy()
    expect(screen.queryByTestId('wechat-active-card')).toBeNull()
  })
})

describe('WechatSettingsPage role gate and route registration', () => {
  it('shows a readable permission result to operators and grid workers without any API call', async () => {
    for (const session of [OPERATOR_SESSION, GRID_SESSION]) {
      const calls = stubApi((url) => {
        throw new Error(`non-admin must not call the management API: ${url}`)
      })

      const { unmount } = renderPage(session)

      expect(await screen.findByText('非管理员没有微信公众号配置权限')).toBeTruthy()
      expect(
        screen.getByText(/服务端同样会以 403 拒绝非管理员的公众号配置请求/),
      ).toBeTruthy()
      expect(screen.queryByTestId('wechat-state-tag')).toBeNull()
      expect(calls).toEqual([])

      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('is registered on the real route tree and does not fall into PlaceholderPage', async () => {
    stubApi((url) => {
      if (url === CONFIG_URL) return json(config())
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderAdmin('/system/wechat')

    expect(await screen.findByTestId('wechat-state-tag')).toBeTruthy()
    expect(screen.queryByText('待建设')).toBeNull()
    expect(screen.queryByText('该模块尚未建设')).toBeNull()
  })
})
