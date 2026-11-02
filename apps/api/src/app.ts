import { Hono } from 'hono'
import {
  API_ERROR_CODES,
  API_ROUTES,
  SERVICE_NAME,
  healthResponseSchema,
  type ApiError,
  type ApiErrorCode,
  type HealthResponse,
} from '@sanchuang-dev/local-life-contracts'
import { logEvent } from './log.js'

export interface AppOptions {
  version?: string
  startedAt?: number
  logRequests?: boolean
}

type AppBindings = {
  Variables: {
    requestId: string
  }
}

function errorBody(code: ApiErrorCode, message: string, requestId?: string): ApiError {
  return requestId ? { error: { code, message, requestId } } : { error: { code, message } }
}

/**
 * Builds the HTTP app without binding a port so tests and future embedding can
 * exercise the real middleware, routing and error envelope.
 */
export function createApp(options: AppOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  const startedAt = options.startedAt ?? Date.now()
  const logRequests = options.logRequests ?? true

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    const startedAtMs = performance.now()
    await next()
    if (logRequests) {
      logEvent('request.completed', {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - startedAtMs),
      })
    }
  })

  app.get(API_ROUTES.health, (c) => {
    const payload: HealthResponse = {
      status: 'ok',
      service: SERVICE_NAME,
      version: options.version ?? process.env.npm_package_version ?? '0.0.0',
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      timestamp: new Date().toISOString(),
    }
    // Parse against the shared contract so a response drift fails here, not in a client.
    return c.json(healthResponseSchema.parse(payload))
  })

  app.notFound((c) => {
    const message = `No route for ${c.req.method} ${c.req.path}`
    return c.json(errorBody(API_ERROR_CODES.notFound, message, c.get('requestId')), 404)
  })

  app.onError((error, c) => {
    logEvent('request.failed', {
      requestId: c.get('requestId'),
      path: c.req.path,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return c.json(
      errorBody(API_ERROR_CODES.internal, 'Internal server error', c.get('requestId')),
      500,
    )
  })

  return app
}
