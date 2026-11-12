/**
 * Contract self-check for `reconciliationDiffSchema` (LL-MVP-008 / Issue #64).
 *
 * Why this file exists: the diff DTO is the one shape the API server *produces*
 * and the admin UI *parses*. A field-level mismatch between
 * `packages/contracts/src/ledger.ts` and the layer that builds the diff does not
 * fail the build — it explodes at runtime inside `schema.parse`, i.e. exactly
 * when a user opens the reconciliation page. So the alignment is asserted here
 * instead of trusted.
 *
 * Two kinds of assertion, both re-runnable:
 *   1. **Set equality** — the schema's required field set must equal the domain
 *      service interface's field set, read verbatim from the service source.
 *      Adding a field on one side only turns this red immediately.
 *   2. **Round-trip** — an object shaped exactly like the service's return block
 *      must parse; a missing field and an unknown field must both fail (the
 *      schema is `strictObject`, so both directions matter), and the four
 *      adapter-supplied drill-down fields must still be strictly validated when
 *      present.
 *
 * Run from the repo root (the `test` script builds `dist` first):
 *   pnpm --filter @sanchuang-dev/local-life-contracts test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  ledgerAnomalySeveritySchema,
  reconciliationBatchStatusSchema,
  reconciliationBatchTotalsSchema,
  reconciliationDiffItemSchema,
  reconciliationDiffReasonSchema,
  reconciliationDiffSchema,
  reconciliationDiffSummarySchema,
} from '@sanchuang-dev/local-life-contracts'

const here = dirname(fileURLToPath(import.meta.url))
const SERVICE_SOURCE = resolve(here, '../../../apps/api/src/ledger/reconciliation-service.ts')

/** Field names declared by an exported TypeScript interface, in source order. */
function interfaceFields(block) {
  const fields = []
  for (const line of block.split('\n').slice(1)) {
    const trimmed = line.trim()
    // Skip the closing brace, and doc/comment lines - any of them may contain
    // a colon (`@param x:`) that is not a field declaration.
    if (!trimmed || trimmed === '}' || trimmed.startsWith('*') || trimmed.startsWith('//')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\??:/)
    if (match) fields.push(match[1])
  }
  return fields
}

function serviceDiffInterfaceFields() {
  const source = readFileSync(SERVICE_SOURCE, 'utf8')
  const start = source.indexOf('export interface ReconciliationDiff {')
  assert.notEqual(start, -1, 'ReconciliationDiff interface must exist in the service')
  const end = source.indexOf('\n}', start)
  assert.notEqual(end, -1, 'ReconciliationDiff interface must be closed')
  return interfaceFields(source.slice(start, end))
}

/** A key is optional when `undefined` is an accepted input for it. */
function isOptional(schema) {
  return schema.safeParse(undefined).success
}

/** Keys the schema refuses to do without. */
function requiredKeys(schema) {
  return Object.entries(schema.shape)
    .filter(([, value]) => !isOptional(value))
    .map(([key]) => key)
}

/**
 * An object shaped exactly like `getReconciliationDiff`'s return block for an
 * ad-hoc period (no batch row), which is the smallest legal *domain* payload.
 * The HTTP adapter adds the four drill-down fields on top of this.
 */
function serviceShapedDiff(overrides = {}) {
  return {
    batchId: null,
    batchNo: null,
    status: null,
    periodFrom: '2026-11-01',
    periodTo: '2026-11-07',
    stored: null,
    computed: { entryCount: 0, totalCents: 0 },
    items: [],
    summary: { total: 0, low: 0, medium: 0, high: 0 },
    lateRecordedCount: 0,
    lateRecordedTotalCents: 0,
    asOf: '2026-11-07T03:00:00.000Z',
    ...overrides,
  }
}

const DRILL_DOWN_KEYS = [
  'unbatchedCount',
  'unbatchedTotalCents',
  'unbatchedEntries',
  'openAnomalies',
]

