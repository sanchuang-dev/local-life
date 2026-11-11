import { createHash, randomUUID } from 'node:crypto'
import { and, count, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type CreateSettlementStatementRequest,
  type SettlementCandidate,
  type SettlementQuoteResponse,
  type SettlementStatement,
  type SettlementStatementDetail,
  type SettlementStatementLine,
  type SettlementStatementPerformance,
  type SettlementStatementListResponse,
  type SettlementStatementSummary,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  crmServiceOrders, ledgerEntries, settlementReceiptClaims, settlementStatementEvents,
  settlementStatementLines, settlementStatementPerformance, settlementStatements,
} from '../db/schema.js'
import {
  LocalError, assertCommunityAccess, insertAudit, iso, mapConstraintError,
  nextUpdatedAt, scopeCommunityIds, type LocalActor, type LocalTransaction,
} from '../local/shared.js'
import { ledgerEntrySelection, shanghaiDayEndExclusiveMs,
  shanghaiDayStartMs, toLedgerEntry } from './shared.js'
import { listSettlementCandidates, readSettlementCandidate } from './settlement-candidates.js'
import { quoteSettlementOrder } from './settlement-rules.js'

const MAX_SNAPSHOT_LINES = 1_000
type StatementRow = typeof settlementStatements.$inferSelect
type LineRow = typeof settlementStatementLines.$inferSelect
type PerformanceRow = typeof settlementStatementPerformance.$inferSelect
type PerformanceWrite = Omit<typeof settlementStatementPerformance.$inferInsert, 'id' | 'statementId'>
type EventRow = typeof settlementStatementEvents.$inferSelect
type LineWrite = Omit<typeof settlementStatementLines.$inferInsert, 'id' | 'statementId'>
type SourceLine = { snapshot: LineWrite; orderId: string }
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function requireOffice(actor: LocalActor): void {
  if (actor.role !== 'admin' && actor.role !== 'operator') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '仅管理员或授权运营人员可查看结算单')
  }
}
function requireAdmin(actor: LocalActor): void {
  if (actor.role !== 'admin') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '只有管理员可确认和锁定分成结算单')
  }
}
function conflict(message: string): never {
  throw new LocalError(409, API_ERROR_CODES.conflict, message)
}
function constrain(error: unknown): never {
  if (error instanceof Error && /UNIQUE constraint|constraint failed|immutable|settlement snapshot|receipt claim/iu.test(error.message)) {
    conflict('结算单、凭据或版本已被占用或修改，请刷新后重新核对')
  }
  return mapConstraintError(error)
}

function summaryOf(row: StatementRow): SettlementStatementSummary {
  return {
    lineCount: row.lineCount,
    calculatedCount: row.calculatedCount,
    blockedCount: row.blockedCount,
    eligibleGrossCents: row.eligibleGrossCents,
    feeCents: row.feeCents,
    sellerNetCents: row.sellerNetCents,
    sanchuangNetCents: row.sanchuangNetCents,
    guangdianNetCents: row.guangdianNetCents,
    eligibleDistributionCents: row.calculatedCount > 0
      ? row.sellerNetCents + row.sanchuangNetCents + row.guangdianNetCents : null,
  }
}
function statementDto(row: StatementRow): SettlementStatement {
  return {
    id: row.id, statementNo: row.statementNo, communityId: row.communityId,
    periodFrom: row.periodFrom, periodTo: row.periodTo, generation: row.generation,
    revision: row.revision, status: row.status, snapshotDigest: row.snapshotDigest,
    asOf: iso(row.asOf), createdByUserId: row.createdByUserId,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    reviewedByUserId: row.reviewedByUserId, reviewEvidenceRef: row.reviewEvidenceRef,
    reviewedAt: row.reviewedAt ? iso(row.reviewedAt) : null,
    lockedByUserId: row.lockedByUserId, lockEvidenceRef: row.lockEvidenceRef,
    lockedAt: row.lockedAt ? iso(row.lockedAt) : null,
    summary: summaryOf(row), paymentState: 'not_recorded',
  }
}
function lineDto(row: LineRow): SettlementStatementLine {
  return {
    id: row.id, statementId: row.statementId, orderId: row.orderId,
    orderDisplayNo: row.orderDisplayNo, communityId: row.communityId,
    productId: row.productId, productName: row.productName,
    periodAt: iso(row.periodAt), registeredAmountCents: row.registeredAmountCents,
    receiptEntryId: row.receiptEntryId, receiptEvidenceRef: row.receiptEvidenceRef,
    receiptReceivedAt: row.receiptReceivedAt ? iso(row.receiptReceivedAt) : null,
    receiptAmountCents: row.receiptAmountCents, operatingBatchId: row.operatingBatchId,
    gridStaffId: row.gridStaffId, gridReviewerUserId: row.gridReviewerUserId,
    mappingId: row.mappingId, sellerPartyId: row.sellerPartyId,
    sanchuangPartyId: row.sanchuangPartyId, guangdianPartyId: row.guangdianPartyId,
    agreementRef: row.agreementRef, ruleId: row.ruleId, ruleVersion: row.ruleVersion,
    state: row.state, blockingReasons: JSON.parse(row.blockingReasonsJson) as string[],
    allocation: row.allocationJson ? JSON.parse(row.allocationJson) as SettlementStatementLine['allocation'] : null,
    sourceDigest: row.sourceDigest,
  }
}
function performanceDto(row: PerformanceRow): SettlementStatementPerformance {
  return {
    ...row, confirmedAt: iso(row.confirmedAt),
  }
}
function eventDto(row: EventRow): SettlementStatementDetail['events'][number] {
  return {
    ...row, createdAt: iso(row.createdAt),
  }
}

