import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type CreateSettlementRuleRequest,
  type SettlementQuoteResponse,
  type SettlementRuleVersion,
  type SettlementTrialAllocation,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { settlementProductMappings, settlementRuleVersions } from '../db/schema.js'
import {
  LocalError, assertCommunityAccess, insertAudit, iso, mapConstraintError,
  scopeCommunityIds, type LocalActor,
} from '../local/shared.js'
import { toShanghaiBusinessDate } from './shared.js'
import { readSettlementCandidate } from './settlement-candidates.js'
import { allocateSettlementCents } from './settlement-calculator.js'

type RuleRow = typeof settlementRuleVersions.$inferSelect

function toRule(row: RuleRow): SettlementRuleVersion {
  return {
    ...row,
    ratesBps: {
      seller: row.sellerRateBps,
      sanchuang: row.sanchuangRateBps,
      guangdian: row.guangdianRateBps,
    },
    approvalStatus: 'admin_attested',
    approvedAt: iso(row.approvedAt),
  }
}

function ruleConflict(error: unknown): never {
  if (error instanceof Error &&
      /overlapping approved settlement rule|approved rule must match verified|UNIQUE constraint failed|CHECK constraint failed|constraint failed/iu.test(error.message)) {
    throw new LocalError(409, API_ERROR_CODES.conflict,
      '合同版本或生效区间与已有数据冲突，请核对合同批准证据')
  }
  return mapConstraintError(error)
}

/** Read-only scoped history, including historical rule versions for #186. */
export function listSettlementRules(
  db: AppDatabase,
  actor: LocalActor,
  communityId?: string,
  mappingId?: string,
): { items: SettlementRuleVersion[] } {
  if (!actor.role || actor.role === 'grid_worker') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '无权查看合作分成合同')
  }
  if (communityId) assertCommunityAccess(db, actor, communityId)
  const permitted = scopeCommunityIds(db, actor)
  if (permitted?.length === 0) return { items: [] }
  const rows = db.select().from(settlementRuleVersions).where(and(
    communityId ? eq(settlementRuleVersions.communityId, communityId) : undefined,
    mappingId ? eq(settlementRuleVersions.mappingId, mappingId) : undefined,
    permitted ? inArray(settlementRuleVersions.communityId, permitted) : undefined,
  )).orderBy(desc(settlementRuleVersions.approvedAt), desc(settlementRuleVersions.version)).all()
  return { items: rows.map(toRule) }
}

/**
 * Only an actual admin may attest the approval of explicit agreement terms.
 * This attestation is NOT an invented finance-reviewer signature.
 * Version numbers and all evidence are append-only, protected by SQL triggers.
 */
export function createSettlementRule(
  db: AppDatabase,
  actor: LocalActor,
  input: CreateSettlementRuleRequest,
  now = new Date(),
): SettlementRuleVersion {
  if (actor.role !== 'admin') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '仅管理员可登记已核准合同版本')
  }
  const mapping = db.select().from(settlementProductMappings)
    .where(eq(settlementProductMappings.id, input.mappingId)).get()
  if (!mapping) {
    throw new LocalError(404, API_ERROR_CODES.notFound, '真实销售商户映射不存在')
  }
  if (!mapping.sanchuangPartyId || !mapping.guangdianPartyId) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '三方真实法律主体未全部核验')
  }
  if (input.agreementRef !== mapping.agreementRef ||
      input.effectiveFrom < mapping.effectiveFrom ||
      input.effectiveTo > mapping.effectiveTo) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '合同编号或有效期不匹配已核验销售商户映射')
  }

  try {
    return db.transaction((tx) => {
      const last = tx.select({ version: settlementRuleVersions.version })
        .from(settlementRuleVersions)
        .where(eq(settlementRuleVersions.mappingId, mapping.id))
        .orderBy(desc(settlementRuleVersions.version)).get()
      const version = (last?.version ?? 0) + 1
      const entry: RuleRow = {
        id: randomUUID(), mappingId: mapping.id, version,
        communityId: mapping.communityId, productId: mapping.productId,
        sellerPartyId: mapping.sellerPartyId,
        sanchuangPartyId: mapping.sanchuangPartyId!,
        guangdianPartyId: mapping.guangdianPartyId!,
        agreementRef: input.agreementRef,
        approvalEvidenceRef: input.approvalEvidenceRef,
        approvalOn: input.approvalOn,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        feeBase: input.feeBase,
        processorFeeBps: input.processorFeeBps,
        processorFeeOwner: input.processorFeeOwner,
        sellerRateBps: input.ratesBps.seller,
        sanchuangRateBps: input.ratesBps.sanchuang,
        guangdianRateBps: input.ratesBps.guangdian,
        roundingRecipient: input.roundingRecipient,
        roundingPolicy: input.roundingPolicy,
        processorFeeRounding: input.processorFeeRounding,
        reversalPolicy: input.reversalPolicy,
        partialRefundPolicy: input.partialRefundPolicy,
        approvalStatus: 'admin_attested',
        approvedByUserId: actor.userId, approvedAt: now,
      }
      tx.insert(settlementRuleVersions).values(entry).run()
      insertAudit(tx, actor.userId, 'settlement.rule.admin_attested', entry.id, now, {
        mappingId: mapping.id, communityId: mapping.communityId,
        version: String(version), agreementRef: input.agreementRef,
        approvalEvidenceRef: input.approvalEvidenceRef,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
      })
      return toRule(entry)
    })
  } catch (error) {
    return ruleConflict(error)
  }
}

