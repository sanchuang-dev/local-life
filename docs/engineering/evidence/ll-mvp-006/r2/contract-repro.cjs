#!/usr/bin/env node
/**
 * 根因可复现片段（Issue #62 / Finding A）。
 *
 * 修复前的 `buildTeamRewardState` 分别计算 `eligible` 与 `unavailableReason`：
 * 库存/预算耗尽时两者会同时给出 `eligible: true` 和
 * `unavailableReason: 'stock_exhausted'`。契约的 `teamRewardStateSchema`
 * 有 superRefine 要求「eligible 为真 ⇒ unavailableReason 必须为 null」，
 * 于是 `.parse()` 抛 ZodError，路由层兜底成 500 internal_error。
 *
 * 这个脚本不依赖数据库与 HTTP，只拿契约本身复现那一步：把一对自相矛盾的
 * 字段喂给 schema，看它是否真的拒绝。它证明的是「为什么 500」，不是
 * 「接口当时返回了什么」——后者由 r2-api-runs.before-fix.json 里的两条
 * 原始 500 响应（含 requestId）负责。
 *
 * 用法：node docs/engineering/evidence/ll-mvp-006/r2/contract-repro.cjs
 */
'use strict'

const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const contracts = require(path.join(REPO_ROOT, 'packages/contracts/dist/index.js'))

const NOW = new Date().toISOString()

/** 一个除 eligible/unavailableReason 外完全合法的 teamRewardState。 */
function state(overrides) {
  return {
    activityId: '11111111-1111-4111-8111-111111111111',
    teamId: '22222222-2222-4222-8222-222222222222',
    ruleVersion: 1,
    planConfigured: true,
    reward: {
      prizeName: '社区小礼品',
      prizeUnitCostCents: 2500,
      prizeQuantityPerTeam: 1,
      claimRecipient: 'leader',
      redemptionValidHours: 24,
      checkinWindow: { opensAt: NOW, closesAt: NOW },
    },
    requirement: {
      seatsRequired: 3,
      seatsFilled: 3,
      seatsSatisfied: true,
      checkinsRequired: 3,
      checkinsValid: 3,
      checkinsSatisfied: true,
    },
    eligible: true,
    unavailableReason: null,
    claimableByMe: true,
    grant: null,
    credential: null,
    ...overrides,
  }
}

const cases = [
  {
    id: 'baseline.ok',
    label: '对照：eligible=true 且 unavailableReason=null —— 契约应当接受',
    payload: state({}),
    expect: 'ok',
  },
  {
    id: 'bug.stockExhausted',
    label: '修复前的自我矛盾态：eligible=true 同时 unavailableReason=stock_exhausted',
    payload: state({ unavailableReason: 'stock_exhausted' }),
    expect: 'reject',
  },
  {
    id: 'bug.budgetExhausted',
    label: '修复前的自我矛盾态：eligible=true 同时 unavailableReason=budget_exhausted',
    payload: state({ unavailableReason: 'budget_exhausted' }),
    expect: 'reject',
  },
  {
    id: 'fixed.stockExhausted',
    label: '修复后的正确形态：eligible=false + unavailableReason=stock_exhausted —— 契约接受',
    payload: state({ eligible: false, claimableByMe: false, unavailableReason: 'stock_exhausted' }),
    expect: 'ok',
  },
]

let failed = 0
const runs = []
for (const item of cases) {
  const result = contracts.teamRewardStateSchema.safeParse(item.payload)
  const observed = result.success ? 'ok' : 'reject'
  const pass = observed === item.expect
  if (!pass) failed += 1
  const issue = result.success
    ? null
    : (result.error.issues[0] && `${result.error.issues[0].path.join('.')}: ${result.error.issues[0].message}`) || 'unknown'
  runs.push({ id: item.id, label: item.label, expect: item.expect, observed, pass, firstIssue: issue })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${item.id} :: expect=${item.expect} observed=${observed}${issue ? ` :: ${issue}` : ''}`)
}

const out = path.join(__dirname, 'r2-contract-repro.json')
require('node:fs').writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      contractModule: 'packages/contracts/dist/index.js',
      schema: 'teamRewardStateSchema',
      totals: { checks: runs.length, passed: runs.length - failed, failed },
      runs,
    },
    null,
    2,
  ) + '\n',
)
console.log(`\n${runs.length - failed}/${runs.length} contract probes behaved as expected; wrote ${out}`)
process.exit(failed === 0 ? 0 : 1)
