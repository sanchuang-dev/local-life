import {
  EXTERNAL_OFFER_ROUTES,
  createExternalOfferRequestSchema,
  updateExternalOfferRequestSchema,
  externalOfferSchema,
  externalOfferListSchema,
  type ExternalOffer,
  type CreateExternalOfferRequest,
  type UpdateExternalOfferRequest,
} from '@sanchuang-dev/local-life-contracts'
import { fillRoute, parsePayload, requestLocalJson } from './localApi'

export async function listAdminOffers(signal?: AbortSignal): Promise<ExternalOffer[]> {
  const response = await requestLocalJson('/api' + EXTERNAL_OFFER_ROUTES.adminList, { signal })
  return parsePayload(externalOfferListSchema, response, '第三方优惠列表').items
}

export async function createAdminOffer(
  csrfToken: string, data: CreateExternalOfferRequest,
): Promise<ExternalOffer> {
  const body = createExternalOfferRequestSchema.parse(data)
  return parsePayload(externalOfferSchema, await requestLocalJson(
    '/api' + EXTERNAL_OFFER_ROUTES.adminList,
    { method: 'POST', csrfToken, body },
  ), '第三方优惠创建结果')
}

export async function updateAdminOffer(
  csrfToken: string, id: string, data: UpdateExternalOfferRequest,
): Promise<ExternalOffer> {
  const body = updateExternalOfferRequestSchema.parse(data)
  return parsePayload(externalOfferSchema, await requestLocalJson(
    '/api' + fillRoute(EXTERNAL_OFFER_ROUTES.adminDetail, ':offerId', id),
    { method: 'PATCH', csrfToken, body },
  ), '第三方优惠修改结果')
}
