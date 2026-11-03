import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      64,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await derivePassword(password, salt)
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, saltText, hashText] = encoded.split('$')
  if (
    algorithm !== 'scrypt' ||
    cost !== '16384' ||
    blockSize !== '8' ||
    parallelism !== '1' ||
    !saltText ||
    !hashText
  ) {
    await derivePassword(password, Buffer.from('local-life-auth-timing-salt'))
    return false
  }

  try {
    const expected = Buffer.from(hashText, 'base64url')
    const actual = await derivePassword(password, Buffer.from(saltText, 'base64url'))
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
