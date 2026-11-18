import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Test-only WeChat Pay fixtures and a controlled local HTTP server.
 *
 * The merchant key is the WeChat Pay documentation's public *test* key; it is
 * not a real merchant credential. The platform key pair is generated solely for
 * offline response-signature tests. No real merchant number, certificate,
 * AppSecret or APIv3 key is present anywhere in this repository.
 */

function fixture(name: string): string {
  return fileURLToPath(new URL(name, import.meta.url))
}

export const TEST_MERCHANT_PRIVATE_KEY_PEM = readFileSync(
  fixture('wechat-pay-test-merchant-key.pem'),
  'utf8',
)
export const TEST_MERCHANT_PRIVATE_KEY: KeyObject = createPrivateKey({
  key: TEST_MERCHANT_PRIVATE_KEY_PEM,
  format: 'pem',
})
export const TEST_MERCHANT_PUBLIC_KEY_PEM = createPublicKey(TEST_MERCHANT_PRIVATE_KEY)
  .export({ format: 'pem', type: 'spki' })
  .toString()

export const TEST_MERCHANT_SERIAL = '408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB'
export const TEST_MCHID = '1900007291'
export const TEST_APPID = 'wx2421b1c4370ec43b'
export const TEST_PLATFORM_KEY_ID = 'PUB_KEY_ID_TEST000000000000000000000001'
export const TEST_PLATFORM_PUBLIC_KEY_PEM = readFileSync(
  fixture('wechat-pay-test-platform-test-public-key.pem'),
  'utf8',
)
export const TEST_PLATFORM_PRIVATE_KEY_PEM = readFileSync(
  fixture('wechat-pay-test-platform-private-key.pem'),
  'utf8',
)
export const TEST_PLATFORM_PUBLIC_KEY = createPublicKey({
  key: TEST_PLATFORM_PUBLIC_KEY_PEM,
  format: 'pem',
})
export const TEST_PLATFORM_PRIVATE_KEY: KeyObject = createPrivateKey({
  key: TEST_PLATFORM_PRIVATE_KEY_PEM,
  format: 'pem',
})

export function signWechatResponse(
  platformPrivateKey: KeyObject,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return sign(
    'sha256',
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, 'utf8'),
    platformPrivateKey,
  ).toString('base64')
}

export interface CapturedWechatRequest {
  index: number
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface FakeWechatResponse {
  status: number
  body: string
  /** Signs `signBody` (defaults to `body`) but sends `body`. */
  signBody?: string
  timestamp?: string
  nonce?: string
  serial?: string
  /** Simulates proxy/filter stripping of Wechatpay-* headers. */
  omitSignatureHeaders?: boolean
  delayMs?: number
}

export interface FakeWechatServer {
  baseUrl: string
  requests: CapturedWechatRequest[]
  close: () => Promise<void>
}

const DEFAULT_NONCE = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'

export async function startFakeWechatServer(
  responder: (
    request: CapturedWechatRequest,
  ) => FakeWechatResponse | Promise<FakeWechatResponse>,
  platformPrivateKey: KeyObject = TEST_PLATFORM_PRIVATE_KEY,
): Promise<FakeWechatServer> {
  const requests: CapturedWechatRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        const captured: CapturedWechatRequest = {
          index: requests.length,
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        requests.push(captured)
        const spec = await responder(captured)
        if (spec.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, spec.delayMs))
        }
        const timestamp = spec.timestamp ?? Math.floor(Date.now() / 1_000).toString()
        const nonce = spec.nonce ?? DEFAULT_NONCE
        const serial = spec.serial ?? TEST_PLATFORM_KEY_ID
        if (!spec.omitSignatureHeaders) {
          res.setHeader('Wechatpay-Timestamp', timestamp)
          res.setHeader('Wechatpay-Nonce', nonce)
          res.setHeader('Wechatpay-Serial', serial)
          res.setHeader(
            'Wechatpay-Signature',
            signWechatResponse(platformPrivateKey, timestamp, nonce, spec.signBody ?? spec.body),
          )
        }
        res.setHeader('Request-ID', `fake-request-${captured.index}`)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Connection', 'close')
        res.statusCode = spec.status
        res.end(spec.body)
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fake WeChat server failed to bind')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export function authorizationFields(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const fields: Record<string, string> = {}
  for (const match of header.matchAll(/([a-z_]+)="([^"]*)"/gu)) {
    fields[match[1]!] = match[2]!
  }
  return fields
}
