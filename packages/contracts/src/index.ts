import { z } from 'zod'

/** Route identifiers shared by the API and every client that calls it. */
export const API_ROUTES = {
  health: '/healthz',
} as const

export const SERVICE_NAME = 'local-life-api' as const

export const API_ERROR_CODES = {
  notFound: 'not_found',
  internal: 'internal_error',
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

/** `GET /healthz` contract. The API validates its own response with this schema. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal(SERVICE_NAME),
  version: z.string().min(1),
  uptimeSeconds: z.number().int().nonnegative(),
  timestamp: isoTimestamp,
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

/** Structured error envelope. Clients must be able to distinguish real errors from demo states. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
  }),
})

export type ApiError = z.infer<typeof apiErrorSchema>
