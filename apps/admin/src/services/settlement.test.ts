// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateSettlementMappingRequest,
  CreateSettlementPartyRequest,
  CreateSettlementRuleRequest,
  SettlementMapping,
  SettlementOrderPartySnapshot,
  SettlementParty,
  SettlementQuoteResponse,
  SettlementRuleVersion,
} from '@sanchuang-dev/local-life-contracts'
import { LocalApiError } from './localApi'
import {
  SETTLEMENT_PARTY_ROLE_LABELS,
  SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS,
  SETTLEMENT_RULE_FIXED_POLICY_LABELS,
  SETTLEMENT_RULE_PARTY_KEY_LABELS,
  confirmSettlementOrderParty,
  createSettlementMapping,
  createSettlementParty,
  createSettlementRuleVersion,
  listSettlementMappings,
  listSettlementParties,
  listSettlementRuleVersions,
  quoteSettlementOrder,
  readSettlementOrderParty,
  type SettlementOrderPartyResponse,
} from './settlement'

/**
 * Transport-level tests for the settlement-party service (#219).
 *
 * `fetch` is stubbed and every response is a literal body, so these tests prove
 * what the service actually sends and what it does with the server's answer:
 *
 * - the list request is built from `LEDGER_ROUTES` with no query unless the
 *   caller really narrowed to one community;
 * - the create request is a CSRF-protected POST whose body is exactly the
 *   contracted fields (no `verifiedAt`, no client-side verification claim);
 * - a 201 single object is parsed with the *party* schema, not the list schema;
 * - contract mismatches raise `invalid_response` instead of degrading to `[]`;
 * - real 403/409 envelopes and a network rejection keep their status/code/message.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const PARTY_ID = '123e4567-e89b-42d3-a456-426614174501'
const COMMUNITY_ID = '123e4567-e89b-42d3-a456-4266141740a1'

const PARTY: SettlementParty = {
  id: PARTY_ID,
  role: 'seller',
  legalName: '重庆幸福商贸有限公司',
  registryRef: '91500000MA5U1234XY',
  verificationRef: '营业执照核验单 2026-001',
  // Verification is the server's fact only; the fixture just records what it said.
  verifiedAt: '2026-11-01T02:00:00.000Z',
  createdByUserId: USER_ID,
  createdAt: '2026-11-01T01:00:00.000Z',
}

const CREATE_REQUEST: CreateSettlementPartyRequest = {
  role: 'seller',
  legalName: '重庆幸福商贸有限公司',
  registryRef: '91500000MA5U1234XY',
  verificationRef: '营业执照核验单 2026-001',
}

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit]

const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A minimal JSON response; jsdom has no `Response`, and this is all the code reads. */
function stubJson(status: number, payload: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  } as unknown as Response)
}

function stubRejection(cause: unknown): void {
  fetchMock.mockRejectedValueOnce(cause)
}

function lastCall(): { url: string; init: RequestInit; headers: Record<string, string> } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  const init = call[1] ?? {}
  return {
    url: String(call[0]),
    init,
    headers: (init.headers ?? {}) as Record<string, string>,
  }
}

describe('SETTLEMENT_PARTY_ROLE_LABELS', () => {
  it('covers exactly the three contracted roles with the agreed wording', () => {
    expect(SETTLEMENT_PARTY_ROLE_LABELS).toEqual({
      seller: '商品销售商户',
      sanchuang: '三创主体',
      guangdian: '广电主体',
    })
  })
})

