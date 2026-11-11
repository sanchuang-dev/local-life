import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type RecordSettlementPaymentRequest,
  type SettlementPaymentBeneficiary,
  type SettlementPaymentEvent,
  type SettlementPaymentOverview,
  type SettlementPaymentRecord,
  type SettlementPaymentState,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  settlementParties,
  settlementPaymentEvents,
  settlementPaymentRecords,
  settlementStatementLines,
  settlementStatements,
} from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  insertAudit,
  iso,
  mapConstraintError,
  type LocalActor,
} from '../local/shared.js'

type StatementRow = typeof settlementStatements.$inferSelect
type PaymentRow = typeof settlementPaymentRecords.$inferSelect
type EventRow = typeof settlementPaymentEvents.$inferSelect
type PartyRole = 'seller' | 'sanchuang' | 'guangdian'
type Payable = {
  partyId: string
  role: PartyRole
  legalName: string
  registryRef: string
  verificationRef: string | null
  payableCents: number
}
type Allocation = {
  sellerNetCents: number
  sanchuangNetCents: number
  guangdianNetCents: number
}

function requireOffice(actor: LocalActor): void {
  if (actor.role !== 'admin' && actor.role !== 'operator') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '仅管理员或授权运营人员可查看付款凭据')
  }
}
function requireAdmin(actor: LocalActor): void {
  if (actor.role !== 'admin') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '只有管理员可登记或复核线下付款凭据')
  }
}
function conflict(message: string): never {
  throw new LocalError(409, API_ERROR_CODES.conflict, message)
}
function invalid(message: string): never {
  throw new LocalError(400, API_ERROR_CODES.invalidRequest, message)
}
function constrain(error: unknown): never {
  if (error instanceof Error &&
      /UNIQUE constraint|immutable|settlement payment|payment record|payment event|overpay/iu.test(error.message)) {
    conflict('付款凭据、事件幂等键或可付额度已被占用，请刷新后核对')
  }
  return mapConstraintError(error)
}
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')
const proofFingerprint = (value: string): string =>
  sha256(value.trim().replace(/\s+/gu, ' ').toLowerCase())

function statementFor(db: AppDatabase, actor: LocalActor, statementId: string): StatementRow {
  requireOffice(actor)
  const row = db.select().from(settlementStatements)
    .where(eq(settlementStatements.id, statementId)).get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '结算单不存在')
  assertCommunityAccess(db, actor, row.communityId)
  return row
}

function safeSum(values: number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n)
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) conflict('付款金额超出安全整数范围')
  return Number(total)
}

function payableForStatement(db: AppDatabase, row: StatementRow): Payable[] {
  if (row.status !== 'locked') return []
  const lines = db.select().from(settlementStatementLines)
    .where(eq(settlementStatementLines.statementId, row.id)).all()
    .filter((line) => line.state === 'calculated' && line.allocationJson)
  const totals = new Map<string, { role: PartyRole; cents: number }>()
  const add = (partyId: string | null, role: PartyRole, cents: number): void => {
    if (cents <= 0) return
    if (!partyId) conflict('锁定结算单缺少应付主体快照，不能登记付款')
    const current = totals.get(partyId)
    if (current && current.role !== role) {
      conflict('同一结算主体出现冲突角色，不能登记付款')
    }
    totals.set(partyId, {
      role,
      cents: safeSum([current?.cents ?? 0, cents]),
    })
  }
  for (const line of lines) {
    const allocation = JSON.parse(line.allocationJson!) as Allocation
    add(line.sellerPartyId, 'seller', allocation.sellerNetCents)
    add(line.sanchuangPartyId, 'sanchuang', allocation.sanchuangNetCents)
    add(line.guangdianPartyId, 'guangdian', allocation.guangdianNetCents)
  }
  const ids = [...totals.keys()]
  const parties = ids.length
    ? db.select().from(settlementParties).where(inArray(settlementParties.id, ids)).all()
    : []
  if (parties.length !== ids.length) conflict('锁定结算单引用的付款主体不存在')
  const byId = new Map(parties.map((party) => [party.id, party]))
  return ids.map((partyId) => {
    const total = totals.get(partyId)!
    const party = byId.get(partyId)!
    if (party.role !== total.role) conflict('锁定结算单的主体角色与登记主体不一致')
    return {
      partyId,
      role: total.role,
      legalName: party.legalName,
      registryRef: party.registryRef,
      verificationRef: party.verificationRef,
      payableCents: total.cents,
    }
  }).sort((a, b) => a.role.localeCompare(b.role) || a.partyId.localeCompare(b.partyId))
}

