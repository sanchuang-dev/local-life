/** Shared development port contract. All dev:local consumers use this module. */
export const DEFAULT_LOCAL_PORTS = Object.freeze({
  api: 4080,
  web: 5173,
  admin: 5174,
})

function readPort(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`${name} 必须是 1-65535 之间的整数端口。`)
  }
  return number
}

/**
 * Apps pass explicit env keys; the local launcher passes values read from
 * apps/api/.env.local. Conventional defaults belong only here.
 */
export function resolveLocalPorts(values = {}) {
  const ports = {
    api: readPort(values.PORT, 'PORT', DEFAULT_LOCAL_PORTS.api),
    web: readPort(values.WEB_PORT, 'WEB_PORT', DEFAULT_LOCAL_PORTS.web),
    admin: readPort(values.ADMIN_PORT, 'ADMIN_PORT', DEFAULT_LOCAL_PORTS.admin),
  }
  if (new Set(Object.values(ports)).size !== 3) {
    throw new Error('API、H5 和 Admin 必须使用三个不同的端口。')
  }
  return ports
}

export function localPortAssignments(ports) {
  return [
    { port: ports.api, name: 'API' },
    { port: ports.web, name: 'H5' },
    { port: ports.admin, name: 'Admin' },
  ]
}

export function localTrustedOrigins(ports) {
  return [ports.web, ports.admin]
    .flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`])
    .join(',')
}

export function localVitePorts(env = process.env) {
  return resolveLocalPorts({
    PORT: env.LOCAL_LIFE_API_PORT,
    WEB_PORT: env.LOCAL_LIFE_WEB_PORT,
    ADMIN_PORT: env.LOCAL_LIFE_ADMIN_PORT,
  })
}
