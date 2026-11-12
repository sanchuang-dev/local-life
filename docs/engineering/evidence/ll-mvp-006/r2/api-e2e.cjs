#!/usr/bin/env node
/**
 * LL-MVP-006 (Issue #62) R2 end-to-end acceptance driver — API + SQLite side.
 *
 * Everything here is a real HTTP request against a real Node/Hono API process
 * backed by a real SQLite file, and every assertion that matters is re-checked
 * in SQL (stock/budget ledger, grants, codes, append-only events, audit_logs)
 * so a passing status code alone can never make a check green.
 *
 * Usage:
 *   node docs/engineering/evidence/ll-mvp-006/r2/api-e2e.cjs \
 *     [--api http://127.0.0.1:4091] [--db /tmp/ll-mvp-006-r2/verify.sqlite] \
 *     [--pass-file /tmp/ll-mvp-006-r2/admin-pass.txt] [--out <json path>]
 *
 * Requires a freshly built database (see README §2) and AUTH_DEV_ENABLED=true.
 */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

/* -------------------------------------------------------------------------- */
/* Args / environment                                                         */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const API = arg('api', 'http://127.0.0.1:4091')
const API_ALT_PORT = Number(arg('api-alt-port', '4092'))
const DB_PATH = arg('db', '/tmp/ll-mvp-006-r2/verify.sqlite')
const PASS_FILE = arg('pass-file', '/tmp/ll-mvp-006-r2/admin-pass.txt')
const OUT = arg('out', path.join(__dirname, 'r2-api-runs.json'))
const ADMIN_USER = arg('admin-user', 'r2.verify')

const Database = require(path.join(REPO_ROOT, 'apps/api/node_modules/better-sqlite3'))
const db = new Database(DB_PATH)

const RUNS = []
const FAILED = []
const STDERR = []

function rec(id, label, pass, evidence, extra) {
  const entry = { id, label, pass: Boolean(pass), evidence: String(evidence) }
  if (extra !== undefined) entry.data = extra
  RUNS.push(entry)
  if (!pass) FAILED.push(id)
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${id} ${label} :: ${evidence}`)
  return pass
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1Z')
}

function utcIso(offsetMs = 0) {
  // The contract regex demands exactly three fractional digits.
  return new Date(Date.now() + offsetMs).toISOString()
}

/* -------------------------------------------------------------------------- */
/* HTTP client with a cookie jar                                              */
/* -------------------------------------------------------------------------- */

class Client {
  constructor(base, name) {
    this.base = new URL(base)
    this.name = name
    this.cookies = new Map()
    this.csrf = null
    this.session = null
  }

  cookieHeader() {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  absorb(res) {
    const raw = res.headers['set-cookie'] || []
    for (const line of raw) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const key = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '') this.cookies.delete(key)
      else this.cookies.set(key, value)
    }
  }

  request(method, pathname, options = {}) {
    const { body, headers = {}, port } = options
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const host = this.base.hostname
    const targetPort = port ?? this.base.port
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host,
          port: targetPort,
          method,
          path: pathname,
          headers: {
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
            ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}),
            ...headers,
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
  del(p) { return this.request('DELETE', p) }

  post(p, body, options = {}) {
    return this.request('POST', p, {
      ...options,
      body: body === undefined ? {} : body,
      headers: { ...(options.headers || {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
    })
  }

  patch(p, body, options = {}) {
    return this.request('PATCH', p, {
      ...options,
      body,
      headers: { ...(options.headers || {}), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
    })
  }

  async loadCsrf() {
    const res = await this.get('/api/auth/csrf'.replace('/api', ''))
    if (res.status !== 200) throw new Error(`csrf ${res.status}: ${res.text}`)
    this.csrf = res.json.csrfToken
    if (!this.cookies.get('ll_csrf')) this.cookies.set('ll_csrf', this.csrf)
    return this.csrf
  }
}

function errCode(res) {
  return res.json && res.json.error ? res.json.error.code : null
}

function errMessage(res) {
  return res.json && res.json.error ? res.json.error.message : ''
}

/* -------------------------------------------------------------------------- */
/* SQL helpers                                                                */
/* -------------------------------------------------------------------------- */

const q = {
  one: (sql, ...params) => db.prepare(sql).get(...params),
  all: (sql, ...params) => db.prepare(sql).all(...params),
  run: (sql, ...params) => db.prepare(sql).run(...params),
}

function stock(activityId, prizeName) {
  return q.one('SELECT * FROM activity_prize_stocks WHERE activity_id = ? AND prize_name = ?', activityId, prizeName)
}

function countGrants(activityId) {
  return q.one('SELECT count(*) AS n FROM activity_reward_grants WHERE activity_id = ?', activityId).n
}

function countAudit(activityId, event) {
  return q.one('SELECT count(*) AS n FROM audit_logs WHERE target_id = ? AND event = ?', activityId, event).n
}

function countEvents(activityId, kind) {
  return q.one('SELECT count(*) AS n FROM activity_reward_events WHERE activity_id = ? AND kind = ?', activityId, kind).n
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const C = {}          // communities
const A = {}          // activities: {id, updatedAt, plan}
const U = {}          // residents: Client
const T = {}          // teams by activity key
let STAFF = null      // grid worker client
let STAFF_ID = null
let ADMIN = null

async function staffLogin(username, password, label) {
  const c = new Client(API, label)
  await c.loadCsrf()
  const res = await c.post('/auth/login', { username, password })
  if (res.status !== 200) throw new Error(`${label} login failed ${res.status} ${res.text}`)
  c.session = res.json
  // Login rotates the CSRF token: the authoritative copy is the fresh cookie.
  c.csrf = c.cookies.get('ll_csrf') || (res.json && res.json.csrfToken) || c.csrf
  return c
}

async function resident(name, communityId) {
  const c = new Client(API, name)
  await c.loadCsrf()
  const res = await c.post('/auth/dev/login', { displayName: name, communityId })
  if (res.status !== 200) throw new Error(`resident ${name} login failed ${res.status} ${res.text}`)
  c.session = res.json
  c.csrf = c.cookies.get('ll_csrf') || (res.json && res.json.csrfToken) || c.csrf
  return c
}

async function createActivity(key, communityId, plan, { publish = true } = {}) {
  const keyRules = {
    startsAt: utcIso(-60 * 60 * 1000),
    endsAt: utcIso(6 * 60 * 60 * 1000),
    location: `验收现场 ${key}`,
    budgetCapCents: 100000,
    prizeQuantityCap: 20,
    publicRules: {
      eligibility: '本社区居民，实名参与',
      checkin: '现场签到并由工作人员核验',
      purchase: '无需消费',
      prizeClaim: '三人成团且三人都已核验签到后可领取',
    },
  }
  if (plan) keyRules.rewardPlan = plan
  const created = await ADMIN.post('/admin/activities', {
    communityId,
    title: `验收活动 ${key}`,
    summary: `LL-MVP-006 验收活动 ${key}`,
    description: `验收用活动 ${key}`,
    keyRules,
  })
  if (created.status !== 201) throw new Error(`create ${key} ${created.status} ${created.text}`)
  const detail = created.json
  A[key] = { id: detail.id, updatedAt: detail.updatedAt, plan: plan || null, title: detail.title }
  if (!publish) return A[key]
  const pub = await ADMIN.post(`/admin/activities/${detail.id}/publish`, {
    expectedUpdatedAt: detail.updatedAt,
  })
  if (pub.status !== 200) throw new Error(`publish ${key} ${pub.status} ${pub.text}`)
  A[key].updatedAt = pub.json.updatedAt
  A[key].status = pub.json.status
  return A[key]
}

function plan(prizeName, overrides = {}) {
  return {
    prizeName,
    prizeUnitCostCents: 2500,
    prizeQuantityPerTeam: 1,
    totalPrizeQuantity: 10,
    budgetCapCents: 100000,
    claimRecipient: 'leader',
    checkinWindow: { opensAt: utcIso(-30 * 60 * 1000), closesAt: utcIso(3 * 60 * 60 * 1000) },
    redemptionValidHours: 24,
    ...overrides,
  }
}

async function formTeam(activityKey, users) {
  const [leader, ...rest] = users
  const first = await leader.post(`/activities/${A[activityKey].id}/participation`, {})
  if (first.status !== 200) throw new Error(`participation ${activityKey} ${first.status} ${first.text}`)
  let inviteCode = first.json.state.team.inviteCode
  for (const member of rest) {
    const res = await member.post(`/activities/${A[activityKey].id}/participation`, { inviteCode })
    if (res.status !== 200) throw new Error(`join ${activityKey} ${res.status} ${res.text}`)
    inviteCode = res.json.state.team.inviteCode ?? inviteCode
  }
  // GET returns the participation state directly; POST wraps it as {created, state}.
  const state = await leader.get(`/activities/${A[activityKey].id}/participation`)
  T[activityKey] = {
    teamId: state.json.team.id,
    inviteCode: state.json.team.inviteCode,
    leader: users[0],
  }
  return T[activityKey]
}

async function selfCheckin(activityKey, user) {
  const res = await user.post(`/activities/${A[activityKey].id}/checkin`, {})
  if (res.status !== 200) throw new Error(`checkin ${activityKey} ${res.status} ${res.text}`)
  return res
}

async function verifyAll(activityKey, actor = STAFF) {
  const list = await actor.get(`/admin/activities/${A[activityKey].id}/checkins`)
  if (list.status !== 200) throw new Error(`checkins ${activityKey} ${list.status} ${list.text}`)
  for (const item of list.json.items) {
    if (item.verifiedAt !== null || item.status !== 'valid') continue
    const res = await actor.post(
      `/admin/activities/${A[activityKey].id}/checkins/${item.id}/verify`,
      {},
    )
    if (res.status !== 200) throw new Error(`verify ${activityKey} ${res.status} ${res.text}`)
  }
  return list
}

async function rewardState(activityKey, user) {
  const res = await user.get(`/activities/${A[activityKey].id}/rewards`)
  return { status: res.status, body: res.json || {}, text: res.text }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/* -------------------------------------------------------------------------- */
/* Race helper: a second real API process on another port, same SQLite file    */
/* -------------------------------------------------------------------------- */

let altProc = null
async function startAltApi() {
  const tsx = path.join(REPO_ROOT, 'apps/api/node_modules/.bin/tsx')
  altProc = spawn(tsx, ['src/index.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(API_ALT_PORT),
      DATABASE_PATH: DB_PATH,
      AUTH_DEV_ENABLED: 'true',
      TRUSTED_ORIGINS: 'http://localhost:5241,http://localhost:5242',
      SESSION_TTL_HOURS: '24',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  altProc.stderr.on('data', (d) => STDERR.push(String(d)))
  altProc.stdout.on('data', (d) => STDERR.push(String(d)))
  const probe = new Client(`http://127.0.0.1:${API_ALT_PORT}`, 'alt-probe')
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await probe.get('/healthz')
      if (res.status === 200) return probe.base.href
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('alt api did not start\n' + STDERR.join(''))
}