function eventsFor(db: AppDatabase, statementId: string): EventRow[] {
  return db.select().from(settlementPaymentEvents)
    .where(eq(settlementPaymentEvents.statementId, statementId))
    .orderBy(asc(settlementPaymentEvents.createdAt), asc(settlementPaymentEvents.sequence))
    .all()
}
function recordsFor(db: AppDatabase, statementId: string): PaymentRow[] {
  return db.select().from(settlementPaymentRecords)
    .where(eq(settlementPaymentRecords.statementId, statementId))
    .orderBy(asc(settlementPaymentRecords.recordedAt), asc(settlementPaymentRecords.id))
    .all()
}
function eventDto(row: EventRow): SettlementPaymentEvent {
  return {
    id: row.id,
    paymentRecordId: row.paymentRecordId,
    statementId: row.statementId,
    kind: row.kind,
    sequence: row.sequence,
    actorUserId: row.actorUserId,
    evidenceRef: row.evidenceRef,
    state: row.state,
    createdAt: iso(row.createdAt),
  }
}
function currentStates(events: EventRow[]): Map<string, SettlementPaymentRecord['state']> {
  const result = new Map<string, SettlementPaymentRecord['state']>()
  for (const event of events) result.set(event.paymentRecordId, event.state)
  return result
}
function recordDto(
  row: PaymentRow,
  state: SettlementPaymentRecord['state'],
): SettlementPaymentRecord {
  return {
    id: row.id,
    statementId: row.statementId,
    communityId: row.communityId,
    beneficiaryPartyId: row.beneficiaryPartyId,
    beneficiaryRole: row.beneficiaryRole,
    beneficiaryLegalName: row.beneficiaryLegalName,
    beneficiaryRegistryRef: row.beneficiaryRegistryRef,
    beneficiaryVerificationRef: row.beneficiaryVerificationRef,
    payableCentsSnapshot: row.payableCentsSnapshot,
    amountCents: row.amountCents,
    paidAt: iso(row.paidAt),
    proofRefMasked: row.proofRefMasked,
    recorderUserId: row.recorderUserId,
    recordedAt: iso(row.recordedAt),
    state,
  }
}
function beneficiaryState(
  payable: number,
  records: SettlementPaymentRecord[],
): SettlementPaymentBeneficiary['state'] {
  if (records.some((record) => record.state === 'disputed')) return 'disputed'
  if (records.some((record) => record.state === 'pending_review')) return 'pending_review'
  const verified = safeSum(records.filter((record) => record.state === 'verified')
    .map((record) => record.amountCents))
  if (verified === payable) return 'verified'
  if (verified > 0) return 'partial'
  return 'awaiting_payment'
}
function overallState(
  locked: boolean,
  beneficiaries: SettlementPaymentBeneficiary[],
): SettlementPaymentState {
  if (!locked) return 'not_recorded'
  if (beneficiaries.some((item) => item.state === 'disputed')) return 'disputed'
  if (beneficiaries.some((item) => item.state === 'pending_review')) return 'pending_review'
  if (beneficiaries.length > 0 && beneficiaries.every((item) => item.state === 'verified')) {
    return 'verified'
  }
  if (beneficiaries.some((item) => item.verifiedCents > 0)) return 'partial'
  return 'awaiting_payment'
}

function overviewOf(db: AppDatabase, row: StatementRow): SettlementPaymentOverview {
  const payables = payableForStatement(db, row)
  const eventRows = eventsFor(db, row.id)
  const states = currentStates(eventRows)
  const recordRows = recordsFor(db, row.id)
  const records = recordRows.map((record) =>
    recordDto(record, states.get(record.id) ?? 'pending_review'))
  const beneficiaries = payables.map((payable): SettlementPaymentBeneficiary => {
    const own = records.filter((record) => record.beneficiaryPartyId === payable.partyId)
    const recordedCents = safeSum(own.map((record) => record.amountCents))
    const verifiedCents = safeSum(own.filter((record) => record.state === 'verified')
      .map((record) => record.amountCents))
    return {
      partyId: payable.partyId,
      role: payable.role,
      legalName: payable.legalName,
      registryRef: payable.registryRef,
      verificationRef: payable.verificationRef,
      payableCents: payable.payableCents,
      recordedCents,
      verifiedCents,
      state: beneficiaryState(payable.payableCents, own),
    }
  })
  return {
    statementId: row.id,
    communityId: row.communityId,
    state: overallState(row.status === 'locked', beneficiaries),
    payableCents: safeSum(beneficiaries.map((item) => item.payableCents)),
    recordedCents: safeSum(records.map((record) => record.amountCents)),
    verifiedCents: safeSum(records.filter((record) => record.state === 'verified')
      .map((record) => record.amountCents)),
    beneficiaries,
    records,
    events: eventRows.map(eventDto),
  }
}

