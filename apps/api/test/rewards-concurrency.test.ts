import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import type { ActivityRewardPlan } from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import { createActivity, transitionActivity, updateActivity } from '../src/activities/service.js'
import { confirmParticipation } from '../src/participation/service.js'
import { claimTeamReward } from '../src/rewards/service.js'
import {
  activityPrizeStocks,
  activityRewardCodes,
  communities,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { seedConfirmedCommunity } from './resident-community-fixtures.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const apiRoot = fileURLToPath(new URL('..', import.meta.url))

const OPEN = new Date('2026-11-01T00:00:00.000Z')
const IN_WINDOW = new Date('2026-11-10T10:00:00.000Z')

const PLAN: ActivityRewardPlan = {
  prizeName: '粮油礼包',
  prizeUnitCostCents: 5_000,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 4,
  budgetCapCents: 15_000,
  claimRecipient: 'leader',
  checkinWindow: {
    opensAt: '2026-11-01T00:00:00.000Z',
    closesAt: '2026-11-30T00:00:00.000Z',
  },
  redemptionValidHours: 72,
}

const BASE_RULES = {
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-11-30T00:00:00.000Z',
  location: '幸福社区党群服务中心',
  budgetCapCents: 15_000,
  prizeQuantityCap: 4,
  publicRules: {
    eligibility: '本社区 60 岁以上居民',
    checkin: '活动当天到现场签到',
    purchase: '无消费门槛',
    prizeClaim: '达标后凭券领取',
  },
}

interface RaceChild {
  ready: Promise<void>
  /** Resolves once the child has announced it is about to attempt the write. */
  attempting: Promise<void>
  go: () => void
  result: Promise<RaceResult>
  kill: () => void
}

interface RaceResult {
  ok: boolean
  code?: string | null
  reason?: string | null
  message?: string
  attemptedAt: number
  finishedAt: number
  created?: boolean
  grantId?: string
  claimedQuantity?: number
  redeemed?: boolean
  /** Duration of the write itself, measured inside the child. */
  callMs?: number
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Child process that opens its own better-sqlite3 connection to the shared
 * database file, waits for a `go` line on stdin, and then runs ONE claim.
 *
 * It waits on stdin instead of sleeping so the parent can hold SQLite's write
 * lock and make both children queue behind it: a real race, not two serial calls.
 */
function claimChildSource(serviceHref: string, clientHref: string, codesHref: string): string {
  return `
import { createInterface } from 'node:readline'
import { createDatabase } from ${JSON.stringify(clientHref)}
import { claimTeamReward, RewardError } from ${JSON.stringify(serviceHref)}
import { eq } from 'drizzle-orm'
import { activityPrizeStocks } from ${JSON.stringify(codesHref)}

const [databasePath, activityId, userId, migrationsFolder] = process.argv.slice(2)
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
const rl = createInterface({ input: process.stdin })

rl.once('line', () => {
  let payload
  let attemptedAt = Date.now()
  try {
    // Announce the attempt BEFORE touching the database: the parent waits for
    // this marker and only then releases its write lock, so both contenders are
    // provably queued on the same lock instead of running one after the other.
    process.stdout.write('attempting\\n')
    attemptedAt = Date.now()
    const claim = claimTeamReward(db, { activityId, userId, now: new Date('2026-11-10T10:00:00.000Z') })
    const callMs = Date.now() - attemptedAt
    const stock = db.select().from(activityPrizeStocks).where(eq(activityPrizeStocks.activityId, activityId)).get()
    payload = {
      ok: true,
      created: claim.created,
      grantId: claim.grant.id,
      claimedQuantity: stock?.claimedQuantity ?? null,
      callMs,
      attemptedAt,
      finishedAt: Date.now(),
    }
  } catch (error) {
    payload = {
      ok: false,
      code: error?.code ?? null,
      reason: error?.reason ?? null,
      message: error?.message ?? String(error),
      callMs: Date.now() - attemptedAt,
      attemptedAt,
      finishedAt: Date.now(),
    }
  }
  process.stdout.write('ready\\n')
  process.stdout.write(JSON.stringify(payload) + '\\n', () => {
    try { sqlite.close() } catch {}
    rl.close()
    process.exit(0)
  })
})
process.stdout.write('ready\\n')
`
}

function spawnRaceChild(scriptPath: string, args: string[]): RaceChild {
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: apiRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  let markAttempting: () => void = () => {}
  const attempting = new Promise<void>((resolve) => {
    markAttempting = resolve
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.includes('ready')) markReady()
    if (stdout.includes('attempting')) markAttempting()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const result = new Promise<RaceResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`race child timed out\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, 30_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const payload = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .at(-1)
      if (code !== 0 || payload === undefined) {
        reject(new Error(`race child exited with ${code}\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      resolve(JSON.parse(payload) as RaceResult)
    })
  })
  void result.catch(() => {})
  return {
    ready,
    attempting,
    go: () => child.stdin.write('go\n'),
    result,
    kill: () => child.kill('SIGKILL'),
  }
}

