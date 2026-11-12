#!/usr/bin/env node
/**
 * LL-MVP-006 / t13 — write-path check-in-window guard, asserted at the HTTP layer.
 *
 * Why this file exists (Finding D). t13 put the containment rule on the write
 * paths only. `updateActivity` has three sub-paths:
 *   (a) `rewardPlan` present            -> activityKeyRulesWriteSchema.parse
 *   (b) `rewardPlan: null` (clear)      -> allowed, nothing to bound
 *   (c) `rewardPlan` ABSENT (inherit)   -> merged with the stored plan, then the
 *                                          guard is applied to the merged value
 * Sub-path (c) is the one an ordinary "just move the activity dates" edit takes.
 * In the first cut of t13 it threw a hand-built `new z.ZodError(...)` without a
 * refinement context; zod 4's ZodError is NOT `instanceof Error`, and Hono's
 * `#handleError` only forwards Errors to `onError`, so the exception escaped to
 * `@hono/node-server` and surfaced as a **500 with an empty body, no requestId
 * and no log line** - while correctly refusing the write.
 *
 * This script therefore asserts the OUTCOME CONTRACT, not the implementation:
 * every out-of-bounds write attempt, on every sub-path, must come back as
 * `400 invalid_request` with the standard `{error:{code,message,requestId}}`
 * envelope, an operator-actionable message, a log line, and zero database
 * mutation. Any future sub-path that bypasses the guard - or any guard that
 * again refuses un-reportably - turns these red.
 *
 * Recorded states:
 *   r2-t13-update-path.before-fix.json  -> 4/6 (2 FAIL: empty-body 500, no log)
 *   r2-t13-update-path.json             -> current run against the working tree
 *
 * Usage: node docs/engineering/evidence/ll-mvp-006/r2/t13-update-path.cjs
 * Requires the real API from r2/reset-env.sh on :4091.
 */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const API = arg('api', 'http://127.0.0.1:4091')
const DB_PATH = arg('db', '/tmp/ll-mvp-006-r2/verify.sqlite')
const PASS_FILE = arg('pass-file', '/tmp/ll-mvp-006-r2/admin-pass.txt')
const LOG_FILE = arg('log', '/tmp/ll-mvp-006-r2/api.log')
const OUT = arg('out', path.join(__dirname, 'r2-t13-update-path.json'))
const ADMIN_USER = arg('admin-user', 'r2.verify')

const Database = require(path.join(REPO_ROOT, 'apps/api/node_modules/better-sqlite3'))
const db = new Database(DB_PATH, { readonly: true })

const RUNS = []
const FAILED = []

function rec(id, label, pass, evidence, extra) {
  const entry = { id, label, pass: Boolean(pass), evidence: String(evidence) }
  if (extra !== undefined) entry.data = extra
  RUNS.push(entry)
  if (!pass) FAILED.push(id)
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${label} :: ${evidence}`)
  return pass
}

class Client {
  constructor(base) {
    this.base = new URL(base)
    this.cookies = new Map()
    this.csrf = null
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  absorb(res) {
    for (const sc of res.headers['set-cookie'] || []) {
      const [kv] = sc.split(';')
      const i = kv.indexOf('=')
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1))
    }
    // Login rotates the CSRF token; the fresh cookie is authoritative.
    if (this.cookies.get('ll_csrf')) this.csrf = this.cookies.get('ll_csrf')
  }
  request(method, pathname, body) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.base.hostname,
          port: this.base.port,
          method,
          path: pathname,
          headers: {
            accept: 'application/json',
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
            ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}),
            ...(method !== 'GET' && this.csrf ? { 'x-csrf-token': this.csrf } : {}),
          },
          timeout: 30000,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            this.absorb(res)
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = text ? JSON.parse(text) : null
            } catch {
              json = null
            }
            resolve({ status: res.statusCode, headers: res.headers, text, json })
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${pathname}`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
  get(p) { return this.request('GET', p) }
  post(p, body) { return this.request('POST', p, body === undefined ? {} : body) }
  patch(p, body) { return this.request('PATCH', p, body) }
  async login(username, password) {
    const csrf = await this.get('/auth/csrf')
    if (csrf.status !== 200) throw new Error(`csrf ${csrf.status}`)
    this.csrf = csrf.json.csrfToken
    if (!this.cookies.get('ll_csrf')) this.cookies.set('ll_csrf', this.csrf)
    const res = await this.post('/auth/login', { username, password })
    if (res.status !== 200) throw new Error(`login ${res.status} ${res.text}`)
    this.session = res.json
    return this
  }
}

