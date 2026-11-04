import { createHash, randomUUID } from 'node:crypto'
import { and, count, eq, gt, inArray } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  crmebOrderSyncResponseSchema,
  type CrmebOrderStatus,
  type CrmebOrderSyncRequest,
  type CrmebOrderSyncResponse,
  type CrmebRawOrder,
  type CrmebRawRefund,
  type CrmebSyncError,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  crmebIdentities,
  crmebOrderEvents,
  crmebOrders,
  crmebRefunds,
  crmebSyncRuns,
} from '../db/schema.js'
import { logEvent } from '../log.js'
import { CrmebClientError, type CrmebOutapiClient } from './client.js'
import { CrmebDomainError } from './errors.js'
import { parseDecimalYuanToCents } from './money.js'

const CHANNEL = 'crmeb' as const
const VALID_TRANSACTION_STATUSES: CrmebOrderStatus[] = [
  'unshipped',
  'shipped',
  'received',
  'completed',
]

/** SQLite transactions in this adapter are synchronous, so one guard is enough. */
let syncRunning = false

/** Bounds one run to 100 x 100 refund rows; the cursor marks truncation explicitly. */
const REFUND_SCAN_MAX_PAGES = 100

export interface CrmebOrderSignals {
  paid: boolean
  status: number
  refundStatus: number | null
}

/**
 * Normalises CRMEB order fields into the platform enum, strictly in the
 * priority order from evidence §11.3. CRMEB's Chinese `status_name` is never
 * consulted. Unknown integers stay `unknown` instead of being guessed.
 */
export function mapCrmebOrderStatus(signals: CrmebOrderSignals): CrmebOrderStatus {
  const { paid, status, refundStatus } = signals
  if (refundStatus === 2 || status === -2) return 'refunded'
  if (refundStatus === 3 || refundStatus === 4) return 'partial_refund'
  if (refundStatus === 1 || status === -1) return 'refunding'
  // A cancelled-unpaid order is indistinguishable from a never-paid one
  // (outapi has no `is_cancel`), so both stay `unpaid` and never count as a sale.
  if (!paid) return 'unpaid'
  if (status === 0) return 'unshipped'
  if (status === 1 || status === 4) return 'shipped'
  if (status === 2) return 'received'
  if (status === 3) return 'completed'
  return 'unknown'
}