describe('listSettlementParties', () => {
  it('GET 无筛选：只请求 /api/admin/settlement/parties，不带 query，返回解析后的 items', async () => {
    stubJson(200, { items: [PARTY] })

    const parties = await listSettlementParties()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init, headers } = lastCall()
    expect(url).toBe('/api/admin/settlement/parties')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('include')
    // A read must not carry a write token, and must not send a body.
    expect(headers['x-csrf-token']).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect(parties).toEqual([PARTY])
  })

  it('GET 空筛选值不发送 communityId：管理员「全部」查询没有参数', async () => {
    stubJson(200, { items: [] })

    await listSettlementParties({ communityId: '   ' })

    expect(lastCall().url).toBe('/api/admin/settlement/parties')
  })

  it('GET 带 communityId：query 正确编码，且只有一个参数', async () => {
    stubJson(200, { items: [PARTY] })

    const parties = await listSettlementParties({ communityId: COMMUNITY_ID })

    const { url } = lastCall()
    expect(url).toBe(
      `/api/admin/settlement/parties?communityId=${encodeURIComponent(COMMUNITY_ID)}`,
    )
    expect(new URL(url, 'http://localhost').searchParams.getAll('communityId')).toEqual([
      COMMUNITY_ID,
    ])
    expect(parties).toEqual([PARTY])
  })

  it('未核验主体原样返回 verifiedAt=null，不推断、不补齐', async () => {
    const unverified: SettlementParty = { ...PARTY, verifiedAt: null }
    stubJson(200, { items: [unverified] })

    const [party] = await listSettlementParties()

    expect(party?.verifiedAt).toBeNull()
  })

  it('响应不符合契约：抛 invalid_response，不返回空列表', async () => {
    // Missing `items` is not an empty list — it is a broken contract.
    stubJson(200, {})

    const failure = await listSettlementParties().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
    expect((failure as LocalApiError).status).toBe(200)
  })

  it('主体字段不符合契约：同样抛 invalid_response', async () => {
    stubJson(200, {
      items: [{ ...PARTY, verifiedAt: '2026-11-01 02:00' }],
    })

    const failure = await listSettlementParties().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })

  it('403 错误 envelope：LocalApiError status 403，code 与 message 保留', async () => {
    stubJson(403, {
      error: { code: 'forbidden', message: '当前角色无权查看或管理商户主体' },
    })

    const failure = await listSettlementParties().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(403)
    expect((failure as LocalApiError).code).toBe('forbidden')
    expect((failure as LocalApiError).message).toBe('当前角色无权查看或管理商户主体')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetch 拒绝：LocalApiError status 0、code network_error', async () => {
    stubRejection(new TypeError('Failed to fetch'))

    const failure = await listSettlementParties().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(0)
    expect((failure as LocalApiError).code).toBe('network_error')
  })
})

