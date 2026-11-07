import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  LOCAL_ORDER_EVENT_SOURCE_TYPE,
  LOCAL_ORDER_STATUS_TRANSITIONS,
  localOrderCreateResponseSchema,
  localOrderDetailSchema,
  localOrderEventListResponseSchema,
  localOrderEventSchema,
  localOrderListResponseSchema,
  localOrderSummarySchema,
  type CreateLocalOrderOnBehalfRequest,
  type CreateLocalOrderRequest,
  type LocalOrderCreateResponse,
  type LocalOrderDetail,
  type LocalOrderEvent,
  type LocalOrderEventListResponse,
  type LocalOrderListQuery,
  type LocalOrderListResponse,
  type LocalOrderStatus,
  type LocalOrderSummary,
  type LocalOrderTransitionStatus,
  type LocalOrderVerifyRequest,
  type UpdateLocalOrderStatusRequest,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  communities,
  localOrderEvents,
  localOrders,
  residentCommunityAssignments,
  staffAccounts,
  users,
} from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  assertExpectedUpdatedAt,
  combine,
  escapedLike,
  insertAudit,
  iso,
  mapConstraintError,
  nextUpdatedAt,
  scopeCommunityIds,
  type LocalActor,
  type LocalTransaction,
} from './shared.js'
import { requireProduct, type ProductRow } from './products.js'

/* ------------------------------- Selections ------------------------------- */

const orderSelection = {
  id: localOrders.id,
  communityId: localOrders.communityId,
  communityName: communities.name,
  productId: localOrders.productId,
  residentUserId: localOrders.residentUserId,
  idempotencyKey: localOrders.idempotencyKey,
  status: localOrders.status,
  recordSource: localOrders.recordSource,
  productName: localOrders.productName,
  unitPriceCents: localOrders.unitPriceCents,
  quantity: localOrders.quantity,
  totalCents: localOrders.totalCents,
  note: localOrders.note,
  createdByStaffId: localOrders.createdByStaffId,
  attributedStaffId: localOrders.attributedStaffId,
  sourceActivityId: localOrders.sourceActivityId,
  verifiedByUserId: localOrders.verifiedByUserId,
  verifiedAt: localOrders.verifiedAt,
  verificationNote: localOrders.verificationNote,
  createdAt: localOrders.createdAt,
  updatedAt: localOrders.updatedAt,
}

interface OrderRow {
  id: string
  communityId: string
  communityName: string
  productId: string
  residentUserId: string
  idempotencyKey: string
  status: LocalOrderStatus
  recordSource: 'resident' | 'staff_on_behalf'
  productName: string
  unitPriceCents: number
  quantity: number
  totalCents: number
  note: string | null
  createdByStaffId: string | null
  attributedStaffId: string | null
  sourceActivityId: string | null
  verifiedByUserId: string | null
  verifiedAt: Date | null
  verificationNote: string | null
  createdAt: Date
  updatedAt: Date
}

function orderQuery(db: AppDatabase) {
  return db
    .select(orderSelection)
    .from(localOrders)
    .innerJoin(communities, eq(localOrders.communityId, communities.id))
}

function findOrder(db: AppDatabase, orderId: string): OrderRow | undefined {
  return orderQuery(db).where(eq(localOrders.id, orderId)).get()
}

function requireOrder(db: AppDatabase, orderId: string): OrderRow {
  const row = findOrder(db, orderId)
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '订单不存在')
  return row
}

function findByIdempotencyKey(
  db: AppDatabase,
  communityId: string,
  residentUserId: string,
  idempotencyKey: string,
): OrderRow | undefined {
  return orderQuery(db)
    .where(
      and(
        eq(localOrders.communityId, communityId),
        eq(localOrders.residentUserId, residentUserId),
        eq(localOrders.idempotencyKey, idempotencyKey),
      ),
    )
    .get()
}

/* --------------------------------- Helpers -------------------------------- */

function userRefMap(db: AppDatabase, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, { id: string; displayName: string | null }>()
  if (unique.length === 0) return map
  for (const row of db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, unique))
    .all()) {
    map.set(row.id, row)
  }
  return map
}

