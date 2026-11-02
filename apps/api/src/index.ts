import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadConfig, type ApiConfig } from './config.js'
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

  const app = createApp()

  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      logEvent('server.listening', {
        host: config.host,
        port: info.port,
        environment: config.nodeEnv,
      })
    },
  )

  const shutdown = (signal: NodeJS.Signals): void => {
    logEvent('server.shutting_down', { signal })
    const forceExit = setTimeout(() => process.exit(1), 5_000)
    forceExit.unref()
    server.close(() => {
      clearTimeout(forceExit)
      process.exit(0)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

start()
