import {
  ACTIVITY_DRAW_ROUTES,
  publicActivityDrawPoolSchema,
  residentDrawAttemptSchema,
  residentDrawHistorySchema,
  residentDrawStateSchema,
  drawStaffCredentialSchema,
  type PublicActivityDrawPool,
  type ResidentDrawAttempt,
  type ResidentDrawState,
  type DrawStaffCredential,
} from '@sanchuang-dev/local-life-contracts'
import { requestLocal } from './localApi'

/** Every route and response is checked against the canonical shared contracts. */
export function drawApiPath(route: string, activityId: string): string {
  return '/api' + route.replace(':activityId', encodeURIComponent(activityId))
}

export function getPublicDrawPool(activityId: string, signal?: AbortSignal): Promise<PublicActivityDrawPool> {
  return requestLocal(drawApiPath(ACTIVITY_DRAW_ROUTES.publicPool, activityId),
    publicActivityDrawPoolSchema, '今日抽奖奖品', { signal })
}
export function getResidentDrawState(activityId: string, signal?: AbortSignal): Promise<ResidentDrawState> {
  return requestLocal(drawApiPath(ACTIVITY_DRAW_ROUTES.state, activityId),
    residentDrawStateSchema, '今日抽奖资格', { signal })
}
export function getResidentDrawHistory(activityId: string, signal?: AbortSignal) {
  return requestLocal(drawApiPath(ACTIVITY_DRAW_ROUTES.history, activityId),
    residentDrawHistorySchema, '抽奖记录', { signal })
}
export function enterResidentDraw(
  activityId: string, csrfToken: string, idempotencyKey: string,
): Promise<ResidentDrawAttempt> {
  return requestLocal(drawApiPath(ACTIVITY_DRAW_ROUTES.enter, activityId),
    residentDrawAttemptSchema, '抽奖', {
      method: 'POST', csrfToken, body: { idempotencyKey },
    })
}
/** Staff authorization, origin and community scope are independently enforced by Hono. */
export function verifyStaffDrawCode(
  activityId: string, csrfToken: string, code: string,
): Promise<DrawStaffCredential> {
  return requestLocal(drawApiPath(ACTIVITY_DRAW_ROUTES.adminVerify, activityId),
    drawStaffCredentialSchema, '奖品查验', { method: 'POST', csrfToken, body: { code } })
}
export function redeemStaffDrawCode(
  activityId: string, csrfToken: string, code: string,
): Promise<DrawStaffCredential> {
  return requestLocal(drawApiPath(ACTIVITY_DRAW_ROUTES.adminRedeem, activityId),
    drawStaffCredentialSchema, '奖品核销', { method: 'POST', csrfToken, body: { code } })
}
