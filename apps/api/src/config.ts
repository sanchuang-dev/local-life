import { readFileSync } from 'node:fs'
import { z } from 'zod'

/** AES-256 requires exactly 32 key bytes; anything else is a config error. */
const WECHAT_CONFIG_MASTER_KEY_BYTES = 32
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const WECHAT_CONFIG_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4080),
    DATABASE_PATH: z.string().min(1).default('../../.data/local-life.sqlite'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    COOKIE_DOMAIN: z.string().min(1).optional(),
    // WeChat admin config (#113 LL-SYS-001). The master key encrypts the
    // versioned credentials stored in SQLite; it is never stored in the
    // database, a response, a log or the front-end bundle.
    //
    // Exactly one source may be configured:
    // - WECHAT_CONFIG_MASTER_KEY_FILE: recommended for deployments (mounted file
    //   containing the base64 of 32 random bytes);
    // - WECHAT_CONFIG_MASTER_KEY: the same base64 value inline (local/dev or
    //   secret-manager injection only).
    // Supplying both is a deployment mistake and fails startup. Supplying
    // neither is allowed: admin config then fails closed instead of pretending
    // the feature works.
    WECHAT_CONFIG_MASTER_KEY: z.string().optional(),
    WECHAT_CONFIG_MASTER_KEY_FILE: z.string().optional(),
    /** Master-key generation label; rotates with the key, defaults to `v1`. */
    WECHAT_CONFIG_KEY_ID: z
      .string()
      .trim()
      .regex(WECHAT_CONFIG_KEY_ID_PATTERN, 'must be 1-32 letters, digits, "." "_" or "-"')
      .optional(),
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
    if (value.NODE_ENV === 'production' && !value.WEB_BASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_BASE_URL'],
        message: 'WEB_BASE_URL is required in production',
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

/**
 * Decryption material for the persisted WeChat public-account credentials.
 *
 * `key` is the raw 32-byte AES-256 key. The loader is the only place that knows
 * whether it came from a file or inline env; the rest of the app only receives
 * this object so no module ever re-reads or re-validates the variable. The key
 * must never be serialized, logged or written to SQLite — only ciphertext and
 * `keyId` are persisted.
 */
export interface WechatConfigMasterKey {
  key: Buffer
  /**
   * Generation label stored next to every ciphertext. A row encrypted under a
   * different id fails closed instead of being decrypted with the wrong key.
   */
  keyId: string
}

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  databasePath: string
  sessionTtlSeconds: number
  cookieDomain?: string
  cookieSecure: boolean
  /**
   * Master key for the persisted WeChat admin configs (#113). It is the only
   * WeChat-related startup input: the resident OAuth provider is resolved from
   * the database on every request, never from an env snapshot. Absent means the
   * feature fails closed (no save/verify/activate and no provider decryption).
   */
  wechatConfigMasterKey?: WechatConfigMasterKey
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

/**
 * Env variables that configured the WeChat provider before #113. They are no
 * longer read: the provider comes from the active `wechat_oauth_configs` row.
 * Kept as a named list so startup can warn once — with the variable NAMES only,
 * never their values — and so operators can find the migration note.
 */
export const LEGACY_WECHAT_ENV_VARS = [
  'WECHAT_APP_ID',
  'WECHAT_APP_SECRET',
  'WECHAT_REDIRECT_URI',
] as const

/** Names (never values) of the deprecated WeChat variables still present. */
export function legacyWechatEnvVars(env: NodeJS.ProcessEnv): string[] {
  return LEGACY_WECHAT_ENV_VARS.filter((name) => Boolean(env[name]?.trim()))
}

type ParsedEnvironment = z.infer<typeof environmentSchema>

/**
 * Decode one base64 master-key value, or fail with a message that names the
 * variable but never echoes (even a fragment of) the key material.
 */
function decodeWechatConfigMasterKey(raw: string, variable: string): Buffer {
  const normalized = raw.trim()
  if (!normalized) {
    throw new ConfigError(
      `${variable} is empty; remove it or provide the base64 of ${WECHAT_CONFIG_MASTER_KEY_BYTES} key bytes`,
    )
  }
  if (!BASE64_PATTERN.test(normalized)) {
    throw new ConfigError(`${variable} must be base64-encoded AES-256 key material`)
  }
  // Accept canonical padded base64 as well as an unpadded value.
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  if (padded.length % 4 !== 0) {
    throw new ConfigError(`${variable} is not a valid base64 value`)
  }
  const key = Buffer.from(padded, 'base64')
  const canonical =
    key.toString('base64').replace(/=+$/u, '') === normalized.replace(/=+$/u, '')
  if (key.length !== WECHAT_CONFIG_MASTER_KEY_BYTES || !canonical) {
    throw new ConfigError(
      `${variable} must decode to exactly ${WECHAT_CONFIG_MASTER_KEY_BYTES} bytes of AES-256 key material`,
    )
  }
  return key
}

/**
 * Load the WeChat admin config master key from at most one source.
 *
 * - both `WECHAT_CONFIG_MASTER_KEY_FILE` and `WECHAT_CONFIG_MASTER_KEY` set is a
 *   deployment error: two silently different keys would make half the rows
 *   undecryptable;
 * - an unreadable file, malformed base64 or the wrong key length is a startup
 *   failure, never a silent fallback;
 * - neither set is allowed and yields `undefined`: the admin feature fails
 *   closed while the rest of the API still starts.
 *
 * Errors deliberately contain only the variable name and the expected shape —
 * never the key value, its prefix/suffix or the raw file contents.
 */
function loadWechatConfigMasterKey(
  value: ParsedEnvironment,
): WechatConfigMasterKey | undefined {
  const inline = value.WECHAT_CONFIG_MASTER_KEY?.trim() || undefined
  const fileName = value.WECHAT_CONFIG_MASTER_KEY_FILE?.trim() || undefined

  if (inline && fileName) {
    throw new ConfigError(
      'WECHAT_CONFIG_MASTER_KEY and WECHAT_CONFIG_MASTER_KEY_FILE are mutually exclusive; configure exactly one',
    )
  }
  if (!inline && !fileName) return undefined

  const keyId = value.WECHAT_CONFIG_KEY_ID ?? 'v1'

  if (fileName) {
    let contents: string
    try {
      contents = readFileSync(fileName, 'utf8')
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String((error as NodeJS.ErrnoException).code)
          : 'unknown'
      throw new ConfigError(`WECHAT_CONFIG_MASTER_KEY_FILE could not be read (${code})`)
    }
    return {
      key: decodeWechatConfigMasterKey(contents, 'WECHAT_CONFIG_MASTER_KEY_FILE contents'),
      keyId,
    }
  }

  if (!inline) {
    // Unreachable: the earlier two guards already returned. Kept as a typed
    // failure instead of a non-null assertion so a future refactor cannot turn
    // an accidental `undefined` key into a runtime crash.
    throw new ConfigError('WECHAT_CONFIG_MASTER_KEY is empty')
  }
  return {
    key: decodeWechatConfigMasterKey(inline, 'WECHAT_CONFIG_MASTER_KEY'),
    keyId,
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
  // Resolved before the rest of the object so a bad master key fails startup
  // with a specific ConfigError instead of surfacing later as a decrypt error.
  const wechatConfigMasterKey = loadWechatConfigMasterKey(value)
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
    ...(wechatConfigMasterKey ? { wechatConfigMasterKey } : {}),
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
