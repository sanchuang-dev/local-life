import { z } from 'zod'

/** Route identifiers shared by the API and every client that calls it. */
export const API_ROUTES = {
  health: '/healthz',
  authMethods: '/auth/methods',
  authCsrf: '/auth/csrf',
  authSession: '/auth/session',
  authLogin: '/auth/login',
  authLogout: '/auth/logout',
  authWechatStart: '/auth/wechat/start',
} as const

export const SERVICE_NAME = 'local-life-api' as const

export const API_ERROR_CODES = {
  notFound: 'not_found',
  internal: 'internal_error',
  invalidRequest: 'invalid_request',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  conflict: 'conflict',
  rateLimited: 'rate_limited',
  notConfigured: 'not_configured',
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

export const staffRoleSchema = z.enum(['admin', 'operator', 'grid_worker'])
export type StaffRole = z.infer<typeof staffRoleSchema>

export const staffLoginRequestSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1).max(128),
})

export const createCommunityRequestSchema = z.object({
  name: z.string().trim().min(2).max(60),
})

export const createStaffAccountRequestSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/),
  displayName: z.string().trim().min(1).max(40),
  password: z.string().min(12).max(128),
  role: z.enum(['operator', 'grid_worker']),
  userId: z.preprocess(
    (value) => (value === '' || value == null ? undefined : value),
    z.string().uuid().optional(),
  ),
  communityIds: z.array(z.string().uuid()).min(1).max(20),
})

export const authUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().nullable(),
})

export const authCommunitySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
})

export const authStaffSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  role: staffRoleSchema,
  communities: z.array(authCommunitySchema),
})

export const authSessionResponseSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    user: authUserSchema,
    staff: authStaffSchema.nullable(),
    csrfToken: z.string().min(20),
  }),
])

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>