interface RaceWorld {
  db: AppDatabase
  sqlite: SqliteConnection
  databasePath: string
  activityId: string
  communityId: string
  operator: { userId: string; staffId: string; role: 'admin' }
  tempDir: string
  /**
   * Adds a resident who really confirmed this activity's community (#171).
   * Joining a team is community-scoped, so a bare `users` row is no longer
   * allowed to occupy a seat.
   */
  addResident: (displayName: string) => string
  cleanup: () => void
}

/**
 * A published activity on a real FILE database (children need a shared file, not
 * `:memory:`) with one qualified team. The plan is configurable so each test can
 * starve either the stock pool or the money budget.
 */
function createRaceWorld(plan: ActivityRewardPlan): RaceWorld {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-rewards-race-'))
  const databasePath = join(tempDir, 'race.sqlite')
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)

  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '并发社区', createdAt: OPEN }).run()
  const adminUser = randomUUID()
  db.insert(users)
    .values({ id: adminUser, displayName: '管理员', createdAt: OPEN, updatedAt: OPEN })
    .run()
  const staffId = randomUUID()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId: adminUser,
      username: 'race-admin',
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      createdAt: OPEN,
      updatedAt: OPEN,
    })
    .run()
  const operator = { userId: adminUser, staffId, role: 'admin' as const }

  const created = createActivity(db, operator, {
    communityId,
    title: '并发活动',
    keyRules: { ...BASE_RULES, rewardPlan: plan },
  })
  const published = transitionActivity(db, operator, created.id, 'publish', created.updatedAt)

  const addResident = (displayName: string): string => {
    const id = randomUUID()
    db.insert(users)
      .values({ id, displayName, createdAt: OPEN, updatedAt: OPEN })
      .run()
    // Real confirmation through the production service: the resident's own
    // permanent community for this activity's community (#171).
    seedConfirmedCommunity(db, id, communityId, OPEN)
    return id
  }

  return {
    db,
    sqlite,
    databasePath,
    activityId: published.id,
    communityId,
    operator,
    addResident,
    tempDir,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

test('two connections racing for the last prize produce exactly one grant', async () => {
  // One prize in the pool: whoever gets there first consumes it.
  const world = createRaceWorld({ ...PLAN, totalPrizeQuantity: 1, budgetCapCents: 15_000 })
  const children: RaceChild[] = []
  try {
    // Two fully qualified teams (3 seats + 3 verified check-ins each).
    const teams: Array<{ leader: string; teamId: string }> = []
    for (const label of ['甲', '乙']) {
      const leader = world.addResident(`团长${label}`)
      const started = confirmParticipation(world.db, {
        activityId: world.activityId,
        userId: leader,
        now: OPEN,
      })
      const inviteCode = started.state.team!.inviteCode!
      const teamId = started.state.team!.id
      for (const memberLabel of ['二', '三']) {
        const member = world.addResident(`成员${label}${memberLabel}`)
        confirmParticipation(world.db, {
          activityId: world.activityId,
          userId: member,
          inviteCode,
          now: OPEN,
        })
        recordCheckinDirect(world, member, teamId)
      }
      recordCheckinDirect(world, leader, teamId)
      teams.push({ leader, teamId })
    }
    assert.equal(teams.length, 2)

    // Each worker process gets its own better-sqlite3 connection to this file.
    symlinkSync(join(apiRoot, 'node_modules'), join(world.tempDir, 'node_modules'), 'dir')
    const scriptPath = join(world.tempDir, 'claim-child.mjs')
    writeFileSync(
      scriptPath,
      claimChildSource(
        new URL('../src/rewards/service.ts', import.meta.url).href,
        new URL('../src/db/client.ts', import.meta.url).href,
        new URL('../src/db/schema.ts', import.meta.url).href,
      ),
    )

    const contender = (userId: string) =>
      spawnRaceChild(scriptPath, [world.databasePath, world.activityId, userId, migrationsFolder])
    const one = contender(teams[0]!.leader)
    const two = contender(teams[1]!.leader)
    children.push(one, two)
    await withTimeout(Promise.all([one.ready, two.ready]), 30_000, 'race children startup')

    // Hold SQLite's write lock so both children queue behind it before either can
    // read the ledger: a genuine check-then-write race. The commit happens only
    // after BOTH children announced they are attempting, which is what makes the
    // contention real rather than incidental.
    world.sqlite.prepare('BEGIN IMMEDIATE').run()
    one.go()
    two.go()
    await withTimeout(
      Promise.all([one.attempting, two.attempting]),
      20_000,
      'both children announced their attempt',
    )
    // Both children are past their marker, but the marker fires before the
    // `BEGIN IMMEDIATE` syscall, so keep the lock open for a beat: this is the
    // window in which they provably block instead of running one after the other.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    world.sqlite.prepare('COMMIT').run()

    const [resultOne, resultTwo] = await withTimeout(
      Promise.all([one.result, two.result]),
      30_000,
      'race children result',
    )

    // Contention, proven without relying on wall-clock ordering between
    // processes: at least one child spent real time inside its write, which can
    // only happen because another connection held the write lock.
    const slowestCall = Math.max(resultOne.callMs ?? 0, resultTwo.callMs ?? 0)
    assert.ok(
      slowestCall >= 300,
      `a worker must have waited on the foreign write lock: ${JSON.stringify([resultOne, resultTwo])}`,
    )

    const winners = [resultOne, resultTwo].filter((result) => result.ok)
    const losers = [resultOne, resultTwo].filter((result) => !result.ok)
    assert.equal(winners.length, 1, `exactly one claim may succeed: ${JSON.stringify([resultOne, resultTwo])}`)
    assert.equal(losers.length, 1)
    assert.equal(winners[0]?.claimedQuantity, 1, 'the pool holds exactly one prize')
    assert.equal(losers[0]?.code, 'prize_stock_exhausted')

    // The ledger and the grant table agree, and nothing was oversold.
    const grants = world.sqlite.prepare('SELECT count(*) c FROM activity_reward_grants').get() as {
      c: number
    }
    assert.equal(grants.c, 1, 'only one grant row may exist')
    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.claimedQuantity, 1)
    assert.equal(stock?.committedBudgetCents, PLAN.prizeUnitCostCents)
    assert.equal(stock?.totalQuantity, 1)
  } finally {
    for (const child of children) child.kill()
    world.sqlite.close()
    world.cleanup()
  }
})

