#!/usr/bin/env node
/**
 * LL-IDENTITY-001 (#171) — read-only preflight for resident community binding.
 *
 * The product decision is "one resident account, one resident-confirmed
 * permanent community". Existing `resident_community_assignments` rows were
 * written by the pre-#171 login flow and therefore are NOT evidence that a
 * person ever confirmed anything. Before such a database is migrated, the
 * maintainer needs to know how many accounts would land in each bucket and
 * whether existing business facts (orders, participations, rewards, ledger,
 * CRM) hang off an account whose community would become ambiguous.
 *
 * Hard rules this tool follows:
 *  - it opens the SQLite file with `readOnly: true`; every statement is a
 *    SELECT, and SQLite itself refuses a write on this handle;
 *  - it never needs the API, Drizzle, a master key or WeChat credentials;
 *  - by default it prints aggregate counts only (no user UUID, no phone, no
 *    openid); `--user-ids` is an explicit opt-in for an operator working on
 *    their own machine;
 *  - it refuses to run against a path that does not exist, so a typo cannot
 *    silently report "0 rows everywhere" for a database that was never opened.
 *
 * Usage:
 *   node scripts/resident-binding-preflight.mjs <path-to-sqlite> [--user-ids] [--json]
 *
 * Exit codes: 0 success, 1 usage/IO error, 2 unsafe input (write marker etc.).
 */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ASSIGNMENTS = 'resident_community_assignments'

/** Business fact tables that reference a resident and a community. */
const FACT_TABLES = [
  { table: 'local_orders', user_column: 'resident_user_id', community_column: 'community_id' },
  { table: 'activity_participations', user_column: 'user_id', community_column: null },
  { table: 'activity_draw_attempts', user_column: 'user_id', community_column: null },
  { table: 'activity_reward_grants', user_column: 'recipient_user_id', community_column: null },
  { table: 'crm_leads', user_column: 'resident_user_id', community_column: 'community_id' },
  { table: 'ledger_entries', user_column: null, community_column: 'community_id' },
]

function usage(message) {
  const text = [
    message,
    '',
    'usage: node scripts/resident-binding-preflight.mjs <path-to-sqlite> [--user-ids] [--json]',
    '',
    'Reads a SQLite database in read-only mode and reports how many resident',
    'accounts have 0 / 1 / many legacy community relations. Never modifies it.',
  ].join('\n')
  const error = new Error(text)
  error.exitCode = 1
  throw error
}

function parseArgs(argv) {
  const positional = argv.filter((value) => !value.startsWith('--'))
  const flags = new Set(argv.filter((value) => value.startsWith('--')))
  for (const flag of flags) {
    if (!['--user-ids', '--json'].includes(flag)) usage(`unknown flag: ${flag}`)
  }
  if (positional.length !== 1) usage('exactly one SQLite path is required')
  return { databasePath: positional[0], includeUserIds: flags.has('--user-ids'), json: flags.has('--json') }
}

function tableExists(sqlite, name) {
  const row = sqlite
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
  return Boolean(row)
}

function columnExists(sqlite, table, column) {
  const rows = sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()
  return rows.some((row) => row.name === column)
}

