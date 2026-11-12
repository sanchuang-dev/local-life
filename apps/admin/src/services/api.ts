import {
  apiErrorSchema,
  healthResponseSchema,
  type HealthResponse,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Calls the real API through the Vite dev proxy. A non-2xx response or an
 * invalid payload throws; callers must render the failure instead of inventing
 * a healthy-looking placeholder.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/healthz', {
    signal,
    headers: { accept: 'application/json' },
  })

  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload)
    throw new Error(
      parsedError.success
        ? `${parsedError.data.error.code}: ${parsedError.data.error.message}`
        : `API 返回 HTTP ${response.status}，且响应体不是约定的错误格式。`,
    )
  }

  return healthResponseSchema.parse(payload)
}

export type { HealthResponse }
