import {
  API_ROUTES,
  apiErrorSchema,
  authSessionResponseSchema,
  type AuthSessionResponse,
} from '@sanchuang-dev/local-life-contracts'

type BaseAuthenticatedSession = Extract<AuthSessionResponse, { authenticated: true }>
export type AuthenticatedSession = BaseAuthenticatedSession & {
  staff: NonNullable<BaseAuthenticatedSession['staff']>
}

async function responseError(response: Response): Promise<Error> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(payload)
  return new Error(
    parsed.success
      ? `${parsed.data.error.code}: ${parsed.data.error.message}`
      : `请求失败（HTTP ${response.status}）`,
  )
}

export async function fetchSession(): Promise<AuthSessionResponse> {
  const response = await fetch(`/api${API_ROUTES.authSession}`, { credentials: 'include' })
  if (!response.ok) throw await responseError(response)
  return authSessionResponseSchema.parse(await response.json())
}

export async function loginStaff(username: string, password: string): Promise<AuthenticatedSession> {
  const csrfResponse = await fetch(`/api${API_ROUTES.authCsrf}`, { credentials: 'include' })
  if (!csrfResponse.ok) throw await responseError(csrfResponse)
  const csrf = (await csrfResponse.json()) as { csrfToken: string }

  const response = await fetch(`/api${API_ROUTES.authLogin}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf.csrfToken,
    },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) throw await responseError(response)
  const parsed = authSessionResponseSchema.parse(await response.json())
  if (!parsed.authenticated || !parsed.staff) throw new Error('该账户没有后台访问权限')
  return { ...parsed, staff: parsed.staff }
}

export async function logoutStaff(csrfToken: string): Promise<void> {
  const response = await fetch(`/api${API_ROUTES.authLogout}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-csrf-token': csrfToken },
  })
  if (!response.ok) throw await responseError(response)
}
