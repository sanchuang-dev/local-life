import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOCAL_PORTS, localPortAssignments, localTrustedOrigins, resolveLocalPorts } from './local-ports.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const localDatabase = '../../.data/local-life-dev.sqlite'
// Created once, never overwritten; unlike apps/api/.env this is local-only.
export const localEnvTemplate = [
  '# Used only by pnpm dev:local / pnpm admin:local; not for production.',
  '# Gitignored. Do not put production credentials here.',
  'NODE_ENV=development',
  'HOST=127.0.0.1',
  'PORT=' + DEFAULT_LOCAL_PORTS.api,
  'WEB_PORT=' + DEFAULT_LOCAL_PORTS.web,
  'ADMIN_PORT=' + DEFAULT_LOCAL_PORTS.admin,
  'DATABASE_PATH=' + localDatabase,
  'SESSION_TTL_HOURS=168',
  'AUTH_DEV_ENABLED=true',
  '',
].join('\n')

const apiEnvironmentKeys = [
  'NODE_ENV', 'HOST', 'PORT', 'WEB_PORT', 'ADMIN_PORT', 'DATABASE_PATH', 'SESSION_TTL_HOURS',
  'LOCAL_LIFE_API_PORT', 'LOCAL_LIFE_WEB_PORT', 'LOCAL_LIFE_ADMIN_PORT',
  'COOKIE_DOMAIN', 'WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'WECHAT_REDIRECT_URI',
  'WEB_BASE_URL', 'TRUSTED_ORIGINS', 'AUTH_DEV_ENABLED',
]

export function assertLocalConfig(source) {
  const values = Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=')
        return [
          line.slice(0, separator),
          line.slice(separator + 1).trim().replace(/^["']|["']$/g, ''),
        ]
      }),
  )
  for (const [name, expected] of [
    ['NODE_ENV', 'development'],
    ['HOST', '127.0.0.1'],
    ['DATABASE_PATH', localDatabase],
  ]) {
    if (values[name] !== expected) {
      throw new Error('本地配置 ' + name + ' 必须为 ' + expected + '；不要将本地启动指向线上数据。')
    }
  }
  if (!['true', 'false'].includes(values.AUTH_DEV_ENABLED)) {
    throw new Error('本地配置 AUTH_DEV_ENABLED 必须为 true 或 false。')
  }
  for (const key of ['PORT', 'WEB_PORT', 'ADMIN_PORT']) {
    if (values[key] === undefined || values[key] === '') {
      throw new Error('本地配置必须显式指定 ' + key + '；端口只允许在 apps/api/.env.local 修改。')
    }
  }
  return resolveLocalPorts(values)
}

export function prepareLocalFiles(root = projectRoot) {
  const dataDirectory = join(root, '.data')
  const envPath = join(root, 'apps', 'api', '.env.local')
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(envPath), { recursive: true })

  if (!existsSync(envPath)) {
    let fd
    try {
      fd = openSync(envPath, 'wx', 0o600)
      writeFileSync(fd, localEnvTemplate)
      console.log('已创建独立本地配置 apps/api/.env.local')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  const ports = assertLocalConfig(readFileSync(envPath, 'utf8'))
  return { envPath, dataDirectory, dbPath: join(dataDirectory, 'local-life-dev.sqlite'), ports }
}

export function isolatedLocalEnvironment(parentEnv, envPath, ports = DEFAULT_LOCAL_PORTS) {
  const next = { ...parentEnv }
  // dotenv does not overwrite process.env: discard exported production credentials.
  for (const key of apiEnvironmentKeys) delete next[key]
  next.DOTENV_CONFIG_PATH = envPath
  delete next.DOTENV_CONFIG_OVERRIDE
  // Managed values override deprecated copies in existing .env.local.
  next.PORT = String(ports.api)
  next.LOCAL_LIFE_API_PORT = String(ports.api)
  next.LOCAL_LIFE_WEB_PORT = String(ports.web)
  next.LOCAL_LIFE_ADMIN_PORT = String(ports.admin)
  next.TRUSTED_ORIGINS = localTrustedOrigins(ports)
  next.WEB_BASE_URL = 'http://localhost:' + ports.web + '/local-life/'
  return next
}

function runChecked(args, env) {
  const result = spawnSync(packageManager, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error('pnpm ' + args.join(' ') + ' 执行失败（exit ' + (result.status ?? 'signal') + '）。')
  }
}

function isPortBusy(port, host) {
  return new Promise((done) => {
    const socket = connect({ port, host })
    socket.once('connect', () => { socket.destroy(); done(true) })
    socket.once('error', () => { socket.destroy(); done(false) })
    socket.setTimeout(500, () => { socket.destroy(); done(false) })
  })
}

async function assertPortsFree(ports) {
  for (const { port, name } of localPortAssignments(ports)) {
    const busy = await Promise.all(
      ['127.0.0.1', '::1'].map((host) => isPortBusy(port, host)),
    )
    if (busy.some(Boolean)) {
      throw new Error(name + ' 端口 ' + port + ' 已被占用。请先停止已有服务，避免 Vite 静默使用其他端口。')
    }
  }
}

function runDev(env, ports) {
  console.log('\n本地生活启动中（Ctrl+C 可结束）：')
  console.log('  居民 H5：http://localhost:' + ports.web + '/local-life/')
  console.log('  管理台：http://localhost:' + ports.admin + '/')
  console.log('  API：   http://127.0.0.1:' + ports.api + '/healthz\n')

  const child = spawn(packageManager, ['dev'], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })
  let shuttingDown = false
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      if (process.platform !== 'win32' && child.pid) {
        // pnpm starts additional Vite/tsx processes. Stop their whole process group.
        try {
          process.kill(-child.pid, signal)
        } catch {
          child.kill(signal)
        }
      } else {
        child.kill(signal)
      }
    })
  }
  child.once('error', (error) => {
    console.error('本地开发服务启动失败：' + error.message)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
  })
}

async function main() {
  const action = process.argv[2] ?? 'start'
  if (!['start', 'setup', 'admin'].includes(action)) {
    throw new Error('请使用 pnpm dev:local、pnpm db:local:setup 或 pnpm admin:local。')
  }
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error('本项目需要 Node.js 22 或以上。')
  }

  const { envPath, dbPath, ports } = prepareLocalFiles()
  const localEnv = isolatedLocalEnvironment(process.env, envPath, ports)

  if (action === 'start') await assertPortsFree(ports)
  console.log('本地数据库：' + dbPath + '（重复启动不会清空）')
  if (action !== 'admin') runChecked(['install', '--frozen-lockfile'], localEnv)
  runChecked(['--filter', '@sanchuang-dev/local-life-api', 'db:prepare'], localEnv)

  if (action === 'admin') {
    console.log('安全初始化首个管理员（密码交互输入，不会写入源码或日志）：')
    runChecked(['--filter', '@sanchuang-dev/local-life-api', 'bootstrap-admin'], localEnv)
  } else if (action === 'start') {
    runDev(localEnv, ports)
  } else {
    console.log('本地数据库已就绪。')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('本地生活启动失败：' + error.message)
    process.exitCode = 1
  })
}
