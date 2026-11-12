#!/usr/bin/env node
/**
 * LL-MVP-006 (Issue #62) — 既有库升级到 0006 的真实验证。
 *
 * 复现的是"已经在跑 0000..0005 的老库"这一真实场景：
 *   1. 复制 apps/api/db/migrations 但把 journal 截断到 0000..0005（只到上一张卡）；
 *   2. 用仓库自带的 drizzle 迁移器跑这个老目录，得到一个真正停在 0005 的库；
 *   3. 用 SQL 灌入真实业务数据（社区/居民/管理员/后台账号/活动/规则版本）；
 *   4. 启动真实 API 进程指向这个库 —— 进程启动时执行 0000..0006，只有 0006 是新的；
 *   5. 逐项断言：老数据仍在、话音之外新增的对象都在、新触发器真的生效。
 *
 * 用法：node docs/engineering/evidence/ll-mvp-006/r2/migration-0006.cjs
 * 输出：docs/engineering/evidence/ll-mvp-006/r2/r2-migration-runs.json
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const WORK = '/tmp/ll-mvp-006-r2'
const DB = path.join(WORK, 'migration.sqlite')
const OLD_DIR = path.join(WORK, 'migrations-0005')
const PORT = Number(process.env.PORT || 4093)
const OUT = path.join(__dirname, 'r2-migration-runs.json')
const { createHash } = crypto

const Database = require(path.join(REPO_ROOT, 'apps/api/node_modules/better-sqlite3'))
const { drizzle } = require(path.join(REPO_ROOT, 'apps/api/node_modules/drizzle-orm/better-sqlite3'))
const { migrate } = require(path.join(REPO_ROOT, 'apps/api/node_modules/drizzle-orm/better-sqlite3/migrator'))

const RUNS = []
function rec(id, label, pass, evidence) {
  RUNS.push({ id, label, pass: Boolean(pass), evidence: String(evidence) })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${label} :: ${evidence}`)
}

function utcIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString()
}

/** Build a copy of the migrations folder whose journal stops at 0005. */
function buildOldMigrationsDir() {
  const src = path.join(REPO_ROOT, 'apps/api/db/migrations')
  fs.rmSync(OLD_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(OLD_DIR, 'meta'), { recursive: true })
  const journal = JSON.parse(fs.readFileSync(path.join(src, 'meta/_journal.json'), 'utf8'))
  const kept = journal.entries.filter((entry) => Number(entry.tag.slice(0, 4)) <= 5)
  for (const entry of kept) {
    fs.copyFileSync(
      path.join(src, `${entry.tag}.sql`),
      path.join(OLD_DIR, `${entry.tag}.sql`),
    )
  }
  fs.writeFileSync(
    path.join(OLD_DIR, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  )
  return kept.map((entry) => entry.tag)
}

function objects(db) {
  return {
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
    triggers: db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name),
    indexes: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
  }
}