describe('reconciliationDiffSchema vs the reconciliation service', () => {
  it('required fields equal the domain interface fields, exactly', () => {
    assert.deepEqual(
      requiredKeys(reconciliationDiffSchema).sort(),
      serviceDiffInterfaceFields().sort(),
    )
  })

  it('only the adapter-supplied drill-down fields are optional', () => {
    const optional = Object.keys(reconciliationDiffSchema.shape)
      .filter((key) => isOptional(reconciliationDiffSchema.shape[key]))
      .sort()
    assert.deepEqual(optional, [...DRILL_DOWN_KEYS].sort())
  })

  it('is a strictObject: an unknown field is rejected', () => {
    const parsed = reconciliationDiffSchema.safeParse(serviceShapedDiff({ unbatchedEntryCount: 1 }))
    assert.equal(parsed.success, false)
    assert.ok(parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys'))
  })

  it('rejects a misspelled field instead of silently dropping it', () => {
    assert.equal(
      reconciliationDiffSchema.safeParse(serviceShapedDiff({ batchno: 'RC-1' })).success,
      false,
    )
  })
})

describe('reconciliationDiffSchema round-trip', () => {
  it('parses the smallest domain-shaped payload (ad-hoc period)', () => {
    assert.equal(reconciliationDiffSchema.safeParse(serviceShapedDiff()).success, true)
  })

  it('parses a locked batch with findings and late-recorded facts', () => {
    const parsed = reconciliationDiffSchema.safeParse(
      serviceShapedDiff({
        batchId: '33333333-3333-4333-8333-333333333333',
        batchNo: 'RC-2026-11-01',
        status: 'locked',
        stored: { entryCount: 3, totalCents: 4500 },
        computed: { entryCount: 3, totalCents: 4500 },
        items: [
          {
            reason: 'late_recorded_after_lock',
            severity: 'medium',
            entryId: null,
            sourceDisplayNo: null,
            detail: '锁后补录 1 条',
          },
        ],
        summary: { total: 1, low: 0, medium: 1, high: 0 },
        lateRecordedCount: 2,
        lateRecordedTotalCents: 900,
      }),
    )
    assert.equal(parsed.success, true)
  })

  it('parses the adapter-shaped payload that carries the drill-down details', () => {
    const parsed = reconciliationDiffSchema.safeParse(
      serviceShapedDiff({
        unbatchedCount: 0,
        unbatchedTotalCents: 0,
        unbatchedEntries: [],
        openAnomalies: [],
      }),
    )
    assert.equal(parsed.success, true)
  })

  it('still validates the drill-down fields when the adapter supplies them', () => {
    // Present-but-wrong must fail: `optional` widens what is *allowed*, not what
    // is *accepted*. A drill-down count that is not a count is still refused.
    assert.equal(
      reconciliationDiffSchema.safeParse(serviceShapedDiff({ unbatchedCount: -1 })).success,
      false,
    )
    assert.equal(
      reconciliationDiffSchema.safeParse(serviceShapedDiff({ unbatchedTotalCents: 1.5 })).success,
      false,
    )
    assert.equal(
      reconciliationDiffSchema.safeParse(serviceShapedDiff({ unbatchedEntries: [{}] })).success,
      false,
    )
    assert.equal(
      reconciliationDiffSchema.safeParse(serviceShapedDiff({ openAnomalies: [{}] })).success,
      false,
    )
  })

  it('rejects a payload missing a required field', () => {
    const payload = serviceShapedDiff()
    delete payload.computed
    const parsed = reconciliationDiffSchema.safeParse(payload)
    assert.equal(parsed.success, false)
    assert.ok(parsed.error.issues.some((issue) => issue.path[0] === 'computed'))
  })
})

describe('reconciliationDiffSchema cross-field rules', () => {
  const oneFinding = (severity, reason = 'open_anomaly') => [
    { reason, severity, entryId: null, sourceDisplayNo: null, detail: '需要人看一眼' },
  ]

  it('accepts a summary that agrees with the findings', () => {
    const parsed = reconciliationDiffSchema.safeParse(
      serviceShapedDiff({
        items: oneFinding('high'),
        summary: { total: 1, low: 0, medium: 0, high: 1 },
      }),
    )
    assert.equal(parsed.success, true)
  })

  it('rejects summary.total that disagrees with items.length', () => {
    const parsed = reconciliationDiffSchema.safeParse(
      serviceShapedDiff({ items: oneFinding('low') }),
    )
    assert.equal(parsed.success, false)
  })

  it('rejects a per-severity count that disagrees with the findings', () => {
    const parsed = reconciliationDiffSchema.safeParse(
      serviceShapedDiff({
        items: oneFinding('high'),
        summary: { total: 1, low: 1, medium: 0, high: 0 },
      }),
    )
    assert.equal(parsed.success, false)
  })

  it('rejects an unknown diff reason', () => {
    const parsed = reconciliationDiffSchema.safeParse(
      serviceShapedDiff({
        items: oneFinding('low', 'unknown_reason'),
        summary: { total: 1, low: 1, medium: 0, high: 0 },
      }),
    )
    assert.equal(parsed.success, false)
  })

  it('keeps money as integer cents', () => {
    assert.equal(
      reconciliationDiffSchema.safeParse(
        serviceShapedDiff({ computed: { entryCount: 1, totalCents: 1.5 } }),
      ).success,
      false,
    )
  })

  it('keeps the status enum closed', () => {
    assert.equal(
      reconciliationDiffSchema.safeParse(serviceShapedDiff({ status: 'closed' })).success,
      false,
    )
  })
})

describe('the new sub-schemas', () => {
  it('lists exactly the six diff reasons, in a stable order', () => {
    assert.deepEqual(reconciliationDiffReasonSchema.options, [
      'pending_attribution',
      'open_anomaly',
      'reversal_original_outside_period',
      'batch_totals_drift',
      'late_recorded_after_lock',
      'empty_period',
    ])
  })

  it('reuses the anomaly severity enum rather than restating it', () => {
    assert.deepEqual(
      reconciliationDiffItemSchema.shape.severity.options,
      ledgerAnomalySeveritySchema.options,
    )
  })

  it('reuses the batch status enum rather than restating it', () => {
    const statusSchema = reconciliationDiffSchema.shape.status
    assert.equal(statusSchema.safeParse('open').success, true)
    assert.equal(statusSchema.safeParse('locked').success, true)
    assert.equal(statusSchema.safeParse(null).success, true)
    assert.equal(statusSchema.safeParse('closed').success, false)
    assert.deepEqual(reconciliationBatchStatusSchema.options, ['open', 'locked'])
  })

  it('requires a human-readable detail on every finding', () => {
    const base = { reason: 'empty_period', severity: 'low', entryId: null, sourceDisplayNo: null }
    assert.equal(reconciliationDiffItemSchema.safeParse({ ...base, detail: '' }).success, false)
    assert.equal(
      reconciliationDiffItemSchema.safeParse({ ...base, detail: 'x'.repeat(501) }).success,
      false,
    )
    assert.equal(
      reconciliationDiffItemSchema.safeParse({ ...base, detail: '期间内没有任何流水' }).success,
      true,
    )
  })

  it('counts four non-negative integers in the summary', () => {
    assert.deepEqual(Object.keys(reconciliationDiffSummarySchema.shape), [
      'total',
      'low',
      'medium',
      'high',
    ])
    assert.equal(
      reconciliationDiffSummarySchema.safeParse({ total: 0, low: 0, medium: 0, high: 0 }).success,
      true,
    )
    assert.equal(
      reconciliationDiffSummarySchema.safeParse({ total: -1, low: 0, medium: 0, high: 0 }).success,
      false,
    )
  })

  it('pairs entryCount with an integer-cents total', () => {
    assert.equal(
      reconciliationBatchTotalsSchema.safeParse({ entryCount: 3, totalCents: 4500 }).success,
      true,
    )
    assert.equal(
      reconciliationBatchTotalsSchema.safeParse({ entryCount: 3, totalCents: 45.5 }).success,
      false,
    )
  })
})