export function settlementPaymentStateForStatement(
  db: AppDatabase,
  statementId: string,
  status: StatementRow['status'],
): SettlementPaymentState {
  if (status !== 'locked') return 'not_recorded'
  const row = db.select().from(settlementStatements)
    .where(eq(settlementStatements.id, statementId)).get()
  if (!row) return 'not_recorded'
  return overviewOf(db, row).state
}

export function getSettlementPaymentOverview(
  db: AppDatabase,
  actor: LocalActor,
  statementId: string,
): SettlementPaymentOverview {
  requireAdmin(actor)
  return overviewOf(db, statementFor(db, actor, statementId))
}

export function recordSettlementPayment(
  db: AppDatabase,
  actor: LocalActor,
  statementId: string,
  request: RecordSettlementPaymentRequest,
  now = new Date(),
): SettlementPaymentOverview {
  requireAdmin(actor)
  if (/\d{12,}/u.test(request.proofRefMasked)) {
    invalid('付款凭据只保存脱敏引用，禁止填写完整银行卡号或账号')
  }
  const paidAt = new Date(request.paidAt)
  if (!Number.isFinite(paidAt.getTime())) invalid('实际付款时间无效')
  try {
    return db.transaction((tx) => {
      const row = statementFor(db, actor, statementId)
      if (row.status !== 'locked' || !row.lockedAt) {
        conflict('只有已复核锁定的结算单才能登记线下付款凭据')
      }
      if (paidAt.getTime() < row.lockedAt.getTime()) {
        conflict('实际付款时间早于结算单锁定时间，不能作为本结算单付款凭据')
      }
      if (paidAt.getTime() > now.getTime()) invalid('实际付款时间不能晚于当前时间')

      const fingerprint = proofFingerprint(request.proofRefMasked)
      const replay = db.select().from(settlementPaymentRecords)
        .where(eq(settlementPaymentRecords.idempotencyKey, request.idempotencyKey)).get()
      if (replay) {
        if (replay.statementId === statementId &&
            replay.beneficiaryPartyId === request.beneficiaryPartyId &&
            replay.amountCents === request.amountCents &&
            replay.paidAt.getTime() === paidAt.getTime() &&
            replay.proofFingerprint === fingerprint &&
            replay.recorderUserId === actor.userId) {
          return overviewOf(db, row)
        }
        conflict('付款登记幂等键已用于另一笔内容')
      }
      const duplicateProof = db.select({ id: settlementPaymentRecords.id })
        .from(settlementPaymentRecords)
        .where(eq(settlementPaymentRecords.proofFingerprint, fingerprint)).get()
      if (duplicateProof) conflict('同一付款凭据不能重复用于其他主体或结算单')

      const beneficiary = payableForStatement(db, row)
        .find((item) => item.partyId === request.beneficiaryPartyId)
      if (!beneficiary) conflict('付款对象不是该锁定结算单中的真实应付主体')
      const existing = db.select({ amountCents: settlementPaymentRecords.amountCents })
        .from(settlementPaymentRecords).where(and(
          eq(settlementPaymentRecords.statementId, row.id),
          eq(settlementPaymentRecords.beneficiaryPartyId, beneficiary.partyId),
        )).all()
      const after = safeSum([...existing.map((item) => item.amountCents), request.amountCents])
      if (after > beneficiary.payableCents) {
        conflict('登记金额超过该主体锁定应付余额，禁止超额或跨账单静默抵扣')
      }

      const id = randomUUID()
      tx.insert(settlementPaymentRecords).values({
        id,
        statementId: row.id,
        communityId: row.communityId,
        beneficiaryPartyId: beneficiary.partyId,
        beneficiaryRole: beneficiary.role,
        beneficiaryLegalName: beneficiary.legalName,
        beneficiaryRegistryRef: beneficiary.registryRef,
        beneficiaryVerificationRef: beneficiary.verificationRef,
        payableCentsSnapshot: beneficiary.payableCents,
        amountCents: request.amountCents,
        paidAt,
        proofRefMasked: request.proofRefMasked,
        proofFingerprint: fingerprint,
        recorderUserId: actor.userId,
        idempotencyKey: request.idempotencyKey,
        recordedAt: now,
      }).run()
      tx.insert(settlementPaymentEvents).values({
        id: randomUUID(),
        paymentRecordId: id,
        statementId: row.id,
        kind: 'recorded',
        sequence: 1,
        actorUserId: actor.userId,
        evidenceRef: null,
        state: 'pending_review',
        idempotencyKey: request.idempotencyKey,
        createdAt: now,
      }).run()
      insertAudit(tx, actor.userId, 'settlement.payment.recorded', id, now, {
        statementId: row.id,
        communityId: row.communityId,
        beneficiaryPartyId: beneficiary.partyId,
        amountCents: String(request.amountCents),
      })
      return overviewOf(db, row)
    }, { behavior: 'immediate' })
  } catch (error) {
    return constrain(error)
  }
}