function rowFor(db: AppDatabase, actor: LocalActor, id: string): StatementRow {
  requireOffice(actor)
  const row = db.select().from(settlementStatements).where(eq(settlementStatements.id, id)).get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '结算单不存在')
  assertCommunityAccess(db, actor, row.communityId)
  return row
}
function linesFor(db: AppDatabase, id: string): LineRow[] {
  return db.select().from(settlementStatementLines)
    .where(eq(settlementStatementLines.statementId, id))
    .orderBy(settlementStatementLines.orderId).all()
}
function performanceFor(db: AppDatabase, id: string): PerformanceRow[] {
  return db.select().from(settlementStatementPerformance)
    .where(eq(settlementStatementPerformance.statementId,id))
    .orderBy(settlementStatementPerformance.entryId).all()
}
function eventsFor(db: AppDatabase, id: string): EventRow[] {
  return db.select().from(settlementStatementEvents)
    .where(eq(settlementStatementEvents.statementId, id))
    .orderBy(settlementStatementEvents.revision).all()
}
function checkedSum(values: number[]): number {
  const total = values.reduce((sum, n) => sum + BigInt(n), 0n)
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) conflict('结算金额超出安全整数范围')
  return Number(total)
}

/**
 * CRM confirmed service orders have no monetary amount at all (#64).
 * Snapshot only evidence-backed, explicitly attributed facts as WORKER COUNTS;
 * no receipt, percentage, transfer, or personal payout can originate here.
 */
function captureCrmPerformance(
  db: AppDatabase, communityId: string, from: string, to: string,
): PerformanceWrite[] {
  const rows = db.select(ledgerEntrySelection).from(ledgerEntries).where(and(
    eq(ledgerEntries.communityId,communityId),
    eq(ledgerEntries.sourceSystem,'crm_service_order'),
    eq(ledgerEntries.factKind,'order_verified'),
    gte(ledgerEntries.occurredAt,new Date(shanghaiDayStartMs(from))),
    lt(ledgerEntries.occurredAt,new Date(shanghaiDayEndExclusiveMs(to))),
  )).all()
  const performance: PerformanceWrite[] = []
  for(const row of rows) {
    const entry=toLedgerEntry(row)
    if (entry.amountCents !== 0 || entry.attribution.state !== 'attributed' ||
        !entry.attribution.staffId || !entry.verifiedAt) {
      continue
    }
    const crm=db.select({confirmedByUserId:crmServiceOrders.confirmedByUserId})
      .from(crmServiceOrders).where(eq(crmServiceOrders.id,entry.sourceId)).get()
    if(!crm) throw new Error('Confirmed CRM ledger fact lost its source order')
    const partial={
      entryId:entry.entryId, sourceId:entry.sourceId,
      sourceDisplayNo:entry.sourceDisplayNo, communityId,
      staffId:entry.attribution.staffId, confirmedByUserId:crm.confirmedByUserId,
      confirmedAt:new Date(entry.verifiedAt), evidenceRef:entry.evidence.ref,
    }
    performance.push({
      ...partial, sourceDigest:sha256(JSON.stringify({
        ...partial,confirmedAt:partial.confirmedAt.toISOString(),
      })),
    })
  }
  return performance.sort((a,b)=>a.entryId.localeCompare(b.entryId))
}

