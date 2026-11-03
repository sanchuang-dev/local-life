import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig, type ApiConfig } from './config.js'
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
        wechatOAuthConfigured: Boolean(config.wechat),
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