function terminalPaymentAction(
  db: AppDatabase,
  actor: LocalActor,
  statementId: string,
  paymentId: string,
  kind: 'verified' | 'disputed',
  eventIdempotencyKey: string,
  evidenceRef: string,
  now: Date,
): SettlementPaymentOverview {
  requireAdmin(actor)
  try {
    return db.transaction((tx) => {
      const row = statementFor(db, actor, statementId)
      if (row.status !== 'locked') conflict('只有锁定结算单的付款凭据可以复核')
      const record = db.select().from(settlementPaymentRecords).where(and(
        eq(settlementPaymentRecords.id, paymentId),
        eq(settlementPaymentRecords.statementId, statementId),
      )).get()
      if (!record) throw new LocalError(404, API_ERROR_CODES.notFound, '付款凭据不存在')

      const replay = db.select().from(settlementPaymentEvents)
        .where(eq(settlementPaymentEvents.idempotencyKey, eventIdempotencyKey)).get()
      if (replay) {
        if (replay.paymentRecordId === paymentId &&
            replay.kind === kind &&
            replay.actorUserId === actor.userId &&
            replay.evidenceRef === evidenceRef) {
          return overviewOf(db, row)
        }
        conflict('付款复核幂等键已用于另一事件')
      }
      const terminal = db.select().from(settlementPaymentEvents).where(and(
        eq(settlementPaymentEvents.paymentRecordId, paymentId),
        inArray(settlementPaymentEvents.kind, ['verified', 'disputed']),
      )).get()
      if (terminal) conflict('该付款凭据已经完成复核，不能重复或改写结论')
      if (record.recorderUserId === actor.userId) {
        throw new LocalError(403, API_ERROR_CODES.forbidden, '付款登记人不能复核自己的付款凭据')
      }
      const beneficiary = payableForStatement(db, row)
        .find((item) => item.partyId === record.beneficiaryPartyId)
      if (!beneficiary ||
          beneficiary.role !== record.beneficiaryRole ||
          beneficiary.legalName !== record.beneficiaryLegalName ||
          beneficiary.registryRef !== record.beneficiaryRegistryRef ||
          beneficiary.verificationRef !== record.beneficiaryVerificationRef ||
          beneficiary.payableCents !== record.payableCentsSnapshot) {
        conflict('付款对象与锁定结算单主体快照不一致，禁止核销')
      }
      if (kind === 'verified') {
        const overview = overviewOf(db, row)
        const ownVerified = overview.records
          .filter((item) => item.beneficiaryPartyId === record.beneficiaryPartyId &&
            item.state === 'verified')
          .map((item) => item.amountCents)
        if (safeSum([...ownVerified, record.amountCents]) > beneficiary.payableCents) {
          conflict('复核后将超过锁定应付金额，禁止核销')
        }
      }
      tx.insert(settlementPaymentEvents).values({
        id: randomUUID(),
        paymentRecordId: paymentId,
        statementId,
        kind,
        sequence: 2,
        actorUserId: actor.userId,
        evidenceRef,
        state: kind,
        idempotencyKey: eventIdempotencyKey,
        createdAt: now,
      }).run()
      insertAudit(tx, actor.userId, 'settlement.payment.' + kind, paymentId, now, {
        statementId,
        beneficiaryPartyId: record.beneficiaryPartyId,
        amountCents: String(record.amountCents),
      })
      return overviewOf(db, row)
    }, { behavior: 'immediate' })
  } catch (error) {
    return constrain(error)
  }
}

export function verifySettlementPayment(
  db: AppDatabase,
  actor: LocalActor,
  statementId: string,
  paymentId: string,
  eventIdempotencyKey: string,
  evidenceRef: string,
  now = new Date(),
): SettlementPaymentOverview {
  return terminalPaymentAction(
    db, actor, statementId, paymentId, 'verified',
    eventIdempotencyKey, evidenceRef, now,
  )
}

export function disputeSettlementPayment(
  db: AppDatabase,
  actor: LocalActor,
  statementId: string,
  paymentId: string,
  eventIdempotencyKey: string,
  evidenceRef: string,
  now = new Date(),
): SettlementPaymentOverview {
  return terminalPaymentAction(
    db, actor, statementId, paymentId, 'disputed',
    eventIdempotencyKey, evidenceRef, now,
  )
}
