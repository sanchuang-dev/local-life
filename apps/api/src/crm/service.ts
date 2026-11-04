import { randomUUID } from 'node:crypto'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import {
  API_ERROR_CODES,
  CRM_ACTIVATION_SOURCE,
  CRM_LEAD_STATUS_TRANSITIONS,
  CRM_ORDER_STATUS_TRANSITIONS,
  adminCrmFilterOptionsResponseSchema,
  crmBusinessTypeSchema,
  crmFollowUpListResponseSchema,
  crmFollowUpSchema,
  crmLeadDetailSchema,
  crmLeadEventListResponseSchema,
  crmLeadEventSchema,
  crmLeadListResponseSchema,
  crmLeadSourceTypeSchema,
  crmLeadStatusSchema,
  crmLeadSummarySchema,
  crmOrderDetailSchema,
  crmOrderEventListResponseSchema,
  crmOrderEventSchema,
  crmOrderListResponseSchema,
  crmOrderSummarySchema,
  crmServiceOrderStatusSchema,
  crmStaffOptionSchema,
  type AdminCrmFilterOptionsResponse,
  type ApiErrorCode,
  type CreateCrmFollowUpRequest,
  type CreateCrmFollowUpResponse,
  type CreateCrmLeadRequest,
  type CreateCrmServiceOrderRequest,
  type CrmBusinessType,
  type CrmFollowUpListResponse,
  type CrmLeadDetail,
  type CrmLeadEvent,
  type CrmLeadEventListResponse,
  type CrmLeadListResponse,
  type CrmLeadSourceType,
  type CrmLeadStatus,
  type CrmLeadSummary,
  type CrmOrderDetail,
  type CrmOrderEvent,
  type CrmOrderEventListResponse,
  type CrmOrderListResponse,
  type CrmOrderReviewRequest,
  type CrmOrderSummary,
  type CrmServiceOrderStatus,
  type CrmStaffRef,
  type CrmUserRef,
  type StaffRole,
  type TransferCrmLeadRequest,
  type UpdateCrmLeadStatusRequest,
  type UpdateCrmOrderStatusRequest,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  auditLogs,
  communities,
  crmFollowUps,
  crmLeadEvents,
  crmLeads,
  crmOrderEvents,
  crmServiceOrders,
  residentCommunityAssignments,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../db/schema.js'

/** Resolved server-side staff identity; never trust a client-supplied role/owner. */
export interface CrmActor {
  userId: string
  staffId: string
  role: StaffRole
}

/**
 * Domain error carrying the HTTP status and shared error code. Routes translate it
 * into the standard `{ error: { code, message, requestId } }` envelope.
 */
export class CrmError extends Error {
  status: 400 | 403 | 404 | 409
  code: ApiErrorCode

  constructor(status: 400 | 403 | 404 | 409, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'CrmError'
    this.status = status
    this.code = code
  }
}

type CrmTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

/* ------------------------------- Selections ------------------------------- */

const leadSelection = {
  id: crmLeads.id,
  communityId: crmLeads.communityId,
  communityName: communities.name,
  ownerStaffId: crmLeads.ownerStaffId,
  residentUserId: crmLeads.residentUserId,
  contactName: crmLeads.contactName,
  contactPhone: crmLeads.contactPhone,
  sourceType: crmLeads.sourceType,
  sourceActivityId: crmLeads.sourceActivityId,
  promotionStaffId: crmLeads.promotionStaffId,
  createdByStaffId: crmLeads.createdByStaffId,
  status: crmLeads.status,
  nextContactAt: crmLeads.nextContactAt,
  lastContactedAt: crmLeads.lastContactedAt,
  createdAt: crmLeads.createdAt,
  updatedAt: crmLeads.updatedAt,
}

interface LeadRow {
  id: string
  communityId: string
  communityName: string
  ownerStaffId: string
  residentUserId: string | null
  contactName: string
  contactPhone: string
  sourceType: CrmLeadSourceType
  sourceActivityId: string | null
  promotionStaffId: string | null
  createdByStaffId: string
  status: CrmLeadStatus
  nextContactAt: Date | null
  lastContactedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const orderSelection = {
  id: crmServiceOrders.id,
  communityId: crmServiceOrders.communityId,
  communityName: communities.name,
  leadId: crmServiceOrders.leadId,
  orderNo: crmServiceOrders.orderNo,
  businessType: crmServiceOrders.businessType,
  status: crmServiceOrders.status,
  customerName: crmServiceOrders.customerName,
  contactPhone: crmServiceOrders.contactPhone,
  evidenceRef: crmServiceOrders.evidenceRef,
  notes: crmServiceOrders.notes,
  createdByStaffId: crmServiceOrders.createdByStaffId,
  attributedStaffId: crmServiceOrders.attributedStaffId,
  sourceActivityId: crmServiceOrders.sourceActivityId,
  promotionStaffId: crmServiceOrders.promotionStaffId,
  confirmedByUserId: crmServiceOrders.confirmedByUserId,
  confirmedAt: crmServiceOrders.confirmedAt,
  confirmationNote: crmServiceOrders.confirmationNote,
  failureReason: crmServiceOrders.failureReason,
  createdAt: crmServiceOrders.createdAt,
  updatedAt: crmServiceOrders.updatedAt,
}

interface OrderRow {
  id: string
  communityId: string
  communityName: string
  leadId: string
  orderNo: string
  businessType: CrmBusinessType
  status: CrmServiceOrderStatus
  customerName: string
  contactPhone: string
  evidenceRef: string | null
  notes: string | null
  createdByStaffId: string
  attributedStaffId: string
  sourceActivityId: string | null
  promotionStaffId: string | null
  confirmedByUserId: string | null
  confirmedAt: Date | null
  confirmationNote: string | null
  failureReason: string | null
  createdAt: Date
  updatedAt: Date
}

function leadQuery(db: AppDatabase) {
  return db
    .select(leadSelection)
    .from(crmLeads)
    .innerJoin(communities, eq(crmLeads.communityId, communities.id))
}

function orderQuery(db: AppDatabase) {
  return db
    .select(orderSelection)
    .from(crmServiceOrders)
    .innerJoin(communities, eq(crmServiceOrders.communityId, communities.id))
}

function findLead(db: AppDatabase, leadId: string): LeadRow | undefined {
  return leadQuery(db).where(eq(crmLeads.id, leadId)).get()
}

function requireLead(db: AppDatabase, leadId: string): LeadRow {
  const row = findLead(db, leadId)
  if (!row) throw new CrmError(404, API_ERROR_CODES.notFound, '线索不存在')
  return row
}

function findOrder(db: AppDatabase, orderId: string): OrderRow | undefined {
  return orderQuery(db).where(eq(crmServiceOrders.id, orderId)).get()
}

function requireOrder(db: AppDatabase, orderId: string): OrderRow {
  const row = findOrder(db, orderId)
  if (!row) throw new CrmError(404, API_ERROR_CODES.notFound, '业务单不存在')
  return row
}

/* --------------------------------- Helpers -------------------------------- */

function iso(timestamp: Date): string {
  return timestamp.toISOString()
}

function isoOrNull(timestamp: Date | null): string | null {
  return timestamp === null ? null : timestamp.toISOString()
}

/** List payloads only expose a masked phone; the full value requires the detail route. */
export function maskContactPhone(phone: string): string {
  const compact = phone.trim()
  if (compact.length <= 4) return '*'.repeat(Math.max(compact.length, 1))
  const visibleStart = compact.length >= 11 ? 3 : compact.length >= 8 ? 2 : 1
  const visibleEnd = compact.length >= 11 ? 4 : compact.length >= 8 ? 2 : 1
  const maskedLength = compact.length - visibleStart - visibleEnd
  return `${compact.slice(0, visibleStart)}${'*'.repeat(Math.max(maskedLength, 1))}${compact.slice(-visibleEnd)}`
}

function assertExpectedUpdatedAt(actual: Date, expectedUpdatedAt: string): void {
  if (actual.getTime() !== Date.parse(expectedUpdatedAt)) {
    throw new CrmError(409, API_ERROR_CODES.conflict, '数据已被其他操作更新，请刷新后重试')
  }
}

/** The optimistic-concurrency token must always advance, even within one millisecond. */
function nextUpdatedAt(previous: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1))
}