function emptyQuote(
  orderId: string,
  status: 'pending_rule' | 'blocked',
  blockingReasons: string[],
  rule: SettlementRuleVersion | null,
  receiptEntryId: string | null,
  ids: { seller: string | null; sanchuang: string | null; guangdian: string | null },
): SettlementQuoteResponse {
  return {
    orderId, quoteOnly: true, status, rule, allocation: null,
    payableAmountCents: null, blockingReasons, receiptEntryId,
    sellerPartyId: ids.seller, sanchuangPartyId: ids.sanchuang,
    guangdianPartyId: ids.guangdian,
  }
}

/**
 * Trial-only. #184 provides ALL ledger/attribution/anomaly blockers.
 * Rule matching is exact mapping ID + actual receipt business day.
 * No persisted statement or payable is generated.
 */
export function quoteSettlementOrder(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
): SettlementQuoteResponse {
  const candidate = readSettlementCandidate(db, actor, orderId)
  const party = candidate.orderParty
  const ids = {
    seller: party?.sellerPartyId ?? null,
    sanchuang: party?.sanchuangPartyId ?? null,
    guangdian: party?.guangdianPartyId ?? null,
  }
  const receipt = candidate.receipt
  const receiptId = receipt?.entryId ?? null
  const blockers = candidate.blockingReasons.filter((x) => x !== 'missing_approved_rule')

  if (!party || candidate.sellerStatus !== 'verified' || !receipt) {
    return emptyQuote(orderId, 'pending_rule', candidate.blockingReasons, null, receiptId, ids)
  }
  const receiptDay = toShanghaiBusinessDate(new Date(receipt.receivedAt))
  const matching = db.select().from(settlementRuleVersions)
    .where(and(
      eq(settlementRuleVersions.mappingId, party.mappingId),
      eq(settlementRuleVersions.communityId, candidate.communityId),
      eq(settlementRuleVersions.productId, candidate.productId),
      eq(settlementRuleVersions.sellerPartyId, party.sellerPartyId),
      eq(settlementRuleVersions.sanchuangPartyId, party.sanchuangPartyId!),
      eq(settlementRuleVersions.guangdianPartyId, party.guangdianPartyId!),
      lte(settlementRuleVersions.effectiveFrom, receiptDay),
      gte(settlementRuleVersions.effectiveTo, receiptDay),
    )).get()
  if (!matching) {
    return emptyQuote(orderId, 'pending_rule', candidate.blockingReasons, null, receiptId, ids)
  }

  const rule = toRule(matching)
  if (blockers.length > 0 || receipt.amountCents <= 0) {
    return emptyQuote(orderId, 'blocked',
      blockers.length ? blockers : ['zero_or_invalid_receipt'], rule, receiptId, ids)
  }
  const attempt = allocateSettlementCents(receipt.amountCents, rule)
  if (!attempt.allocation) {
    return emptyQuote(orderId, 'blocked', [attempt.blockingReason], rule, receiptId, ids)
  }
  // Allocation is a deterministic estimate, not an authorized payable amount.
  return {
    orderId, quoteOnly: true, status: 'calculated', rule,
    allocation: attempt.allocation,
    payableAmountCents: null, blockingReasons: [], receiptEntryId: receiptId,
    sellerPartyId: ids.seller,
    sanchuangPartyId: ids.sanchuang,
    guangdianPartyId: ids.guangdian,
  }
}
