import {
  TENCENT_MAP_ADMIN_ROUTES,
  apiErrorSchema,
  tencentMapConfigStatusSchema,
  tencentMapPickerConfigSchema,
  type TencentMapConfigStatus,
  type TencentMapPickerConfig,
} from '@sanchuang-dev/local-life-contracts'

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body)
    throw new Error(error.success ? error.data.error.message : `操作失败（HTTP ${response.status}）`)
  }
  return body
}

export async function readTencentMapSettings(signal?: AbortSignal): Promise<TencentMapConfigStatus> {
  return tencentMapConfigStatusSchema.parse(
    await request(TENCENT_MAP_ADMIN_ROUTES.config, { signal }),
  )
}

export async function saveTencentMapKey(key: string, appName: string, csrfToken: string): Promise<TencentMapConfigStatus> {
  return tencentMapConfigStatusSchema.parse(await request(TENCENT_MAP_ADMIN_ROUTES.config, {
    method: 'PUT',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ key, appName }),
  }))
}

export async function setTencentMapEnabled(enabled: boolean, csrfToken: string): Promise<TencentMapConfigStatus> {
  return tencentMapConfigStatusSchema.parse(await request(TENCENT_MAP_ADMIN_ROUTES.enabled, {
    method: 'PATCH',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ enabled }),
  }))
}

export async function readTencentMapPicker(): Promise<TencentMapPickerConfig> {
  return tencentMapPickerConfigSchema.parse(await request(TENCENT_MAP_ADMIN_ROUTES.pickerConfig))
}
