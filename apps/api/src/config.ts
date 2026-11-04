import { z } from 'zod'

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4080),
    DATABASE_PATH: z.string().min(1).default('../../.data/local-life.sqlite'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    COOKIE_DOMAIN: z.string().min(1).optional(),
    WECHAT_APP_ID: z.string().min(1).optional(),
    WECHAT_APP_SECRET: z.string().min(1).optional(),
    WECHAT_REDIRECT_URI: z.string().url().optional(),
    WEB_BASE_URL: z.string().url().optional(),
    TRUSTED_ORIGINS: z.string().default(''),
    AUTH_DEV_ENABLED: z.enum(['true', 'false']).default('false'),
    // CRMEB integration (Issue #63). The three credentials are optional as a
    // group: when they are absent the adapter reports `not_configured` instead
    // of faking a working shop. A partially supplied group is a deployment
    // mistake and must fail startup. CRMEB_H5_BASE_URL is an optional override.
    CRMEB_BASE_URL: z.string().url().optional(),
    CRMEB_OUTAPI_APPID: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{4,30}$/, 'must be 4-30 letters or digits')
      .optional(),
    CRMEB_OUTAPI_APPSECRET: z.string().min(1).optional(),
    CRMEB_H5_BASE_URL: z.string().url().optional(),
    CRMEB_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(10_000),
  })
  .superRefine((value, context) => {
    const crmebCredentials = [
      value.CRMEB_BASE_URL,
      value.CRMEB_OUTAPI_APPID,
      value.CRMEB_OUTAPI_APPSECRET,
    ]
    const suppliedCredentials = crmebCredentials.filter(Boolean).length
    if (suppliedCredentials > 0 && suppliedCredentials < 3) {
      for (const [path, field] of [
        ['CRMEB_BASE_URL', value.CRMEB_BASE_URL],
        ['CRMEB_OUTAPI_APPID', value.CRMEB_OUTAPI_APPID],
        ['CRMEB_OUTAPI_APPSECRET', value.CRMEB_OUTAPI_APPSECRET],
      ] as const) {
        if (!field) {
          context.addIssue({
            code: 'custom',
            path: [path],
            message: `${path} is required when any CRMEB credential is supplied`,
          })
        }
      }
    }
    // An H5 override alone is meaningless: it may only accompany credentials.
    if (value.CRMEB_H5_BASE_URL && suppliedCredentials < 3) {
      context.addIssue({
        code: 'custom',
        path: ['CRMEB_BASE_URL'],
        message: 'CRMEB credentials are required when CRMEB_H5_BASE_URL is supplied',
      })
    }
    for (const [path, raw] of [
      ['CRMEB_BASE_URL', value.CRMEB_BASE_URL],
      ['CRMEB_H5_BASE_URL', value.CRMEB_H5_BASE_URL],
    ] as const) {
      if (!raw) continue
      try {
        const parsed = new URL(raw)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          context.addIssue({ code: 'custom', path: [path], message: 'must use http or https' })
        }
      } catch {
        context.addIssue({ code: 'custom', path: [path], message: 'must be a valid URL' })
      }
    }
    if (Boolean(value.WECHAT_APP_ID) !== Boolean(value.WECHAT_APP_SECRET)) {
      context.addIssue({
        code: 'custom',
        path: ['WECHAT_APP_SECRET'],
        message: 'WECHAT_APP_ID and WECHAT_APP_SECRET must be configured together',
      })
    }
    if (value.WECHAT_APP_ID && !value.WECHAT_REDIRECT_URI) {
      context.addIssue({
        code: 'custom',
        path: ['WECHAT_REDIRECT_URI'],
        message: 'WECHAT_REDIRECT_URI is required when WeChat credentials are configured',
      })
    }
    if (value.NODE_ENV === 'production' && !value.WEB_BASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_BASE_URL'],
        message: 'WEB_BASE_URL is required in production',
      })
    }
    if (value.WECHAT_APP_ID && !value.WEB_BASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_BASE_URL'],
        message: 'WEB_BASE_URL is required when WeChat OAuth is configured',
      })
    }
    if (value.NODE_ENV === 'production' && value.AUTH_DEV_ENABLED === 'true') {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_DEV_ENABLED'],
        message: 'Development authentication must never be enabled in production',
      })
    }
  })

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  databasePath: string
  sessionTtlSeconds: number
  cookieDomain?: string
  cookieSecure: boolean
  wechat?: {
    appId: string
    appSecret: string
    redirectUri: string
  }
  trustedOrigins: string[]
  webBaseUrl: string
  authDevEnabled: boolean
  crmeb?: {
    baseUrl: string
    appId: string
    appSecret: string
    /** H5 entry origin; defaults to the CRMEB site root. */
    h5BaseUrl: string
    timeoutMs: number
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = environmentSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ConfigError(`Invalid API environment: ${details}`)
  }

  const value = parsed.data
  const webBaseUrl = value.WEB_BASE_URL ?? 'http://localhost:5173/local-life/'
  let trustedOrigins: string[]
  try {
    trustedOrigins = value.TRUSTED_ORIGINS
      ? value.TRUSTED_ORIGINS.split(',').map((origin) => new URL(origin.trim()).origin)
      : value.NODE_ENV === 'production'
        ? [new URL(webBaseUrl).origin]
        : [
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:5174',
          'http://127.0.0.1:5174',
        ]
  } catch {
    throw new ConfigError('Invalid API environment: TRUSTED_ORIGINS must be a comma-separated list of valid URLs')
  }

  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databasePath: value.DATABASE_PATH,
    sessionTtlSeconds: value.SESSION_TTL_HOURS * 60 * 60,
    ...(value.COOKIE_DOMAIN ? { cookieDomain: value.COOKIE_DOMAIN } : {}),
    cookieSecure: value.NODE_ENV === 'production',
    ...(value.WECHAT_APP_ID && value.WECHAT_APP_SECRET && value.WECHAT_REDIRECT_URI
      ? {
          wechat: {
            appId: value.WECHAT_APP_ID,
            appSecret: value.WECHAT_APP_SECRET,
            redirectUri: value.WECHAT_REDIRECT_URI,
          },
        }
      : {}),
    trustedOrigins,
    webBaseUrl,
    authDevEnabled: value.AUTH_DEV_ENABLED === 'true',
    ...(value.CRMEB_BASE_URL && value.CRMEB_OUTAPI_APPID && value.CRMEB_OUTAPI_APPSECRET
      ? {
          crmeb: {
            baseUrl: value.CRMEB_BASE_URL.replace(/\/+$/, ''),
            appId: value.CRMEB_OUTAPI_APPID,
            appSecret: value.CRMEB_OUTAPI_APPSECRET,
            h5BaseUrl: (value.CRMEB_H5_BASE_URL ?? value.CRMEB_BASE_URL).replace(/\/+$/, ''),
            timeoutMs: value.CRMEB_TIMEOUT_MS,
          },
        }
      : {}),
  }
}
