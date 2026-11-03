import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { createDatabase } from '../db/client.js'

const config = loadConfig(process.env)
if (config.nodeEnv !== 'development') {
  throw new Error('db:prepare 仅允许在开发环境运行，生产迁移由 API 启动流程负责。')
}
const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { sqlite } = createDatabase(config.databasePath, migrationsFolder)
try {
  const row = sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count: number }
  if (row.count === 0) throw new Error('迁移完成后数据库没有表')
  console.log('SQLite 已迁移：' + config.databasePath + '（' + row.count + ' 个表）')
} finally {
  sqlite.close()
}