/** Same immutable evidence pipeline as #184/#185, never a new money source. */
function captureOne(db: AppDatabase, actor: LocalActor, candidate: SettlementCandidate): SourceLine {
  const quote: SettlementQuoteResponse = quoteSettlementOrder(db, actor, candidate.orderId)
  const actual = candidate.receipt
  const ledger = actual
    ? db.select(ledgerEntrySelection).from(ledgerEntries).where(eq(ledgerEntries.id, actual.entryId)).get()
    : null
  const operatingBatchId = ledger ? toLedgerEntry(ledger).batchId : null
  const eligible = quote.status === 'calculated' && quote.allocation !== null &&
    actual !== null && operatingBatchId !== null
  const reasons = eligible ? [] : (
    quote.blockingReasons.length ? quote.blockingReasons :
      ['receipt_not_in_locked_reconciliation']
  )
  const snapshot: LineWrite = {
    orderId: candidate.orderId, orderDisplayNo: candidate.orderDisplayNo,
    communityId: candidate.communityId, productId: candidate.productId,
    productName: candidate.productName, periodAt: new Date(candidate.periodAt),
    registeredAmountCents: candidate.registeredAmountCents,
    receiptEntryId: actual?.entryId ?? null, receiptEvidenceRef: actual?.evidenceRef ?? null,
    receiptReceivedAt: actual ? new Date(actual.receivedAt) : null,
    receiptAmountCents: actual?.amountCents ?? null, operatingBatchId,
    gridStaffId: actual?.attribution.state === 'attributed' &&
      actual.confirmation?.staffId === actual.attribution.staffId
      ? actual.attribution.staffId : null,
    gridReviewerUserId: actual?.confirmation?.reviewedByUserId ?? null,
    mappingId: candidate.orderParty?.mappingId ?? null,
    sellerPartyId: quote.sellerPartyId, sanchuangPartyId: quote.sanchuangPartyId,
    guangdianPartyId: quote.guangdianPartyId,
    agreementRef: quote.rule?.agreementRef ?? candidate.orderParty?.agreementRef ?? null,
    ruleId: quote.rule?.id ?? null, ruleVersion: quote.rule?.version ?? null,
    state: eligible ? 'calculated' : 'blocked',
    blockingReasonsJson: JSON.stringify(reasons),
    allocationJson: eligible ? JSON.stringify(quote.allocation) : null,
    sourceDigest: sha256(JSON.stringify({ candidate, quote, operatingBatchId })),
  }
  return { orderId: candidate.orderId, snapshot }
}
function capturePeriod(
  db: AppDatabase, actor: LocalActor,
  communityId: string, periodFrom: string, periodTo: string,
): { lines: SourceLine[]; performance: PerformanceWrite[]; totals: Omit<SettlementStatementSummary, 'eligibleDistributionCents'>; digest: string } {
  const result: SettlementCandidate[] = []
  let page = 1
  while (true) {
    const part = listSettlementCandidates(db, actor, {
      communityId, from: periodFrom, to: periodTo, page, pageSize: 100,
    })
    if (part.total > MAX_SNAPSHOT_LINES) {
      conflict('单次结算草案超过1000笔，请分段创建业务期间，禁止截断导出')
    }
    result.push(...part.items)
    if (result.length >= part.total) break
    page++
  }
  const lines = result.map(candidate => captureOne(db, actor, candidate))
    .sort((a,b) => a.orderId.localeCompare(b.orderId))
  const performance = captureCrmPerformance(db,communityId,periodFrom,periodTo)
  const calculated = lines.filter(l => l.snapshot.state === 'calculated')
  const allocations = calculated.map(l => {
    if (!l.snapshot.allocationJson) throw new Error('Calculated line lost allocation')
    return JSON.parse(l.snapshot.allocationJson) as {
      grossReceivedCents: number; processorFeeCents: number;
      sellerNetCents: number; sanchuangNetCents: number; guangdianNetCents: number;
    }
  })
  const totals = {
    lineCount: lines.length,
    calculatedCount: calculated.length,
    blockedCount: lines.length - calculated.length,
    eligibleGrossCents: checkedSum(allocations.map(x=>x.grossReceivedCents)),
    feeCents: checkedSum(allocations.map(x=>x.processorFeeCents)),
    sellerNetCents: checkedSum(allocations.map(x=>x.sellerNetCents)),
    sanchuangNetCents: checkedSum(allocations.map(x=>x.sanchuangNetCents)),
    guangdianNetCents: checkedSum(allocations.map(x=>x.guangdianNetCents)),
  }
  if (totals.eligibleGrossCents !== totals.feeCents + totals.sellerNetCents +
    totals.sanchuangNetCents + totals.guangdianNetCents) {
    throw new Error('Settlement gross/net statement does not conserve cents')
  }
  return {
    lines, performance, totals,
    digest: sha256(JSON.stringify({
      lines:lines.map(l=>[l.orderId,l.snapshot.sourceDigest]),
      performance:performance.map(x=>[x.entryId,x.sourceDigest]),
    })),
  }
}
function appendEvent(
  tx: LocalTransaction, row: StatementRow,
  kind: EventRow['kind'], actor: LocalActor, revision: number,
  at: Date, evidenceRef: string | null,
): void {
  tx.insert(settlementStatementEvents).values({
    id: randomUUID(), statementId: row.id, kind, revision,
    actorUserId: actor.userId, evidenceRef,
    snapshotDigest: row.snapshotDigest, createdAt: at,
  }).run()
  insertAudit(tx, actor.userId, 'settlement.statement.' + kind, row.id, at, {
    communityId: row.communityId, statementNo: row.statementNo,
    revision: String(revision), snapshotDigest: row.snapshotDigest,
  })
}