function mapConstraintError(error: unknown): never {
  if (error instanceof CrmError) throw error
  if (error instanceof Error && /UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
    throw new CrmError(409, API_ERROR_CODES.conflict, '数据冲突，请刷新后重试')
  }
  throw error
}

function escapedLike(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/gu, '\\$&')}%`
}

function assignedCommunityIds(db: AppDatabase, staffId: string): string[] {
  return db
    .select({ communityId: staffCommunityAssignments.communityId })
    .from(staffCommunityAssignments)
    .where(eq(staffCommunityAssignments.staffAccountId, staffId))
    .all()
    .map((row) => row.communityId)
}

function assertCommunityAccess(db: AppDatabase, actor: CrmActor, communityId: string): void {
  if (actor.role === 'admin') return
  if (!assignedCommunityIds(db, actor.staffId).includes(communityId)) {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '无权访问该社区的数据')
  }
}

function assertLeadAccess(db: AppDatabase, actor: CrmActor, lead: LeadRow): void {
  if (actor.role === 'admin') return
  const communityIds = assignedCommunityIds(db, actor.staffId)
  if (!communityIds.includes(lead.communityId)) {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '无权访问该社区的线索')
  }
  if (actor.role === 'grid_worker' && lead.ownerStaffId !== actor.staffId) {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '只能操作本人名下的线索')
  }
}

function assertOrderAccess(db: AppDatabase, actor: CrmActor, order: OrderRow): void {
  if (actor.role === 'admin') return
  const communityIds = assignedCommunityIds(db, actor.staffId)
  if (!communityIds.includes(order.communityId)) {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '无权访问该社区的业务单')
  }
  if (
    actor.role === 'grid_worker' &&
    order.createdByStaffId !== actor.staffId &&
    order.attributedStaffId !== actor.staffId
  ) {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '只能操作本人名下的业务单')
  }
}

function staffRoleAndStatus(
  db: AppDatabase,
  staffId: string,
): { role: StaffRole; status: 'active' | 'disabled' } | undefined {
  return db
    .select({ role: staffAccounts.role, status: staffAccounts.status })
    .from(staffAccounts)
    .where(eq(staffAccounts.id, staffId))
    .get()
}

/**
 * Owner/promotion/transfer targets must be an active operator or grid worker
 * assigned to the community. `admin` can operate across communities but is not
 * an attribution target, so a lead's owner never becomes a global admin.
 */
function assertStaffAssignable(
  db: AppDatabase,
  communityId: string,
  staffId: string,
): void {
  const staff = staffRoleAndStatus(db, staffId)
  if (!staff || staff.status !== 'active') {
    throw new CrmError(400, API_ERROR_CODES.invalidRequest, '目标员工不存在或已停用')
  }
  if (staff.role === 'admin') {
    throw new CrmError(
      400,
      API_ERROR_CODES.invalidRequest,
      '目标员工必须是该社区的运营员或网格员',
    )
  }
  if (!assignedCommunityIds(db, staffId).includes(communityId)) {
    throw new CrmError(400, API_ERROR_CODES.invalidRequest, '目标员工不属于该社区')
  }
}

function assertStaffFilterAccess(db: AppDatabase, actor: CrmActor, staffId: string): void {
  if (actor.role === 'admin' || actor.role === 'grid_worker') return
  if (staffId === actor.staffId) return
  const actorCommunities = new Set(assignedCommunityIds(db, actor.staffId))
  if (!assignedCommunityIds(db, staffId).some((id) => actorCommunities.has(id))) {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '无权按该员工筛选')
  }
}

/* ------------------------------- Reference maps ---------------------------- */

interface RefMaps {
  staff: Map<string, CrmStaffRef>
  users: Map<string, CrmUserRef>
  activities: Map<string, { id: string; title: string }>
}

function staffRefMap(db: AppDatabase, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, CrmStaffRef>()
  if (unique.length === 0) return map
  const rows = db
    .select({ id: staffAccounts.id, displayName: users.displayName })
    .from(staffAccounts)
    .leftJoin(users, eq(staffAccounts.userId, users.id))
    .where(inArray(staffAccounts.id, unique))
    .all()
  for (const row of rows) {
    map.set(row.id, { id: row.id, displayName: row.displayName ?? null })
  }
  return map
}

function userRefMap(db: AppDatabase, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, CrmUserRef>()
  if (unique.length === 0) return map
  const rows = db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, unique))
    .all()
  for (const row of rows) {
    map.set(row.id, { id: row.id, displayName: row.displayName })
  }
  return map
}

function activityRefMap(db: AppDatabase, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, { id: string; title: string }>()
  if (unique.length === 0) return map
  const rows = db
    .select({ id: activities.id, title: activities.title })
    .from(activities)
    .where(inArray(activities.id, unique))
    .all()
  for (const row of rows) map.set(row.id, row)
  return map
}

function refMaps(db: AppDatabase, input: {
  staffIds?: Array<string | null | undefined>
  userIds?: Array<string | null | undefined>
  activityIds?: Array<string | null | undefined>
}): RefMaps {
  return {
    staff: staffRefMap(db, input.staffIds ?? []),
    users: userRefMap(db, input.userIds ?? []),
    activities: activityRefMap(db, input.activityIds ?? []),
  }
}

function staffRef(map: Map<string, CrmStaffRef>, id: string): CrmStaffRef {
  return map.get(id) ?? { id, displayName: null }
}

function userRef(map: Map<string, CrmUserRef>, id: string): CrmUserRef {
  return map.get(id) ?? { id, displayName: null }
}

function activityRef(
  map: Map<string, { id: string; title: string }>,
  id: string | null,
): { id: string; title: string } | null {
  if (id === null) return null
  return map.get(id) ?? null
}

function followUpCounts(db: AppDatabase, leadIds: string[]): Map<string, number> {
  const map = new Map<string, number>()
  if (leadIds.length === 0) return map
  const rows = db
    .select({ leadId: crmFollowUps.leadId, value: count() })
    .from(crmFollowUps)
    .where(inArray(crmFollowUps.leadId, leadIds))
    .groupBy(crmFollowUps.leadId)
    .all()
  for (const row of rows) map.set(row.leadId, row.value)
  return map
}

/* --------------------------------- Mappers -------------------------------- */

function toLeadSummary(
  row: LeadRow,
  maps: RefMaps,
  followUpCount: number,
): CrmLeadSummary {
  return crmLeadSummarySchema.parse({
    id: row.id,
    community: { id: row.communityId, name: row.communityName },
    ownerStaff: staffRef(maps.staff, row.ownerStaffId),
    contactName: row.contactName,
    contactPhoneMasked: maskContactPhone(row.contactPhone),
    sourceType: row.sourceType,
    sourceActivity: activityRef(maps.activities, row.sourceActivityId),
    promotionStaff: row.promotionStaffId ? staffRef(maps.staff, row.promotionStaffId) : null,
    status: row.status,
    followUpCount,
    nextContactAt: isoOrNull(row.nextContactAt),
    lastContactedAt: isoOrNull(row.lastContactedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function toLeadDetail(
  row: LeadRow,
  maps: RefMaps,
  followUpCount: number,
): CrmLeadDetail {
  return crmLeadDetailSchema.parse({
    ...toLeadSummary(row, maps, followUpCount),
    contactPhone: row.contactPhone,
    residentUserId: row.residentUserId,
    createdByStaff: staffRef(maps.staff, row.createdByStaffId),
  })
}

function leadMaps(db: AppDatabase, rows: LeadRow[]): RefMaps {
  return refMaps(db, {
    staffIds: rows.flatMap((row) => [
      row.ownerStaffId,
      row.promotionStaffId,
      row.createdByStaffId,
    ]),
    activityIds: rows.map((row) => row.sourceActivityId),
  })
}

function toOrderSummary(
  row: OrderRow,
  maps: RefMaps,
): CrmOrderSummary {
  return crmOrderSummarySchema.parse({
    id: row.id,
    community: { id: row.communityId, name: row.communityName },
    leadId: row.leadId,
    orderNo: row.orderNo,
    businessType: row.businessType,
    status: row.status,
    customerName: row.customerName,
    contactPhoneMasked: maskContactPhone(row.contactPhone),
    attributedStaff: staffRef(maps.staff, row.attributedStaffId),
    sourceActivity: activityRef(maps.activities, row.sourceActivityId),
    promotionStaff: row.promotionStaffId ? staffRef(maps.staff, row.promotionStaffId) : null,
    confirmedBy: row.confirmedByUserId ? userRef(maps.users, row.confirmedByUserId) : null,
    confirmedAt: isoOrNull(row.confirmedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function toOrderEvent(
  row: typeof crmOrderEvents.$inferSelect,
  maps: RefMaps,
): CrmOrderEvent {
  return crmOrderEventSchema.parse({
    id: row.id,
    orderId: row.orderId,
    event: row.event,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actor: row.actorUserId ? userRef(maps.users, row.actorUserId) : null,
    note: row.note,
    createdAt: iso(row.createdAt),
  })
}

function orderMaps(db: AppDatabase, rows: OrderRow[]): RefMaps {
  return refMaps(db, {
    staffIds: rows.flatMap((row) => [
      row.attributedStaffId,
      row.promotionStaffId,
      row.createdByStaffId,
    ]),
    userIds: rows.map((row) => row.confirmedByUserId),
    activityIds: rows.map((row) => row.sourceActivityId),
  })
}

function orderEvents(db: AppDatabase, orderId: string): CrmOrderEvent[] {
  const rows = db
    .select()
    .from(crmOrderEvents)
    .where(eq(crmOrderEvents.orderId, orderId))
    .orderBy(asc(crmOrderEvents.createdAt))
    .all()
  const maps = refMaps(db, { userIds: rows.map((row) => row.actorUserId) })
  return rows.map((row) => toOrderEvent(row, maps))
}

function toOrderDetail(
  row: OrderRow,
  maps: RefMaps,
  events: CrmOrderEvent[],
): CrmOrderDetail {
  return crmOrderDetailSchema.parse({
    ...toOrderSummary(row, maps),
    contactPhone: row.contactPhone,
    evidenceRef: row.evidenceRef,
    notes: row.notes,
    createdByStaff: staffRef(maps.staff, row.createdByStaffId),
    confirmation:
      row.status === 'confirmed' && row.confirmedAt
        ? {
            confirmedBy: row.confirmedByUserId
              ? userRef(maps.users, row.confirmedByUserId)
              : null,
            confirmedAt: iso(row.confirmedAt),
            note: row.confirmationNote,
          }
        : null,
    failureReason: row.failureReason,
    activationSource: row.status === 'confirmed' ? CRM_ACTIVATION_SOURCE : null,
    events,
  })
}

/* ------------------------------- Audit helpers ----------------------------- */

function insertAudit(
  tx: CrmTransaction,
  actorUserId: string,
  event: string,
  targetId: string,
  createdAt: Date,
  metadata?: Record<string, string>,
): void {
  tx.insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId,
      event,
      targetId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt,
    })
    .run()
}

function insertLeadEvent(
  tx: CrmTransaction,
  input: {
    leadId: string
    actorUserId: string
    event: CrmLeadEvent['event']
    fromStatus?: CrmLeadStatus | null
    toStatus?: CrmLeadStatus | null
    fromOwnerStaffId?: string | null
    toOwnerStaffId?: string | null
    note?: string | null
    createdAt: Date
  },
): void {
  tx.insert(crmLeadEvents)
    .values({
      id: randomUUID(),
      leadId: input.leadId,
      actorUserId: input.actorUserId,
      event: input.event,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      fromOwnerStaffId: input.fromOwnerStaffId ?? null,
      toOwnerStaffId: input.toOwnerStaffId ?? null,
      note: input.note ?? null,
      createdAt: input.createdAt,
    })
    .run()
}

function insertOrderEvent(
  tx: CrmTransaction,
  input: {
    orderId: string
    actorUserId: string
    event: CrmOrderEvent['event']
    fromStatus?: CrmServiceOrderStatus | null
    toStatus?: CrmServiceOrderStatus | null
    note?: string | null
    createdAt: Date
  },
): void {
  tx.insert(crmOrderEvents)
    .values({
      id: randomUUID(),
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      event: input.event,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      note: input.note ?? null,
      createdAt: input.createdAt,
    })
    .run()
}

/**
 * Advances a lead inside the order-review transaction. The conditional UPDATE
 * guarantees no concurrent writer moved the lead, and the event/audit pair keeps
 * every hop of the frozen lead state machine explicit.
 */
function advanceLeadStatus(
  tx: CrmTransaction,
  lead: typeof crmLeads.$inferSelect,
  toStatus: CrmLeadStatus,
  actorUserId: string,
  eventAt: Date,
  note: string,
): typeof crmLeads.$inferSelect {
  const updatedAt = nextUpdatedAt(lead.updatedAt, eventAt)
  const result = tx
    .update(crmLeads)
    .set({ status: toStatus, updatedAt })
    .where(
      and(
        eq(crmLeads.id, lead.id),
        eq(crmLeads.status, lead.status),
        eq(crmLeads.updatedAt, lead.updatedAt),
      ),
    )
    .run()
  if (result.changes !== 1) {
    throw new CrmError(409, API_ERROR_CODES.conflict, '线索已被其他操作更新，请刷新后重试')
  }
  insertLeadEvent(tx, {
    leadId: lead.id,
    actorUserId,
    event: 'lead.status_changed',
    fromStatus: lead.status,
    toStatus,
    fromOwnerStaffId: lead.ownerStaffId,
    toOwnerStaffId: lead.ownerStaffId,
    note,
    createdAt: eventAt,
  })
  insertAudit(tx, actorUserId, 'crm.lead.status_changed', lead.id, eventAt, {
    fromStatus: lead.status,
    toStatus,
    reason: 'order_confirmed',
  })
  return { ...lead, status: toStatus, updatedAt }
}

/* --------------------------------- Leads ---------------------------------- */

export interface LeadListInput {
  page: number
  pageSize: number
  communityId?: string
  staffId?: string
  status?: CrmLeadStatus
  sourceType?: CrmLeadSourceType
  keyword?: string
}

export function listLeads(
  db: AppDatabase,
  actor: CrmActor,
  input: LeadListInput,
): CrmLeadListResponse {
  const conditions: SQL<unknown>[] = []

  if (actor.role === 'grid_worker') {
    if (input.staffId && input.staffId !== actor.staffId) {
      throw new CrmError(403, API_ERROR_CODES.forbidden, '网格员只能查看本人名下的线索')
    }
    const communityIds = assignedCommunityIds(db, actor.staffId)
    if (communityIds.length === 0) {
      return crmLeadListResponseSchema.parse({
        items: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
      })
    }
    conditions.push(
      inArray(crmLeads.communityId, communityIds),
      eq(crmLeads.ownerStaffId, actor.staffId),
    )
  } else if (actor.role === 'operator') {
    const communityIds = assignedCommunityIds(db, actor.staffId)
    if (communityIds.length === 0) {
      return crmLeadListResponseSchema.parse({
        items: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
      })
    }
    conditions.push(inArray(crmLeads.communityId, communityIds))
    if (input.staffId) assertStaffFilterAccess(db, actor, input.staffId)
  }

  if (input.communityId) {
    assertCommunityAccess(db, actor, input.communityId)
    conditions.push(eq(crmLeads.communityId, input.communityId))
  }
  if (input.staffId) conditions.push(eq(crmLeads.ownerStaffId, input.staffId))
  if (input.status) conditions.push(eq(crmLeads.status, input.status))
  if (input.sourceType) conditions.push(eq(crmLeads.sourceType, input.sourceType))
  if (input.keyword) {
    const pattern = escapedLike(input.keyword)
    conditions.push(
      or(
        sql`${crmLeads.contactName} LIKE ${pattern} ESCAPE '\\'`,
        sql`${crmLeads.contactPhone} LIKE ${pattern} ESCAPE '\\'`,
      )!,
    )
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined
  const total = db.select({ value: count() }).from(crmLeads).where(where).get()?.value ?? 0
  const rows = leadQuery(db)
    .where(where)
    .orderBy(
      sql`${crmLeads.nextContactAt} IS NULL`,
      asc(crmLeads.nextContactAt),
      desc(crmLeads.updatedAt),
      desc(crmLeads.createdAt),
    )
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize)
    .all()
  const maps = leadMaps(db, rows)
  const counts = followUpCounts(db, rows.map((row) => row.id))
  return crmLeadListResponseSchema.parse({
    items: rows.map((row) => toLeadSummary(row, maps, counts.get(row.id) ?? 0)),
    total,
    page: input.page,
    pageSize: input.pageSize,
  })
}

function leadDetailById(db: AppDatabase, leadId: string): CrmLeadDetail {
  const row = requireLead(db, leadId)
  return toLeadDetail(row, leadMaps(db, [row]), followUpCounts(db, [row.id]).get(row.id) ?? 0)
}

export function getLead(db: AppDatabase, actor: CrmActor, leadId: string): CrmLeadDetail {
  const row = requireLead(db, leadId)
  assertLeadAccess(db, actor, row)
  return leadDetailById(db, leadId)
}

export function createLead(
  db: AppDatabase,
  actor: CrmActor,
  body: CreateCrmLeadRequest,
): CrmLeadDetail {
  const community = db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.id, body.communityId))
    .get()
  if (!community) {
    throw new CrmError(400, API_ERROR_CODES.invalidRequest, '社区不存在')
  }
  assertCommunityAccess(db, actor, body.communityId)

  const ownerStaffId = body.ownerStaffId ?? actor.staffId
  if (actor.role === 'grid_worker' && ownerStaffId !== actor.staffId) {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '网格员只能创建本人名下的线索')
  }
  assertStaffAssignable(db, body.communityId, ownerStaffId)

  let sourceActivityId: string | null = null
  if (body.sourceType === 'activity') {
    if (!body.sourceActivityId) {
      throw new CrmError(400, API_ERROR_CODES.invalidRequest, '活动来源必须指定来源活动')
    }
    const activity = db
      .select({ id: activities.id, communityId: activities.communityId })
      .from(activities)
      .where(eq(activities.id, body.sourceActivityId))
      .get()
    if (!activity) {
      throw new CrmError(400, API_ERROR_CODES.invalidRequest, '来源活动不存在')
    }
    if (activity.communityId !== body.communityId) {
      throw new CrmError(400, API_ERROR_CODES.invalidRequest, '来源活动不属于该社区')
    }
    sourceActivityId = activity.id
  } else if (body.sourceActivityId) {
    throw new CrmError(400, API_ERROR_CODES.invalidRequest, '只有活动来源可以指定来源活动')
  }

  let promotionStaffId: string | null = null
  if (body.sourceType === 'grid_promotion') {
    promotionStaffId = body.promotionStaffId ?? ownerStaffId
    assertStaffAssignable(db, body.communityId, promotionStaffId)
  } else if (body.promotionStaffId) {
    throw new CrmError(400, API_ERROR_CODES.invalidRequest, '只有推广来源可以指定推广员工')
  }

  if (body.residentUserId) {
    const resident = db
      .select({ userId: residentCommunityAssignments.userId })
      .from(residentCommunityAssignments)
      .where(
        and(
          eq(residentCommunityAssignments.userId, body.residentUserId),
          eq(residentCommunityAssignments.communityId, body.communityId),
        ),
      )
      .get()
    if (!resident) {
      throw new CrmError(400, API_ERROR_CODES.invalidRequest, '关联居民不属于该社区')
    }
  }

  const now = new Date()
  const leadId = randomUUID()
  try {
    db.transaction((tx) => {
      tx.insert(crmLeads)
        .values({
          id: leadId,
          communityId: body.communityId,
          ownerStaffId,
          residentUserId: body.residentUserId ?? null,
          contactName: body.contactName,
          contactPhone: body.contactPhone,
          sourceType: body.sourceType,
          sourceActivityId,
          promotionStaffId,
          createdByStaffId: actor.staffId,
          status: 'new',
          nextContactAt: body.nextContactAt ? new Date(body.nextContactAt) : null,
          lastContactedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      insertLeadEvent(tx, {
        leadId,
        actorUserId: actor.userId,
        event: 'lead.created',
        toStatus: 'new',
        toOwnerStaffId: ownerStaffId,
        createdAt: now,
      })
      insertAudit(tx, actor.userId, 'crm.lead.created', leadId, now, {
        communityId: body.communityId,
        sourceType: body.sourceType,
        status: 'new',
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return leadDetailById(db, leadId)
}

export function updateLeadStatus(
  db: AppDatabase,
  actor: CrmActor,
  leadId: string,
  body: UpdateCrmLeadStatusRequest,
): CrmLeadDetail {
  const row = requireLead(db, leadId)
  assertLeadAccess(db, actor, row)
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  // `converted` is system-only (order confirm); the contract already limits the body.
  if (!CRM_LEAD_STATUS_TRANSITIONS[row.status].includes(body.status)) {
    throw new CrmError(409, API_ERROR_CODES.conflict, '当前状态不允许该流转')
  }

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  try {
    db.transaction((tx) => {
      const result = tx
        .update(crmLeads)
        .set({ status: body.status, updatedAt })
        .where(
          and(
            eq(crmLeads.id, leadId),
            eq(crmLeads.status, row.status),
            eq(crmLeads.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new CrmError(409, API_ERROR_CODES.conflict, '线索已被其他操作更新，请刷新后重试')
      }
      insertLeadEvent(tx, {
        leadId,
        actorUserId: actor.userId,
        event: 'lead.status_changed',
        fromStatus: row.status,
        toStatus: body.status,
        fromOwnerStaffId: row.ownerStaffId,
        toOwnerStaffId: row.ownerStaffId,
        note: body.note ?? null,
        createdAt: now,
      })
      insertAudit(tx, actor.userId, 'crm.lead.status_changed', leadId, now, {
        fromStatus: row.status,
        toStatus: body.status,
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return leadDetailById(db, leadId)
}

export function transferLead(
  db: AppDatabase,
  actor: CrmActor,
  leadId: string,
  body: TransferCrmLeadRequest,
): CrmLeadDetail {
  const row = requireLead(db, leadId)
  assertLeadAccess(db, actor, row)
  if (body.toOwnerStaffId === row.ownerStaffId) {
    throw new CrmError(409, API_ERROR_CODES.conflict, '该员工已是当前归属')
  }
  assertStaffAssignable(db, row.communityId, body.toOwnerStaffId)
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  try {
    db.transaction((tx) => {
      const result = tx
        .update(crmLeads)
        .set({ ownerStaffId: body.toOwnerStaffId, updatedAt })
        .where(
          and(
            eq(crmLeads.id, leadId),
            eq(crmLeads.ownerStaffId, row.ownerStaffId),
            eq(crmLeads.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new CrmError(409, API_ERROR_CODES.conflict, '线索已被其他操作更新，请刷新后重试')
      }
      insertLeadEvent(tx, {
        leadId,
        actorUserId: actor.userId,
        event: 'lead.transferred',
        fromStatus: row.status,
        toStatus: row.status,
        fromOwnerStaffId: row.ownerStaffId,
        toOwnerStaffId: body.toOwnerStaffId,
        note: body.reason,
        createdAt: now,
      })
      insertAudit(tx, actor.userId, 'crm.lead.transferred', leadId, now, {
        fromOwnerStaffId: row.ownerStaffId,
        toOwnerStaffId: body.toOwnerStaffId,
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return leadDetailById(db, leadId)
}

export function listLeadEvents(
  db: AppDatabase,
  actor: CrmActor,
  leadId: string,
): CrmLeadEventListResponse {
  const row = requireLead(db, leadId)
  assertLeadAccess(db, actor, row)
  const events = db
    .select()
    .from(crmLeadEvents)
    .where(eq(crmLeadEvents.leadId, leadId))
    .orderBy(asc(crmLeadEvents.createdAt))
    .all()
  const maps = refMaps(db, {
    staffIds: events.flatMap((event) => [event.fromOwnerStaffId, event.toOwnerStaffId]),
    userIds: events.map((event) => event.actorUserId),
  })
  return crmLeadEventListResponseSchema.parse({
    items: events.map((event) =>
      crmLeadEventSchema.parse({
        id: event.id,
        leadId: event.leadId,
        event: event.event,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        fromOwnerStaff: event.fromOwnerStaffId
          ? staffRef(maps.staff, event.fromOwnerStaffId)
          : null,
        toOwnerStaff: event.toOwnerStaffId
          ? staffRef(maps.staff, event.toOwnerStaffId)
          : null,
        actor: event.actorUserId ? userRef(maps.users, event.actorUserId) : null,
        note: event.note,
        createdAt: iso(event.createdAt),
      }),
    ),
  })
}

export function listFollowUps(
  db: AppDatabase,
  actor: CrmActor,
  leadId: string,
): CrmFollowUpListResponse {
  const row = requireLead(db, leadId)
  assertLeadAccess(db, actor, row)
  const rows = db
    .select()
    .from(crmFollowUps)
    .where(eq(crmFollowUps.leadId, leadId))
    .orderBy(asc(crmFollowUps.createdAt))
    .all()
  const maps = staffRefMap(db, rows.map((item) => item.staffId))
  return crmFollowUpListResponseSchema.parse({
    items: rows.map((item) =>
      crmFollowUpSchema.parse({
        id: item.id,
        leadId: item.leadId,
        staff: staffRef(maps, item.staffId),
        content: item.content,
        nextContactAt: isoOrNull(item.nextContactAt),
        createdAt: iso(item.createdAt),
      }),
    ),
  })
}

export function createFollowUp(
  db: AppDatabase,
  actor: CrmActor,
  leadId: string,
  body: CreateCrmFollowUpRequest,
): CreateCrmFollowUpResponse {
  const row = requireLead(db, leadId)
  assertLeadAccess(db, actor, row)
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  const nextContactAt =
    body.nextContactAt === undefined
      ? row.nextContactAt
      : body.nextContactAt === null
        ? null
        : new Date(body.nextContactAt)
  const followUpId = randomUUID()

  try {
    db.transaction((tx) => {
      const result = tx
        .update(crmLeads)
        .set({ lastContactedAt: now, nextContactAt, updatedAt })
        .where(
          and(
            eq(crmLeads.id, leadId),
            eq(crmLeads.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new CrmError(409, API_ERROR_CODES.conflict, '线索已被其他操作更新，请刷新后重试')
      }
      tx.insert(crmFollowUps)
        .values({
          id: followUpId,
          leadId,
          staffId: actor.staffId,
          content: body.content,
          nextContactAt,
          createdAt: now,
        })
        .run()
      insertLeadEvent(tx, {
        leadId,
        actorUserId: actor.userId,
        event: 'lead.follow_up_added',
        fromStatus: row.status,
        toStatus: row.status,
        fromOwnerStaffId: row.ownerStaffId,
        toOwnerStaffId: row.ownerStaffId,
        createdAt: now,
      })
      insertAudit(tx, actor.userId, 'crm.follow_up.created', leadId, now)
    })
  } catch (error) {
    mapConstraintError(error)
  }

  const refreshed = leadDetailById(db, leadId)
  const followUp = db
    .select()
    .from(crmFollowUps)
    .where(eq(crmFollowUps.id, followUpId))
    .get()
  if (!followUp) {
    throw new CrmError(404, API_ERROR_CODES.notFound, '跟进记录不存在')
  }
  const maps = staffRefMap(db, [followUp.staffId])
  return {
    followUp: crmFollowUpSchema.parse({
      id: followUp.id,
      leadId: followUp.leadId,
      staff: staffRef(maps, followUp.staffId),
      content: followUp.content,
      nextContactAt: isoOrNull(followUp.nextContactAt),
      createdAt: iso(followUp.createdAt),
    }),
    lead: refreshed,
  }
}

/* -------------------------------- Orders ---------------------------------- */

export interface OrderListInput {
  page: number
  pageSize: number
  communityId?: string
  staffId?: string
  businessType?: CrmBusinessType
  status?: CrmServiceOrderStatus
  keyword?: string
}

export function listOrders(
  db: AppDatabase,
  actor: CrmActor,
  input: OrderListInput,
): CrmOrderListResponse {
  const conditions: SQL<unknown>[] = []

  if (actor.role === 'grid_worker') {
    if (input.staffId && input.staffId !== actor.staffId) {
      throw new CrmError(403, API_ERROR_CODES.forbidden, '网格员只能查看本人名下的业务单')
    }
    const communityIds = assignedCommunityIds(db, actor.staffId)
    if (communityIds.length === 0) {
      return crmOrderListResponseSchema.parse({
        items: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
      })
    }
    conditions.push(
      inArray(crmServiceOrders.communityId, communityIds),
      or(
        eq(crmServiceOrders.createdByStaffId, actor.staffId),
        eq(crmServiceOrders.attributedStaffId, actor.staffId),
      )!,
    )
  } else if (actor.role === 'operator') {
    const communityIds = assignedCommunityIds(db, actor.staffId)
    if (communityIds.length === 0) {
      return crmOrderListResponseSchema.parse({
        items: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
      })
    }
    conditions.push(inArray(crmServiceOrders.communityId, communityIds))
    if (input.staffId) assertStaffFilterAccess(db, actor, input.staffId)
  }

  if (input.communityId) {
    assertCommunityAccess(db, actor, input.communityId)
    conditions.push(eq(crmServiceOrders.communityId, input.communityId))
  }
  if (input.staffId) conditions.push(eq(crmServiceOrders.attributedStaffId, input.staffId))
  if (input.businessType) {
    conditions.push(eq(crmServiceOrders.businessType, input.businessType))
  }
  if (input.status) conditions.push(eq(crmServiceOrders.status, input.status))
  if (input.keyword) {
    const pattern = escapedLike(input.keyword)
    conditions.push(
      or(
        sql`${crmServiceOrders.orderNo} LIKE ${pattern} ESCAPE '\\'`,
        sql`${crmServiceOrders.customerName} LIKE ${pattern} ESCAPE '\\'`,
      )!,
    )
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined
  const total =
    db.select({ value: count() }).from(crmServiceOrders).where(where).get()?.value ?? 0
  const rows = orderQuery(db)
    .where(where)
    .orderBy(desc(crmServiceOrders.updatedAt), desc(crmServiceOrders.createdAt))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize)
    .all()
  const maps = orderMaps(db, rows)
  return crmOrderListResponseSchema.parse({
    items: rows.map((row) => toOrderSummary(row, maps)),
    total,
    page: input.page,
    pageSize: input.pageSize,
  })
}

function orderDetailById(db: AppDatabase, orderId: string): CrmOrderDetail {
  const row = requireOrder(db, orderId)
  return toOrderDetail(row, orderMaps(db, [row]), orderEvents(db, orderId))
}

export function getOrder(
  db: AppDatabase,
  actor: CrmActor,
  orderId: string,
): CrmOrderDetail {
  const row = requireOrder(db, orderId)
  assertOrderAccess(db, actor, row)
  return orderDetailById(db, orderId)
}

export function createOrder(
  db: AppDatabase,
  actor: CrmActor,
  body: CreateCrmServiceOrderRequest,
): CrmOrderDetail {
  const lead = requireLead(db, body.leadId)
  assertLeadAccess(db, actor, lead)
  if (lead.status === 'invalid') {
    throw new CrmError(409, API_ERROR_CODES.conflict, '无效线索不能创建业务单')
  }

  const now = new Date()
  const orderId = randomUUID()
  const customerName = body.customerName ?? lead.contactName
  const contactPhone = body.contactPhone ?? lead.contactPhone

  try {
    db.transaction((tx) => {
      tx.insert(crmServiceOrders)
        .values({
          id: orderId,
          communityId: lead.communityId,
          leadId: lead.id,
          orderNo: body.orderNo,
          businessType: body.businessType,
          status: 'submitted',
          customerName,
          contactPhone,
          evidenceRef: body.evidenceRef ?? null,
          notes: body.notes ?? null,
          createdByStaffId: actor.staffId,
          attributedStaffId: lead.ownerStaffId,
          sourceActivityId: lead.sourceActivityId,
          promotionStaffId: lead.promotionStaffId,
          confirmedByUserId: null,
          confirmedAt: null,
          confirmationNote: null,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      insertOrderEvent(tx, {
        orderId,
        actorUserId: actor.userId,
        event: 'order.created',
        toStatus: 'submitted',
        createdAt: now,
      })
      insertAudit(tx, actor.userId, 'crm.order.created', orderId, now, {
        leadId: lead.id,
        communityId: lead.communityId,
        businessType: body.businessType,
        status: 'submitted',
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return orderDetailById(db, orderId)
}

export function updateOrderStatus(
  db: AppDatabase,
  actor: CrmActor,
  orderId: string,
  body: UpdateCrmOrderStatusRequest,
): CrmOrderDetail {
  const row = requireOrder(db, orderId)
  assertOrderAccess(db, actor, row)
  if (!CRM_ORDER_STATUS_TRANSITIONS[row.status].includes(body.status)) {
    throw new CrmError(409, API_ERROR_CODES.conflict, '当前状态不允许该流转')
  }
  if (body.status === 'failed' && !body.failureReason) {
    throw new CrmError(400, API_ERROR_CODES.invalidRequest, '标记失败必须填写原因')
  }
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  try {
    db.transaction((tx) => {
      const result = tx
        .update(crmServiceOrders)
        .set({
          status: body.status,
          failureReason: body.status === 'failed' ? body.failureReason ?? null : row.failureReason,
          updatedAt,
        })
        .where(
          and(
            eq(crmServiceOrders.id, orderId),
            eq(crmServiceOrders.status, row.status),
            eq(crmServiceOrders.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new CrmError(409, API_ERROR_CODES.conflict, '业务单已被其他操作更新，请刷新后重试')
      }
      insertOrderEvent(tx, {
        orderId,
        actorUserId: actor.userId,
        event: 'order.status_changed',
        fromStatus: row.status,
        toStatus: body.status,
        note: body.note ?? body.failureReason ?? null,
        createdAt: now,
      })
      insertAudit(tx, actor.userId, 'crm.order.status_changed', orderId, now, {
        fromStatus: row.status,
        toStatus: body.status,
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return orderDetailById(db, orderId)
}

export function reviewOrder(
  db: AppDatabase,
  actor: CrmActor,
  orderId: string,
  body: CrmOrderReviewRequest,
): CrmOrderDetail {
  if (actor.role === 'grid_worker') {
    throw new CrmError(403, API_ERROR_CODES.forbidden, '网格员无权执行人工核验')
  }
  const row = requireOrder(db, orderId)
  assertCommunityAccess(db, actor, row.communityId)
  if (row.status !== 'pending_verification') {
    throw new CrmError(409, API_ERROR_CODES.conflict, '只有待核验业务单可以审核')
  }
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  const target: CrmServiceOrderStatus = body.decision === 'confirm' ? 'confirmed' : 'failed'

  try {
    db.transaction((tx) => {
      const result = tx
        .update(crmServiceOrders)
        .set(
          body.decision === 'confirm'
            ? {
                status: 'confirmed',
                confirmedByUserId: actor.userId,
                confirmedAt: now,
                confirmationNote: body.note,
                failureReason: null,
                updatedAt,
              }
            : {
                status: 'failed',
                failureReason: body.note,
                updatedAt,
              },
        )
        .where(
          and(
            eq(crmServiceOrders.id, orderId),
            eq(crmServiceOrders.status, 'pending_verification'),
            eq(crmServiceOrders.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new CrmError(409, API_ERROR_CODES.conflict, '业务单已被其他操作审核，请刷新后重试')
      }

      insertOrderEvent(tx, {
        orderId,
        actorUserId: actor.userId,
        event: 'order.reviewed',
        fromStatus: 'pending_verification',
        toStatus: target,
        note: body.note,
        createdAt: now,
      })
      insertAudit(
        tx,
        actor.userId,
        body.decision === 'confirm' ? 'crm.order.confirmed' : 'crm.order.rejected',
        orderId,
        now,
        {
          fromStatus: 'pending_verification',
          toStatus: target,
          decision: body.decision,
          leadId: row.leadId,
        },
      )

      if (body.decision === 'confirm') {
        const lead = tx
          .select()
          .from(crmLeads)
          .where(eq(crmLeads.id, row.leadId))
          .get()
        if (!lead) {
          throw new CrmError(404, API_ERROR_CODES.notFound, '线索不存在')
        }
        if (lead.status === 'invalid') {
          throw new CrmError(
            409,
            API_ERROR_CODES.conflict,
            '线索已被标记无效，请先由负责人恢复为跟进中再核验',
          )
        }
        if (lead.status === 'new') {
          // Never write a forbidden new -> converted hop: advance through contacting
          // with two conditional updates and two events in this same transaction.
          const contacting = advanceLeadStatus(
            tx,
            lead,
            'contacting',
            actor.userId,
            now,
            '系统随订单人工核验进入跟进',
          )
          advanceLeadStatus(
            tx,
            contacting,
            'converted',
            actor.userId,
            new Date(now.getTime() + 1),
            '订单人工核验确认',
          )
        } else if (lead.status === 'contacting') {
          advanceLeadStatus(tx, lead, 'converted', actor.userId, now, '订单人工核验确认')
        }
        // `converted` is idempotent: confirming a second order leaves the lead untouched.
      }
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return orderDetailById(db, orderId)
}

export function listOrderEvents(
  db: AppDatabase,
  actor: CrmActor,
  orderId: string,
): CrmOrderEventListResponse {
  const row = requireOrder(db, orderId)
  assertOrderAccess(db, actor, row)
  return crmOrderEventListResponseSchema.parse({
    items: orderEvents(db, orderId),
  })
}

/* ------------------------------- Filter options ---------------------------- */

export function getFilterOptions(
  db: AppDatabase,
  actor: CrmActor,
): AdminCrmFilterOptionsResponse {
  const scopedCommunities =
    actor.role === 'admin'
      ? db.select({ id: communities.id, name: communities.name }).from(communities).all()
      : db
          .select({ id: communities.id, name: communities.name })
          .from(staffCommunityAssignments)
          .innerJoin(communities, eq(staffCommunityAssignments.communityId, communities.id))
          .where(eq(staffCommunityAssignments.staffAccountId, actor.staffId))
          .all()
  const allowedCommunities = new Set(scopedCommunities.map((item) => item.id))

  const staffRows = db
    .select({ staffId: staffAccounts.id, displayName: users.displayName, role: staffAccounts.role })
    .from(staffAccounts)
    .leftJoin(users, eq(staffAccounts.userId, users.id))
    .all()
  const staff = staffRows.flatMap((item) => {
    const communityIds = assignedCommunityIds(db, item.staffId)
    if (actor.role !== 'admin') {
      const visible =
        item.staffId === actor.staffId ||
        communityIds.some((id) => allowedCommunities.has(id))
      if (!visible) return []
    }
    const itemCommunities = scopedCommunities.filter((community) =>
      communityIds.includes(community.id),
    )
    return [
      crmStaffOptionSchema.parse({
        id: item.staffId,
        displayName: item.displayName,
        role: item.role,
        communities: itemCommunities,
      }),
    ]
  })

  return adminCrmFilterOptionsResponseSchema.parse({
    communities: scopedCommunities,
    staff,
    leadStatuses: [...crmLeadStatusSchema.options],
    leadSourceTypes: [...crmLeadSourceTypeSchema.options],
    businessTypes: [...crmBusinessTypeSchema.options],
    orderStatuses: [...crmServiceOrderStatusSchema.options],
  })
}