function staffRefMap(db: AppDatabase, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, { id: string; displayName: string | null }>()
  if (unique.length === 0) return map
  for (const row of db
    .select({ id: staffAccounts.id, displayName: users.displayName })
    .from(staffAccounts)
    .leftJoin(users, eq(staffAccounts.userId, users.id))
    .where(inArray(staffAccounts.id, unique))
    .all()) {
    map.set(row.id, { id: row.id, displayName: row.displayName ?? null })
  }
  return map
}

function activityRefMap(db: AppDatabase, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, { id: string; title: string }>()
  if (unique.length === 0) return map
  for (const row of db
    .select({ id: activities.id, title: activities.title })
    .from(activities)
    .where(inArray(activities.id, unique))
    .all()) {
    map.set(row.id, row)
  }
  return map
}

interface RefMaps {
  users: ReturnType<typeof userRefMap>
  staff: ReturnType<typeof staffRefMap>
  activities: ReturnType<typeof activityRefMap>
}

function refMaps(db: AppDatabase, rows: OrderRow[], events: Array<typeof localOrderEvents.$inferSelect> = []): RefMaps {
  return {
    users: userRefMap(db, [
      ...rows.map((row) => row.residentUserId),
      ...rows.map((row) => row.verifiedByUserId),
      ...events.map((row) => row.actorUserId),
    ]),
    staff: staffRefMap(db, [
      ...rows.map((row) => row.createdByStaffId),
      ...rows.map((row) => row.attributedStaffId),
      ...events.map((row) => row.actorStaffId),
    ]),
    activities: activityRefMap(db, rows.map((row) => row.sourceActivityId)),
  }
}

function userRef(map: RefMaps['users'], id: string | null) {
  if (!id) return null
  return map.get(id) ?? { id, displayName: null }
}

function staffRef(map: RefMaps['staff'], id: string | null) {
  if (!id) return null
  return map.get(id) ?? { id, displayName: null }
}

function toEvent(
  row: typeof localOrderEvents.$inferSelect,
  maps: RefMaps,
): LocalOrderEvent {
  return localOrderEventSchema.parse({
    id: row.id,
    orderId: row.orderId,
    event: row.event,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actor: userRef(maps.users, row.actorUserId),
    actorStaff: staffRef(maps.staff, row.actorStaffId),
    note: row.note,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    createdAt: iso(row.createdAt),
  })
}

