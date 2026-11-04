import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/**
 * SIMULATED CRMEB OUTAPI (test-only).
 *
 * This is not a production mock and it never backs a real API route outside
 * tests. It reproduces the response shapes documented in
 * `docs/engineering/crmeb-integration.md` (HTTP-200 envelope, `Access_token`
 * exchange, `{list,count}` pagination, order detail with `refund_status`) so the
 * adapter can be exercised over real HTTP without a CRMEB instance.
 */

export interface SimulatedProduct {
  id: number
  image?: string
  slider_image?: string[] | string
  store_name: string
  store_info?: string
  price: string | number
  ot_price?: string | number
  cate_id?: string | number[]
  cate_name?: string
  is_show?: number
  spec_type?: number
  description?: string
  attrs?: Array<Record<string, unknown>>
}

export interface SimulatedOrder {
  id: number
  order_id: string
  uid?: number
  paid: number
  status: number
  pay_type?: string | null
  pay_time?: number
  add_time?: number
  pay_price?: string | number
  total_price?: string | number
  items?: Array<Record<string, unknown>>
  /** Present on detail responses only; list rows must omit it. */
  refund_status?: number
}

export interface SimulatedRefund {
  id: number
  store_order_id: number
  order_id: string
  refund_type: number
  refund_price?: string | number
  refunded_price?: string | number
  refunded_time?: number
  add_time?: number
}

export interface SimulatedCrmebOptions {
  products?: SimulatedProduct[]
  productDetails?: Record<string, SimulatedProduct>
  orders?: SimulatedOrder[]
  orderDetails?: Record<string, SimulatedOrder>
  refunds?: SimulatedRefund[]
  /** Token lifetime in seconds. Use a value below 60 to exercise early refresh. */
  tokenTtlSeconds?: number
  /** How many authorized calls answer `{status:401}` before succeeding. */
  unauthorizedResponses?: number
  alwaysUnauthorized?: boolean
  /** Return a shape that violates the documented contract. */
  driftProductList?: boolean
  /** Simulate an outapi permission/error envelope on these lists. */
  productListFailureStatus?: number
  orderListFailureStatus?: number
  /** Return a different numeric id on order detail to exercise key collisions. */
  orderDetailIdOverrides?: Record<string, number>
}

export interface RecordedRequest {
  method: string
  path: string
  search: string
  authorization: string | undefined
}