const T0 = Date.now()
const at = (ms) => new Date(T0 + ms).toISOString()
const HOUR = 60 * 60 * 1000

// A plan window that sits entirely BEFORE the activity window.
const outOfBoundsPlan = (name) => ({
  prizeName: name,
  prizeUnitCostCents: 2500,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 10,
  budgetCapCents: 100000,
  claimRecipient: 'leader',
  checkinWindow: { opensAt: at(-4 * HOUR), closesAt: at(-3 * HOUR) },
  redemptionValidHours: 24,
})
const legalPlan = (name) => ({
  ...outOfBoundsPlan(name),
  checkinWindow: { opensAt: at(-30 * 60 * 1000), closesAt: at(3 * HOUR) },
})

function rules(overrides = {}) {
  return {
    startsAt: at(-1 * HOUR),
    endsAt: at(6 * HOUR),
    location: 't13 更新路径验收',
    budgetCapCents: 100000,
    prizeQuantityCap: 20,
    publicRules: {
      eligibility: '本社区居民，实名参与',
      checkin: '现场签到并由工作人员核验',
      purchase: '无需消费',
      prizeClaim: '三人成团且三人都已核验签到后可领取',
    },
    ...overrides,
  }
}

function envelope(res) {
  return res.json && res.json.error ? res.json.error : null
}

/** 400 + standard envelope + requestId: the contract every rejection must meet. */
function rejectionIsReportable(res) {
  const err = envelope(res)
  return res.status === 400 && err !== null && Boolean(err.code) && Boolean(err.requestId) &&
    typeof err.message === 'string' && err.message.length > 0
}

function logLines() {
  return fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').length : 0
}

function row(activityId) {
  return db
    .prepare('SELECT starts_at, ends_at, reward_plan_json, updated_at FROM activities WHERE id = ?')
    .get(activityId)
}

function rowEquals(a, b) {
  return a.starts_at === b.starts_at && a.ends_at === b.ends_at &&
    a.reward_plan_json === b.reward_plan_json && a.updated_at === b.updated_at
}