function scalar(sqlite, sql, ...params) {
  const row = sqlite.prepare(sql).get(...params)
  if (!row) return 0
  const value = Object.values(row)[0]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function readDistribution(sqlite) {
  // Left join from `users` so accounts with zero relations are counted from the
  // identity master table, exactly like `GET /admin/users` does (#153).
  const rows = sqlite
    .prepare(`
      SELECT users.id AS user_id,
             COUNT(${ASSIGNMENTS}.community_id) AS relations
      FROM users
      LEFT JOIN ${ASSIGNMENTS} ON ${ASSIGNMENTS}.user_id = users.id
      GROUP BY users.id
    `)
    .all()
  const distribution = { zero: 0, one: 0, many: 0 }
  const single = []
  const multi = []
  for (const row of rows) {
    const relations = Number(row.relations)
    if (relations === 0) distribution.zero += 1
    else if (relations === 1) {
      distribution.one += 1
      single.push(row.user_id)
    } else {
      distribution.many += 1
      multi.push({ userId: row.user_id, relations })
    }
  }
  return {
    residents: rows.length,
    distribution,
    singleAssignmentUserIds: single,
    multiAssignmentUsers: multi,
  }
}

function readAssignmentIntegrity(sqlite) {
  const rows = sqlite.prepare(`SELECT user_id, community_id, created_at FROM ${ASSIGNMENTS}`).all()
  const duplicatePairs = scalar(
    sqlite,
    `SELECT COUNT(*) FROM (
       SELECT user_id, community_id FROM ${ASSIGNMENTS}
       GROUP BY user_id, community_id HAVING COUNT(*) > 1
     )`,
  )
  const orphanCommunity = scalar(
    sqlite,
    `SELECT COUNT(*) FROM ${ASSIGNMENTS}
     WHERE community_id NOT IN (SELECT id FROM communities)`,
  )
  const orphanUser = scalar(
    sqlite,
    `SELECT COUNT(*) FROM ${ASSIGNMENTS} WHERE user_id NOT IN (SELECT id FROM users)`,
  )
  const missingCreatedAt = rows.filter((row) => row.created_at === null || row.created_at === undefined).length
  const epochCreatedAt = rows.filter((row) => Number(row.created_at) === 0).length
  const futureCreatedAt = rows.filter((row) => {
    const value = Number(row.created_at)
    return Number.isFinite(value) && value > Date.now() + 24 * 60 * 60 * 1000
  }).length
  const communities = new Set(rows.map((row) => row.community_id)).size
  return {
    rows: rows.length,
    communities,
    duplicateUserCommunityPairs: duplicatePairs,
    orphanCommunityRows: orphanCommunity,
    orphanUserRows: orphanUser,
    rowsWithoutCreatedAt: missingCreatedAt,
    rowsWithEpochCreatedAt: epochCreatedAt,
    rowsWithFutureCreatedAt: futureCreatedAt,
    hasConfirmationProvenanceColumn: columnExists(sqlite, ASSIGNMENTS, 'source'),
  }
}

function readFactImpact(sqlite, multiUserIds) {
  const facts = []
  for (const spec of FACT_TABLES) {
    if (!tableExists(sqlite, spec.table)) {
      facts.push({ table: spec.table, present: false })
      continue
    }
    const entry = {
      table: spec.table,
      present: true,
      rows: scalar(sqlite, `SELECT COUNT(*) FROM ${spec.table}`),
    }
    if (spec.user_column && columnExists(sqlite, spec.table, spec.user_column)) {
      entry.rowsForMultiAssignmentResidents = multiUserIds.length
        ? scalar(
            sqlite,
            `SELECT COUNT(*) FROM ${spec.table}
             WHERE ${spec.user_column} IN (${multiUserIds.map(() => '?').join(',')})`,
            ...multiUserIds,
          )
        : 0
    }
    facts.push(entry)
  }
  return facts
}

function readBindingState(sqlite) {
  const table = 'resident_community_bindings'
  if (!tableExists(sqlite, table)) {
    return { tablePresent: false }
  }
  const statuses = sqlite.prepare(`SELECT status, COUNT(*) AS rows FROM ${table} GROUP BY status`).all()
  const confirmedUsersWithMoreThanOne = scalar(
    sqlite,
    `SELECT COUNT(*) FROM (
       SELECT user_id FROM ${table} WHERE status = 'confirmed' GROUP BY user_id HAVING COUNT(*) > 1
     )`,
  )
  const confirmedWithoutConfirmTime = columnExists(sqlite, table, 'confirmed_at')
    ? scalar(sqlite, `SELECT COUNT(*) FROM ${table} WHERE status = 'confirmed' AND confirmed_at IS NULL`)
    : null
  return {
    tablePresent: true,
    byStatus: Object.fromEntries(statuses.map((row) => [row.status, Number(row.rows)])),
    confirmedUsersWithMoreThanOne,
    confirmedRowsWithoutConfirmedAt: confirmedWithoutConfirmTime,
  }
}

function readCommunityCoverage(sqlite) {
  return sqlite
    .prepare(`
      SELECT communities.id AS community_id,
             communities.name AS name,
             COUNT(${ASSIGNMENTS}.user_id) AS legacy_relations
      FROM communities
      LEFT JOIN ${ASSIGNMENTS} ON ${ASSIGNMENTS}.community_id = communities.id
      GROUP BY communities.id
      ORDER BY legacy_relations DESC, communities.name ASC
    `)
    .all()
    .map((row) => ({ name: row.name, legacyRelations: Number(row.legacy_relations) }))
}

/**
 * Bucket rules for the maintainer. A legacy row is never "confirmed": the old
 * login flow wrote it without any explicit consent, so `one` means "needs the
 * person to confirm this very community" and `many` means "needs a human
 * decision, never a coin flip".
 */
function classify(report) {
  const { distribution } = report.legacy
  const blocking = []
  if (report.legacy.integrity.duplicateUserCommunityPairs > 0) {
    blocking.push('legacy assignments contain duplicate (user, community) pairs')
  }
  if (report.legacy.integrity.orphanCommunityRows > 0) {
    blocking.push('legacy assignments reference a missing community')
  }
  if (report.legacy.integrity.orphanUserRows > 0) {
    blocking.push('legacy assignments reference a missing user')
  }
  return {
    accountsNeedingFirstConfirmation: distribution.zero + distribution.one,
    accountsNeedingManualReview: distribution.many,
    accountsAlreadyConfirmed: report.binding.tablePresent
      ? Object.entries(report.binding.byStatus)
          .filter(([status]) => status === 'confirmed')
          .reduce((sum, [, rows]) => sum + rows, 0)
      : 0,
    automaticConversionToPermanentBindingAllowed: false,
    randomSelectionAllowed: false,
    blockingIssues: blocking,
    verdict: blocking.length > 0 ? 'blocked_for_human_review' : 'ready_for_manual_review',
  }
}

function renderText(report) {
  const lines = []
  lines.push('LL-IDENTITY-001 (#171) resident binding preflight — READ ONLY')
  lines.push(`database: ${report.database.path}`)
  lines.push(`size: ${report.database.bytes} bytes`)
  lines.push('')
  lines.push('Legacy resident_community_assignments (no confirmation provenance):')
  lines.push(`  residents (users):        ${report.legacy.residents}`)
  lines.push(`  0 legacy relations:       ${report.legacy.distribution.zero}`)
  lines.push(`  1 legacy relation:        ${report.legacy.distribution.one}`)
  lines.push(`  2+ legacy relations:      ${report.legacy.distribution.many}`)
  lines.push(`  assignment rows:          ${report.legacy.integrity.rows}`)
  lines.push(`  communities referenced:   ${report.legacy.integrity.communities}`)
  lines.push(
    `  confirmation provenance:  ${report.legacy.integrity.hasConfirmationProvenanceColumn ? 'column present' : 'ABSENT (expected: legacy rows are unconfirmed)'}`,
  )
  lines.push('')
  lines.push('Permanent binding table:')
  if (!report.binding.tablePresent) {
    lines.push('  resident_community_bindings: NOT PRESENT (pre-#171 database)')
  } else {
    lines.push(`  resident_community_bindings: present, by status ${JSON.stringify(report.binding.byStatus)}`)
    lines.push(`  confirmed users with >1 row: ${report.binding.confirmedUsersWithMoreThanOne}`)
  }
  lines.push('')
  lines.push('Business facts that touch a resident (rows for 2+ legacy relation accounts):')
  for (const fact of report.facts) {
    if (!fact.present) {
      lines.push(`  ${fact.table}: table absent`)
      continue
    }
    const extra =
      fact.rowsForMultiAssignmentResidents === undefined
        ? ''
        : `, ${fact.rowsForMultiAssignmentResidents} on multi-relation accounts`
    lines.push(`  ${fact.table}: ${fact.rows} rows${extra}`)
  }
  lines.push('')
  lines.push('Decision inputs:')
  lines.push(`  accounts needing first confirmation: ${report.classification.accountsNeedingFirstConfirmation}`)
  lines.push(`  accounts needing manual review:      ${report.classification.accountsNeedingManualReview}`)
  lines.push(`  automatic conversion allowed:        ${report.classification.automaticConversionToPermanentBindingAllowed}`)
  lines.push(`  verdict:                             ${report.classification.verdict}`)
  for (const issue of report.classification.blockingIssues) lines.push(`  blocking: ${issue}`)
  if (report.legacy.singleAssignmentUserIds.length > 0) {
    lines.push('')
    lines.push('Accounts with exactly one legacy relation (candidate only, needs the person to confirm):')
    for (const userId of report.legacy.singleAssignmentUserIds) lines.push(`  ${userId}`)
  }
  if (report.legacy.multiAssignmentUsers.length > 0) {
    lines.push('')
    lines.push('Accounts with multiple legacy relations (manual review, never auto-picked):')
    for (const entry of report.legacy.multiAssignmentUsers) {
      lines.push(`  ${entry.userId} — ${entry.relations} relations`)
    }
  }
  return lines.join('\n')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const absolute = resolve(options.databasePath)
  if (!existsSync(absolute)) {
    usage(`database not found: ${absolute}`)
  }
  const stat = statSync(absolute)
  if (!stat.isFile()) usage(`not a regular file: ${absolute}`)

  // `readOnly: true` is the enforcement, not a convention: SQLite rejects every
  // write on this handle, so a later edit cannot turn the preflight into a
  // migration by accident.
  const sqlite = new DatabaseSync(absolute, { readOnly: true })
  try {
    if (!tableExists(sqlite, 'users')) usage(`${absolute} has no 'users' table; not a local-life database`)
    if (!tableExists(sqlite, ASSIGNMENTS)) usage(`${absolute} has no '${ASSIGNMENTS}' table`)

    const legacy = readDistribution(sqlite)
    const multiUserIds = legacy.multiAssignmentUsers.map((entry) => entry.userId)
    const report = {
      tool: 'resident-binding-preflight',
      issue: 'LL-IDENTITY-001 (#171)',
      readOnly: true,
      generatedAt: new Date().toISOString(),
      database: { path: absolute, bytes: stat.size },
      legacy: {
        residents: legacy.residents,
        distribution: legacy.distribution,
        singleAssignmentUserIds: options.includeUserIds ? legacy.singleAssignmentUserIds : [],
        multiAssignmentUsers: options.includeUserIds ? legacy.multiAssignmentUsers : [],
        integrity: readAssignmentIntegrity(sqlite),
        communities: readCommunityCoverage(sqlite),
      },
      binding: readBindingState(sqlite),
      facts: readFactImpact(sqlite, multiUserIds),
    }
    report.classification = classify(report)

    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
      return
    }
    console.log(renderText(report))
    if (!options.includeUserIds) {
      console.log('')
      console.log('Aggregate-only output. Re-run with --user-ids to list platform UUIDs locally.')
    }
  } finally {
    sqlite.close()
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(error && typeof error === 'object' && 'exitCode' in error ? error.exitCode : 1)
}
