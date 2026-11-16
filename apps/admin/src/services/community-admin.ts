/** Shared client contract for existing admin community and staff endpoints. */
export interface ManagedCommunity {
  id: string
  name: string
  address?: string | null
  latitudeGcj02?: number | null
  longitudeGcj02?: number | null
}

export interface ManagedStaff {
  id: string
  username: string
  displayName: string | null
  role: 'admin' | 'operator' | 'grid_worker'
  status: 'active' | 'disabled'
  communities: ManagedCommunity[]
}

export const STAFF_ROLE_LABELS = {
  admin: '管理员',
  operator: '运营员',
  grid_worker: '网格员',
} as const

export async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const text = payload && typeof payload === 'object' && 'error' in payload &&
      payload.error && typeof payload.error === 'object' && 'message' in payload.error
      ? String(payload.error.message)
      : `请求失败（HTTP ${response.status}）`
    throw new Error(text)
  }
  return payload as T
}

export function listManagedCommunities() {
  return adminRequest<{ items: ManagedCommunity[] }>('/api/admin/communities')
}

export function listManagedStaff() {
  return adminRequest<{ items: ManagedStaff[] }>('/api/admin/staff')
}
