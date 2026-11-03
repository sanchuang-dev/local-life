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
  })
  .superRefine((value, context) => {
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
  }
}