/** A single active period; explicit CAS replacement creates a NEW immutable generation. */
export function createSettlementStatement(
  db: AppDatabase, actor: LocalActor, request: CreateSettlementStatementRequest,
  now = new Date(),
): SettlementStatementDetail {
  requireOffice(actor)
  assertCommunityAccess(db, actor, request.communityId)
  if (request.periodFrom > request.periodTo) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '结算业务期间不正确')
  }
  try {
    return db.transaction(tx => {
      const period = and(
        eq(settlementStatements.communityId, request.communityId),
        eq(settlementStatements.periodFrom, request.periodFrom),
        eq(settlementStatements.periodTo, request.periodTo),
      )
      const history = db.select().from(settlementStatements)
        .where(period).orderBy(desc(settlementStatements.generation)).all()
      const active = history.find(s => s.status !== 'superseded')
      if (active) {
        if (active.status === 'locked') conflict('已有锁定结算单；后续冲正必须作为新期间争议处理')
        if (!request.replaceStatementId || request.replaceStatementId !== active.id ||
          request.expectedRevision !== active.revision) {
          conflict('期间已有草案；如需更新凭据，请提供旧草案ID和预期版本以重新生成')
        }
        const update = tx.update(settlementStatements).set({
          status: 'superseded', revision: active.revision + 1,
          updatedAt: nextUpdatedAt(active.updatedAt, now),
        }).where(and(eq(settlementStatements.id, active.id),
          eq(settlementStatements.revision, active.revision))).run()
        if (update.changes !== 1) conflict('旧草案已被其他人更新')
        appendEvent(tx, active, 'superseded', actor, active.revision + 1, now, null)
      } else if (request.replaceStatementId) {
        conflict('没有可替换的有效草案')
      }
      const source = capturePeriod(db, actor,
        request.communityId, request.periodFrom, request.periodTo)
      const generation = (history[0]?.generation ?? 0) + 1
      const number = 'SET-' + request.periodFrom.replace(/-/gu, '') +
        '-' + request.periodTo.replace(/-/gu, '') + '-' + request.communityId.slice(0, 8) +
        '-V' + generation
      const row: StatementRow = {
        id: randomUUID(), statementNo: number,
        communityId: request.communityId,
        periodFrom: request.periodFrom, periodTo: request.periodTo,
        generation, revision: 1, status: 'draft',
        snapshotDigest: source.digest, asOf: now,
        ...source.totals,
        createdByUserId: actor.userId, createdAt: now, updatedAt: now,
        reviewedByUserId: null, reviewEvidenceRef: null, reviewedAt: null,
        lockedByUserId: null, lockEvidenceRef: null, lockedAt: null,
      }
      tx.insert(settlementStatements).values(row).run()
      for (const line of source.lines) {
        tx.insert(settlementStatementLines).values({
          ...line.snapshot, id: randomUUID(), statementId: row.id,
        }).run()
      }
      for (const evidence of source.performance) {
        tx.insert(settlementStatementPerformance).values({
          ...evidence, id:randomUUID(),statementId:row.id,
        }).run()
      }
      appendEvent(tx, row, 'created', actor, 1, now, null)
      return detailOf(db, actor, row.id)
    }, { behavior: 'immediate' })
  } catch (error) { return constrain(error) }
}