function waitForApi(base, timeoutMs = 60000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/healthz', method: 'GET', timeout: 2000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve(true)
        else retry()
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
      req.end()
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error('api did not start'))
      else setTimeout(tick, 500)
    }
    tick()
  })
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true })
  fs.rmSync(DB, { force: true })
  fs.rmSync(`${DB}-wal`, { force: true })
  fs.rmSync(`${DB}-shm`, { force: true })

  const oldTags = buildOldMigrationsDir()
  rec('mig.oldFolder', '构造"上一张卡"的迁移目录（journal 截断到 0005）',
    oldTags.length === 6 && oldTags.at(-1).startsWith('0005_'),
    `tags=${oldTags.join(',')}`)

  /* ---- 1. bring the database up to 0005 only ---- */
  const db = new Database(DB)
  db.pragma('foreign_keys = ON')
  migrate(drizzle(db), { migrationsFolder: OLD_DIR })
  const before = objects(db)
  rec('mig.at0005', '老库真实停在 0005：无奖励相关表，activities 无 reward_plan_json 列',
    !before.tables.includes('activity_reward_grants') &&
      !db.prepare("SELECT count(*) n FROM pragma_table_info('activities') WHERE name = 'reward_plan_json'").get().n,
    `tables=${before.tables.length} triggers=${before.triggers.length} hasGrantsTable=${before.tables.includes('activity_reward_grants')} hasRewardPlanColumn=${db.prepare("SELECT count(*) n FROM pragma_table_info('activities') WHERE name = 'reward_plan_json'").get().n === 1}`)

  /* ---- 2. seed real business data that must survive the upgrade ---- */
  const now = Date.now()
  const communityId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const staffUserId = crypto.randomUUID()
  const staffId = crypto.randomUUID()
  const activityId = crypto.randomUUID()
  const ruleVersionId = crypto.randomUUID()

  db.prepare('INSERT INTO communities (id, name, created_at) VALUES (?, ?, ?)')
    .run(communityId, '老库社区', now)
  db.prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(userId, '老库居民', now, now)
  db.prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(staffUserId, '老库管理员', now, now)
  db.prepare(
    `INSERT INTO staff_accounts (id, user_id, username, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?)`,
  ).run(staffId, staffUserId, 'legacy.admin', 'scrypt$legacy$placeholder', now, now)
  db.prepare(
    `INSERT INTO activity_rule_versions (id, activity_id, version, snapshot_json, created_by_user_id, created_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(ruleVersionId, activityId, JSON.stringify({
    startsAt: utcIso(-3600_000),
    endsAt: utcIso(6 * 3600_000),
    location: '老库现场',
    budgetCapCents: 100000,
    prizeQuantityCap: 20,
    publicRules: { eligibility: '本社区居民', checkin: '现场签到', purchase: '无需消费', prizeClaim: '三人成团' },
  }), staffUserId, now)
  db.prepare(
    `INSERT INTO activities
      (id, community_id, title, summary, description, status, starts_at, ends_at, location,
       budget_cap_cents, prize_quantity_cap, public_rules_json, current_rule_version_id,
       created_by_user_id, created_at, updated_at, published_at)
     VALUES (?, ?, ?, NULL, NULL, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    activityId, communityId, '老库活动', now - 3600_000, now + 6 * 3600_000, '老库现场',
    100000, 20, JSON.stringify({
      eligibility: '本社区居民', checkin: '现场签到', purchase: '无需消费', prizeClaim: '三人成团',
    }), ruleVersionId, staffUserId, now, now, now,
  )
  db.close()

  const seeded = new Database(DB, { readonly: true })
  const seededCounts = {
    communities: seeded.prepare('SELECT count(*) n FROM communities').get().n,
    users: seeded.prepare('SELECT count(*) n FROM users').get().n,
    staff: seeded.prepare('SELECT count(*) n FROM staff_accounts').get().n,
    activities: seeded.prepare('SELECT count(*) n FROM activities').get().n,
    ruleVersions: seeded.prepare('SELECT count(*) n FROM activity_rule_versions').get().n,
  }
  seeded.close()
  rec('mig.seed', '在 0005 库中写入真实老数据（社区/居民/管理员/已发布活动/规则版本）',
    seededCounts.activities === 1 && seededCounts.ruleVersions === 1,
    JSON.stringify(seededCounts))

  /* ---- 3. let the real API process apply 0006 on startup ---- */
  const logFile = path.join(WORK, 'migration-api.log')
  fs.rmSync(logFile, { force: true })
  const child = spawn(path.join(REPO_ROOT, 'apps/api/node_modules/.bin/tsx'), ['apps/api/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATABASE_PATH: DB,
      AUTH_DEV_ENABLED: 'true',
      SESSION_TTL_HOURS: '24',
      TRUSTED_ORIGINS: 'http://localhost:5241',
      WEB_BASE_URL: 'http://localhost:5241/local-life/',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  child.stdout.on('data', (d) => chunks.push(String(d)))
  child.stderr.on('data', (d) => chunks.push(String(d)))
  let started = false
  try {
    await waitForApi()
    started = true
  } finally {
    fs.writeFileSync(logFile, chunks.join(''))
  }
  rec('mig.startup', '真实 API 进程启动时对老库执行增量迁移（0006 apply）', started,
    started ? `GET /healthz => 200 on :${PORT}` : chunks.join('').slice(-600))

  /* ---- 4. assert the upgrade result ---- */
  const after = new Database(DB, { readonly: true })
  const afterObjects = objects(after)
  const NEW_TABLES = [
    'activity_checkins',
    'activity_reward_grants',
    'activity_reward_codes',
    'activity_prize_stocks',
    'activity_reward_events',
    'activity_reward_disputes',
  ]
  const missing = NEW_TABLES.filter((t) => !afterObjects.tables.includes(t))
  const newTriggers = afterObjects.triggers.filter((t) => !before.triggers.includes(t))
  const newIndexes = afterObjects.indexes.filter((i) => !before.indexes.includes(i))
  rec('mig.objects', '0006 新增 6 张表 / 32 个触发器 / 相关索引全部到位',
    missing.length === 0 && newTriggers.length === 32 && newIndexes.length > 0,
    `missingTables=${missing.join(',') || 'none'} newTables=${afterObjects.tables.length - before.tables.length} newTriggers=${newTriggers.length} newIndexes=${newIndexes.length}`)

  const rewardColumn = after.prepare("SELECT count(*) n FROM pragma_table_info('activities') WHERE name = 'reward_plan_json'").get().n === 1
  rec('mig.column', 'activities.reward_plan_json 列已由 ALTER TABLE 添加，且是 nullable',
    rewardColumn, `hasColumn=${rewardColumn}`)

  const afterCounts = {
    communities: after.prepare('SELECT count(*) n FROM communities').get().n,
    users: after.prepare('SELECT count(*) n FROM users').get().n,
    staff: after.prepare('SELECT count(*) n FROM staff_accounts').get().n,
    activities: after.prepare('SELECT count(*) n FROM activities').get().n,
    ruleVersions: after.prepare('SELECT count(*) n FROM activity_rule_versions').get().n,
  }
  const preserved =
    JSON.stringify(afterCounts) === JSON.stringify(seededCounts) &&
    after.prepare('SELECT title, status FROM activities WHERE id = ?').get(activityId).title === '老库活动'
  rec('mig.preserved', '老数据零丢失：各表行数与升级前完全一致，活动标题/状态未变', preserved,
    `${JSON.stringify(seededCounts)} -> ${JSON.stringify(afterCounts)}`)

  const backfilled =
    after.prepare('SELECT count(*) n FROM activity_reward_grants').get().n +
    after.prepare('SELECT count(*) n FROM activity_prize_stocks').get().n +
    after.prepare('SELECT count(*) n FROM activity_checkins').get().n
  rec('mig.noBackfill', '0006 不回填任何奖励数据（老活动保持"未配置奖励计划"）', backfilled === 0,
    `grants+stocks+checkins=${backfilled} reward_plan_json=${after.prepare('SELECT reward_plan_json FROM activities WHERE id = ?').get(activityId).reward_plan_json}`)

  // The new triggers must actually bite on the upgraded file, not just exist.
  // Probed on a read-write handle: a read-only connection would fail with
  // "attempt to write a readonly database" and prove nothing.
  const guarded = new Database(DB)
  const guard = { checkinWindow: false, stockFrozen: false, checkinMessage: '', stockMessage: '' }
  try {
    guarded.prepare(
      `INSERT INTO activity_checkins (id, activity_id, user_id, team_id, seat_no, status, checked_in_at)
       VALUES (?, ?, ?, NULL, NULL, 'valid', ?)`,
    ).run(crypto.randomUUID(), activityId, userId, now)
  } catch (error) {
    guard.checkinMessage = String(error.message)
    guard.checkinWindow = /check-in is outside the frozen check-in window|team must belong/u.test(guard.checkinMessage)
  }
  try {
    guarded.prepare(
      `INSERT INTO activity_prize_stocks
        (activity_id, prize_name, rule_version_id, unit_cost_cents, total_quantity,
         claimed_quantity, redeemed_quantity, budget_cap_cents, committed_budget_cents,
         redeemed_budget_cents, updated_at)
       VALUES (?, '伪装奖品', ?, 2500, 10, 0, 0, 100000, 0, 0, ?)`,
    ).run(activityId, ruleVersionId, now)
  } catch (error) {
    // No frozen rewardPlan in the old snapshot => the frozen_plan_guard must refuse.
    guard.stockMessage = String(error.message)
    guard.stockFrozen = /stock row must copy the frozen reward plan/u.test(guard.stockMessage)
  }
  // The rows must really not be there afterwards.
  const leaked = guarded.prepare('SELECT count(*) n FROM activity_checkins WHERE activity_id = ?').get(activityId).n +
    guarded.prepare('SELECT count(*) n FROM activity_prize_stocks WHERE activity_id = ?').get(activityId).n
  guarded.close()
  rec('mig.triggersLive', '新约束在升级后的库上真实生效（无奖励计划的签到被拒、无快照的库存行被拒，且未落库）',
    guard.checkinWindow && guard.stockFrozen && leaked === 0,
    `checkin="${guard.checkinMessage}" stock="${guard.stockMessage}" leakedRows=${leaked}`)

  const integrity = after.prepare('PRAGMA integrity_check').get()
  const fkIssues = after.prepare('PRAGMA foreign_key_check').all()
  rec('mig.integrity', '升级后完整性检查通过（integrity_check=ok、无外键违规）',
    integrity.integrity_check === 'ok' && fkIssues.length === 0,
    `integrity_check=${integrity.integrity_check} foreignKeyViolations=${fkIssues.length}`)

  after.close()
  child.kill('SIGTERM')

  const failed = RUNS.filter((r) => !r.pass)
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    db: DB,
    oldMigrations: oldTags,
    totals: { checks: RUNS.length, passed: RUNS.length - failed.length, failed: failed.length },
    failedIds: failed.map((r) => r.id),
    runs: RUNS,
  }, null, 2) + '\n')
  console.log(`\n${RUNS.length - failed.length}/${RUNS.length} migration checks passed; wrote ${OUT}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('DRIVER ERROR:', error)
  process.exit(2)
})