test('two connections racing for the last budget slot produce exactly one grant', async () => {
  // Quantity room for four prizes, but money for exactly one.
  const world = createRaceWorld({
    ...PLAN,
    totalPrizeQuantity: 4,
    budgetCapCents: PLAN.prizeUnitCostCents,
  })
  const children: RaceChild[] = []
  try {
    const teams: Array<{ leader: string }> = []
    for (const label of ['甲', '乙']) {
      const leader = world.addResident(`团长${label}`)
      const started = confirmParticipation(world.db, {
        activityId: world.activityId,
        userId: leader,
        now: OPEN,
      })
      const inviteCode = started.state.team!.inviteCode!
      const teamId = started.state.team!.id
      for (const memberLabel of ['二', '三']) {
        const member = world.addResident(`成员${label}${memberLabel}`)
        confirmParticipation(world.db, {
          activityId: world.activityId,
          userId: member,
          inviteCode,
          now: OPEN,
        })
        recordCheckinDirect(world, member, teamId)
      }
      recordCheckinDirect(world, leader, teamId)
      teams.push({ leader })
    }

    symlinkSync(join(apiRoot, 'node_modules'), join(world.tempDir, 'node_modules'), 'dir')
    const scriptPath = join(world.tempDir, 'claim-child.mjs')
    writeFileSync(
      scriptPath,
      claimChildSource(
        new URL('../src/rewards/service.ts', import.meta.url).href,
        new URL('../src/db/client.ts', import.meta.url).href,
        new URL('../src/db/schema.ts', import.meta.url).href,
      ),
    )

    const one = spawnRaceChild(scriptPath, [
      world.databasePath,
      world.activityId,
      teams[0]!.leader,
      migrationsFolder,
    ])
    const two = spawnRaceChild(scriptPath, [
      world.databasePath,
      world.activityId,
      teams[1]!.leader,
      migrationsFolder,
    ])
    children.push(one, two)
    await withTimeout(Promise.all([one.ready, two.ready]), 30_000, 'race children startup')

    world.sqlite.prepare('BEGIN IMMEDIATE').run()
    one.go()
    two.go()
    await withTimeout(
      Promise.all([one.attempting, two.attempting]),
      20_000,
      'both children announced their attempt',
    )
    // Both children are past their marker but the marker fires before the
    // `BEGIN IMMEDIATE` syscall, so keep the lock a little longer: this is the
    // window in which they provably block instead of running serially.
    await new Promise((resolve) => setTimeout(resolve, 300))
    world.sqlite.prepare('COMMIT').run()

    const [resultOne, resultTwo] = await withTimeout(
      Promise.all([one.result, two.result]),
      30_000,
      'race children result',
    )
    const winners = [resultOne, resultTwo].filter((result) => result.ok)
    const losers = [resultOne, resultTwo].filter((result) => !result.ok)
    assert.equal(winners.length, 1, `exactly one claim may succeed: ${JSON.stringify([resultOne, resultTwo])}`)
    assert.equal(losers[0]?.code, 'budget_exceeded', 'the loser must be told the budget ran out')

    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.claimedQuantity, 1)
    assert.equal(stock?.committedBudgetCents, PLAN.prizeUnitCostCents)
    assert.ok(
      stock!.committedBudgetCents <= stock!.budgetCapCents,
      'the committed budget must never exceed the cap',
    )
  } finally {
    for (const child of children) child.kill()
    world.sqlite.close()
    world.cleanup()
  }
})