/** Read-only search: operators only see explicitly assigned communities. */
export function listSettlementStatements(
  db: AppDatabase, actor: LocalActor,
  query: { communityId?: string; page: number; pageSize: number },
): SettlementStatementListResponse {
  requireOffice(actor)
  if (query.communityId) assertCommunityAccess(db, actor, query.communityId)
  const scope = scopeCommunityIds(db, actor)
  if (scope?.length === 0) return {
    items: [], total: 0, page: query.page, pageSize: query.pageSize,
  }
  const where = and(
    query.communityId ? eq(settlementStatements.communityId, query.communityId) : undefined,
    scope ? inArray(settlementStatements.communityId, scope) : undefined,
  )
  const total = db.select({ n: count() }).from(settlementStatements).where(where).get()?.n ?? 0
  const items = db.select().from(settlementStatements).where(where)
    .orderBy(desc(settlementStatements.createdAt), desc(settlementStatements.id))
    .limit(query.pageSize).offset((query.page - 1)*query.pageSize)
    .all().map(statementDto)
  return { items, total, page: query.page, pageSize: query.pageSize }
}
function detailOf(db: AppDatabase, actor: LocalActor, id: string): SettlementStatementDetail {
  const row = rowFor(db, actor, id)
  const lines = linesFor(db, id)
  const postLockDisputes: SettlementStatementDetail['postLockDisputes'] = []
  if (row.status === 'locked') {
    // Never rewrite a frozen line because an external reversal arrived later.
    for (const line of lines.filter(l => l.state === 'calculated')) {
      const fresh = captureOne(db, actor, readSettlementCandidate(db, actor, line.orderId))
      if (fresh.snapshot.sourceDigest !== line.sourceDigest) {
        const reasons = JSON.parse(fresh.snapshot.blockingReasonsJson) as string[]
        postLockDisputes.push({
          orderId: line.orderId,
          reasons: reasons.length ? reasons : ['结算锁定后收款或核验依据发生变化，待人工核查'],
        })
      }
    }
  }
  return {
    statement: statementDto(row), lines: lines.map(lineDto),
    performance:performanceFor(db,id).map(performanceDto),
    events: eventsFor(db, id).map(eventDto), postLockDisputes,
  }
}
export function getSettlementStatement(
  db: AppDatabase, actor: LocalActor, id: string,
): SettlementStatementDetail {
  return detailOf(db, actor, id)
}

/** Compare exact complete item set AND every immutable source fingerprint. */
function assertFresh(db: AppDatabase, actor: LocalActor, row: StatementRow): LineRow[] {
  const lines = linesFor(db, row.id)
  const source = capturePeriod(db, actor, row.communityId, row.periodFrom, row.periodTo)
  if (source.digest !== row.snapshotDigest ||
      lines.length !== source.lines.length ||
      lines.some((l, i) => l.orderId !== source.lines[i]?.orderId ||
        l.sourceDigest !== source.lines[i]?.snapshot.sourceDigest) ||
      source.totals.lineCount !== row.lineCount ||
      source.totals.calculatedCount !== row.calculatedCount ||
      source.totals.eligibleGrossCents !== row.eligibleGrossCents) {
    conflict('证据、合同、归属或期间订单已经变化，请重新生成草案，原快照不修改')
  }
  return lines
}

