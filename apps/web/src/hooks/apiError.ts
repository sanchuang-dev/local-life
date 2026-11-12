import { apiErrorSchema } from '@sanchuang-dev/local-life-contracts'

/**
 * Real API failure surfaced to a workbench page. The shared error envelope is
 * the only source of the message; a non-JSON response keeps the HTTP status so
 * the UI never invents a success or a friendlier fake reason.
 */
export class CrmApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly requestId: string | null

  constructor(message: string, status: number, code: string | null, requestId: string | null) {
    super(message)
    this.name = 'CrmApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

/** Read the shared `{ error: { code, message, requestId? } }` envelope. */
export async function apiErrorFromResponse(
  response: Response,
  fallback: string,
): Promise<CrmApiError> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(payload)
  if (parsed.success) {
    return new CrmApiError(
      parsed.data.error.message,
      response.status,
      parsed.data.error.code,
      parsed.data.error.requestId ?? null,
    )
  }
  return new CrmApiError(`${fallback}（HTTP ${response.status}）`, response.status, null, null)
}
