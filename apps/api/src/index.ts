import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { legacyWechatEnvVars, loadConfig, type ApiConfig } from './config.js'
import { createDatabase } from './db/client.js'
import { logEvent } from './log.js'

function start(): void {
  let config: ApiConfig
  try {
    config = loadConfig(process.env)
  } catch (error) {
    logEvent('config.invalid', {
      message: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
    return
  }

  // The resident WeChat provider now comes from the database (#113). Warn once
  // about leftover pre-#113 variables, naming them only: their values are never
  // read, logged or rejected, so a deployment can migrate without downtime.
  const legacyWechatVariables = legacyWechatEnvVars(process.env)
  if (legacyWechatVariables.length > 0) {
    logEvent('config.wechat_env_ignored', {
      variables: legacyWechatVariables,
      hint: 'remove them and configure/enable the account under 系统管理 → 微信公众号',
    })
  }

  const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
  let database: ReturnType<typeof createDatabase>
  try {
    database = createDatabase(config.databasePath, migrationsFolder)
  } catch (error) {
    logEvent('database.startup_failed', {
      errorType: error instanceof Error ? error.name : 'unknown',
    })
    process.exitCode = 1
    return
  }

  const app = createApp({ config, db: database.db })
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      logEvent('server.listening', {
        host: config.host,
        port: info.port,
        environment: config.nodeEnv,
        wechatConfigMasterKeyConfigured: Boolean(config.wechatConfigMasterKey),
        developmentResidentLoginEnabled: config.authDevEnabled,
      })
    },
  )

  const shutdown = (signal: NodeJS.Signals): void => {
    logEvent('server.shutting_down', { signal })
    const forceExit = setTimeout(() => process.exit(1), 5_000)
    forceExit.unref()
    server.close(() => {
      clearTimeout(forceExit)
      database.sqlite.close()
      process.exit(0)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

start()