export interface SimulatedCrmeb {
  baseUrl: string
  requests: RecordedRequest[]
  tokenRequests: Array<'access' | 'refresh'>
  options: Required<
    Pick<
      SimulatedCrmebOptions,
      'products' | 'productDetails' | 'orders' | 'orderDetails' | 'refunds'
    >
  > & {
    tokenTtlSeconds: number
    unauthorizedResponses: number
    alwaysUnauthorized: boolean
    driftProductList: boolean
    productListFailureStatus: number | undefined
    orderListFailureStatus: number | undefined
    orderDetailIdOverrides: Record<string, number>
  }
  close(): Promise<void>
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function success(response: ServerResponse, data: unknown): void {
  sendJson(response, 200, { status: 200, msg: '操作成功', data })
}

function failure(response: ServerResponse, status: number, msg: string): void {
  sendJson(response, 200, { status, msg, data: null })
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

export async function startSimulatedCrmeb(
  options: SimulatedCrmebOptions = {},
): Promise<SimulatedCrmeb> {
  const state: SimulatedCrmeb = {
    baseUrl: '',
    requests: [],
    tokenRequests: [],
    options: {
      products: options.products ?? [],
      productDetails: options.productDetails ?? {},
      orders: options.orders ?? [],
      orderDetails: options.orderDetails ?? {},
      refunds: options.refunds ?? [],
      tokenTtlSeconds: options.tokenTtlSeconds ?? 1_800,
      unauthorizedResponses: options.unauthorizedResponses ?? 0,
      alwaysUnauthorized: options.alwaysUnauthorized ?? false,
      driftProductList: options.driftProductList ?? false,
      productListFailureStatus: options.productListFailureStatus,
      orderListFailureStatus: options.orderListFailureStatus,
      orderDetailIdOverrides: options.orderDetailIdOverrides ?? {},
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }

  let issuedToken = ''

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const method = request.method ?? 'GET'
    const authorization = request.headers['authori-zation']
    state.requests.push({
      method,
      path: url.pathname,
      search: url.search,
      authorization: typeof authorization === 'string' ? authorization : undefined,
    })

    if (method === 'POST' && url.pathname === '/outapi/access_token') {
      const body = (await readJson(request)) as
        | { appid?: string; appsecret?: string }
        | null
      state.tokenRequests.push('access')
      if (!body?.appid || !body.appsecret) {
        failure(response, 400, 'appid/appsecret 不能为空')
        return
      }
      issuedToken = `simulated-access-token-${String(state.tokenRequests.length).padStart(4, '0')}`
      success(response, {
        access_token: issuedToken,
        exp_time: Math.floor(Date.now() / 1_000) + state.options.tokenTtlSeconds,
        auth_info: { appid: body.appid },
      })
      return
    }

    if (method === 'POST' && url.pathname === '/outapi/refresh_token') {
      const body = (await readJson(request)) as { access_token?: string } | null
      state.tokenRequests.push('refresh')
      if (!body?.access_token) {
        failure(response, 400, 'access_token 不能为空')
        return
      }
      issuedToken = `simulated-access-token-${String(state.tokenRequests.length).padStart(4, '0')}`
      success(response, {
        access_token: issuedToken,
        exp_time: Math.floor(Date.now() / 1_000) + state.options.tokenTtlSeconds,
      })
      return
    }

    const unauthorized =
      state.options.alwaysUnauthorized ||
      (state.options.unauthorizedResponses > 0 &&
        (state.options.unauthorizedResponses -= 1) >= 0)
    if (unauthorized || authorization !== issuedToken) {
      failure(response, 401, '登录已过期')
      return
    }

    if (method === 'GET' && url.pathname === '/outapi/product/list') {
      if (state.options.productListFailureStatus) {
        failure(response, state.options.productListFailureStatus, '您暂时没有访问权限')
        return
      }
      if (state.options.driftProductList) {
        success(response, { list: 'not-an-array', count: 1 })
        return
      }
      success(response, {
        list: state.options.products,
        count: state.options.products.length,
      })
      return
    }

    if (method === 'GET' && url.pathname.startsWith('/outapi/product/')) {
      const id = url.pathname.slice('/outapi/product/'.length)
      const product = state.options.productDetails[id]
      if (!product) {
        failure(response, 404, '商品不存在')
        return
      }
      success(response, product)
      return
    }

    if (method === 'GET' && url.pathname === '/outapi/order/list') {
      if (state.options.orderListFailureStatus) {
        failure(response, state.options.orderListFailureStatus, '您暂时没有访问权限')
        return
      }
      success(response, {
        list: state.options.orders,
        count: state.options.orders.length,
      })
      return
    }

    if (method === 'GET' && url.pathname.startsWith('/outapi/order/')) {
      const orderNo = decodeURIComponent(url.pathname.slice('/outapi/order/'.length))
      const order = state.options.orderDetails[orderNo]
      if (!order) {
        failure(response, 404, '订单不存在')
        return
      }
      const override = state.options.orderDetailIdOverrides[orderNo]
      success(response, override ? { ...order, id: override } : order)
      return
    }

    if (method === 'GET' && url.pathname === '/outapi/refund/list') {
      const page = Number(url.searchParams.get('page') ?? '1')
      const limit = Number(url.searchParams.get('limit') ?? '100')
      const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1
      const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 100
      const start = (safePage - 1) * safeLimit
      success(response, {
        list: state.options.refunds.slice(start, start + safeLimit),
        count: state.options.refunds.length,
      })
      return
    }

    failure(response, 404, '接口不存在')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('simulated CRMEB server did not bind a TCP port')
  }
  state.baseUrl = `http://127.0.0.1:${address.port}`
  return state
}