describe('createSettlementParty', () => {
  it('POST：路径/方法正确、带 x-csrf-token、body 等于契约字段，201 单个对象解析成功', async () => {
    stubJson(201, PARTY)

    const created = await createSettlementParty('csrf-token-for-party-tests', CREATE_REQUEST)

    const { url, init, headers } = lastCall()
    expect(url).toBe('/api/admin/settlement/parties')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(headers['x-csrf-token']).toBe('csrf-token-for-party-tests')
    expect(headers['content-type']).toBe('application/json')
    const body: unknown = JSON.parse(String(init.body))
    expect(body).toEqual(CREATE_REQUEST)
    // The client must not claim a verification fact: the request has no such field.
    expect(body).not.toHaveProperty('verifiedAt')
    expect(created).toEqual(PARTY)
  })

  it('verificationRef=null 是合法契约值，原样发送（未核验不等于无依据）', async () => {
    const request: CreateSettlementPartyRequest = { ...CREATE_REQUEST, verificationRef: null }
    stubJson(201, { ...PARTY, verificationRef: null, verifiedAt: null })

    const created = await createSettlementParty('csrf-token', request)

    expect(JSON.parse(String(lastCall().init.body))).toEqual(request)
    expect(created.verifiedAt).toBeNull()
  })

  it('body 先经契约校验：非法 role 不会发起请求', async () => {
    const invalid = { ...CREATE_REQUEST, role: 'carrier' } as unknown as CreateSettlementPartyRequest

    const failure = await createSettlementParty('csrf-token', invalid).catch(
      (cause: unknown) => cause,
    )

    expect(failure).not.toBeInstanceOf(LocalApiError)
    expect(failure).toBeInstanceOf(Error)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('201 返回列表形状而不是单个主体：抛 invalid_response，不当作创建成功', async () => {
    stubJson(201, { items: [PARTY] })

    const failure = await createSettlementParty('csrf-token', CREATE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })

  it('409 冲突 envelope：status 409、code/message 冒泡，不伪造成功', async () => {
    stubJson(409, {
      error: { code: 'conflict', message: '同一统一社会信用代码的主体已登记' },
    })

    const failure = await createSettlementParty('csrf-token', CREATE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(409)
    expect((failure as LocalApiError).code).toBe('conflict')
    expect((failure as LocalApiError).message).toBe('同一统一社会信用代码的主体已登记')
  })

  it('401 未登录：status 401 原样冒泡', async () => {
    stubJson(401, { error: { code: 'unauthorized', message: '请先登录管理后台' } })

    const failure = await createSettlementParty('csrf-token', CREATE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(401)
    expect((failure as LocalApiError).code).toBe('unauthorized')
  })

  it('fetch 拒绝：LocalApiError status 0、code network_error', async () => {
    stubRejection(new TypeError('Failed to fetch'))

    const failure = await createSettlementParty('csrf-token', CREATE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(0)
    expect((failure as LocalApiError).code).toBe('network_error')
  })
})

/* -------------------------------------------------------------------------- */
/* #220 — merchant mappings and per-order seller confirmation                 */
/* -------------------------------------------------------------------------- */

const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174201'
const MAPPING_ID = '123e4567-e89b-42d3-a456-426614174401'
const SELLER_PARTY_ID = '123e4567-e89b-42d3-a456-426614174501'
const SANCHUANG_PARTY_ID = '123e4567-e89b-42d3-a456-426614174502'
const GUANGDIAN_PARTY_ID = '123e4567-e89b-42d3-a456-426614174503'
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174101'

const MAPPING: SettlementMapping = {
  id: MAPPING_ID,
  communityId: COMMUNITY_ID,
  productId: PRODUCT_ID,
  sellerPartyId: SELLER_PARTY_ID,
  sanchuangPartyId: SANCHUANG_PARTY_ID,
  guangdianPartyId: GUANGDIAN_PARTY_ID,
  agreementRef: '合作协议 2026-001',
  effectiveFrom: '2026-11-01',
  effectiveTo: '2026-12-31',
  createdByUserId: USER_ID,
  createdAt: '2026-11-01T01:30:00.000Z',
}

const CREATE_MAPPING_REQUEST: CreateSettlementMappingRequest = {
  communityId: COMMUNITY_ID,
  productId: PRODUCT_ID,
  sellerPartyId: SELLER_PARTY_ID,
  sanchuangPartyId: SANCHUANG_PARTY_ID,
  guangdianPartyId: GUANGDIAN_PARTY_ID,
  agreementRef: '合作协议 2026-001',
  effectiveFrom: '2026-11-01',
  effectiveTo: '2026-12-31',
}

const CONFIRMED_SNAPSHOT: SettlementOrderPartySnapshot = {
  orderId: ORDER_ID,
  mappingId: MAPPING_ID,
  sellerPartyId: SELLER_PARTY_ID,
  sanchuangPartyId: SANCHUANG_PARTY_ID,
  guangdianPartyId: GUANGDIAN_PARTY_ID,
  agreementRef: '合作协议 2026-001',
  confirmationRef: '订单截图与人工核对 2026-11-05',
  confirmedByUserId: USER_ID,
  confirmedAt: '2026-11-05T03:00:00.000Z',
}

describe('listSettlementMappings', () => {
  it('GET 无筛选：只请求 /api/admin/settlement/mappings，不带 query，返回解析后的 items', async () => {
    stubJson(200, { items: [MAPPING] })

    const mappings = await listSettlementMappings()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init, headers } = lastCall()
    expect(url).toBe('/api/admin/settlement/mappings')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('include')
    expect(headers['x-csrf-token']).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect(mappings).toEqual([MAPPING])
  })

  it('GET 带 communityId：query 正确编码，且只有一个参数', async () => {
    stubJson(200, { items: [MAPPING] })

    const mappings = await listSettlementMappings({ communityId: COMMUNITY_ID })

    const { url } = lastCall()
    expect(url).toBe(
      `/api/admin/settlement/mappings?communityId=${encodeURIComponent(COMMUNITY_ID)}`,
    )
    expect(new URL(url, 'http://localhost').searchParams.getAll('communityId')).toEqual([
      COMMUNITY_ID,
    ])
    expect(mappings).toEqual([MAPPING])
  })

  it('映射是版本化历史：同一商品的多条记录原样返回，不合并成「当前版本」', async () => {
    const older: SettlementMapping = {
      ...MAPPING,
      id: '123e4567-e89b-42d3-a456-426614174402',
      agreementRef: '合作协议 2025-009',
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
    }
    stubJson(200, { items: [older, MAPPING] })

    const mappings = await listSettlementMappings()

    expect(mappings.map((row) => row.id)).toEqual([older.id, MAPPING.id])
  })

  it('响应不符合契约：抛 invalid_response，不返回空列表', async () => {
    stubJson(200, {})

    const failure = await listSettlementMappings().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })
})

describe('createSettlementMapping', () => {
  it('POST：带 CSRF、body 等于契约字段，201 单对象解析成功', async () => {
    stubJson(201, MAPPING)

    const created = await createSettlementMapping('csrf-token-mapping', CREATE_MAPPING_REQUEST)

    const { url, init, headers } = lastCall()
    expect(url).toBe('/api/admin/settlement/mappings')
    expect(init.method).toBe('POST')
    expect(headers['x-csrf-token']).toBe('csrf-token-mapping')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual(CREATE_MAPPING_REQUEST)
    expect(created).toEqual(MAPPING)
  })

  it('409 冲突 envelope：status/code/message 冒泡，不伪造成功', async () => {
    stubJson(409, {
      error: { code: 'conflict', message: '指定主体尚未凭资料完成核验或类型不匹配' },
    })

    const failure = await createSettlementMapping('csrf-token-mapping', CREATE_MAPPING_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(409)
    expect((failure as LocalApiError).code).toBe('conflict')
    expect((failure as LocalApiError).message).toBe('指定主体尚未凭资料完成核验或类型不匹配')
  })

  it('effectiveTo < effectiveFrom：共享契约本地拒绝，且不发请求', async () => {
    const invalid: CreateSettlementMappingRequest = {
      ...CREATE_MAPPING_REQUEST,
      effectiveFrom: '2026-12-31',
      effectiveTo: '2026-11-01',
    }

    const failure = await createSettlementMapping('csrf-token-mapping', invalid).catch(
      (cause: unknown) => cause,
    )

    expect(failure).not.toBeInstanceOf(LocalApiError)
    expect(failure).toBeInstanceOf(Error)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('201 返回列表形状：抛 invalid_response，不当作创建成功', async () => {
    stubJson(201, { items: [MAPPING] })

    const failure = await createSettlementMapping('csrf-token-mapping', CREATE_MAPPING_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })
})

describe('readSettlementOrderParty', () => {
  it('missing_seller：snapshot 原样为 null，不补默认快照', async () => {
    const response: SettlementOrderPartyResponse = {
      orderId: ORDER_ID,
      sellerStatus: 'missing_seller',
      snapshot: null,
    }
    stubJson(200, response)

    const party = await readSettlementOrderParty(ORDER_ID)

    expect(lastCall().url).toBe(`/api/admin/settlement/orders/${ORDER_ID}/party`)
    expect(lastCall().init.method).toBe('GET')
    expect(party).toEqual(response)
    expect(party.snapshot).toBeNull()
  })

  it('incomplete_parties：snapshot 存在但承运主体缺失，原样透出（不补全）', async () => {
    const incomplete: SettlementOrderPartyResponse = {
      orderId: ORDER_ID,
      sellerStatus: 'incomplete_parties',
      snapshot: { ...CONFIRMED_SNAPSHOT, guangdianPartyId: null },
    }
    stubJson(200, incomplete)

    const party = await readSettlementOrderParty(ORDER_ID)

    expect(party.sellerStatus).toBe('incomplete_parties')
    expect(party.snapshot?.guangdianPartyId).toBeNull()
    expect(party.snapshot).toEqual(incomplete.snapshot)
  })

  it('verified：透出完整 snapshot 字段', async () => {
    const verified: SettlementOrderPartyResponse = {
      orderId: ORDER_ID,
      sellerStatus: 'verified',
      snapshot: CONFIRMED_SNAPSHOT,
    }
    stubJson(200, verified)

    const party = await readSettlementOrderParty(ORDER_ID)

    expect(party).toEqual(verified)
    expect(party.snapshot).toEqual(CONFIRMED_SNAPSHOT)
  })

  it('orderId 在路径中正确编码（fillRoute + encodeURIComponent）', async () => {
    stubJson(200, { orderId: ORDER_ID, sellerStatus: 'missing_seller', snapshot: null })

    await readSettlementOrderParty('order 1/2?x=1')

    expect(lastCall().url).toBe('/api/admin/settlement/orders/order%201%2F2%3Fx%3D1/party')
    // The encoded id must not leak into a query string.
    expect(lastCall().url).not.toContain('?x=1')
  })

  it('契约不符（未知 sellerStatus）：抛 invalid_response，不当作 missing_seller', async () => {
    stubJson(200, { orderId: ORDER_ID, sellerStatus: 'pending', snapshot: null })

    const failure = await readSettlementOrderParty(ORDER_ID).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })

  it('404 envelope：status 404 与 code 冒泡，不返回空归属', async () => {
    stubJson(404, { error: { code: 'not_found', message: '本地订单不存在' } })

    const failure = await readSettlementOrderParty(ORDER_ID).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(404)
    expect((failure as LocalApiError).code).toBe('not_found')
    expect((failure as LocalApiError).message).toBe('本地订单不存在')
  })
})

describe('confirmSettlementOrderParty', () => {
  const CONFIRM_REQUEST = {
    mappingId: MAPPING_ID,
    confirmationRef: '订单截图与人工核对 2026-11-05',
  }

  it('POST：路由填充 orderId、带 CSRF、body 为契约字段，201 snapshot 解析成功', async () => {
    stubJson(201, CONFIRMED_SNAPSHOT)

    const snapshot = await confirmSettlementOrderParty('csrf-token-confirm', ORDER_ID, CONFIRM_REQUEST)

    const { url, init, headers } = lastCall()
    expect(url).toBe(`/api/admin/settlement/orders/${ORDER_ID}/party`)
    expect(init.method).toBe('POST')
    expect(headers['x-csrf-token']).toBe('csrf-token-confirm')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual(CONFIRM_REQUEST)
    expect(snapshot).toEqual(CONFIRMED_SNAPSHOT)
    // The 201 body is the snapshot, not the { sellerStatus, snapshot } read model.
    expect(snapshot).not.toHaveProperty('sellerStatus')
  })

  it('orderId 在 POST 路径中同样被编码，不会拼出额外 query', async () => {
    stubJson(201, { ...CONFIRMED_SNAPSHOT, orderId: ORDER_ID })

    await confirmSettlementOrderParty('csrf-token-confirm', 'order 3/4', CONFIRM_REQUEST)

    expect(lastCall().url).toBe('/api/admin/settlement/orders/order%203%2F4/party')
  })

  it('409 冲突 envelope（订单未核验/映射不匹配）：status/code/message 冒泡', async () => {
    stubJson(409, {
      error: { code: 'conflict', message: '订单尚未业务核验，不允许确认商户归属' },
    })

    const failure = await confirmSettlementOrderParty(
      'csrf-token-confirm',
      ORDER_ID,
      CONFIRM_REQUEST,
    ).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(409)
    expect((failure as LocalApiError).code).toBe('conflict')
    expect((failure as LocalApiError).message).toBe('订单尚未业务核验，不允许确认商户归属')
  })

  it('契约不符（缺少 snapshot 字段）：抛 invalid_response，不伪造成功', async () => {
    stubJson(201, { orderId: ORDER_ID, mappingId: MAPPING_ID })

    const failure = await confirmSettlementOrderParty(
      'csrf-token-confirm',
      ORDER_ID,
      CONFIRM_REQUEST,
    ).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })

  it('confirmationRef 少于 2 个字符：共享契约本地拒绝，且不发请求', async () => {
    const failure = await confirmSettlementOrderParty('csrf-token-confirm', ORDER_ID, {
      mappingId: MAPPING_ID,
      confirmationRef: 'x',
    }).catch((cause: unknown) => cause)

    expect(failure).not.toBeInstanceOf(LocalApiError)
    expect(failure).toBeInstanceOf(Error)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------------------------------- */
/* #221 — contract rule versions (human-attested, server-numbered)            */
/* -------------------------------------------------------------------------- */

const RULE_ID = '123e4567-e89b-42d3-a456-426614174601'

const CREATE_RULE_REQUEST: CreateSettlementRuleRequest = {
  mappingId: MAPPING_ID,
  agreementRef: '合作协议 2026-001',
  approvalEvidenceRef: '合同审批单 2026-1101',
  approvalOn: '2026-10-28',
  effectiveFrom: '2026-11-01',
  effectiveTo: '2026-12-31',
  feeBase: 'actual_received',
  processorFeeBps: 60,
  processorFeeOwner: 'seller',
  ratesBps: { seller: 6000, sanchuang: 2500, guangdian: 1500 },
  roundingRecipient: 'guangdian',
  roundingPolicy: 'floor_then_named_remainder',
  processorFeeRounding: 'floor',
  reversalPolicy: 'full_reversal_blocks',
  partialRefundPolicy: 'unsupported_blocks',
}

const RULE_VERSION: SettlementRuleVersion = {
  id: RULE_ID,
  mappingId: MAPPING_ID,
  version: 3,
  communityId: COMMUNITY_ID,
  productId: PRODUCT_ID,
  sellerPartyId: SELLER_PARTY_ID,
  sanchuangPartyId: SANCHUANG_PARTY_ID,
  guangdianPartyId: GUANGDIAN_PARTY_ID,
  agreementRef: '合作协议 2026-001',
  approvalEvidenceRef: '合同审批单 2026-1101',
  approvalOn: '2026-10-28',
  effectiveFrom: '2026-11-01',
  effectiveTo: '2026-12-31',
  feeBase: 'actual_received',
  processorFeeBps: 60,
  processorFeeOwner: 'seller',
  ratesBps: { seller: 6000, sanchuang: 2500, guangdian: 1500 },
  roundingRecipient: 'guangdian',
  roundingPolicy: 'floor_then_named_remainder',
  processorFeeRounding: 'floor',
  reversalPolicy: 'full_reversal_blocks',
  partialRefundPolicy: 'unsupported_blocks',
  approvalStatus: 'admin_attested',
  approvedByUserId: USER_ID,
  approvedAt: '2026-10-28T08:00:00.000Z',
}

describe('settlement rule labels', () => {
  it('三方分配主体标签与主体登记口径一致', () => {
    expect(SETTLEMENT_RULE_PARTY_KEY_LABELS).toEqual({
      seller: '商品销售商户',
      sanchuang: '三创主体',
      guangdian: '广电主体',
    })
  })

  it('手续费承担主体标签包含 none 的四选项', () => {
    expect(SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS).toEqual({
      none: '无',
      seller: '由销售商户承担',
      sanchuang: '由三创承担',
      guangdian: '由广电承担',
    })
  })

  it('固定策略说明以只读文案给出，且不宣称可以自行选择口径', () => {
    expect(SETTLEMENT_RULE_FIXED_POLICY_LABELS).toEqual({
      feeBase: '按实际到账金额计算（#166 收款凭据），不是订单金额',
      roundingPolicy: '先向下取整分摊，剩余分币归指定主体',
      processorFeeRounding: '手续费向下取整',
      reversalPolicy: '整单冲正即阻断结算',
      partialRefundPolicy: '不支持部分退款，一经出现即阻断',
    })
  })
})

describe('listSettlementRuleVersions', () => {
  it('GET 无 query：只请求 /api/admin/settlement/rules，不补默认范围', async () => {
    stubJson(200, { items: [RULE_VERSION] })

    const versions = await listSettlementRuleVersions()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init, headers } = lastCall()
    expect(url).toBe('/api/admin/settlement/rules')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('include')
    expect(headers['x-csrf-token']).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect(versions).toEqual([RULE_VERSION])
  })

  it('GET 只带 communityId：只发送该参数', async () => {
    stubJson(200, { items: [RULE_VERSION] })

    await listSettlementRuleVersions({ communityId: COMMUNITY_ID })

    const { url } = lastCall()
    expect(url).toBe(
      `/api/admin/settlement/rules?communityId=${encodeURIComponent(COMMUNITY_ID)}`,
    )
    expect(new URL(url, 'http://localhost').searchParams.getAll('mappingId')).toEqual([])
  })

  it('GET 只带 mappingId：只发送该参数（不夹带 communityId 默认值）', async () => {
    stubJson(200, { items: [RULE_VERSION] })

    const versions = await listSettlementRuleVersions({ mappingId: MAPPING_ID })

    const { url } = lastCall()
    expect(url).toBe(`/api/admin/settlement/rules?mappingId=${encodeURIComponent(MAPPING_ID)}`)
    expect(new URL(url, 'http://localhost').searchParams.getAll('communityId')).toEqual([])
    expect(versions).toEqual([RULE_VERSION])
  })

  it('GET 两个筛选同时给出：两个参数都发送', async () => {
    stubJson(200, { items: [] })

    await listSettlementRuleVersions({ communityId: COMMUNITY_ID, mappingId: MAPPING_ID })

    const { url } = lastCall()
    expect(url).toBe(
      `/api/admin/settlement/rules?communityId=${encodeURIComponent(COMMUNITY_ID)}` +
        `&mappingId=${encodeURIComponent(MAPPING_ID)}`,
    )
  })

  it('真实空态：没有登记过规则时返回空数组', async () => {
    stubJson(200, { items: [] })

    await expect(listSettlementRuleVersions()).resolves.toEqual([])
  })

  it('请求失败不得被当成空数组：403 冒泡', async () => {
    stubJson(403, { error: { code: 'forbidden', message: '无权查看合作分成合同' } })

    const failure = await listSettlementRuleVersions().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(403)
    expect((failure as LocalApiError).code).toBe('forbidden')
    expect((failure as LocalApiError).message).toBe('无权查看合作分成合同')
  })

  it('响应不符合契约：抛 invalid_response，不返回空数组', async () => {
    stubJson(200, {})

    const failure = await listSettlementRuleVersions().catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })
})

describe('createSettlementRuleVersion', () => {
  it('POST：带 CSRF、body 等于契约字段，201 单对象解析且版本号来自响应', async () => {
    stubJson(201, RULE_VERSION)

    const created = await createSettlementRuleVersion('csrf-token-rule', CREATE_RULE_REQUEST)

    const { url, init, headers } = lastCall()
    expect(url).toBe('/api/admin/settlement/rules')
    expect(init.method).toBe('POST')
    expect(headers['x-csrf-token']).toBe('csrf-token-rule')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual(CREATE_RULE_REQUEST)
    expect(created).toEqual(RULE_VERSION)
    // Version / approval facts come from the server response only.
    expect(created.version).toBe(3)
    expect(created.approvalStatus).toBe('admin_attested')
    expect(created.approvedByUserId).toBe(USER_ID)
    // The client cannot submit server-owned fields: the strict contract drops none.
    expect(JSON.parse(String(init.body))).not.toHaveProperty('version')
    expect(JSON.parse(String(init.body))).not.toHaveProperty('approvalStatus')
  })

  it('409 冲突（期限重叠/映射无效）冒泡，不伪造成功', async () => {
    stubJson(409, {
      error: { code: 'conflict', message: '合同编号或有效期不匹配已核验销售商户映射' },
    })

    const failure = await createSettlementRuleVersion('csrf-token-rule', CREATE_RULE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(409)
    expect((failure as LocalApiError).code).toBe('conflict')
    expect((failure as LocalApiError).message).toBe('合同编号或有效期不匹配已核验销售商户映射')
  })

  it('401 未登录冒泡', async () => {
    stubJson(401, { error: { code: 'unauthorized', message: '请先登录管理后台' } })

    const failure = await createSettlementRuleVersion('csrf-token-rule', CREATE_RULE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(401)
    expect((failure as LocalApiError).code).toBe('unauthorized')
  })

  it('403（非管理员或 CSRF 失败）冒泡', async () => {
    stubJson(403, { error: { code: 'forbidden', message: '仅管理员可登记已核准合同版本' } })

    const failure = await createSettlementRuleVersion('csrf-token-rule', CREATE_RULE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(403)
    expect((failure as LocalApiError).code).toBe('forbidden')
    expect((failure as LocalApiError).message).toBe('仅管理员可登记已核准合同版本')
  })

  it('201 响应缺少 version / approvalStatus：抛 invalid_response，不当作创建成功', async () => {
    const { version: _version, approvalStatus: _approvalStatus, ...withoutServerFields } =
      RULE_VERSION
    expect(_version).toBe(3)
    expect(_approvalStatus).toBe('admin_attested')
    stubJson(201, withoutServerFields)

    const failure = await createSettlementRuleVersion('csrf-token-rule', CREATE_RULE_REQUEST).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })

  describe('共享契约在发请求前拒绝非法规则', () => {
    const invalidCases: Array<{ name: string; request: CreateSettlementRuleRequest }> = [
      {
        name: '三方基点合计 ≠ 10000',
        request: { ...CREATE_RULE_REQUEST, ratesBps: { seller: 6000, sanchuang: 2500, guangdian: 1000 } },
      },
      {
        name: 'effectiveTo 早于 effectiveFrom',
        request: { ...CREATE_RULE_REQUEST, effectiveFrom: '2026-12-31', effectiveTo: '2026-11-01' },
      },
      {
        name: 'approvalOn 晚于 effectiveFrom',
        request: { ...CREATE_RULE_REQUEST, approvalOn: '2026-11-02' },
      },
      {
        name: 'processorFeeBps=0 但 owner≠none',
        request: { ...CREATE_RULE_REQUEST, processorFeeBps: 0, processorFeeOwner: 'seller' },
      },
      {
        name: 'processorFeeBps>0 但 owner=none',
        request: { ...CREATE_RULE_REQUEST, processorFeeOwner: 'none' },
      },
    ]

    it.each(invalidCases)('$name：本地拒绝且不发请求', async ({ request }) => {
      const failure = await createSettlementRuleVersion('csrf-token-rule', request).catch(
        (cause: unknown) => cause,
      )

      expect(failure).not.toBeInstanceOf(LocalApiError)
      expect(failure).toBeInstanceOf(Error)
      expect(String((failure as Error).message)).toMatch(/ratesBps|effectiveTo|approvalOn|processorFeeOwner/u)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

/* -------------------------------------------------------------------------- */
/* #222 — single-order trial quote (POST + CSRF, simulation only)            */
/* -------------------------------------------------------------------------- */

const QUOTE_RECEIPT_ENTRY_ID = '123e4567-e89b-42d3-a456-426614174301'

const QUOTE_CALCULATED: SettlementQuoteResponse = {
  orderId: ORDER_ID,
  quoteOnly: true,
  status: 'calculated',
  rule: RULE_VERSION,
  allocation: {
    grossReceivedCents: 12_800,
    processorFeeCents: 76,
    sellerNetCents: 7_634,
    sanchuangNetCents: 3_181,
    guangdianNetCents: 1_909,
    totalNetCents: 12_724,
    conservedTotalCents: 12_800,
    roundingResidualCents: 1,
  },
  payableAmountCents: null,
  blockingReasons: [],
  receiptEntryId: QUOTE_RECEIPT_ENTRY_ID,
  sellerPartyId: SELLER_PARTY_ID,
  sanchuangPartyId: SANCHUANG_PARTY_ID,
  guangdianPartyId: GUANGDIAN_PARTY_ID,
}

const QUOTE_PENDING_RULE: SettlementQuoteResponse = {
  orderId: ORDER_ID,
  quoteOnly: true,
  status: 'pending_rule',
  rule: null,
  allocation: null,
  payableAmountCents: null,
  blockingReasons: ['missing_approved_rule'],
  receiptEntryId: QUOTE_RECEIPT_ENTRY_ID,
  sellerPartyId: SELLER_PARTY_ID,
  sanchuangPartyId: null,
  guangdianPartyId: null,
}

const QUOTE_BLOCKED: SettlementQuoteResponse = {
  ...QUOTE_PENDING_RULE,
  status: 'blocked',
  blockingReasons: ['order_not_verified', 'missing_receipt'],
}

describe('quoteSettlementOrder', () => {
  it('成功 calculated：POST /api/admin/settlement/quotes、带 CSRF、body 严格只有 orderId', async () => {
    stubJson(200, QUOTE_CALCULATED)

    const quote = await quoteSettlementOrder('csrf-token-quote', ORDER_ID)

    const { url, init, headers } = lastCall()
    expect(url).toBe('/api/admin/settlement/quotes')
    // Read-only in meaning, but the contract fixes POST + CSRF: never a GET.
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(headers['x-csrf-token']).toBe('csrf-token-quote')
    expect(headers['content-type']).toBe('application/json')
    const body: unknown = JSON.parse(String(init.body))
    expect(body).toEqual({ orderId: ORDER_ID })
    // Strict request object: no extra field may be smuggled in.
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['orderId'])

    expect(quote).toEqual(QUOTE_CALCULATED)
    expect(quote.quoteOnly).toBe(true)
    // The simulation never reports a payable amount.
    expect(quote.payableAmountCents).toBeNull()
    expect(quote.status).toBe('calculated')
  })

  it('pending_rule：rule/allocation 原样为 null，不被误当 0', async () => {
    stubJson(200, QUOTE_PENDING_RULE)

    const quote = await quoteSettlementOrder('csrf-token-quote', ORDER_ID)

    expect(quote).toEqual(QUOTE_PENDING_RULE)
    expect(quote.status).toBe('pending_rule')
    expect(quote.rule).toBeNull()
    expect(quote.allocation).toBeNull()
    expect(quote.payableAmountCents).toBeNull()
  })

  it('blocked：blockingReasons 原样透出', async () => {
    stubJson(200, QUOTE_BLOCKED)

    const quote = await quoteSettlementOrder('csrf-token-quote', ORDER_ID)

    expect(quote.status).toBe('blocked')
    expect(quote.allocation).toBeNull()
    expect(quote.blockingReasons).toEqual(['order_not_verified', 'missing_receipt'])
  })

  it('响应 quoteOnly=false（非法）：抛 invalid_response，不当作试算成功', async () => {
    stubJson(200, { ...QUOTE_CALCULATED, quoteOnly: false })

    const failure = await quoteSettlementOrder('csrf-token-quote', ORDER_ID).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })

  it('响应 payableAmountCents 非 null（非法）：抛 invalid_response，绝不透出 payable 数字', async () => {
    stubJson(200, { ...QUOTE_CALCULATED, payableAmountCents: 12_724 })

    const failure = await quoteSettlementOrder('csrf-token-quote', ORDER_ID).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).code).toBe('invalid_response')
  })

  it('403 冒泡：真实 status/code/message 保留', async () => {
    stubJson(403, { error: { code: 'forbidden', message: '无权查看合作分成合同' } })

    const failure = await quoteSettlementOrder('csrf-token-quote', ORDER_ID).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(403)
    expect((failure as LocalApiError).code).toBe('forbidden')
    expect((failure as LocalApiError).message).toBe('无权查看合作分成合同')
  })

  it('400 与 404 冒泡：订单不存在/参数错误不被吞成未试算', async () => {
    stubJson(404, { error: { code: 'not_found', message: '本地订单不存在' } })

    const missing = await quoteSettlementOrder('csrf-token-quote', ORDER_ID).catch(
      (cause: unknown) => cause,
    )
    expect(missing).toBeInstanceOf(LocalApiError)
    expect((missing as LocalApiError).status).toBe(404)
    expect((missing as LocalApiError).code).toBe('not_found')

    stubJson(400, { error: { code: 'invalid_request', message: '订单 ID 不正确' } })

    const invalid = await quoteSettlementOrder('csrf-token-quote', ORDER_ID).catch(
      (cause: unknown) => cause,
    )
    expect(invalid).toBeInstanceOf(LocalApiError)
    expect((invalid as LocalApiError).status).toBe(400)
    expect((invalid as LocalApiError).code).toBe('invalid_request')
  })

  it('网络失败：LocalApiError status 0、code network_error', async () => {
    stubRejection(new TypeError('Failed to fetch'))

    const failure = await quoteSettlementOrder('csrf-token-quote', ORDER_ID).catch(
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(LocalApiError)
    expect((failure as LocalApiError).status).toBe(0)
    expect((failure as LocalApiError).code).toBe('network_error')
  })

  it.each([
    { name: '空字符串', orderId: '' },
    { name: '非 UUID', orderId: 'order-1' },
    { name: '仅空白', orderId: '   ' },
  ])('orderId $name：共享契约本地拒绝，不发请求', async ({ orderId }) => {
    const failure = await quoteSettlementOrder('csrf-token-quote', orderId).catch(
      (cause: unknown) => cause,
    )

    expect(failure).not.toBeInstanceOf(LocalApiError)
    expect(failure).toBeInstanceOf(Error)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