/** Only paid, non-refund, non-unknown states count as a valid transaction. */
export function isValidCrmebTransaction(
  status: CrmebOrderStatus,
  paid: boolean,
): boolean {
  return paid && VALID_TRANSACTION_STATUSES.includes(status)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function secondsToDate(value: number | null | undefined): Date | null {
  if (value === null || value === undefined || value <= 0) return null
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date
}

function requireCents(value: unknown, context: string): number {
  const cents = parseDecimalYuanToCents(value)
  if (cents === null) {
    throw new CrmebClientError(
      'contract_mismatch',
      `CRMEB ${context} 金额无法按 decimal 解析`,
    )
  }
  return cents
}

function optionalCents(value: unknown, context: string): number {
  if (value === null || value === undefined || value === '') return 0
  return requireCents(value, context)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatCrmebDate(date: Date): string {
  // Evidence §5.6: CRMEB splits the window on '-', so ISO strings corrupt it.
  return [
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  ].join(' ')
}

/** Builds the CRMEB `data` window (`YYYY/MM/DD HH:mm:ss-YYYY/MM/DD HH:mm:ss`, UTC). */
export function formatCrmebDateWindow(since: Date, until: Date): string {
  return `${formatCrmebDate(since)}-${formatCrmebDate(until)}`
}

function errorCodeOf(error: unknown): string {
  if (error instanceof CrmebClientError) return error.kind
  if (error instanceof CrmebDomainError) return error.code
  return 'internal_error'
}

function errorMessageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'unknown error'
  return raw.replace(/\s+/g, ' ').slice(0, 300)
}

function itemsSnapshot(raw: CrmebRawOrder): unknown[] {
  return (raw.items ?? []).map((item) => ({
    name: item.store_name ?? '',
    sku: item.suk ?? null,
    image: item.image ?? null,
    priceCents: parseDecimalYuanToCents(item.price ?? 0),
    quantity: Number(item.cart_num ?? 0),
  }))
}

interface PersistedOrder {
  created: boolean
  updated: boolean
  events: number
  rowId: string
}

function persistOrder(
  db: AppDatabase,
  raw: CrmebRawOrder,
  refundCount: number,
  syncedAt: Date,
): PersistedOrder {
  const externalOrderId = raw.id
  if (!Number.isSafeInteger(externalOrderId) || externalOrderId <= 0) {
    throw new CrmebClientError('contract_mismatch', 'CRMEB 订单 id 不是正整数')
  }
  const rawStatus = raw.status
  if (!Number.isSafeInteger(rawStatus)) {
    throw new CrmebClientError('contract_mismatch', 'CRMEB 订单 status 不是整数')
  }
  const paid = raw.paid === 1
  const refundStatus =
    raw.refund_status === null || raw.refund_status === undefined
      ? null
      : Number(raw.refund_status)
  if (refundStatus !== null && !Number.isSafeInteger(refundStatus)) {
    throw new CrmebClientError('contract_mismatch', 'CRMEB 订单 refund_status 不是整数')
  }

  const payAmountCents =
    raw.pay_price === null || raw.pay_price === undefined
      ? paid
        ? Number.NaN
        : 0
      : requireCents(raw.pay_price, `订单 ${raw.order_id} 的 pay_price`)
  if (!Number.isFinite(payAmountCents)) {
    throw new CrmebClientError(
      'contract_mismatch',
      `CRMEB 订单 ${raw.order_id} 缺少 pay_price`,
    )
  }

  const status = mapCrmebOrderStatus({ paid, status: rawStatus, refundStatus })
  // Conservative rule from the integration decision: any after-sale record
  // (refund_type > 0) excludes the order from valid transactions for now.
  const validTransaction = isValidCrmebTransaction(status, paid) && refundCount === 0
  const crmebUid = raw.uid === null || raw.uid === undefined ? null : Number(raw.uid)
  const identity =
    crmebUid === null
      ? undefined
      : db
          .select({ platformUserId: crmebIdentities.platformUserId })
          .from(crmebIdentities)
          .where(
            and(
              eq(crmebIdentities.crmebUid, crmebUid),
              eq(crmebIdentities.status, 'active'),
            ),
          )
          .get()

  const rawHash = sha256(canonicalJson(raw))
  const eventKey = `order:${paid ? 1 : 0}:${rawStatus}:${refundStatus ?? 'none'}`
  const eventPayload = {
    paid,
    rawStatus,
    refundStatus,
    status,
    validTransaction,
    source: 'outapi_pull',
  }
  const eventPayloadJson = JSON.stringify(eventPayload)

  return db.transaction((tx) => {
    // The numeric CRMEB id is the stable identity; order_id is only a business
    // number. Look up by id first and refuse to overwrite a row whose order_id
    // or numeric id changed underneath us.
    const existingById = tx
      .select()
      .from(crmebOrders)
      .where(
        and(
          eq(crmebOrders.channel, CHANNEL),
          eq(crmebOrders.externalOrderId, externalOrderId),
        ),
      )
      .get()
    if (existingById && existingById.externalOrderNo !== raw.order_id) {
      throw new CrmebClientError(
        'contract_mismatch',
        `CRMEB 订单 id ${externalOrderId} 的 order_id 由 ${existingById.externalOrderNo} 变为 ${raw.order_id}，拒绝覆盖`,
      )
    }
    const existingByNo = tx
      .select()
      .from(crmebOrders)
      .where(
        and(
          eq(crmebOrders.channel, CHANNEL),
          eq(crmebOrders.externalOrderNo, raw.order_id),
        ),
      )
      .get()
    if (existingByNo && existingByNo.externalOrderId !== externalOrderId) {
      throw new CrmebClientError(
        'contract_mismatch',
        `CRMEB order_id ${raw.order_id} 的数字 id 由 ${existingByNo.externalOrderId} 变为 ${externalOrderId}，保留旧行`,
      )
    }
    const existing = existingById ?? existingByNo

    const values = {
      channel: CHANNEL,
      externalOrderId,
      externalOrderNo: raw.order_id,
      crmebUid,
      platformUserId: identity?.platformUserId ?? null,
      payType: raw.pay_type ?? null,
      payAmountCents,
      paid,
      status,
      rawStatus,
      refundStatus,
      validTransaction,
      rawHash,
      itemsJson: JSON.stringify(itemsSnapshot(raw)),
      orderedAt: secondsToDate(raw.add_time),
      paidAt: secondsToDate(raw.pay_time),
      syncedAt,
      updatedAt: syncedAt,
    }

    let rowId: string
    let created = false
    let updated = false
    if (!existing) {
      rowId = randomUUID()
      tx.insert(crmebOrders)
        .values({ id: rowId, createdAt: syncedAt, ...values })
        .run()
      created = true
    } else {
      rowId = existing.id
      if (
        existing.rawHash !== rawHash ||
        existing.status !== status ||
        existing.paid !== paid ||
        existing.refundStatus !== refundStatus ||
        existing.validTransaction !== validTransaction ||
        existing.platformUserId !== (identity?.platformUserId ?? null)
      ) {
        tx.update(crmebOrders)
          .set({ ...values, updatedAt: syncedAt })
          .where(eq(crmebOrders.id, rowId))
          .run()
        updated = true
      }
    }

    const inserted = tx
      .insert(crmebOrderEvents)
      .values({
        id: randomUUID(),
        orderId: rowId,
        eventKey,
        payloadHash: sha256(eventPayloadJson),
        payloadJson: eventPayloadJson,
        occurredAt: syncedAt,
        createdAt: syncedAt,
      })
      .onConflictDoNothing()
      .run()

    return { created, updated, rowId, events: inserted.changes > 0 ? 1 : 0 }
  })
}

interface PersistedRefund {
  created: boolean
  updated: boolean
  events: number
  matchedOrder: boolean
}

function persistRefund(
  db: AppDatabase,
  raw: CrmebRawRefund,
  syncedAt: Date,
): PersistedRefund {
  if (!Number.isSafeInteger(raw.id) || raw.id <= 0) {
    throw new CrmebClientError('contract_mismatch', 'CRMEB 售后单 id 不是正整数')
  }
  const storeOrderId = raw.store_order_id
  if (!Number.isSafeInteger(storeOrderId) || storeOrderId <= 0) {
    throw new CrmebClientError('contract_mismatch', 'CRMEB 售后单缺少 store_order_id')
  }
  const refundType = raw.refund_type
  if (!Number.isSafeInteger(refundType) || refundType < 0) {
    throw new CrmebClientError('contract_mismatch', 'CRMEB 售后单 refund_type 不是整数')
  }
  const refundAmountCents = optionalCents(
    raw.refund_price ?? raw.pay_price,
    `售后单 ${raw.order_id} 的退款金额`,
  )
  const refundedAmountCents = optionalCents(
    raw.refunded_price,
    `售后单 ${raw.order_id} 的已退金额`,
  )
  const rawHash = sha256(canonicalJson(raw))
  const refundedAt = secondsToDate(raw.refunded_time)
  const addTime = secondsToDate(raw.add_time)

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(crmebRefunds)
      .where(
        and(
          eq(crmebRefunds.channel, CHANNEL),
          eq(crmebRefunds.externalRefundNo, raw.order_id),
        ),
      )
      .get()

    const values = {
      channel: CHANNEL,
      externalRefundId: raw.id,
      externalRefundNo: raw.order_id,
      externalOrderId: storeOrderId,
      refundType,
      refundAmountCents,
      refundedAmountCents,
      refundedAt,
      addTime,
      rawHash,
      syncedAt,
      updatedAt: syncedAt,
    }

    let created = false
    let updated = false
    if (!existing) {
      tx.insert(crmebRefunds)
        .values({ id: randomUUID(), createdAt: syncedAt, ...values })
        .run()
      created = true
    } else if (existing.rawHash !== rawHash) {
      tx.update(crmebRefunds)
        .set(values)
        .where(eq(crmebRefunds.id, existing.id))
        .run()
      updated = true
    }

    const order = tx
      .select({ id: crmebOrders.id, validTransaction: crmebOrders.validTransaction })
      .from(crmebOrders)
      .where(
        and(
          eq(crmebOrders.channel, CHANNEL),
          eq(crmebOrders.externalOrderId, storeOrderId),
        ),
      )
      .get()
    if (!order) {
      return { created, updated, events: 0, matchedOrder: false }
    }

    // Any after-sale application excludes the order from valid transactions.
    // Order status itself stays whatever the authoritative order detail says.
    if (order.validTransaction) {
      tx.update(crmebOrders)
        .set({ validTransaction: false, updatedAt: syncedAt })
        .where(eq(crmebOrders.id, order.id))
        .run()
    }

    const eventKey = `refund:${raw.order_id}:${refundType}`
    const eventPayloadJson = JSON.stringify({
      refundNo: raw.order_id,
      refundType,
      refundAmountCents,
      refundedAmountCents,
      source: 'outapi_pull',
    })
    const inserted = tx
      .insert(crmebOrderEvents)
      .values({
        id: randomUUID(),
        orderId: order.id,
        eventKey,
        payloadHash: sha256(eventPayloadJson),
        payloadJson: eventPayloadJson,
        occurredAt: syncedAt,
        createdAt: syncedAt,
      })
      .onConflictDoNothing()
      .run()

    return {
      created,
      updated,
      events: inserted.changes > 0 ? 1 : 0,
      matchedOrder: true,
    }
  })
}