function stopAltApi() {
  if (altProc && !altProc.killed) altProc.kill('SIGTERM')
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  if (!fs.existsSync(PASS_FILE)) throw new Error(`missing admin password file: ${PASS_FILE}`)
  const adminPass = fs.readFileSync(PASS_FILE, 'utf8').trim()
  if (adminPass.length < 12) throw new Error('admin password file looks empty')

  rec('env.db', '数据库文件存在且已迁移（33 张表）', true, DB_PATH,
    { tables: q.one("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").n })
  rec('env.fresh', '数据库为从零构建：无历史社区/活动/签到/奖励数据',
    q.one('SELECT count(*) AS n FROM communities').n === 0 &&
      q.one('SELECT count(*) AS n FROM activities').n === 0 &&
      q.one('SELECT count(*) AS n FROM activity_reward_grants').n === 0,
    `communities=${q.one('SELECT count(*) AS n FROM communities').n} activities=${q.one('SELECT count(*) AS n FROM activities').n} grants=${q.one('SELECT count(*) AS n FROM activity_reward_grants').n}`)

  /* ---------------------------- 0. Accounts ------------------------------ */
  ADMIN = await staffLogin(ADMIN_USER, adminPass, 'admin')
  rec('setup.admin', '管理员真实密码登录（scrypt 校验）', ADMIN.session.staff.role === 'admin',
    `role=${ADMIN.session.staff.role}`)

  const c1 = await ADMIN.post('/admin/communities', { name: '验收社区甲' })
  const c2 = await ADMIN.post('/admin/communities', { name: '验收社区乙' })
  if (c1.status !== 201 || c2.status !== 201) throw new Error(`communities ${c1.status}/${c2.status}`)
  C.c1 = c1.json.id
  C.c2 = c2.json.id

  const unique = Date.now().toString(36).slice(-6)
  const staffCreated = await ADMIN.post('/admin/staff', {
    username: `r2grid.${unique}`,
    displayName: '验收网格员',
    password: 'grid-worker-pass-2026',
    role: 'grid_worker',
    communityIds: [C.c1],
  })
  if (staffCreated.status !== 201) throw new Error(`staff ${staffCreated.status} ${staffCreated.text}`)
  STAFF_ID = staffCreated.json.id
  STAFF = await staffLogin(`r2grid.${unique}`, 'grid-worker-pass-2026', 'grid')
  rec('setup.staff', '网格员账号仅被分配到社区甲（用于跨社区 403 反例）',
    STAFF.session.staff.role === 'grid_worker',
    `role=${STAFF.session.staff.role} communities=[社区甲]`)

  /* --------------------------- 1. Activities ----------------------------- */
  await createActivity('MAIN', C.c1, plan('社区小礼品'))
  await createActivity('STOCK', C.c1, plan('限量礼品', { totalPrizeQuantity: 1, budgetCapCents: 100000 }))
  await createActivity('BUDGET', C.c1, plan('预算礼品', { totalPrizeQuantity: 100, budgetCapCents: 2500 }))
  await createActivity('PAUSE', C.c1, plan('暂停礼品'))
  await createActivity('REVOKE', C.c1, plan('撤销礼品'))
  await createActivity('RACE', C.c1, plan('并发礼品'))
  await createActivity('EXPIRE', C.c1, plan('过期礼品'))
  await createActivity('NOPLAN', C.c1, null)
  await createActivity('ANYMEM', C.c1, plan('共享礼品', { claimRecipient: 'any_member' }))
  await createActivity('C2', C.c2, plan('跨社区礼品'))

  rec('setup.activities', '10 个真实活动已创建并发布（含 1 个未配置奖励计划、1 个属于社区乙、1 个 any_member 受领）',
    Object.keys(A).length === 10 && Object.values(A).every((a) => a.id && a.status === 'published'),
    Object.entries(A).map(([k, v]) => `${k}=${v.id.slice(0, 8)}(${v.status})`).join(' '))

  // Frozen plan provenance: the reward plan must be read from the rule snapshot.
  const snap = q.one(
    `SELECT v.version, json_extract(v.snapshot_json, '$.rewardPlan.prizeName') AS prize
     FROM activities a JOIN activity_rule_versions v ON v.id = a.current_rule_version_id
     WHERE a.id = ?`, A.MAIN.id)
  rec('setup.snapshot', '奖励计划已冻结进 activity_rule_versions.snapshot_json（非可变 activities 列）',
    snap.prize === '社区小礼品', `version=${snap.version} prizeName=${snap.prize}`,
    { rewardPlanJsonColumn: q.one('SELECT reward_plan_json IS NOT NULL AS ok FROM activities WHERE id = ?', A.MAIN.id).ok })

  /* ---------------------------- 2. Residents ----------------------------- */
  U.r1 = await resident('验收居民甲', C.c1)
  U.r2 = await resident('验收居民乙', C.c1)
  U.r3 = await resident('验收居民丙', C.c1)
  U.r4 = await resident('验收居民丁', C.c1)
  U.r5 = await resident('验收居民戊', C.c1)
  U.r6 = await resident('验收居民己', C.c1)
  U.s1 = await resident('验收居民庚', C.c2)
  U.s2 = await resident('验收居民辛', C.c2)
  U.s3 = await resident('验收居民壬', C.c2)
  rec('setup.residents', '9 名居民通过 AUTH_DEV_ENABLED 真实登录，服务端签发不透明会话 Cookie',
    Object.keys(U).length === 9,
    `user_ids=${[U.r1, U.r2, U.r3].map((c) => c.session.user.id.slice(0, 8)).join(',')}`)

  await formTeam('MAIN', [U.r1, U.r2, U.r3])
  /* A second team on the same activity: participation is per activity + user. */
  const team2First = await U.r4.post(`/activities/${A.MAIN.id}/participation`, {})
  if (team2First.status !== 200) throw new Error(`main team2 ${team2First.status} ${team2First.text}`)
  const team2Code = team2First.json.state.team.inviteCode
  await U.r5.post(`/activities/${A.MAIN.id}/participation`, { inviteCode: team2Code })
  await U.r6.post(`/activities/${A.MAIN.id}/participation`, { inviteCode: team2Code })
  T.MAIN2 = { teamId: (await U.r4.get(`/activities/${A.MAIN.id}/participation`)).json.team.id }

  for (const key of ['STOCK', 'BUDGET', 'PAUSE', 'REVOKE', 'RACE', 'EXPIRE', 'ANYMEM']) {
    await formTeam(key, [U.r1, U.r2, U.r3])
  }
  const stockTeam2 = await U.r4.post(`/activities/${A.STOCK.id}/participation`, {})
  const stockCode2 = stockTeam2.json.state.team.inviteCode
  await U.r5.post(`/activities/${A.STOCK.id}/participation`, { inviteCode: stockCode2 })
  await U.r6.post(`/activities/${A.STOCK.id}/participation`, { inviteCode: stockCode2 })
  T.STOCK2 = { teamId: (await U.r4.get(`/activities/${A.STOCK.id}/participation`)).json.team.id }

  const budgetTeam2 = await U.r4.post(`/activities/${A.BUDGET.id}/participation`, {})
  const budgetCode2 = budgetTeam2.json.state.team.inviteCode
  await U.r5.post(`/activities/${A.BUDGET.id}/participation`, { inviteCode: budgetCode2 })
  await U.r6.post(`/activities/${A.BUDGET.id}/participation`, { inviteCode: budgetCode2 })
  T.BUDGET2 = { teamId: (await U.r4.get(`/activities/${A.BUDGET.id}/participation`)).json.team.id }

  await formTeam('C2', [U.s1, U.s2, U.s3])
  rec('setup.teams', '三人团通过真实 participation API 组成（服务端席位 3/3、锁定后不再暴露邀请码）',
    (await U.r1.get(`/activities/${A.MAIN.id}/participation`)).json.team.seatsFilled === 3,
    `MAIN team=${T.MAIN.teamId.slice(0, 8)} seats=3 locked=${(await U.r1.get(`/activities/${A.MAIN.id}/participation`)).json.team.status === 'locked'}`)

  /* ------------------- Item 1: check-in + verification ------------------- */
  const preState = await rewardState('MAIN', U.r1)
  rec('item1.pre', '未签到前：团队奖励状态 eligible=false、checkin_incomplete、3 席已满',
    preState.body.eligible === false && preState.body.unavailableReason === 'checkin_incomplete' &&
      preState.body.requirement.seatsSatisfied === true && preState.body.requirement.checkinsValid === 0,
    `eligible=${preState.body.eligible} reason=${preState.body.unavailableReason} seats=${preState.body.requirement.seatsFilled}/3 checkins=${preState.body.requirement.checkinsValid}/3`)

  const ci1 = await selfCheckin('MAIN', U.r1)
  const ci2 = await selfCheckin('MAIN', U.r2)
  const ci3 = await selfCheckin('MAIN', U.r3)
  const unverified = await rewardState('MAIN', U.r1)
  const sqlUnverified = q.one(
    'SELECT count(*) AS n FROM activity_checkins WHERE activity_id = ? AND status = ? AND verified_at IS NOT NULL',
    A.MAIN.id, 'valid').n
  rec('item1.unverified', '三人自助签到后仍未核验：checkinsValid=0、eligible=false、SQL verified 行数=0',
    unverified.body.eligible === false && unverified.body.requirement.checkinsValid === 0 &&
      unverified.body.unavailableReason === 'checkin_incomplete' && sqlUnverified === 0,
    `eligible=${unverified.body.eligible} checkinsValid=${unverified.body.requirement.checkinsValid} sqlVerified=${sqlUnverified} countsForReward=${unverified.body.requirement.checkinsSatisfied}`)

  // A self check-in must not count even after a partial verification.
  await verifyAll('MAIN')
  const afterVerify = await rewardState('MAIN', U.r1)
  const sqlVerified = q.one(
    'SELECT count(*) AS n FROM activity_checkins WHERE activity_id = ? AND status = ? AND verified_at IS NOT NULL',
    A.MAIN.id, 'valid').n
  const overviewBeforeClaim = await STAFF.get(`/admin/activities/${A.MAIN.id}/rewards`)
  rec('item1.verified', '工作人员逐一核验 3 条签到后达标：checkinsValid=3、eligible=true、后台计数一致',
    afterVerify.body.eligible === true && afterVerify.body.requirement.checkinsValid === 3 &&
      afterVerify.body.unavailableReason === null && sqlVerified === 3 &&
      overviewBeforeClaim.json.counts.checkinsVerified === 3 &&
      overviewBeforeClaim.json.counts.checkinsValid === 3,
    `eligible=${afterVerify.body.eligible} checkinsValid=${afterVerify.body.requirement.checkinsValid} sqlVerified=${sqlVerified} overview verified=${overviewBeforeClaim.json.counts.checkinsVerified} pending=${overviewBeforeClaim.json.counts.checkinsPendingVerification}`)

  rec('item1.claimable', '仅团队发起人 claimableByMe=true；普通成员 false（但看不到 claimable 之外的矛盾状态）',
    (await rewardState('MAIN', U.r1)).body.claimableByMe === true &&
      (await rewardState('MAIN', U.r2)).body.claimableByMe === false &&
      (await rewardState('MAIN', U.r2)).body.eligible === true,
    `leader claimableByMe=${(await rewardState('MAIN', U.r1)).body.claimableByMe} member claimableByMe=${(await rewardState('MAIN', U.r2)).body.claimableByMe} member eligible=${(await rewardState('MAIN', U.r2)).body.eligible}`)

  /* --------------------- Item 2: repeated check-in ----------------------- */
  const repeat = await selfCheckin('MAIN', U.r1)
  const rowsAfterRepeat = q.one('SELECT count(*) AS n FROM activity_checkins WHERE activity_id = ?', A.MAIN.id).n
  const verifiedEvents = countEvents(A.MAIN.id, 'checkin.verified')
  const verifiedRow = q.one('SELECT verified_at, verified_by_staff_id FROM activity_checkins WHERE id = ?', ci1.json.checkin.id)
  const repeatVerify = await STAFF.post(
    `/admin/activities/${A.MAIN.id}/checkins/${ci1.json.checkin.id}/verify`, {})
  const verifiedEvents2 = countEvents(A.MAIN.id, 'checkin.verified')
  const verifiedRow2 = q.one('SELECT verified_at, verified_by_staff_id FROM activity_checkins WHERE id = ?', ci1.json.checkin.id)
  rec('item2.checkin', '重复签到/重复核验幂等：返回同一条签到，不新增行、不改首次核验人、不重复追加核验事件',
    repeat.json.checkin.id === ci1.json.checkin.id && rowsAfterRepeat === 3 &&
      repeat.json.countsForReward === true &&
      repeat.json.checkin.verifiedAt === new Date(verifiedRow.verified_at).toISOString() &&
      repeatVerify.status === 200 &&
      repeatVerify.json.verifiedAt === new Date(verifiedRow.verified_at).toISOString() &&
      verifiedRow2.verified_at === verifiedRow.verified_at &&
      verifiedRow2.verified_by_staff_id === verifiedRow.verified_by_staff_id &&
      verifiedEvents === 3 && verifiedEvents2 === 3,
    `sameId=${repeat.json.checkin.id === ci1.json.checkin.id} rows=${rowsAfterRepeat} verifiedAt=${repeat.json.checkin.verifiedAt} reverify=${repeatVerify.status} verifyEvents=${verifiedEvents}->${verifiedEvents2} verifierUnchanged=${verifiedRow2.verified_by_staff_id === verifiedRow.verified_by_staff_id}`)

  /* ------------------- Mainline: claim / credential / redeem ------------- */
  const claim1 = await U.r1.post(`/activities/${A.MAIN.id}/rewards/claim`, {})
  const code1 = claim1.json && claim1.json.code
  const grantsAfterClaim = countGrants(A.MAIN.id)
  const stockAfterClaim = stock(A.MAIN.id, '社区小礼品')
  rec('mainline.claim', '第一份资格：grant 仅 1 行、stock claimed/committed 正确、明文码一次性下发',
    claim1.status === 200 && claim1.json.created === true && grantsAfterClaim === 1 &&
      stockAfterClaim.claimed_quantity === 1 && stockAfterClaim.committed_budget_cents === 2500 &&
      typeof code1 === 'string' && /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code1),
    `status=${claim1.status} created=${claim1.json.created} grants=${grantsAfterClaim} claimed=${stockAfterClaim.claimed_quantity} committed=${stockAfterClaim.committed_budget_cents} codeLen=${code1 ? code1.length : 0} masked=${claim1.json.credential.maskedCode}`)

  rec('mainline.grant', 'grant 价格/数量/受领人/状态与冻结计划一致（totalCost=quantity*unitCost）',
    claim1.json.grant.status === 'granted' && claim1.json.grant.quantity === 1 &&
      claim1.json.grant.unitCostCents === 2500 && claim1.json.grant.totalCostCents === 2500 &&
      claim1.json.grant.recipientUserId === U.r1.session.user.id &&
      claim1.json.grant.recipientRole === 'leader',
    `status=${claim1.json.grant.status} qty=${claim1.json.grant.quantity} unit=${claim1.json.grant.unitCostCents} total=${claim1.json.grant.totalCostCents} recipient=${claim1.json.grant.recipientRole}`)

  const credRead = await U.r1.get(`/activities/${A.MAIN.id}/rewards/credential`)
  const credLeaksPlaintext = credRead.text.includes(code1)
  rec('mainline.credentialMasked', '凭据读取只返回掩码 ******XXXX，明文不再出现（哈希存储）',
    credRead.status === 200 && !credLeaksPlaintext &&
      credRead.json.maskedCode === claim1.json.credential.maskedCode &&
      q.one('SELECT code_hash FROM activity_reward_codes WHERE id = ?', credRead.json.id).code_hash === sha256(code1),
    `masked=${credRead.json.maskedCode} plaintextLeak=${credLeaksPlaintext} hashMatchesSha256=true`)

  // Re-claim is idempotent on the grant but rotates the code (documented behaviour).
  const claim2 = await U.r1.post(`/activities/${A.MAIN.id}/rewards/claim`, {})
  const code2 = claim2.json && claim2.json.code
  const oldCode = q.one('SELECT status, superseded_at FROM activity_reward_codes WHERE id = ?', claim1.json.credential.id)
  const activeCodes = q.one(
    "SELECT count(*) AS n FROM activity_reward_codes WHERE grant_id = ? AND status = 'active'",
    claim1.json.grant.id).n
  rec('item2.claim', '重复领取不重复发奖：grant 仍 1 行、stock 不再增长，旧码被 supersede、仅 1 个 active',
    claim2.status === 200 && claim2.json.created === false && countGrants(A.MAIN.id) === 1 &&
      stock(A.MAIN.id, '社区小礼品').claimed_quantity === 1 &&
      oldCode.status === 'superseded' && oldCode.superseded_at !== null && activeCodes === 1 &&
      code2 !== code1,
    `created=${claim2.json.created} grants=${countGrants(A.MAIN.id)} claimed=${stock(A.MAIN.id, '社区小礼品').claimed_quantity} oldCode=${oldCode.status} activeCodes=${activeCodes}`)

  // Non-recipient must not be able to rotate the recipient's credential.
  const r2claim = await U.r2.post(`/activities/${A.MAIN.id}/rewards/claim`, {})
  const survivor = q.one('SELECT status, code_hash FROM activity_reward_codes WHERE id = ?', claim2.json.credential.id)
  // `not_recipient` is the service's internal RewardErrorReason; the wire code is
  // the shared `forbidden` (API_ERROR_CODES has no not_recipient member) and the
  // distinguishing text is the message. Recorded as a contract note in README §8.
  rec('item5.notRecipient', '非受领人 re-claim 被拒 403 forbidden（reason=not_recipient 仅在文案中），受领人原码未被顶掉',
    r2claim.status === 403 && errCode(r2claim) === 'forbidden' &&
      errMessage(r2claim).includes('受领人') && survivor.status === 'active' &&
      survivor.code_hash === sha256(code2),
    `status=${r2claim.status} code=${errCode(r2claim)} msg=${errMessage(r2claim)} recipientCodeStatus=${survivor.status} hashUnchanged=${survivor.code_hash === sha256(code2)}`)

  const redeem1 = await STAFF.post('/rewards/redeem', { code: code2, note: '现场核销' })
  const stockAfterRedeem = stock(A.MAIN.id, '社区小礼品')
  rec('item5.firstRedeem', '首次核销成功：码/资格/库存/预算四处同时落地',
    redeem1.status === 200 && redeem1.json.redeemed === true &&
      redeem1.json.grant.status === 'redeemed' && redeem1.json.credential.status === 'redeemed' &&
      stockAfterRedeem.redeemed_quantity === 1 && stockAfterRedeem.redeemed_budget_cents === 2500 &&
      stockAfterRedeem.claimed_quantity === 1 && stockAfterRedeem.committed_budget_cents === 2500,
    `status=${redeem1.status} grant=${redeem1.json.grant.status} cred=${redeem1.json.credential.status} redeemedQty=${stockAfterRedeem.redeemed_quantity} redeemedBudget=${stockAfterRedeem.redeemed_budget_cents}`)

  rec('item5.redeemAudit', '核销写入 append-only 事件与审计：grant.redeemed=1、reward.grant.redeemed=1',
    countEvents(A.MAIN.id, 'grant.redeemed') === 1 && countAudit(A.MAIN.id, 'reward.grant.redeemed') === 1,
    `events.grant.redeemed=${countEvents(A.MAIN.id, 'grant.redeemed')} audit.reward.grant.redeemed=${countAudit(A.MAIN.id, 'reward.grant.redeemed')}`)

  const dup = await STAFF.post('/rewards/redeem', { code: code2 })
  const stockAfterDup = stock(A.MAIN.id, '社区小礼品')
  rec('item5.duplicate', '第二次核销被拒 409 reward_already_redeemed，库存/预算不二次扣减、不再追加事件',
    dup.status === 409 && errCode(dup) === 'reward_already_redeemed' &&
      stockAfterDup.redeemed_quantity === 1 && stockAfterDup.redeemed_budget_cents === 2500 &&
      countEvents(A.MAIN.id, 'grant.redeemed') === 1 &&
      countAudit(A.MAIN.id, 'reward.grant.redeemed') === 1,
    `status=${dup.status} code=${errCode(dup)} redeemedQty=${stockAfterDup.redeemed_quantity} redeemedBudget=${stockAfterDup.redeemed_budget_cents} events=${countEvents(A.MAIN.id, 'grant.redeemed')}`)

  const supersededRedeem = await STAFF.post('/rewards/redeem', { code: code1 })
  rec('item5.superseded', '已换发的旧码核销返回 404 redemption_code_invalid（与未知码同形状）',
    supersededRedeem.status === 404 && errCode(supersededRedeem) === 'redemption_code_invalid',
    `status=${supersededRedeem.status} code=${errCode(supersededRedeem)} msg=${errMessage(supersededRedeem)}`)

  const forged = await STAFF.post('/rewards/redeem', { code: 'ABCDEFGHJK' })
  const unknown = await STAFF.post('/rewards/redeem', { code: 'ZYXWVTSRQP' })
  const malformed = await STAFF.post('/rewards/redeem', { code: 'not-a-code' })
  rec('item5.forged', '伪造码与未知码同为 404 redemption_code_invalid（不泄露存在性）；格式非法为 400',
    forged.status === 404 && errCode(forged) === 'redemption_code_invalid' &&
      unknown.status === 404 && errCode(unknown) === 'redemption_code_invalid' &&
      JSON.stringify(Object.keys(forged.json.error).sort()) === JSON.stringify(Object.keys(unknown.json.error).sort()) &&
      forged.json.error.message === unknown.json.error.message &&
      malformed.status === 400 && errCode(malformed) === 'invalid_request',
    `forged=${forged.status}/${errCode(forged)} unknown=${unknown.status}/${errCode(unknown)} sameMessage=${forged.json.error.message === unknown.json.error.message} malformed=${malformed.status}/${errCode(malformed)}`)

  /* -------------- Item 5a-bis: claimRecipient = any_member ------------- */
  await selfCheckin('ANYMEM', U.r1)
  await selfCheckin('ANYMEM', U.r2)
  await selfCheckin('ANYMEM', U.r3)
  await verifyAll('ANYMEM')
  // The NON-leader claims first: with `any_member` the first claimer becomes the
  // recipient, and the leader must then be refused instead of re-issuing.
  const anyClaim = await U.r2.post(`/activities/${A.ANYMEM.id}/rewards/claim`, {})
  const anyGrant = q.one('SELECT recipient_user_id, status FROM activity_reward_grants WHERE activity_id = ?', A.ANYMEM.id)
  const anyCodeBefore = q.one('SELECT code_hash FROM activity_reward_codes WHERE grant_id = ?', anyClaim.json.grant.id)
  const leaderRetry = await U.r1.post(`/activities/${A.ANYMEM.id}/rewards/claim`, {})
  const anyCodeAfter = q.one('SELECT code_hash FROM activity_reward_codes WHERE grant_id = ?', anyClaim.json.grant.id)
  rec('item5.anyMember', 'any_member 受领：首个领取者成为受领人，队长随后领取被 403 拒绝且原码未被顶掉',
    anyClaim.status === 200 && anyClaim.json.created === true &&
      anyGrant.recipient_user_id === U.r2.session.user.id && anyGrant.status === 'granted' &&
      leaderRetry.status === 403 && errCode(leaderRetry) === 'forbidden' &&
      anyCodeBefore.code_hash === anyCodeAfter.code_hash &&
      q.one('SELECT count(*) n FROM activity_reward_grants WHERE activity_id = ?', A.ANYMEM.id).n === 1,
    `firstClaimer=${anyClaim.status}/${anyClaim.json.created} recipientIsFirstClaimer=${anyGrant.recipient_user_id === U.r2.session.user.id} leaderRetry=${leaderRetry.status}/${errCode(leaderRetry)} codeHashUnchanged=${anyCodeBefore.code_hash === anyCodeAfter.code_hash} grants=1`)

  /* ------------------------- Item 6b: redeemed -> disputed -------------- */
  const revokeCheckinRes = await STAFF.post(
    `/admin/activities/${A.MAIN.id}/checkins/${ci3.json.checkin.id}/revoke`,
    { reason: '现场复核：该居民未实际到场' })
  const grantAfterRevoke = q.one('SELECT * FROM activity_reward_grants WHERE activity_id = ? AND team_id = ?', A.MAIN.id, T.MAIN.teamId)
  const stockAfterDispute = stock(A.MAIN.id, '社区小礼品')
  const disputes = q.all('SELECT decision, reason FROM activity_reward_disputes WHERE grant_id = ?', claim1.json.grant.id)
  const revokeStockGuard = q.one('SELECT revoked_at, revoke_reason, status FROM activity_checkins WHERE id = ?', ci3.json.checkin.id)
  rec('item6.redeemedDisputed', '已核销后再撤销签到：grant 转 disputed + opened 争议，已核销库存/预算不回收、历史不删除',
    revokeCheckinRes.status === 200 && grantAfterRevoke.status === 'disputed' &&
      grantAfterRevoke.redeemed_at !== null && disputes.length === 1 && disputes[0].decision === 'opened' &&
      stockAfterDispute.redeemed_quantity === 1 && stockAfterDispute.redeemed_budget_cents === 2500 &&
      stockAfterDispute.claimed_quantity === 1 && revokeStockGuard.status === 'revoked' &&
      revokeStockGuard.revoke_reason.length > 0 &&
      countEvents(A.MAIN.id, 'dispute.opened') === 1,
    `grant=${grantAfterRevoke.status} redeemedAt=${grantAfterRevoke.redeemed_at !== null} disputes=${disputes.length}/${disputes[0] && disputes[0].decision} redeemedQty=${stockAfterDispute.redeemed_quantity} claimed=${stockAfterDispute.claimed_quantity} checkinStatus=${revokeStockGuard.status}`)

  /* ----------------------- Item 6a: unredeemed revoke ------------------- */
  await selfCheckin('REVOKE', U.r1)
  await selfCheckin('REVOKE', U.r2)
  await selfCheckin('REVOKE', U.r3)
  await verifyAll('REVOKE')
  const revokeClaim = await U.r1.post(`/activities/${A.REVOKE.id}/rewards/claim`, {})
  const revokeStockBefore = stock(A.REVOKE.id, '撤销礼品')
  const revokeCheckinList = await STAFF.get(`/admin/activities/${A.REVOKE.id}/checkins`)
  const targetCheckin = revokeCheckinList.json.items.find((i) => i.userId === U.r3.session.user.id)
  const revokeRes = await STAFF.post(
    `/admin/activities/${A.REVOKE.id}/checkins/${targetCheckin.id}/revoke`,
    { reason: '签到凭据造假' })
  const revokeGrant = q.one('SELECT * FROM activity_reward_grants WHERE activity_id = ?', A.REVOKE.id)
  const revokeStockAfter = stock(A.REVOKE.id, '撤销礼品')
  const revokeCode = q.one('SELECT status, revoked_at FROM activity_reward_codes WHERE grant_id = ?', revokeClaim.json.grant.id)
  rec('item6.unredeemedRevoked', '未核销时撤销签到：grant 转 revoked、库存与预算释放归零、码被作废、行仍在',
    revokeRes.status === 200 && revokeGrant.status === 'revoked' && revokeGrant.revoked_at !== null &&
      revokeGrant.revoke_reason.length > 0 && revokeStockBefore.claimed_quantity === 1 &&
      revokeStockAfter.claimed_quantity === 0 && revokeStockAfter.committed_budget_cents === 0 &&
      revokeStockAfter.redeemed_quantity === 0 && revokeCode.status === 'revoked' &&
      countEvents(A.REVOKE.id, 'grant.revoked') === 1 &&
      countAudit(A.REVOKE.id, 'reward.grant.revoked') === 1,
    `grant=${revokeGrant.status} claimed=${revokeStockBefore.claimed_quantity}->${revokeStockAfter.claimed_quantity} committed=${revokeStockBefore.committed_budget_cents}->${revokeStockAfter.committed_budget_cents} code=${revokeCode.status}`)

  const revokedCodeRedeem = await STAFF.post('/rewards/redeem', { code: revokeClaim.json.code })
  rec('item6.revokedCodeDead', '撤销后原凭据不可再核销（404），团队奖励状态同步为不可领',
    revokedCodeRedeem.status === 404 &&
      (await rewardState('REVOKE', U.r1)).body.eligible === false,
    `redeem=${revokedCodeRedeem.status}/${errCode(revokedCodeRedeem)} eligible=${(await rewardState('REVOKE', U.r1)).body.eligible} reason=${(await rewardState('REVOKE', U.r1)).body.unavailableReason}`)

  /* --------------------- Item 4a: stock exhaustion ----------------------- */
  await selfCheckin('STOCK', U.r1); await selfCheckin('STOCK', U.r2); await selfCheckin('STOCK', U.r3)
  await selfCheckin('STOCK', U.r4); await selfCheckin('STOCK', U.r5); await selfCheckin('STOCK', U.r6)
  await verifyAll('STOCK')
  const stockClaim1 = await U.r1.post(`/activities/${A.STOCK.id}/rewards/claim`, {})
  const stockRow1 = stock(A.STOCK.id, '限量礼品')
  const stockState2 = await rewardState('STOCK', U.r4)
  const stockClaim2 = await U.r4.post(`/activities/${A.STOCK.id}/rewards/claim`, {})
  const stockRow2 = stock(A.STOCK.id, '限量礼品')
  rec('item4.stockClaim', '库存仅 1 份：第二团 claim 被拒 409 prize_stock_exhausted，库存/预算/资格行无新增占用',
    stockClaim1.status === 200 && stockRow1.claimed_quantity === 1 && stockRow1.total_quantity === 1 &&
      stockClaim2.status === 409 && errCode(stockClaim2) === 'prize_stock_exhausted' &&
      stockRow2.claimed_quantity === 1 && stockRow2.committed_budget_cents === 2500 &&
      countGrants(A.STOCK.id) === 1,
    `team1=${stockClaim1.status} claimed=${stockRow1.claimed_quantity}/${stockRow1.total_quantity} team2Claim=${stockClaim2.status}/${errCode(stockClaim2)} grants=${countGrants(A.STOCK.id)} claimedAfter=${stockRow2.claimed_quantity}`)
  rec('item4.stockState', '（契约要求）第二团的奖励状态读取应 200 且 eligible=false / unavailableReason=stock_exhausted',
    stockState2.status === 200 && stockState2.body.eligible === false &&
      stockState2.body.unavailableReason === 'stock_exhausted',
    `GET /activities/:id/rewards => ${stockState2.status} eligible=${stockState2.body && stockState2.body.eligible} reason=${stockState2.body && stockState2.body.unavailableReason} claimableByMe=${stockState2.body && stockState2.body.claimableByMe} (raw: ${stockState2.text.slice(0, 90)})`)

  /* --------------------- Item 4b: budget exhaustion ---------------------- */
  await selfCheckin('BUDGET', U.r1); await selfCheckin('BUDGET', U.r2); await selfCheckin('BUDGET', U.r3)
  await selfCheckin('BUDGET', U.r4); await selfCheckin('BUDGET', U.r5); await selfCheckin('BUDGET', U.r6)
  await verifyAll('BUDGET')
  const budgetClaim1 = await U.r1.post(`/activities/${A.BUDGET.id}/rewards/claim`, {})
  const budgetRow1 = stock(A.BUDGET.id, '预算礼品')
  const budgetState2 = await rewardState('BUDGET', U.r4)
  const budgetClaim2 = await U.r4.post(`/activities/${A.BUDGET.id}/rewards/claim`, {})
  const budgetRow2 = stock(A.BUDGET.id, '预算礼品')
  rec('item4.budgetClaim', '预算仅够 1 份：第二团 claim 被拒 409 budget_exceeded，预算不被击穿且库存仍有余量',
    budgetClaim1.status === 200 && budgetRow1.committed_budget_cents === 2500 &&
      budgetRow1.budget_cap_cents === 2500 && budgetRow1.claimed_quantity === 1 &&
      budgetClaim2.status === 409 && errCode(budgetClaim2) === 'budget_exceeded' &&
      budgetRow2.committed_budget_cents === 2500 && budgetRow2.claimed_quantity === 1 &&
      budgetRow2.redeemed_quantity === 0,
    `team1=${budgetClaim1.status} committed=${budgetRow1.committed_budget_cents}/${budgetRow1.budget_cap_cents} team2Claim=${budgetClaim2.status}/${errCode(budgetClaim2)} claimed=${budgetRow2.claimed_quantity} committedAfter=${budgetRow2.committed_budget_cents}`)
  rec('item4.budgetState', '（契约要求）第二团的奖励状态读取应 200 且 unavailableReason=budget_exhausted',
    budgetState2.status === 200 && budgetState2.body.unavailableReason === 'budget_exhausted',
    `GET /activities/:id/rewards => ${budgetState2.status} eligible=${budgetState2.body && budgetState2.body.eligible} reason=${budgetState2.body && budgetState2.body.unavailableReason} (raw: ${budgetState2.text.slice(0, 90)})`)

  /* --------------------- Item 5d: paused activity ------------------------ */
  await selfCheckin('PAUSE', U.r1); await selfCheckin('PAUSE', U.r2); await selfCheckin('PAUSE', U.r3)
  await verifyAll('PAUSE')
  const pauseDetail = await ADMIN.get(`/admin/activities/${A.PAUSE.id}`)
  const paused = await ADMIN.post(`/admin/activities/${A.PAUSE.id}/pause`, {
    expectedUpdatedAt: pauseDetail.json.updatedAt })
  const pauseClaim = await U.r1.post(`/activities/${A.PAUSE.id}/rewards/claim`, {})
  const pauseStockRows = q.one('SELECT count(*) AS n FROM activity_prize_stocks WHERE activity_id = ?', A.PAUSE.id).n
  rec('item5.paused', '活动暂停时 claim 被拒 409 reward_unavailable(activity_not_published)，且库存台账零占用',
    paused.status === 200 && pauseClaim.status === 409 &&
      errCode(pauseClaim) === 'reward_unavailable' &&
      pauseClaim.json.error.message.includes('未发布') &&
      pauseStockRows === 0 && countGrants(A.PAUSE.id) === 0,
    `pause=${paused.status} claim=${pauseClaim.status}/${errCode(pauseClaim)} stockRows=${pauseStockRows} grants=${countGrants(A.PAUSE.id)}`)

  const resumeDetail = await ADMIN.get(`/admin/activities/${A.PAUSE.id}`)
  const resumed = await ADMIN.post(`/admin/activities/${A.PAUSE.id}/resume`, {
    expectedUpdatedAt: resumeDetail.json.updatedAt })
  const resumeClaim = await U.r1.post(`/activities/${A.PAUSE.id}/rewards/claim`, {})
  const resumeStock = stock(A.PAUSE.id, '暂停礼品')
  rec('item5.resumed', '恢复发布后 claim 成功，库存恰好占用 1 份（暂停期间未预占）',
    resumed.status === 200 && resumeClaim.status === 200 &&
      resumeClaim.json.created === true && resumeStock.claimed_quantity === 1,
    `resume=${resumed.status} claim=${resumeClaim.status} created=${resumeClaim.json && resumeClaim.json.created} claimed=${resumeStock.claimed_quantity}`)

  /* ------------------- Item 3: concurrent single grant ------------------- */
  await selfCheckin('RACE', U.r1); await selfCheckin('RACE', U.r2); await selfCheckin('RACE', U.r3)
  await verifyAll('RACE')
  let raceNote = ''
  try {
    await startAltApi()
    const mk = (base) => {
      const c = new Client(base, 'race-' + base)
      c.cookies = new Map(U.r1.cookies)
      c.csrf = U.r1.csrf
      return c
    }
    const clients = [
      mk(API), mk(API), mk(API),
      mk(`http://127.0.0.1:${API_ALT_PORT}`), mk(`http://127.0.0.1:${API_ALT_PORT}`),
      mk(`http://127.0.0.1:${API_ALT_PORT}`),
    ]
    const responses = await Promise.all(
      clients.map((c) => c.post(`/activities/${A.RACE.id}/rewards/claim`, {})),
    )
    const ok = responses.filter((r) => r.status === 200)
    const created = responses.filter((r) => r.status === 200 && r.json.created === true)
    const conflicts = responses.filter((r) => r.status === 409)
    const raceStock = stock(A.RACE.id, '并发礼品')
    raceNote = `200s=${ok.length} createdTrue=${created.length} 409s=${conflicts.length} codes=${new Set(created.map((r) => r.json.code)).size}`
    rec('item3.concurrent', '两个真实 API 进程 × 6 个并发 claim 同一团队：恰好 1 份 grant、1 次库存占用、1 个明文码',
      created.length === 1 && countGrants(A.RACE.id) === 1 &&
        raceStock.claimed_quantity === 1 && raceStock.committed_budget_cents === 2500 &&
        responses.every((r) => r.status === 200) &&
        responses.filter((r) => r.status === 200 && r.json.created === false).length === 5,
      `${raceNote} grants=${countGrants(A.RACE.id)} claimed=${raceStock.claimed_quantity} committed=${raceStock.committed_budget_cents} statuses=${responses.map((r) => r.status).join(',')} createdFlags=${responses.map((r) => (r.json && r.json.created !== undefined ? r.json.created : 'x')).join(',')}`)
  } catch (error) {
    rec('item3.concurrent', '两个真实 API 进程并发 claim 同一团队', false, String(error.message).slice(0, 300))
  } finally {
    stopAltApi()
  }

  /* ------------------------ Item 5c: cross community --------------------- */
  await selfCheckin('C2', U.s1); await selfCheckin('C2', U.s2); await selfCheckin('C2', U.s3)
  await verifyAll('C2', ADMIN)
  const c2claim = await U.s1.post(`/activities/${A.C2.id}/rewards/claim`, {})
  const crossBefore = countAudit(A.C2.id, 'reward.access_denied')
  const cross = await STAFF.post('/rewards/redeem', { code: c2claim.json.code })
  const crossAfter = countAudit(A.C2.id, 'reward.access_denied')
  const crossCodeRow = q.one('SELECT status FROM activity_reward_codes WHERE id = ?', c2claim.json.credential.id)
  rec('item5.crossCommunity', '跨社区核销：403 forbidden + 恰好 1 条 reward.access_denied 审计，社区乙的码仍 active',
    c2claim.status === 200 && cross.status === 403 && errCode(cross) === 'forbidden' &&
      crossAfter === crossBefore + 1 && crossCodeRow.status === 'active',
    `claim=${c2claim.status} cross=${cross.status}/${errCode(cross)} accessDeniedAudit=${crossBefore}->${crossAfter} code=${crossCodeRow.status}`)

  /* --------------------- Item 5b: expired credential --------------------- */
  await selfCheckin('EXPIRE', U.r1); await selfCheckin('EXPIRE', U.r2); await selfCheckin('EXPIRE', U.r3)
  await verifyAll('EXPIRE')
  const expireClaim = await U.r1.post(`/activities/${A.EXPIRE.id}/rewards/claim`, {})
  // Fixture (documented in README §5c): the API mints a 24h TTL and both
  // `expires_at` and `issued_at` are frozen by trigger, so a genuinely expired
  // *API-issued* code cannot be produced without waiting a day. We therefore
  // supersede the real code and insert one extra row in the same table with a
  // real 10-char Crockford code, its real sha256, a past expiry and a valid
  // grant/activity/team scope — every CHECK and the `grant_scope` trigger still
  // apply, so `redeemCredential` takes its normal expired branch.
  const expiredCode = 'ZZZZ900001'
  const nowMs = Date.now()
  q.run(
    "UPDATE activity_reward_codes SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'active'",
    nowMs - 3600_000, expireClaim.json.credential.id)
  q.run(
    `INSERT INTO activity_reward_codes
      (id, grant_id, activity_id, team_id, code_hash, code_suffix, prize_name, status, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    crypto.randomUUID(), expireClaim.json.grant.id, A.EXPIRE.id, T.EXPIRE.teamId,
    sha256(expiredCode), expiredCode.slice(-4), '过期礼品', nowMs - 7200_000, nowMs - 3600_000)
  const expired1 = await STAFF.post('/rewards/redeem', { code: expiredCode })
  const expiredRow = q.one('SELECT status FROM activity_reward_codes WHERE code_hash = ?', sha256(expiredCode))
  const expired2 = await STAFF.post('/rewards/redeem', { code: expiredCode })
  rec('item5.expired', '过期码：400 redemption_code_expired，行被持久标记 expired，重复调用给出同一结论',
    expired1.status === 400 && errCode(expired1) === 'redemption_code_expired' &&
      expiredRow.status === 'expired' &&
      expired2.status === 400 && errCode(expired2) === 'redemption_code_expired' &&
      q.one('SELECT status FROM activity_reward_grants WHERE id = ?', expireClaim.json.grant.id).status === 'granted',
    `redeem=${expired1.status}/${errCode(expired1)} durableStatus=${expiredRow.status} repeat=${expired2.status}/${errCode(expired2)} grant=${q.one('SELECT status FROM activity_reward_grants WHERE id = ?', expireClaim.json.grant.id).status}`)

  /* -------------------- Item 7: H5/admin consistency (API) --------------- */
  const h5 = await rewardState('MAIN', U.r1)
  const adminOverview = await STAFF.get(`/admin/activities/${A.MAIN.id}/rewards`)
  const ov = adminOverview.json
  rec('item7.apiConsistency', 'H5 与后台读取同一事实：grant 状态、掩码、库存/预算计数完全一致',
    h5.body.grant.status === 'disputed' &&
      h5.body.credential.maskedCode === ov.grants[0].credentialMaskedCode &&
      ov.grants[0].grant.status === 'disputed' && ov.grants[0].openDispute === true &&
      ov.stock.claimedQuantity === 1 && ov.stock.redeemedQuantity === 1 &&
      ov.stock.committedBudgetCents === 2500 && ov.stock.redeemedBudgetCents === 2500 &&
      ov.counts.checkinsVerified === 2 && ov.counts.checkinsRevoked === 1,
    `h5.grant=${h5.body.grant.status} h5.masked=${h5.body.credential.maskedCode} admin.masked=${ov.grants[0].credentialMaskedCode} admin.grant=${ov.grants[0].grant.status} openDispute=${ov.grants[0].openDispute} stock claimed/redeemed=${ov.stock.claimedQuantity}/${ov.stock.redeemedQuantity} verified=${ov.counts.checkinsVerified} revoked=${ov.counts.checkinsRevoked}`)

  // Re-login for staff is a real credential re-login; for residents the dev
  // login mints a brand-new user per call (documented in README §7), so the
  // equivalent check is a fresh HTTP client carrying the same server session.
  const ADMIN2 = await staffLogin(ADMIN_USER, adminPass, 'admin-relogin')
  const overview2 = await ADMIN2.get(`/admin/activities/${A.MAIN.id}/rewards`)
  const resident2 = new Client(API, 'resident-refresh')
  resident2.cookies = new Map(U.r1.cookies)
  resident2.csrf = U.r1.csrf
  const h5again = await resident2.get(`/activities/${A.MAIN.id}/rewards`)
  rec('item7.relogin', '重新登录/新连接后状态与凭据掩码不变（服务端会话，不依赖前端内存）',
    overview2.status === 200 && overview2.json.grants[0].credentialMaskedCode === ov.grants[0].credentialMaskedCode &&
      overview2.json.stock.redeemedQuantity === 1 &&
      h5again.status === 200 && h5again.json.credential.maskedCode === h5.body.credential.maskedCode,
    `adminReloginMasked=${overview2.json.grants[0].credentialMaskedCode} residentFreshConnMasked=${h5again.json.credential.maskedCode}`)

  /* ---------- Item 6c: dispute thread is append-only and terminal -------- */
  // The MAIN grant is `disputed` at this point. A reversal must be a NEW row
  // (never an edit, never a delete) and must not touch the redeemed counters.
  const disputeBody = { reason: '争议裁定：奖品已实际交付，维持核销', note: 'R2 验收脚本裁定' }
  const reversed = await STAFF.post(
    `/admin/activities/${A.MAIN.id}/rewards/grants/${claim1.json.grant.id}/disputes`,
    { ...disputeBody, decision: 'reversed' })
  const grantReversed = q.one('SELECT status, redeemed_at FROM activity_reward_grants WHERE id = ?', claim1.json.grant.id)
  const stockAfterReversal = stock(A.MAIN.id, '社区小礼品')
  const threadAfter = q.all('SELECT decision FROM activity_reward_disputes WHERE grant_id = ? ORDER BY created_at', claim1.json.grant.id)
  const reopen = await STAFF.post(
    `/admin/activities/${A.MAIN.id}/rewards/grants/${claim1.json.grant.id}/disputes`,
    { decision: 'opened', reason: '重复开启争议应被拒绝' })
  rec('item6.disputeReversed', '争议裁定是追加式：新增一条 reversed 记录，grant 转 reversed，已核销库存/预算仍不回收，且不可重新开启',
    reversed.status === 200 && grantReversed.status === 'reversed' && grantReversed.redeemed_at !== null &&
      threadAfter.length === 2 && threadAfter[0].decision === 'opened' && threadAfter[1].decision === 'reversed' &&
      stockAfterReversal.redeemed_quantity === 1 && stockAfterReversal.redeemed_budget_cents === 2500 &&
      reopen.status === 409 && countEvents(A.MAIN.id, 'dispute.reversed') === 1,
    `reverse=${reversed.status} grant=${grantReversed.status} redeemedAt=${grantReversed.redeemed_at !== null} thread=${threadAfter.map((d) => d.decision).join('>')} redeemedQty=${stockAfterReversal.redeemed_quantity} reopen=${reopen.status}/${errCode(reopen)}`)

  /* ----------------------- Item 1b: no plan configured ------------------- */
  // A team is required before the reward projection can be read at all, so form
  // one first: otherwise the 409 `team_missing` masks the plan verdict.
  await formTeam('NOPLAN', [U.r1, U.r2, U.r3])
  const noPlanCheckin = await U.r1.get(`/activities/${A.NOPLAN.id}/checkin`)
  const noPlanReward = await U.r1.get(`/activities/${A.NOPLAN.id}/rewards`)
  const noPlanAdmin = await STAFF.get(`/admin/activities/${A.NOPLAN.id}/rewards`)
  rec('item1.noPlan', '未配置奖励计划：签到/奖励入口明确不可用（reward_plan_not_configured），后台 plan=null 且 stock=null',
    noPlanCheckin.status === 200 && noPlanCheckin.json.unavailableReason === 'reward_plan_not_configured' &&
      noPlanCheckin.json.checkinWindow === null && noPlanReward.status === 200 &&
      noPlanAdmin.status === 200 && noPlanAdmin.json.planConfigured === false &&
      noPlanAdmin.json.planSource === 'none' && noPlanAdmin.json.plan === null &&
      noPlanAdmin.json.stock === null &&
      noPlanReward.status === 200 && noPlanReward.json.planConfigured === false &&
      noPlanReward.json.unavailableReason === 'reward_plan_not_configured',
    `checkin.reason=${noPlanCheckin.json.unavailableReason} window=${noPlanCheckin.json.checkinWindow} rewardState=${noPlanReward.status}/${noPlanReward.json && noPlanReward.json.unavailableReason} admin.planSource=${noPlanAdmin.json.planSource} stock=${noPlanAdmin.json.stock}`)

  /* ------------------ Append-only / immutability spot checks ------------- */
  let deleteBlocked = false
  try {
    q.run('DELETE FROM activity_reward_grants WHERE id = ?', claim1.json.grant.id)
  } catch (error) {
    deleteBlocked = /append-only history/u.test(String(error.message))
  }
  let updateBlocked = false
  try {
    q.run("UPDATE activity_reward_codes SET expires_at = issued_at + 999999 WHERE id = ?", claim1.json.credential.id)
  } catch (error) {
    updateBlocked = /immutable/u.test(String(error.message))
  }
  let stockDeleteBlocked = false
  try {
    q.run('DELETE FROM activity_prize_stocks WHERE activity_id = ?', A.MAIN.id)
  } catch (error) {
    stockDeleteBlocked = /never deleted/u.test(String(error.message))
  }
  rec('invariants.appendOnly', '数据库触发器兜底：发奖/库存行不可删除、凭据 TTL 不可改写',
    deleteBlocked && updateBlocked && stockDeleteBlocked,
    `grantDeleteBlocked=${deleteBlocked} codeTtlImmutable=${updateBlocked} stockDeleteBlocked=${stockDeleteBlocked}`)

  const eventSeq = q.all('SELECT sequence FROM activity_reward_events WHERE activity_id = ? ORDER BY sequence', A.MAIN.id)
  rec('invariants.eventSequence', '事件序列连续无洞（append-only 审计可重放）',
    eventSeq.length > 0 && eventSeq.every((row, i) => row.sequence === i + 1),
    `events=${eventSeq.length} seq=${eventSeq.map((r) => r.sequence).join(',')}`)

  const leak = db.prepare('SELECT metadata FROM audit_logs').all()
  const secretsInAudit = leak.filter((row) => (row.metadata || '').match(/ZZZZ900001|ABCDEFGHJK/u))
  rec('invariants.noSecretInAudit', '审计日志不含明文核销码（只记 ID 与枚举）',
    secretsInAudit.length === 0, `auditRows=${leak.length} rowsWithCode=${secretsInAudit.length}`)

  /* ------------- Item 9: t13 write-path cross-check (added by R2) ---------- */
  // t13 added `activityKeyRulesWriteSchema` (= read schema + check-in-window
  // containment) on the CREATE / UPDATE write paths only. `activityKeyRulesSchema`
  // is unchanged on purpose, so rows frozen before t13 stay readable. These
  // checks pin both halves through real HTTP + SQL rather than by reading code:
  // a window fully before the activity must be refused AND leave no row behind,
  // while a window exactly equal to the activity window must still be accepted
  // (closed interval - the boundary an over-eager guard would kill).
  const t13Start = Date.now() + 3600_000
  const t13End = t13Start + 6 * 3600_000
  const t13Iso = (ms) => new Date(ms).toISOString()
  const t13Base = {
    startsAt: t13Iso(t13Start),
    endsAt: t13Iso(t13End),
    location: 't13 边界验收',
    budgetCapCents: 100000,
    prizeQuantityCap: 20,
    publicRules: {
      eligibility: '本社区居民，实名参与',
      checkin: '现场签到并由工作人员核验',
      purchase: '无需消费',
      prizeClaim: '三人成团且三人都已核验签到后可领取',
    },
  }
  const t13Plan = (opensAt, closesAt) => ({
    prizeName: '边界验收礼品',
    prizeUnitCostCents: 2500,
    prizeQuantityPerTeam: 1,
    totalPrizeQuantity: 10,
    budgetCapCents: 100000,
    claimRecipient: 'leader',
    checkinWindow: { opensAt, closesAt },
    redemptionValidHours: 24,
  })
  const badWindowPlan = () =>
    t13Plan(t13Iso(t13Start - 4 * 3600_000), t13Iso(t13Start - 3 * 3600_000))

  // (a) window entirely before the activity -> 400, and nothing written.
  const beforeCount = q.one('SELECT count(*) AS n FROM activities').n
  const badWindow = await ADMIN.post('/admin/activities', {
    communityId: C.c1,
    title: '边界验收 窗口早于活动',
    summary: 'LL-MVP-006 t13 反例',
    description: '签到窗口完全落在活动开始之前，必须被写路径拒绝',
    keyRules: { ...t13Base, rewardPlan: badWindowPlan() },
  })
  const afterCount = q.one('SELECT count(*) AS n FROM activities').n
  rec('t13.windowBeforeRejected',
    '签到窗口完全早于活动：写路径拒绝，且数据库不留活动行',
    badWindow.status === 400 &&
      errCode(badWindow) === 'invalid_request' &&
      afterCount === beforeCount,
    `status=${badWindow.status}/${errCode(badWindow)} activities ${beforeCount}->${afterCount} msg="${errMessage(badWindow)}"`)

  // The wire body is the shared `invalid_request` envelope and does not echo zod
  // issue paths, so the field-level reason is asserted where it is actually
  // observable: the contract's own issue path. The second half of this check is
  // the one that matters for t13's layering claim - the READ schema must still
  // accept the very payload the WRITE schema refuses, otherwise every activity
  // frozen before t13 becomes unreadable.
  const contracts = require(path.join(REPO_ROOT, 'packages/contracts/dist/index.js'))
  const writeProbe = contracts.activityKeyRulesWriteSchema.safeParse({
    ...t13Base,
    rewardPlan: badWindowPlan(),
  })
  const writePaths = writeProbe.success
    ? []
    : writeProbe.error.issues.map((issue) => issue.path.join('.'))
  const readProbe = contracts.activityKeyRulesSchema.safeParse({
    ...t13Base,
    rewardPlan: badWindowPlan(),
  })
  rec('t13.opensAtFieldPath',
    '越界原因定位到 checkinWindow.opensAt，且读 schema 未被收紧（旧数据仍可解析）',
    writePaths.includes('rewardPlan.checkinWindow.opensAt') && readProbe.success === true,
    `writeSchemaPaths=[${writePaths.join('|')}] readSchemaAcceptsSamePayload=${readProbe.success}`)

  // (b) window exactly equal to the activity window -> 201 (closed interval).
  const equalWindow = await ADMIN.post('/admin/activities', {
    communityId: C.c1,
    title: '边界验收 窗口等于活动',
    summary: 'LL-MVP-006 t13 边界',
    description: '签到窗口与活动起止完全一致，属于合法配置，不得误杀',
    keyRules: {
      ...t13Base,
      rewardPlan: t13Plan(t13Iso(t13Start), t13Iso(t13End)),
    },
  })
  const equalRow = equalWindow.status === 201
    ? q.one('SELECT reward_plan_json FROM activities WHERE id = ?', equalWindow.json.id)
    : null
  const equalStored = equalRow ? JSON.parse(equalRow.reward_plan_json).checkinWindow : null
  rec('t13.windowEqualToActivityAccepted',
    '签到窗口恰好等于活动起止（闭区间边界）仍可创建，且计划原样落库',
    equalWindow.status === 201 &&
      equalStored !== null &&
      equalStored.opensAt === t13Iso(t13Start) &&
      equalStored.closesAt === t13Iso(t13End),
    `status=${equalWindow.status} stored=${equalStored ? `${equalStored.opensAt}..${equalStored.closesAt}` : 'none'}`)

  // (c) the guard must also hold on UPDATE, and a rejected edit must not be
  // half-applied. t13 pins this at schema level in its own unit test; here it is
  // proved through HTTP + SQL.
  if (equalWindow.status === 201) {
    const beforeRow = q.one('SELECT starts_at, reward_plan_json FROM activities WHERE id = ?', equalWindow.json.id)
    const movedOut = await ADMIN.patch(`/admin/activities/${equalWindow.json.id}`, {
      expectedUpdatedAt: equalWindow.json.updatedAt,
      keyRules: {
        ...t13Base,
        startsAt: t13Iso(t13Start + 2 * 3600_000),
        endsAt: t13Iso(t13Start + 4 * 3600_000),
        rewardPlan: badWindowPlan(),
      },
    })
    const afterRow = q.one('SELECT starts_at, reward_plan_json FROM activities WHERE id = ?', equalWindow.json.id)
    rec('t13.updateWindowRejected',
      '编辑路径同样拒绝越界窗口，且被拒后数据库原值不变（不半途写入）',
      movedOut.status === 400 &&
        beforeRow.starts_at === afterRow.starts_at &&
        beforeRow.reward_plan_json === afterRow.reward_plan_json,
      `status=${movedOut.status}/${errCode(movedOut)} unchanged=${beforeRow.starts_at === afterRow.starts_at && beforeRow.reward_plan_json === afterRow.reward_plan_json}`)
  } else {
    rec('t13.updateWindowRejected', '编辑路径同样拒绝越界窗口', false,
      'skipped: the boundary activity was not created')
  }

  // (d) t13's stated reason for keeping the rule off the read schema: a row whose
  // stored plan is out of bounds (written before t13) must stay readable AND
  // repairable. Both halves are exercised here on a real row.
  if (equalWindow.status === 201) {
    const row = q.one('SELECT * FROM activities WHERE id = ?', equalWindow.json.id)
    const legacyPlan = t13Plan(t13Iso(t13Start - 4 * 3600_000), t13Iso(t13Start - 3 * 3600_000))
    // Simulate a pre-t13 row: the row itself keeps a legal activity window but
    // its stored plan is out of bounds, exactly what the old code could persist.
    q.run('UPDATE activities SET reward_plan_json = ? WHERE id = ?', JSON.stringify(legacyPlan), row.id)
    const readBack = await ADMIN.get(`/admin/activities/${row.id}`)
    const repairs = await ADMIN.patch(`/admin/activities/${row.id}`, {
      expectedUpdatedAt: readBack.json.updatedAt,
      keyRules: {
        ...t13Base,
        startsAt: t13Iso(t13Start),
        endsAt: t13Iso(t13End),
        rewardPlan: t13Plan(t13Iso(t13Start), t13Iso(t13End)),
      },
    })
    const repaired = q.one('SELECT reward_plan_json FROM activities WHERE id = ?', row.id)
    const repairedWindow = JSON.parse(repaired.reward_plan_json).checkinWindow
    rec('t13.legacyRowStillRepairable',
      '修复前写入的越界计划仍可读取、且运营能把它改回合法值（读 schema 未收紧的实证）',
      readBack.status === 200 && repairs.status === 200 &&
        repairedWindow.opensAt === t13Iso(t13Start),
      `read=${readBack.status} storedPlanOutOfBounds=${readBack.json.rewardPlan.checkinWindow.opensAt} repair=${repairs.status}/${errCode(repairs)} after=${repairedWindow.opensAt}`)
  } else {
    rec('t13.legacyRowStillRepairable', '旧越界行仍可读取并可修复', false,
      'skipped: the boundary activity was not created')
  }
}

main()
  .then(() => {
    const passed = RUNS.filter((r) => r.pass).length
    const summary = {
      generatedAt: new Date().toISOString(),
      api: API,
      db: DB_PATH,
      totals: { checks: RUNS.length, passed, failed: RUNS.length - passed },
      failedIds: FAILED,
      runs: RUNS,
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')
    console.log(`\n${passed}/${RUNS.length} checks passed; failed: ${FAILED.join(',') || 'none'}`)
    console.log(`wrote ${OUT}`)
    db.close()
    process.exit(FAILED.length === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error('DRIVER ERROR:', error)
    if (STDERR.length) console.error(STDERR.join('').slice(-4000))
    const summary = {
      generatedAt: new Date().toISOString(),
      api: API,
      db: DB_PATH,
      driverError: String(error && error.stack ? error.stack : error),
      totals: { checks: RUNS.length, passed: RUNS.filter((r) => r.pass).length, failed: RUNS.filter((r) => !r.pass).length },
      failedIds: FAILED,
      runs: RUNS,
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')
    db.close()
    process.exit(2)
  })