test('two connections racing to redeem the same code redeem it exactly once', async () => {
  const world = createRaceWorld(PLAN)
  const children: RaceChild[] = []
  try {
    const leader = world.addResident('团长甲')
    const started = confirmParticipation(world.db, {
      activityId: world.activityId,
      userId: leader,
      now: OPEN,
    })
    const inviteCode = started.state.team!.inviteCode!
    const teamId = started.state.team!.id
    for (const memberLabel of ['二', '三']) {
      const member = world.addResident(`成员${memberLabel}`)
      confirmParticipation(world.db, {
        activityId: world.activityId,
        userId: member,
        inviteCode,
        now: OPEN,
      })
      recordCheckinDirect(world, member, teamId)
    }
    recordCheckinDirect(world, leader, teamId)

    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: leader,
      now: IN_WINDOW,
    })

    symlinkSync(join(apiRoot, 'node_modules'), join(world.tempDir, 'node_modules'), 'dir')
    const scriptPath = join(world.tempDir, 'redeem-child.mjs')
    writeFileSync(scriptPath, redeemChildSource(claim.code))

    const one = spawnRaceChild(scriptPath, [world.databasePath, world.activityId, migrationsFolder])
    const two = spawnRaceChild(scriptPath, [world.databasePath, world.activityId, migrationsFolder])
    children.push(one, two)
    await withTimeout(Promise.all([one.ready, two.ready]), 30_000, 'race children startup')

    world.sqlite.prepare('BEGIN IMMEDIATE').run()
    one.go()
    two.go()
    await withTimeout(
      Promise.all([one.attempting, two.attempting]),
      20_000,
      'both children announced their attempt',
    )
    // Both children are past their marker but the marker fires before the
    // `BEGIN IMMEDIATE` syscall, so keep the lock a little longer: this is the
    // window in which they provably block instead of running serially.
    await new Promise((resolve) => setTimeout(resolve, 300))
    world.sqlite.prepare('COMMIT').run()

    const [resultOne, resultTwo] = await withTimeout(
      Promise.all([one.result, two.result]),
      30_000,
      'race children result',
    )
    const winners = [resultOne, resultTwo].filter((result) => result.ok && result.redeemed === true)
    const losers = [resultOne, resultTwo].filter((result) => !result.ok)
    assert.equal(winners.length, 1, `exactly one redemption may win: ${JSON.stringify([resultOne, resultTwo])}`)
    assert.equal(losers.length, 1)
    assert.equal(losers[0]?.code, 'reward_already_redeemed')

    // The one-time guarantee is visible in the ledger, not just in the return value.
    const codes = world.db
      .select()
      .from(activityRewardCodes)
      .where(eq(activityRewardCodes.grantId, claim.grant.id))
      .all()
    assert.equal(codes.filter((code) => code.status === 'redeemed').length, 1)
    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.redeemedQuantity, 1, 'a doubled redemption would push this to 2')
    assert.equal(stock?.redeemedBudgetCents, PLAN.prizeUnitCostCents)
  } finally {
    for (const child of children) child.kill()
    world.sqlite.close()
    world.cleanup()
  }
})

