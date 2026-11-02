import { z } from 'zod'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4080),
})

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Validates process environment at startup. An invalid value must stop the
 * server instead of silently falling back, otherwise a broken deployment looks
 * healthy while serving the wrong port or host.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = environmentSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ConfigError(`Invalid API environment: ${details}`)
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
  }
}
