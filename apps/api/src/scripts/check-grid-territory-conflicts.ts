import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Preflight for migration 0030_grid_territory.
 *
 * The migration never chooses a winner: if a grid worker owns more than one
 * community, or a community has more than one grid worker, it aborts. This read
 * only command lists those rows so an administrator can decide which historical
 * relation to remove or split into a new logical territory before retrying.
 */
const databasePath = resolve(
  process.env.DATABASE_PATH ??
    fileURLToPath(new URL('../../../../.data/local-life-dev.sqlite', import.meta.url)),
)

if (!existsSync(databasePath)) {
  console.error(`数据库不存在：${databasePath}`)
  process.exit(2)
}

const db = new Database(databasePath, { readonly: true })

try {
  const staffConflicts = db.prepare(`
    SELECT sca.staff_account_id AS staffAccountId,
           sa.username,
           COUNT(*) AS territoryCount,
           GROUP_CONCAT(c.name, '、') AS communities
    FROM staff_community_assignments sca
    JOIN staff_accounts sa ON sa.id = sca.staff_account_id
    JOIN communities c ON c.id = sca.community_id
    WHERE sa.role = 'grid_worker'
    GROUP BY sca.staff_account_id
    HAVING COUNT(*) > 1
    ORDER BY sa.username
  `).all() as Array<{
    staffAccountId: string
    username: string
    territoryCount: number
    communities: string
  }>

  const territoryConflicts = db.prepare(`
    SELECT sca.community_id AS communityId,
           c.name,
           COUNT(*) AS gridWorkerCount,
           GROUP_CONCAT(sa.username, '、') AS usernames
    FROM staff_community_assignments sca
    JOIN staff_accounts sa ON sa.id = sca.staff_account_id
    JOIN communities c ON c.id = sca.community_id
    WHERE sa.role = 'grid_worker'
    GROUP BY sca.community_id
    HAVING COUNT(*) > 1
    ORDER BY c.name
  `).all() as Array<{
    communityId: string
    name: string
    gridWorkerCount: number
    usernames: string
  }>

  if (staffConflicts.length === 0 && territoryConflicts.length === 0) {
    console.log(`GRID_TERRITORY_PREFLIGHT=PASS (${databasePath})`)
    process.exit(0)
  }

  console.error(`GRID_TERRITORY_PREFLIGHT=CONFLICT (${databasePath})`)
  if (staffConflicts.length > 0) {
    console.error('\n一名网格员关联多个片区：')
    for (const row of staffConflicts) {
      console.error(
        `- ${row.username} (${row.staffAccountId}): ${row.territoryCount} 个片区 · ${row.communities}`,
      )
    }
  }
  if (territoryConflicts.length > 0) {
    console.error('\n一个片区关联多名网格员：')
    for (const row of territoryConflicts) {
      console.error(
        `- ${row.name} (${row.communityId}): ${row.gridWorkerCount} 名网格员 · ${row.usernames}`,
      )
    }
  }
  console.error(
    '\n处理后再迁移：为每名网格员保留一个经营片区；其余片区应解除该网格员，' +
      '或按业务需要拆分为新的逻辑片区。不要直接删除历史社区、居民或订单。',
  )
  process.exit(1)
} finally {
  db.close()
}
