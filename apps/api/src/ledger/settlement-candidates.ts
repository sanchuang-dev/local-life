import { and, count, desc, eq, gte, inArray, isNull, like, lt, lte, or, type SQL } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type SettlementCandidate,
  type SettlementCandidateListResponse,
  type SettlementCandidateQuery,
  type SettlementCandidateReason,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  ledgerAnomalies,
  ledgerEntries,
  localOrders,
  reconciliationBatches,
} from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  combine,
  iso,
  scopeCommunityIds,
  type LocalActor,
} from '../local/shared.js'
import {
  ledgerEntrySelection,
  shanghaiDayEndExclusiveMs,
  shanghaiDayStartMs,
  toLedgerEntry,
  toShanghaiBusinessDate,
} from './shared.js'
import { readOrderPaymentEvidence } from './payment-evidence.js'
import { readOrderPartySnapshot } from './settlement-parties.js'

/**
 * #184 is a read-only projection; it does not create a financial fact or rule.
 * Only the existing order, immutable ledger entry, one-to-one receipt link and
 * human-confirmed seller snapshot may supply candidate fields.
 */
export function listSettlementCandidates(
  db: AppDatabase,
  actor: LocalActor,
  query: SettlementCandidateQuery,
  now = new Date(),
): SettlementCandidateListResponse {
  if (!actor.role || actor.role === 'grid_worker') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '无权查看机构线下结算核查表')
  }
  const conditions: SQL<unknown>[] = []
  const scoped = scopeCommunityIds(db, actor)
  if (scoped !== null) {
    if (scoped.length === 0) {
      return emptyPage(query, now)
    }
    conditions.push(inArray(localOrders.communityId, scoped))
  }
  if (query.communityId) {
    assertCommunityAccess(db, actor, query.communityId)
    conditions.push(eq(localOrders.communityId, query.communityId))
  }
  if (query.from) conditions.push(gte(localOrders.createdAt, new Date(shanghaiDayStartMs(query.from))))
  if (query.to) conditions.push(lt(localOrders.createdAt, new Date(shanghaiDayEndExclusiveMs(query.to))))
  if (query.keyword) {
    const term = '%' + query.keyword.replace(/[%_]/g, '') + '%'
    conditions.push(or(like(localOrders.id, term), like(localOrders.productName, term))!)
  }
  const where = combine(conditions)
  const total = db.select({ n: count() }).from(localOrders).where(where).get()?.n ?? 0
  const orders = db.select().from(localOrders).where(where)
    .orderBy(desc(localOrders.createdAt), desc(localOrders.id))
    .limit(query.pageSize).offset((query.page - 1) * query.pageSize).all()

  const items = orders.map((order): SettlementCandidate => {
    const evidence = readOrderPaymentEvidence(db, actor, order.id)
    const parties = readOrderPartySnapshot(db, actor, order.id)
    const receiptFact = evidence.payment
      ? db.select(ledgerEntrySelection).from(ledgerEntries)
        .where(eq(ledgerEntries.id, evidence.payment.entryId)).get()
      : null
    if (evidence.payment && !receiptFact) {
      throw new Error('Missing linked immutable receipt during settlement projection')
    }
    const receipt = receiptFact ? toLedgerEntry(receiptFact) : null
    const orderFact = db.select(ledgerEntrySelection).from(ledgerEntries)
      .where(and(
        eq(ledgerEntries.sourceSystem, 'local_order'),
        eq(ledgerEntries.sourceId, order.id),
        eq(ledgerEntries.factKind, 'order_verified'),
      )).get()
    const orderFactEntry = orderFact ? toLedgerEntry(orderFact) : null
    const reasons: SettlementCandidateReason[] = []
    const messages: string[] = []
    const block = (reason: SettlementCandidateReason, message: string) => {
      if (reasons.includes(reason)) return
      reasons.push(reason)
      messages.push(message)
    }

    if (order.status !== 'verified') {
      block('order_not_verified', '订单业务尚未人工核验，不等于真实付款')
    }
    if (!evidence.payment) {
      block('missing_receipt', '尚未建立订单与人工收款凭据的明确关联')
    } else {
      if (evidence.payment.reversedEntryId) {
        block('receipt_reversed', '原人工收款已全额冲正，不得产生应付')
      }
      if (evidence.payment.amountCents !== order.totalCents) {
        block('amount_mismatch', '登记价与凭据实收不符；部分退款/合并收款未支持自动拆分')
      }
      if (evidence.payment.attribution.state !== 'attributed' ||
        !evidence.payment.confirmation ||
        evidence.payment.confirmation.staffId !== evidence.payment.attribution.staffId) {
        block('attribution_pending', '实际推广网格员和审核依据尚未确认')
      }
      if (!receipt || receipt.reconciliationState !== 'reconciled') {
        const day = receipt ? toShanghaiBusinessDate(new Date(receipt.occurredAt)) : null
        const late = receipt && day
          ? db.select({ id: reconciliationBatches.id }).from(reconciliationBatches)
            .where(and(eq(reconciliationBatches.status, 'locked'),
              lte(reconciliationBatches.periodFrom, day),
              gte(reconciliationBatches.periodTo, day),
              lt(reconciliationBatches.lockedAt, receiptFact!.createdAt))).get()
          : null
        if (late) {
          block('receipt_late_recorded', '收款凭据在经营对账锁定后补录，原锁账不能被改写')
        } else {
          block('receipt_unreconciled', '实收尚未进入有效的已锁定经营对账批次')
        }
      }
    }
    if (!orderFactEntry || orderFactEntry.reconciliationState !== 'reconciled') {
      block('order_fact_unreconciled', '订单核验经营事实尚未包含在已锁定对账中')
    }
    const relatedIds = [
      evidence.payment?.entryId,
      orderFactEntry?.entryId,
    ].filter((id): id is string => !!id)
    if (relatedIds.length) {
      const anomaly = db.select({ id: ledgerAnomalies.id }).from(ledgerAnomalies)
        .where(and(inArray(ledgerAnomalies.entryId, relatedIds),
          isNull(ledgerAnomalies.resolvedAt))).get()
      if (anomaly) block('unresolved_anomaly', '关联流水存在尚未解决的异常')
    }
    if (parties.sellerStatus === 'missing_seller') {
      block('missing_seller', '尚未明确登记实际销售商户及其订单确认凭据')
    } else if (parties.sellerStatus !== 'verified') {
      block('counterparty_incomplete', '三创或广电法律主体及其协议依据尚未齐全')
    }
    // #185 is the ONLY writer/calculator of approved contract versions.
    // Until that is implemented, an actual payable does not exist.
    block('missing_approved_rule', '未找到经核准的分成合同规则；应分金额待核定')

    return {
      orderId: order.id,
      orderDisplayNo: order.id.slice(0, 8).toUpperCase(),
      communityId: order.communityId, productId: order.productId,
      productName: order.productName, orderStatus: order.status,
      registeredAmountCents: order.totalCents,
      sellerStatus: parties.sellerStatus,
      orderParty: parties.snapshot,
      receipt: evidence.payment,
      receiptReconciliationState: receipt?.reconciliationState ?? null,
      payableAmountCents: null,
      settlementAmountStatus: 'pending_rule',
      blockingReasons: reasons, blockingMessages: messages,
    }
  })

  return {
    items, total, page: query.page, pageSize: query.pageSize,
    asOf: iso(now), summaryScope: 'page',
    summary: {
      recordedReceiptGrossCents: items.reduce((sum, x) => sum + (x.receipt?.amountCents ?? 0), 0),
      reversedReceiptCents: items.reduce((sum, x) =>
        sum + (x.receipt?.reversedEntryId ? x.receipt.amountCents : 0), 0),
      blockedItems: items.filter((x) => x.blockingReasons.length > 0).length,
      visibleItems: items.length,
    },
    payableAmountCents: null, settlementAmountStatus: 'pending_rule',
  }
}

function emptyPage(query: SettlementCandidateQuery, now: Date): SettlementCandidateListResponse {
  return {
    items: [], total: 0, page: query.page, pageSize: query.pageSize,
    asOf: iso(now), summaryScope: 'page',
    summary: { recordedReceiptGrossCents: 0, reversedReceiptCents: 0,
      blockedItems: 0, visibleItems: 0 },
    payableAmountCents: null, settlementAmountStatus: 'pending_rule',
  }
}