test('two connections racing for the same team prize after a rule edit produce exactly one grant', async () => {
  // The regression scenario: an edit bumps the rule version, and two devices of
  // the same team race the claim. The version-scoped lookup used to let both win
  // (one per version); the activity-scoped partial index must collapse them into
  // a single grant, one live code and one occupied stock slot.
  const world = createRaceWorld(PLAN)
  const children: RaceChild[] = []
  try {
    const leader = world.addResident('团长甲')
    const started = confirmParticipation(world.db, {
      activityId: world.activityId,
      userId: leader,
      now: OPEN,
    })
    const inviteCode = started.state.team!.inviteCode!
    const teamId = started.state.team!.id
    for (const memberLabel of ['乙', '丙']) {
      const member = world.addResident(`成员${memberLabel}`)
      confirmParticipation(world.db, {
        activityId: world.activityId,
        userId: member,
        inviteCode,
        now: OPEN,
      })
      recordCheckinDirect(world, member, teamId)
    }
    recordCheckinDirect(world, leader, teamId)

    // The team already holds the prize from BEFORE the edit. This is the crux:
    // under the old version-scoped lookup the two racers below would both miss
    // this grant, because it lives on version 1 while they claim on version 2.
    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: leader,
      now: IN_WINDOW,
    })
    assert.equal(first.created, true, 'the pre-edit claim must create the prize')

    // A location-only edit: this is what used to re-open the prize for the team.
    const before = world.sqlite
      .prepare('SELECT updated_at FROM activities WHERE id=?')
      .get(world.activityId) as { updated_at: number }
    updateActivity(world.db, world.operator, world.activityId, {
      expectedUpdatedAt: new Date(before.updated_at).toISOString(),
      keyRules: { ...BASE_RULES, location: '幸福社区东门', rewardPlan: PLAN },
    })
    const versions = world.sqlite
      .prepare('SELECT count(*) c FROM activity_rule_versions WHERE activity_id=?')
      .get(world.activityId) as { c: number }
    assert.equal(versions.c, 2, 'the edit must have created a second rule version')

    symlinkSync(join(apiRoot, 'node_modules'), join(world.tempDir, 'node_modules'), 'dir')
    const scriptPath = join(world.tempDir, 'claim-child.mjs')
    writeFileSync(
      scriptPath,
      claimChildSource(
        new URL('../src/rewards/service.ts', import.meta.url).href,
        new URL('../src/db/client.ts', import.meta.url).href,
        new URL('../src/db/schema.ts', import.meta.url).href,
      ),
    )

    // Both contenders are the SAME team leader: same activity, same team.
    const one = spawnRaceChild(scriptPath, [
      world.databasePath,
      world.activityId,
      leader,
      migrationsFolder,
    ])
    const two = spawnRaceChild(scriptPath, [
      world.databasePath,
      world.activityId,
      leader,
      migrationsFolder,
    ])
    children.push(one, two)
    await withTimeout(Promise.all([one.ready, two.ready]), 30_000, 'race children startup')

    world.sqlite.prepare('BEGIN IMMEDIATE').run()
    one.go()
    two.go()
    await withTimeout(
      Promise.all([one.attempting, two.attempting]),
      20_000,
      'both children announced their attempt',
    )
    // The marker fires before the `BEGIN IMMEDIATE` syscall, so hold the lock a
    // little longer to keep them provably blocked rather than serialised.
    await new Promise((resolve) => setTimeout(resolve, 300))
    world.sqlite.prepare('COMMIT').run()

    const [resultOne, resultTwo] = await withTimeout(
      Promise.all([one.result, two.result]),
      30_000,
      'race children result',
    )

    // The prize already exists, so BOTH racers must be told "you already have it"
    // and must land on the pre-edit grant. Under the old code each would look up
    // version 2, miss the version-1 grant, and try to create a second prize —
    // one would even be refused by the then-version-scoped unique index, which is
    // why this test asserts on grant identity and not merely on "no error".
    for (const result of [resultOne, resultTwo]) {
      assert.equal(result.ok, true, `a same-team claim must never error: ${JSON.stringify(result)}`)
      assert.equal(
        result.created,
        false,
        `a post-edit claim must be idempotent, not a new prize: ${JSON.stringify(result)}`,
      )
    }
    assert.equal(
      resultOne.grantId,
      resultTwo.grantId,
      `both children must end on the SAME grant: ${JSON.stringify([resultOne, resultTwo])}`,
    )
    assert.equal(
      resultOne.grantId,
      first.grant.id,
      'both racers must land on the grant that predates the rule edit',
    )

    // Ground truth: one grant, one live code, one occupied slot.
    const grants = world.sqlite
      .prepare('SELECT count(*) c FROM activity_reward_grants WHERE activity_id=? AND team_id=?')
      .get(world.activityId, teamId) as { c: number }
    assert.equal(grants.c, 1, 'the database must hold exactly one grant for this team')
    const codes = world.sqlite
      .prepare("SELECT count(*) c FROM activity_reward_codes WHERE activity_id=? AND status='active'")
      .get(world.activityId) as { c: number }
    assert.equal(codes.c, 1, 'exactly one live credential may exist')
    const stocks = world.sqlite
      .prepare('SELECT claimed_quantity, total_quantity FROM activity_prize_stocks WHERE activity_id=?')
      .all(world.activityId) as Array<{ claimed_quantity: number; total_quantity: number }>
    assert.equal(stocks.length, 1, 'the activity owns exactly one stock ledger')
    assert.equal(stocks[0]!.claimed_quantity, PLAN.prizeQuantityPerTeam, 'claimed must not double')
    assert.equal(stocks[0]!.total_quantity, PLAN.totalPrizeQuantity, 'the pool must not be enlarged')
  } finally {
    for (const child of children) child.kill()
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Writes a verified check-in directly: the claim path is what is under test. */
function recordCheckinDirect(world: RaceWorld, userId: string, teamId: string): void {
  const seatNo = world.sqlite
    .prepare('SELECT seat_no FROM activity_participations WHERE team_id=? AND user_id=?')
    .get(teamId, userId) as { seat_no: number } | undefined
  world.sqlite
    .prepare(
      `INSERT INTO activity_checkins
         (id, activity_id, user_id, team_id, seat_no, status, checked_in_at, verified_at, verified_by_staff_id)
       VALUES (?,?,?,?,?,'valid',?,?,?)`,
    )
    .run(
      randomUUID(),
      world.activityId,
      userId,
      teamId,
      seatNo?.seat_no ?? 1,
      IN_WINDOW.getTime(),
      IN_WINDOW.getTime(),
      world.operator.staffId,
    )
}

function redeemChildSource(code: string): string {
  return `
import { createInterface } from 'node:readline'
import { createDatabase } from ${JSON.stringify(new URL('../src/db/client.ts', import.meta.url).href)}
import { redeemCredential, RewardError } from ${JSON.stringify(new URL('../src/rewards/service.ts', import.meta.url).href)}
import { staffAccounts } from ${JSON.stringify(new URL('../src/db/schema.ts', import.meta.url).href)}

const [databasePath, activityId, migrationsFolder] = process.argv.slice(2)
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
const admin = db.select().from(staffAccounts).get()
const rl = createInterface({ input: process.stdin })

rl.once('line', () => {
  let payload
  let attemptedAt = Date.now()
  try {
    process.stdout.write('attempting\\n')
    attemptedAt = Date.now()
    const response = redeemCredential(
      db,
      { userId: admin.userId, staffId: admin.id, role: 'admin' },
      { code: ${JSON.stringify(code)}, now: new Date('2026-11-10T10:00:00.000Z') },
    )
    payload = {
      ok: true,
      redeemed: response.redeemed,
      callMs: Date.now() - attemptedAt,
      attemptedAt,
      finishedAt: Date.now(),
    }
  } catch (error) {
    payload = {
      ok: false,
      code: error?.code ?? null,
      reason: error?.reason ?? null,
      message: error?.message ?? String(error),
      callMs: Date.now() - attemptedAt,
      attemptedAt,
      finishedAt: Date.now(),
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\\n', () => {
    try { sqlite.close() } catch {}
    rl.close()
    process.exit(0)
  })
})
process.stdout.write('ready\\n')
`
}