export interface CrmebOrderSyncDeps {
  db: AppDatabase
  client: CrmebOutapiClient
  actorUserId: string
  /** Role of the real staff session that triggered the run. */
  actorRole: 'admin'
  request: CrmebOrderSyncRequest
}

/**
 * Pull-based order reconciliation.
 *
 * 1. `order/list` discovers orders (newest first by `add_time`).
 * 2. `order/<order_id>` detail is the only authoritative source for
 *    `status`/`refund_status` (the list response unsets `refund_status`).
 * 3. `refund/list` refreshes after-sale records and excludes refunded orders.
 * 4. Every run is audited with window, counts, cursor and errors; nothing is
 *    swallowed and the next run is always allowed to retry.
 *
 * Concurrency: an in-process guard rejects overlapping runs. The unique keys on
 * orders/events/refunds additionally make repeated or racing runs idempotent.
 */
export async function runCrmebOrderSync(
  deps: CrmebOrderSyncDeps,
): Promise<CrmebOrderSyncResponse> {
  const { db, client, actorUserId, actorRole, request } = deps
  if (syncRunning) {
    throw new CrmebDomainError(
      409,
      API_ERROR_CODES.crmebSyncInProgress,
      '已有 CRMEB 订单同步正在运行，请稍后重试',
    )
  }
  syncRunning = true

  const startedAt = new Date()
  const runId = randomUUID()
  const refundPage = request.refundPage ?? 1
  const refundLimit = request.refundLimit ?? 100
  const scope = {
    page: request.page ?? 1,
    limit: request.limit ?? 50,
    sinceAddTime: request.sinceAddTime ?? null,
    refundPage,
    refundLimit,
    refundScan: 'mandatory' as const,
    actorRole,
  }
  const errors: CrmebSyncError[] = []
  const orders = { scanned: 0, created: 0, updated: 0, unchanged: 0, failed: 0 }
  const refunds = {
    scanned: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    unmatched: 0,
  }
  let eventsAppended = 0
  const refundCursor = {
    page: refundPage,
    pageSize: refundLimit,
    pagesScanned: 0,
    nextPage: null as number | null,
    hasMore: false,
    complete: false,
    lastExternalRefundNo: null as string | null,
    lastRefundAddTime: null as string | null,
  }
  let cursor = {
    lastAddTime: null as string | null,
    lastExternalOrderNo: null as string | null,
    refunds: refundCursor,
  }
  const processedOrderIds: string[] = []

  db.insert(crmebSyncRuns)
    .values({
      id: runId,
      status: 'running',
      trigger: 'admin_manual',
      actorRole,
      actorUserId,
      scopeJson: JSON.stringify(scope),
      startedAt,
      createdAt: startedAt,
    })
    .run()

  try {
    const dataWindow = request.sinceAddTime
      ? formatCrmebDateWindow(new Date(request.sinceAddTime), startedAt)
      : undefined
    const list = await client.listOrders({
      page: scope.page,
      limit: scope.limit,
      dataWindow,
    })

    for (const listed of list.list) {
      orders.scanned += 1
      cursor = {
        lastAddTime: secondsToDate(listed.add_time)?.toISOString() ?? null,
        lastExternalOrderNo: listed.order_id,
        refunds: refundCursor,
      }
      try {
        const detail = await client.getOrderDetail(listed.order_id)
        const refundRows = db
          .select({ value: count() })
          .from(crmebRefunds)
          .where(
            and(
              eq(crmebRefunds.channel, CHANNEL),
              eq(crmebRefunds.externalOrderId, detail.id),
              gt(crmebRefunds.refundType, 0),
            ),
          )
          .get()
        const outcome = persistOrder(
          db,
          detail,
          refundRows?.value ?? 0,
          new Date(),
        )
        processedOrderIds.push(outcome.rowId)
        if (outcome.created) orders.created += 1
        else if (outcome.updated) orders.updated += 1
        else orders.unchanged += 1
        eventsAppended += outcome.events
      } catch (error) {
        orders.failed += 1
        errors.push({
          scope: 'order',
          externalOrderNo: listed.order_id,
          code: errorCodeOf(error),
          message: errorMessageOf(error),
        })
      }
    }

    // Refund scanning is mandatory. Page through refund/list from refundPage
    // (bounded), persisting the cursor so a truncated sweep is explicit and can
    // be continued; an incomplete sweep never counts orders as valid.
    let refundRowErrors = 0
    let refundScanFailed = false
    try {
      while (refundCursor.pagesScanned < REFUND_SCAN_MAX_PAGES) {
        const page = refundPage + refundCursor.pagesScanned
        const refundList = await client.listRefunds({ page, limit: refundLimit })
        refundCursor.pagesScanned += 1
        refundCursor.page = page
        for (const raw of refundList.list) {
          refunds.scanned += 1
          refundCursor.lastExternalRefundNo = raw.order_id
          refundCursor.lastRefundAddTime =
            secondsToDate(raw.add_time)?.toISOString() ?? null
          try {
            const outcome = persistRefund(db, raw, new Date())
            if (outcome.created) refunds.created += 1
            else if (outcome.updated) refunds.updated += 1
            else refunds.unchanged += 1
            if (!outcome.matchedOrder) refunds.unmatched += 1
            eventsAppended += outcome.events
          } catch (error) {
            refundRowErrors += 1
            errors.push({
              scope: 'refund',
              externalOrderNo: raw.order_id,
              code: errorCodeOf(error),
              message: errorMessageOf(error),
            })
          }
        }
        refundCursor.hasMore = refundCursor.page * refundLimit < refundList.count
        refundCursor.nextPage = refundCursor.hasMore ? page + 1 : null
        if (!refundCursor.hasMore) break
      }
    } catch (error) {
      refundScanFailed = true
      errors.push({
        scope: 'refund',
        externalOrderNo: null,
        code: errorCodeOf(error),
        message: errorMessageOf(error),
      })
    }
    if (refundCursor.pagesScanned >= REFUND_SCAN_MAX_PAGES && refundCursor.hasMore) {
      refundCursor.nextPage = refundCursor.page + 1
    }
    // A complete refund sweep must start at page 1, reach the end and contain
    // no unreadable refund rows. Anything less invalidates this run's orders.
    refundCursor.complete =
      refundPage === 1 &&
      !refundCursor.hasMore &&
      !refundScanFailed &&
      refundRowErrors === 0
    if (!refundCursor.complete) {
      errors.push({
        scope: 'refund',
        externalOrderNo: null,
        code: 'refund_scan_incomplete',
        message: refundCursor.hasMore
          ? `售后扫描达到单次上限（${REFUND_SCAN_MAX_PAGES} 页），请用 refundPage=${refundCursor.nextPage ?? refundPage} 继续`
          : '售后扫描未从第 1 页完整完成，本次不认定任何有效成交',
      })
      if (processedOrderIds.length > 0) {
        db.update(crmebOrders)
          .set({ validTransaction: false, updatedAt: new Date() })
          .where(
            and(
              eq(crmebOrders.channel, CHANNEL),
              inArray(crmebOrders.id, processedOrderIds),
            ),
          )
          .run()
      }
    }

    const validRows = processedOrderIds.length
      ? db
          .select({ value: count() })
          .from(crmebOrders)
          .where(
            and(
              eq(crmebOrders.channel, CHANNEL),
              inArray(crmebOrders.id, processedOrderIds),
              eq(crmebOrders.validTransaction, true),
            ),
          )
          .get()
      : undefined
    const validTransactions = validRows?.value ?? 0
    const status = errors.length > 0 ? 'failed' : 'succeeded'
    const finishedAt = new Date()

    db.update(crmebSyncRuns)
      .set({
        status,
        ordersScanned: orders.scanned,
        ordersCreated: orders.created,
        ordersUpdated: orders.updated,
        ordersUnchanged: orders.unchanged,
        ordersFailed: orders.failed,
        refundsScanned: refunds.scanned,
        refundsCreated: refunds.created,
        refundsUpdated: refunds.updated,
        refundsUnchanged: refunds.unchanged,
        refundsUnmatched: refunds.unmatched,
        validTransactions,
        eventsAppended,
        cursorJson: JSON.stringify(cursor),
        errorsJson: JSON.stringify(errors.slice(0, 50)),
        errorMessage: errors.length
          ? errors
              .slice(0, 3)
              .map((error) => `${error.code}: ${error.message}`)
              .join('; ')
              .slice(0, 500)
          : null,
        finishedAt,
      })
      .where(eq(crmebSyncRuns.id, runId))
      .run()

    logEvent('crmeb.sync.completed', {
      runId,
      status,
      ordersScanned: orders.scanned,
      ordersFailed: orders.failed,
      refundsScanned: refunds.scanned,
      refundScanComplete: refundCursor.complete,
      validTransactions,
      eventsAppended,
    })

    return crmebOrderSyncResponseSchema.parse({
      runId,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      scope,
      orders,
      refunds,
      validTransactions,
      eventsAppended,
      cursor,
      errors: errors.slice(0, 20),
    })
  } catch (error) {
    const finishedAt = new Date()
    db.update(crmebSyncRuns)
      .set({
        status: 'failed',
        ordersScanned: orders.scanned,
        ordersCreated: orders.created,
        ordersUpdated: orders.updated,
        ordersUnchanged: orders.unchanged,
        ordersFailed: orders.failed,
        refundsScanned: refunds.scanned,
        refundsCreated: refunds.created,
        refundsUpdated: refunds.updated,
        refundsUnchanged: refunds.unchanged,
        refundsUnmatched: refunds.unmatched,
        eventsAppended,
        cursorJson: JSON.stringify(cursor),
        errorsJson: JSON.stringify(
          [
            ...errors,
            {
              scope: 'run' as const,
              externalOrderNo: null,
              code: errorCodeOf(error),
              message: errorMessageOf(error),
            },
          ].slice(0, 50),
        ),
        errorMessage: errorMessageOf(error).slice(0, 500),
        finishedAt,
      })
      .where(eq(crmebSyncRuns.id, runId))
      .run()
    logEvent('crmeb.sync.failed', {
      runId,
      code: errorCodeOf(error),
      ordersScanned: orders.scanned,
    })
    throw error
  } finally {
    syncRunning = false
  }
}