async function main() {
  const adminPass = fs.readFileSync(PASS_FILE, 'utf8').trim()
  const admin = new Client(API)
  await admin.login(ADMIN_USER, adminPass)

  const community = await admin.post('/admin/communities', {
    name: `t13 更新路径社区 ${Date.now().toString(36)}`,
  })
  if (community.status !== 201) throw new Error(`community ${community.status} ${community.text}`)
  const communityId = community.json.id

  const created = await admin.post('/admin/activities', {
    communityId,
    title: 't13 更新路径 活动',
    summary: 't13 更新路径',
    description: 't13 更新路径验收',
    keyRules: rules({ rewardPlan: legalPlan('更新路径礼品') }),
  })
  if (created.status !== 201) throw new Error(`create ${created.status} ${created.text}`)
  const activityId = created.json.id
  rec('setup.activity', '创建带合法奖励计划的活动（用于走「继承计划」的编辑路径）',
    created.status === 201 && created.json.rewardPlan !== null,
    `status=${created.status} plan.checkinWindow=${created.json.rewardPlan.checkinWindow.opensAt}..${created.json.rewardPlan.checkinWindow.closesAt}`)

  /* ---------------------------------------------------------------- */
  /* (c) inherited-plan edit: `rewardPlan` key ABSENT, dates moved so   */
  /*     the inherited plan falls outside the new activity window.      */
  /* ---------------------------------------------------------------- */
  const beforeInherited = row(activityId)
  const logBeforeInherited = logLines()
  const inherited = await admin.patch(`/admin/activities/${activityId}`, {
    expectedUpdatedAt: created.json.updatedAt,
    keyRules: rules({ startsAt: at(2 * HOUR), endsAt: at(4 * HOUR) }),
  })
  const afterInherited = row(activityId)
  const logAfterInherited = logLines()

  rec('t13u.inheritedPathFailsClosed',
    '继承计划的编辑被拒绝，且数据库原值完全未变（不半途写入、不产生越界数据）',
    inherited.status >= 400 && rowEquals(beforeInherited, afterInherited),
    `status=${inherited.status} unchanged=${rowEquals(beforeInherited, afterInherited)}`)

  // THE Finding D assertion: the refusal must be a reportable 400, never a bare
  // 500 with an empty body. This is what an over-eager guard gets wrong.
  rec('t13u.inheritedPathReportable',
    '被拒绝时必须返回 400 + {error:{code,message,requestId}}，而不是空体 500',
    rejectionIsReportable(inherited),
    `status=${inherited.status} contentType=${inherited.headers['content-type'] || '(none)'} bodyLen=${inherited.text.length} code=${envelope(inherited)?.code || 'none'} requestId=${envelope(inherited)?.requestId || 'none'}`)

  // The message must name the field, otherwise the operator cannot act on it.
  const inheritedMsg = envelope(inherited)?.message || ''
  rec('t13u.inheritedPathMessageActionable',
    '拒绝信息点名 checkinWindow.opensAt，运营据此知道该改哪个字段',
    /checkinWindow\.opensAt/u.test(inheritedMsg),
    `message="${inheritedMsg}"`)

  // A rejection that leaves no trace is invisible to operations.
  rec('t13u.inheritedPathLogged',
    '失败请求留下日志（request.completed 或 request.failed），便于运维定位',
    logAfterInherited > logBeforeInherited,
    `apiLogLines ${logBeforeInherited}->${logAfterInherited}`)

  /* ---------------------------------------------------------------- */
  /* (a) explicit plan: same rule, different call site                  */
  /* ---------------------------------------------------------------- */
  const beforeExplicit = row(activityId)
  const explicit = await admin.patch(`/admin/activities/${activityId}`, {
    expectedUpdatedAt: created.json.updatedAt,
    keyRules: rules({ rewardPlan: outOfBoundsPlan('越界礼品') }),
  })
  const afterExplicit = row(activityId)
  rec('t13u.explicitPathReportable',
    '显式携带越界 rewardPlan 的编辑：400 + 错误信封，且原值不变',
    rejectionIsReportable(explicit) && rowEquals(beforeExplicit, afterExplicit),
    `status=${explicit.status} code=${envelope(explicit)?.code || 'none'} unchanged=${rowEquals(beforeExplicit, afterExplicit)}`)

  /* ---------------------------------------------------------------- */
  /* (a') variant: closesAt after endsAt, to prove both bounds fire     */
  /* ---------------------------------------------------------------- */
  const latePlan = { ...legalPlan('晚收礼品'), checkinWindow: { opensAt: at(-30 * 60 * 1000), closesAt: at(9 * HOUR) } }
  const countBefore = db.prepare('SELECT count(*) AS n FROM activities').get().n
  const late = await admin.post('/admin/activities', {
    communityId,
    title: 't13 边界 晚收窗口',
    summary: 't13 边界',
    description: '签到窗口结束晚于活动结束，必须被拒绝',
    keyRules: rules({ rewardPlan: latePlan }),
  })
  const countAfter = db.prepare('SELECT count(*) AS n FROM activities').get().n
  rec('t13u.closesAtBoundEnforced',
    '窗口结束晚于活动结束：创建路径拒绝（400 + 信封），且数据库不留活动行',
    rejectionIsReportable(late) && countAfter === countBefore,
    `status=${late.status} code=${envelope(late)?.code || 'none'} activities ${countBefore}->${countAfter}`)

  // Finding E (low, pre-existing): the CREATE path validates through
  // `bodySchemaError`, which collapses every zod failure into the generic
  // message "活动信息不正确" - the issue path never reaches the operator. The
  // UPDATE path (see t13u.inheritedPathMessageActionable) DOES name the field,
  // so the same rule is actionable in one place and opaque in the other.
  // Asserted separately so it cannot be mistaken for a bound-enforcement bug.
  rec('t13u.createPathMessageActionable',
    '创建路径的拒绝信息应点名 checkinWindow.closesAt（Finding E，low，既有行为）',
    /checkinWindow\.closesAt/u.test(envelope(late)?.message || ''),
    `message="${envelope(late)?.message || ''}"`)

  /* ---------------------------------------------------------------- */
  /* (b) clear-the-plan edit must stay allowed                          */
  /* ---------------------------------------------------------------- */
  const current = await admin.get(`/admin/activities/${activityId}`)
  const cleared = await admin.patch(`/admin/activities/${activityId}`, {
    expectedUpdatedAt: current.json.updatedAt,
    keyRules: rules({ rewardPlan: null }),
  })
  rec('t13u.clearPlanStillAllowed',
    '显式清空奖励计划（rewardPlan:null）仍被允许：约束只作用于计划本身，不误伤清空操作',
    cleared.status === 200 && cleared.json.rewardPlan === null,
    `status=${cleared.status} rewardPlan=${cleared.json ? JSON.stringify(cleared.json.rewardPlan) : 'n/a'}`)

  /* ---------------------------------------------------------------- */
  /* Read-schema leniency: a pre-t13 out-of-bounds row stays readable   */
  /* and repairable. If someone folds the rule into the read schema,    */
  /* every already-published activity 500s in four places.             */
  /* ---------------------------------------------------------------- */
  const legacy = outOfBoundsPlan('历史越界礼品')
  db.prepare('SELECT 1').get() // readonly handle: assert via the API instead
  const legacyActivity = await admin.post('/admin/activities', {
    communityId,
    title: 't13 历史行 活动',
    summary: 't13 历史行',
    description: '模拟修复前已存在的越界计划行',
    keyRules: rules({ rewardPlan: legalPlan('历史礼品') }),
  })
  if (legacyActivity.status !== 201) throw new Error(`legacy create ${legacyActivity.status}`)
  // Simulate the pre-t13 row at the storage layer (the API now refuses to create it).
  const rw = new Database(DB_PATH)
  rw.prepare('UPDATE activities SET reward_plan_json = ? WHERE id = ?')
    .run(JSON.stringify(legacy), legacyActivity.json.id)
  rw.close()

  const readBack = await admin.get(`/admin/activities/${legacyActivity.json.id}`)
  const repairs = await admin.patch(`/admin/activities/${legacyActivity.json.id}`, {
    expectedUpdatedAt: readBack.json ? readBack.json.updatedAt : legacyActivity.json.updatedAt,
    keyRules: rules({ rewardPlan: legalPlan('历史礼品') }),
  })
  rec('t13u.legacyRowReadableAndRepairable',
    '修复前写入的越界计划仍可读取（管理台详情 200），且运营能把它改回合法值',
    readBack.status === 200 &&
      readBack.json.rewardPlan !== null &&
      readBack.json.rewardPlan.checkinWindow.opensAt === legacy.checkinWindow.opensAt &&
      repairs.status === 200,
    `read=${readBack.status} storedOpensAt=${readBack.json?.rewardPlan?.checkinWindow?.opensAt || 'none'} repair=${repairs.status}`)

  const summary = {
    generatedAt: new Date().toISOString(),
    api: API,
    db: DB_PATH,
    totals: { checks: RUNS.length, passed: RUNS.filter((r) => r.pass).length, failed: FAILED.length },
    failedIds: FAILED,
    runs: RUNS,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')
  console.log(`\n${summary.totals.passed}/${RUNS.length} t13 update-path checks passed; failed: ${FAILED.join(',') || 'none'}`)
  console.log(`wrote ${OUT}`)
  db.close()
  process.exit(FAILED.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('DRIVER ERROR:', error)
  process.exit(2)
})
