// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateSettlementPartyRequest,
  SettlementParty,
} from '@sanchuang-dev/local-life-contracts'
import { LocalApiError } from './localApi'
import {
  SETTLEMENT_PARTY_ROLE_LABELS,
  createSettlementParty,
  listSettlementParties,
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