/** Independent ADMIN reviewer (different authenticated user, not role masquerade). */
export function reviewSettlementStatement(
  db: AppDatabase, actor: LocalActor, id: string,
  expectedRevision: number, evidenceRef: string, now = new Date(),
): SettlementStatementDetail {
  requireAdmin(actor)
  try {
    return db.transaction(tx => {
      const row = rowFor(db, actor, id)
      if (row.status !== 'draft' || row.revision !== expectedRevision) {
        conflict('草案状态或版本已变化，不能重复复核')
      }
      if (row.createdByUserId === actor.userId) {
        throw new LocalError(403, API_ERROR_CODES.forbidden, '制单人不能复核自己的结算草案')
      }
      assertFresh(db, actor, row)
      const updated = tx.update(settlementStatements).set({
        status: 'reviewed', revision: row.revision + 1,
        updatedAt: nextUpdatedAt(row.updatedAt, now),
        reviewedByUserId: actor.userId, reviewEvidenceRef: evidenceRef, reviewedAt: now,
      }).where(and(eq(settlementStatements.id, row.id),
        eq(settlementStatements.revision, row.revision),
        eq(settlementStatements.status, 'draft'))).run()
      if (updated.changes !== 1) conflict('结算单已经由其他人复核')
      appendEvent(tx, row, 'reviewed', actor, row.revision + 1, now, evidenceRef)
      return detailOf(db, actor, id)
    }, { behavior: 'immediate' })
  } catch (error) { return constrain(error) }
}

/** Locking is not payment. Only calculated lines acquire immutable receipt claims. */
export function lockSettlementStatement(
  db: AppDatabase, actor: LocalActor, id: string,
  expectedRevision: number, evidenceRef: string, now = new Date(),
): SettlementStatementDetail {
  requireAdmin(actor)
  try {
    return db.transaction(tx => {
      const row = rowFor(db, actor, id)
      if (row.status !== 'reviewed' || row.revision !== expectedRevision ||
          !row.reviewedByUserId || row.reviewedByUserId === row.createdByUserId) {
        conflict('缺少另一位真实管理员的复核签认，或草案版本已经变化')
      }
      if (row.calculatedCount <= 0) {
        conflict('全部订单仍待核定，不允许将无核准规则的金额锁为应付')
      }
      const lines = assertFresh(db, actor, row)
      for (const line of lines.filter(l => l.state === 'calculated')) {
        if (!line.receiptEntryId || !line.allocationJson || !line.ruleId) {
          conflict('存在缺少真实实收和合同版本的结算行')
        }
      }
      const updated = tx.update(settlementStatements).set({
        status: 'locked', revision: row.revision + 1,
        updatedAt: nextUpdatedAt(row.updatedAt, now),
        lockedByUserId: actor.userId, lockEvidenceRef: evidenceRef, lockedAt: now,
      }).where(and(eq(settlementStatements.id, row.id),
        eq(settlementStatements.revision, row.revision),
        eq(settlementStatements.status, 'reviewed'))).run()
      if (updated.changes !== 1) conflict('结算单被并发修改，请刷新')
      for (const line of lines.filter(l => l.state === 'calculated')) {
        tx.insert(settlementReceiptClaims).values({
          receiptEntryId: line.receiptEntryId!,
          orderId: line.orderId, statementId: row.id, lineId: line.id,
          claimedAt: now,
        }).run()
      }
      appendEvent(tx, row, 'locked', actor, row.revision + 1, now, evidenceRef)
      return detailOf(db, actor, id)
    }, { behavior: 'immediate' })
  } catch (error) { return constrain(error) }
}

/** Grid workers can receive ONLY their own performance appendix, never statement money. */
export function performanceLinesForActor(
  db: AppDatabase, actor: LocalActor, id: string,
): { statement: SettlementStatement; lines: SettlementStatementLine[];
  performance: SettlementStatementPerformance[] } {
  if (!actor.role || !actor.staffId) {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '未授权读取网格员业绩附表')
  }
  const row = db.select().from(settlementStatements).where(eq(settlementStatements.id, id)).get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '结算单不存在')
  assertCommunityAccess(db, actor, row.communityId)
  const lines = linesFor(db, row.id).filter(l =>
    actor.role !== 'grid_worker' || l.gridStaffId === actor.staffId)
  const performance = performanceFor(db, row.id).filter(p =>
    actor.role !== 'grid_worker' || p.staffId === actor.staffId)
  return { statement: statementDto(row), lines: lines.map(lineDto),
    performance:performance.map(performanceDto) }
}