function toSummary(row: OrderRow, maps: RefMaps): LocalOrderSummary {
  return localOrderSummarySchema.parse({
    id: row.id,
    community: { id: row.communityId, name: row.communityName },
    resident: userRef(maps.users, row.residentUserId) ?? {
      id: row.residentUserId,
      displayName: null,
    },
    snapshot: {
      productId: row.productId,
      productName: row.productName,
      unitPriceCents: row.unitPriceCents,
      quantity: row.quantity,
      totalCents: row.totalCents,
    },
    status: row.status,
    recordSource: row.recordSource,
    createdByStaff: staffRef(maps.staff, row.createdByStaffId),
    attributedStaff: staffRef(maps.staff, row.attributedStaffId),
    sourceActivity:
      row.sourceActivityId === null
        ? null
        : maps.activities.get(row.sourceActivityId) ?? null,
    note: row.note,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function eventRows(db: AppDatabase, orderId: string) {
  return db
    .select()
    .from(localOrderEvents)
    .where(eq(localOrderEvents.orderId, orderId))
    .orderBy(asc(localOrderEvents.createdAt), asc(localOrderEvents.id))
    .all()
}

function toDetail(row: OrderRow, db: AppDatabase): LocalOrderDetail {
  const events = eventRows(db, row.id)
  const maps = refMaps(db, [row], events)
  const lastNote = [...events].reverse().find((event) => event.note)?.note ?? null
  return localOrderDetailSchema.parse({
    ...toSummary(row, maps),
    verification:
      row.status === 'verified' && row.verifiedAt
        ? {
            verifiedBy: userRef(maps.users, row.verifiedByUserId),
            verifiedAt: iso(row.verifiedAt),
            note: row.verificationNote ?? '人工核验',
          }
        : null,
    statusNote: row.status === 'verified' ? null : lastNote,
    events: events.map((event) => toEvent(event, maps)),
  })
}

function detailById(db: AppDatabase, orderId: string): LocalOrderDetail {
  return toDetail(requireOrder(db, orderId), db)
}

/* ------------------------------- Audit / events --------------------------- */

function insertOrderEvent(
  tx: LocalTransaction,
  input: {
    orderId: string
    actorUserId: string | null
    actorStaffId: string | null
    event: LocalOrderEvent['event']
    fromStatus?: LocalOrderStatus | null
    toStatus?: LocalOrderStatus | null
    note?: string | null
    createdAt: Date
  },
): void {
  tx.insert(localOrderEvents)
    .values({
      id: randomUUID(),
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      actorStaffId: input.actorStaffId,
      event: input.event,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      note: input.note ?? null,
      // Stable consumption contract (#64): every event names its own domain and
      // the order id, so a consumer never has to join to find out what it is.
      sourceType: LOCAL_ORDER_EVENT_SOURCE_TYPE,
      sourceId: input.orderId,
      createdAt: input.createdAt,
    })
    .run()
}

/* ------------------------------- Registration ----------------------------- */

interface RegistrationInput {
  actor: LocalActor
  productId: string
  quantity: number
  note?: string
  sourceActivityId?: string
  idempotencyKey: string
  /** Present only on the staff on-behalf path; resolved server-side from the session. */
  onBehalfOf?: { residentUserId: string; staffId: string }
}

function matchesIntent(row: OrderRow, input: RegistrationInput): boolean {
  return (
    row.productId === input.productId &&
    row.quantity === input.quantity &&
    (row.note ?? null) === (input.note ?? null) &&
    (row.sourceActivityId ?? null) === (input.sourceActivityId ?? null)
  )
}

function assertResidentOfCommunity(
  db: AppDatabase,
  residentUserId: string,
  communityId: string,
): void {
  const membership = db
    .select()
    .from(residentCommunityAssignments)
    .where(
      and(
        eq(residentCommunityAssignments.userId, residentUserId),
        eq(residentCommunityAssignments.communityId, communityId),
      ),
    )
    .get()
  if (!membership) {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '居民不属于该社区，无法登记该商品')
  }
}

/**
 * Registers (or, on an idempotency replay, returns) one local order.
 *
 * Security properties enforced here, not in the route:
 * - the resident comes from the session (or, for on-behalf recording, from a
 *   resident that is proven to belong to the product's community);
 * - the community comes from the product row, never from the body;
 * - the product name / unit price / total are read from `local_products` now and
 *   frozen into the order, so a client cannot influence money and a later price
 *   edit cannot rewrite history;
 * - an off-shelf product refuses *new* registrations;
 * - `(community, resident, idempotencyKey)` is UNIQUE, so a replay — including a
 *   concurrent one that lost the race at the storage layer — returns the existing
 *   order instead of writing a second row.
 */
function registerOrder(db: AppDatabase, input: RegistrationInput): LocalOrderCreateResponse {
  const product = requireProduct(db, input.productId)

  const residentUserId = input.onBehalfOf?.residentUserId ?? input.actor.userId
  const createdByStaffId = input.onBehalfOf?.staffId ?? null
  const recordSource = input.onBehalfOf ? 'staff_on_behalf' : 'resident'

  if (input.onBehalfOf) {
    // Only inside an assigned community, and only for an account that already
    // belongs to that community: no cross-community recording, no ghost residents.
    assertCommunityAccess(db, input.actor, product.communityId)
    const resident = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, residentUserId))
      .get()
    if (!resident) {
      throw new LocalError(404, API_ERROR_CODES.notFound, '代录目标居民账户不存在')
    }
    assertResidentOfCommunity(db, residentUserId, product.communityId)
  } else {
    // Self-service: the resident must actually belong to the product's community.
    assertResidentOfCommunity(db, residentUserId, product.communityId)
  }

  if (input.sourceActivityId) {
    const activity = db
      .select({ id: activities.id, communityId: activities.communityId })
      .from(activities)
      .where(eq(activities.id, input.sourceActivityId))
      .get()
    if (!activity) throw new LocalError(404, API_ERROR_CODES.notFound, '来源活动不存在')
    if (activity.communityId !== product.communityId) {
      throw new LocalError(400, API_ERROR_CODES.invalidRequest, '来源活动不属于该社区')
    }
  }

  const replay = findByIdempotencyKey(
    db,
    product.communityId,
    residentUserId,
    input.idempotencyKey,
  )
  if (replay) {
    if (!matchesIntent(replay, input)) {
      throw new LocalError(
        409,
        API_ERROR_CODES.orderIdempotencyConflict,
        '幂等键已用于另一笔内容不同的登记，请刷新后重试',
      )
    }
    return localOrderCreateResponseSchema.parse({
      created: false,
      order: detailById(db, replay.id),
    })
  }

  if (product.status !== 'on_shelf') {
    throw new LocalError(409, API_ERROR_CODES.productOffShelf, '该商品已下架，无法登记')
  }

  const now = new Date()
  const orderId = randomUUID()
  try {
    db.transaction((tx) => {
      tx.insert(localOrders)
        .values({
          id: orderId,
          communityId: product.communityId,
          productId: product.id,
          residentUserId,
          idempotencyKey: input.idempotencyKey,
          status: 'registered',
          recordSource,
          // Frozen snapshot, computed server-side only.
          productName: product.name,
          unitPriceCents: product.unitPriceCents,
          quantity: input.quantity,
          totalCents: product.unitPriceCents * input.quantity,
          note: input.note ?? null,
          createdByStaffId,
          attributedStaffId: createdByStaffId,
          sourceActivityId: input.sourceActivityId ?? null,
          verifiedByUserId: null,
          verifiedAt: null,
          verificationNote: null,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      insertOrderEvent(tx, {
        orderId,
        actorUserId: input.actor.userId,
        actorStaffId: createdByStaffId,
        event: input.onBehalfOf ? 'order.created_on_behalf' : 'order.registered',
        toStatus: 'registered',
        createdAt: now,
      })
      insertAudit(
        tx,
        input.actor.userId,
        input.onBehalfOf ? 'local_order.created_on_behalf' : 'local_order.registered',
        orderId,
        now,
        {
          communityId: product.communityId,
          productId: product.id,
          residentUserId,
          quantity: String(input.quantity),
          totalCents: String(product.unitPriceCents * input.quantity),
          ...(input.onBehalfOf ? { delegatedBy: 'staff', recordSource } : { recordSource }),
        },
      )
    })
  } catch (error) {
    // A concurrent writer may have won the UNIQUE race: in that case the correct
    // answer is still "one order exists", not a 500.
    const winner = findByIdempotencyKey(
      db,
      product.communityId,
      residentUserId,
      input.idempotencyKey,
    )
    if (winner) {
      if (!matchesIntent(winner, input)) {
        throw new LocalError(
          409,
          API_ERROR_CODES.orderIdempotencyConflict,
          '幂等键已用于另一笔内容不同的登记，请刷新后重试',
        )
      }
      return localOrderCreateResponseSchema.parse({
        created: false,
        order: detailById(db, winner.id),
      })
    }
    mapConstraintError(error)
  }
  return localOrderCreateResponseSchema.parse({
    created: true,
    order: detailById(db, orderId),
  })
}

export function registerResidentOrder(
  db: AppDatabase,
  actor: LocalActor,
  body: CreateLocalOrderRequest,
): LocalOrderCreateResponse {
  return registerOrder(db, {
    actor,
    productId: body.productId,
    quantity: body.quantity,
    idempotencyKey: body.idempotencyKey,
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(body.sourceActivityId === undefined ? {} : { sourceActivityId: body.sourceActivityId }),
  })
}

export function registerOrderOnBehalf(
  db: AppDatabase,
  actor: LocalActor,
  body: CreateLocalOrderOnBehalfRequest,
): LocalOrderCreateResponse {
  if (!actor.staffId) {
    throw new LocalError(401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
  }
  return registerOrder(db, {
    actor,
    productId: body.productId,
    quantity: body.quantity,
    idempotencyKey: body.idempotencyKey,
    onBehalfOf: { residentUserId: body.residentUserId, staffId: actor.staffId },
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(body.sourceActivityId === undefined ? {} : { sourceActivityId: body.sourceActivityId }),
  })
}

/* --------------------------------- Reads ---------------------------------- */

function listOrders(
  db: AppDatabase,
  conditions: SQL<unknown>[],
  query: LocalOrderListQuery,
): LocalOrderListResponse {
  const where = combine(conditions)
  const total =
    db.select({ value: count() }).from(localOrders).where(where).get()?.value ?? 0
  const rows = orderQuery(db)
    .where(where)
    .orderBy(desc(localOrders.updatedAt), desc(localOrders.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all()
  const maps = refMaps(db, rows)
  return localOrderListResponseSchema.parse({
    items: rows.map((row) => toSummary(row, maps)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

/** A resident only ever reads their own orders; the filter is not negotiable. */
export function listMyOrders(
  db: AppDatabase,
  actor: LocalActor,
  query: LocalOrderListQuery,
): LocalOrderListResponse {
  const conditions: SQL<unknown>[] = [eq(localOrders.residentUserId, actor.userId)]
  if (query.status) conditions.push(eq(localOrders.status, query.status))
  if (query.communityId) conditions.push(eq(localOrders.communityId, query.communityId))
  if (query.productId) conditions.push(eq(localOrders.productId, query.productId))
  return listOrders(db, conditions, query)
}

export function getMyOrder(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
): LocalOrderDetail {
  const row = requireOrder(db, orderId)
  if (row.residentUserId !== actor.userId) {
    // 404, not 403: another resident's order must not be enumerable.
    throw new LocalError(404, API_ERROR_CODES.notFound, '订单不存在')
  }
  return toDetail(row, db)
}

/**
 * Staff list. `grid_worker`/`operator` are limited to their assigned communities;
 * `admin` is unscoped. An empty assignment yields an empty page, not an error.
 */
export function listStaffOrders(
  db: AppDatabase,
  actor: LocalActor,
  query: LocalOrderListQuery,
): LocalOrderListResponse {
  const scope = scopeCommunityIds(db, actor)
  const conditions: SQL<unknown>[] = []
  if (scope !== null) {
    if (scope.length === 0) {
      return localOrderListResponseSchema.parse({
        items: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      })
    }
    conditions.push(inArray(localOrders.communityId, scope))
  }
  if (query.communityId) {
    assertCommunityAccess(db, actor, query.communityId)
    conditions.push(eq(localOrders.communityId, query.communityId))
  }
  if (query.status) conditions.push(eq(localOrders.status, query.status))
  if (query.productId) conditions.push(eq(localOrders.productId, query.productId))
  if (query.residentUserId) conditions.push(eq(localOrders.residentUserId, query.residentUserId))
  if (query.keyword) {
    const pattern = escapedLike(query.keyword)
    conditions.push(
      or(
        sql`${localOrders.productName} LIKE ${pattern} ESCAPE '\\'`,
        sql`${localOrders.note} LIKE ${pattern} ESCAPE '\\'`,
      )!,
    )
  }
  return listOrders(db, conditions, query)
}

export function getStaffOrder(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
): LocalOrderDetail {
  const row = requireOrder(db, orderId)
  assertCommunityAccess(db, actor, row.communityId)
  return toDetail(row, db)
}

export function listOrderEvents(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
): LocalOrderEventListResponse {
  const row = requireOrder(db, orderId)
  assertCommunityAccess(db, actor, row.communityId)
  const events = eventRows(db, orderId)
  const maps = refMaps(db, [row], events)
  return localOrderEventListResponseSchema.parse({
    items: events.map((event) => toEvent(event, maps)),
  })
}

/* -------------------------------- Writes ---------------------------------- */

/**
 * Moves an order along the frozen state machine. `verified` is rejected here:
 * only the operations verification endpoint may produce it.
 */
export function updateOrderStatus(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
  body: UpdateLocalOrderStatusRequest,
): LocalOrderDetail {
  const row = requireOrder(db, orderId)
  assertCommunityAccess(db, actor, row.communityId)
  if (row.status === 'verified') {
    throw new LocalError(
      409,
      API_ERROR_CODES.orderAlreadyVerified,
      '订单已完成人工核验，不能再变更状态',
    )
  }
  const next = body.status as LocalOrderTransitionStatus
  if (!LOCAL_ORDER_STATUS_TRANSITIONS[row.status].includes(next)) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '当前状态不允许该流转')
  }
  if (next === 'rejected' && !body.note) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '拒绝登记必须填写原因')
  }
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  try {
    db.transaction((tx) => {
      const result = tx
        .update(localOrders)
        .set({ status: next, updatedAt })
        .where(
          and(
            eq(localOrders.id, orderId),
            eq(localOrders.status, row.status),
            eq(localOrders.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new LocalError(409, API_ERROR_CODES.conflict, '订单已被其他操作更新，请刷新后重试')
      }
      insertOrderEvent(tx, {
        orderId,
        actorUserId: actor.userId,
        actorStaffId: actor.staffId,
        event: next === 'rejected' ? 'order.rejected' : 'order.status_changed',
        fromStatus: row.status,
        toStatus: next,
        note: body.note ?? null,
        createdAt: now,
      })
      insertAudit(
        tx,
        actor.userId,
        next === 'rejected' ? 'local_order.rejected' : 'local_order.status_changed',
        orderId,
        now,
        { fromStatus: row.status, toStatus: next },
      )
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return detailById(db, orderId)
}

/**
 * Operations manual verification. `verified` records that a human checked the
 * facts; it never means paid or activated, which is why no such field exists.
 *
 * Re-verifying an already verified order is an explicit 409
 * `order_already_verified` rather than a silent no-op: two "successes" on the
 * same order would read like two fulfilled deals.
 */
export function verifyOrder(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
  body: LocalOrderVerifyRequest,
): LocalOrderDetail {
  if (actor.role === 'grid_worker' || !actor.role) {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '网格员无权执行人工核验')
  }
  const row = requireOrder(db, orderId)
  assertCommunityAccess(db, actor, row.communityId)
  if (row.status === 'verified') {
    throw new LocalError(
      409,
      API_ERROR_CODES.orderAlreadyVerified,
      '订单已核验，请勿重复核验',
    )
  }
  if (row.status !== 'pending_review') {
    throw new LocalError(409, API_ERROR_CODES.conflict, '只有待核验订单可以核验')
  }
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  const target: LocalOrderStatus = body.decision === 'verify' ? 'verified' : 'rejected'
  try {
    db.transaction((tx) => {
      const result = tx
        .update(localOrders)
        .set(
          body.decision === 'verify'
            ? {
                status: 'verified',
                verifiedByUserId: actor.userId,
                verifiedAt: now,
                verificationNote: body.note,
                updatedAt,
              }
            : {
                status: 'rejected',
                verifiedByUserId: null,
                verifiedAt: null,
                verificationNote: null,
                updatedAt,
              },
        )
        .where(
          and(
            eq(localOrders.id, orderId),
            eq(localOrders.status, 'pending_review'),
            eq(localOrders.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new LocalError(
          409,
          API_ERROR_CODES.conflict,
          '订单已被其他操作核验，请刷新后重试',
        )
      }
      insertOrderEvent(tx, {
        orderId,
        actorUserId: actor.userId,
        actorStaffId: actor.staffId,
        event: body.decision === 'verify' ? 'order.verified' : 'order.rejected',
        fromStatus: 'pending_review',
        toStatus: target,
        note: body.note,
        createdAt: now,
      })
      insertAudit(
        tx,
        actor.userId,
        body.decision === 'verify' ? 'local_order.verified' : 'local_order.rejected',
        orderId,
        now,
        { fromStatus: 'pending_review', toStatus: target, decision: body.decision },
      )
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return detailById(db, orderId)
}

/** Exposed for the routes' 404-vs-403 decisions without re-querying twice. */
export function orderCommunity(db: AppDatabase, orderId: string): string {
  const row = requireOrder(db, orderId)
  return row.communityId
}

export type { ProductRow }
