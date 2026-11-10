import {
  ACTIVITY_DRAW_ROUTES,
  activityDrawPoolSchema,
  activityDrawPrizeSchema,
  createActivityDrawPrizeRequestSchema,
  saveActivityDrawPoolRequestSchema,
  updateActivityDrawPrizeRequestSchema,
  type ActivityDrawPool,
  type ActivityDrawPrize,
  type CreateActivityDrawPrizeRequest,
  type SaveActivityDrawPoolRequest,
  type UpdateActivityDrawPrizeRequest,
} from '@sanchuang-dev/local-life-contracts'
import { fillRoute, parsePayload, requestLocalJson } from './localApi'

/**
 * Admin transport for the real "today's draw" prize pool (LL-LOT-001, #173).
 * Every payload is validated with the shared contract; nothing is cached.
 */

export async function getActivityDrawPool(
  activityId: string,
  signal?: AbortSignal,
): Promise<ActivityDrawPool> {
  const payload = await requestLocalJson(
    `/api${fillRoute(ACTIVITY_DRAW_ROUTES.adminPool, ':activityId', activityId)}`,
    { signal },
  )
  return parsePayload(activityDrawPoolSchema, payload, '抽奖奖品池')
}

export async function saveActivityDrawPool(
  csrfToken: string,
  activityId: string,
  request: SaveActivityDrawPoolRequest,
): Promise<ActivityDrawPool> {
  const body = saveActivityDrawPoolRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(ACTIVITY_DRAW_ROUTES.adminSavePool, ':activityId', activityId)}`,
    { method: 'POST', csrfToken, body },
  )
  return parsePayload(activityDrawPoolSchema, payload, '抽奖奖品池保存结果')
}

export async function createActivityDrawPrize(
  csrfToken: string,
  activityId: string,
  request: CreateActivityDrawPrizeRequest,
): Promise<ActivityDrawPrize> {
  const body = createActivityDrawPrizeRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(ACTIVITY_DRAW_ROUTES.adminCreatePrize, ':activityId', activityId)}`,
    { method: 'POST', csrfToken, body },
  )
  return parsePayload(activityDrawPrizeSchema, payload, '抽奖奖品创建结果')
}

export async function updateActivityDrawPrize(
  csrfToken: string,
  activityId: string,
  prizeId: string,
  request: UpdateActivityDrawPrizeRequest,
): Promise<ActivityDrawPrize> {
  const body = updateActivityDrawPrizeRequestSchema.parse(request)
  const route = fillRoute(ACTIVITY_DRAW_ROUTES.adminPrize, ':activityId', activityId)
  const payload = await requestLocalJson(`/api${fillRoute(route, ':prizeId', prizeId)}`, {
    method: 'PATCH',
    csrfToken,
    body,
  })
  return parsePayload(activityDrawPrizeSchema, payload, '抽奖奖品保存结果')
}
