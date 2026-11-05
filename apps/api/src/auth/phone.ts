import { randomInt, randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, lt } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  maskMainlandPhone,
  type ApiErrorCode,
  type PhoneOtpPurpose,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import type { HttpErrorStatus } from '../http.js'
import {
  auditLogs,
  phoneOtpRequestCounters,
  phoneVerificationCodes,
  residentPhoneIdentities,
  users,
} from '../db/schema.js'
import { constantTimeTextEqual, hashToken } from './security.js'

/**
 * Phone (SMS one-time code) resident identity, Issue #93.
 *
 * Scope of this module:
 * - generate / verify / expire / atomically consume a 6-digit code;
 * - throttle by phone and by IP (cooldown, hourly and daily windows);
 * - bind a verified phone to the *current* platform user.
 *
 * It deliberately does **not** bundle an SMS provider. The only way a code is
 * delivered is an injected {@link SmsSender}; a deployment without one fails
 * closed with `not_configured`. There is no fixed code, no master code and no
 * bypass switch anywhere in this file.
 */

/** A verification code handed to a delivery channel. Never logged or returned. */
export interface SmsVerificationMessage {
  phone: string
  code: string
  purpose: PhoneOtpPurpose
  expiresInSeconds: number
}

/**
 * Minimal delivery abstraction. A real provider adapter (Aliyun/Tencent/…) or a
 * test double implements this; the API only needs the send to be awaited so a
 * failed delivery can invalidate the code before the resident is told to wait.
 */
export interface SmsSender {
  sendVerificationCode(message: SmsVerificationMessage): Promise<void>
}

export const PHONE_OTP_TTL_SECONDS = 300
export const PHONE_OTP_MAX_ATTEMPTS = 5
export const PHONE_OTP_RESEND_COOLDOWN_SECONDS = 60
export const PHONE_OTP_PHONE_HOURLY_WINDOW_MS = 60 * 60 * 1000
export const PHONE_OTP_PHONE_HOURLY_MAX = 5
export const PHONE_OTP_PHONE_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000
export const PHONE_OTP_PHONE_DAILY_MAX = 8
export const PHONE_OTP_IP_DAILY_MAX = 20

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * A failure that maps 1:1 onto the shared error envelope. `status`/`code` are
 * plain fields (not constructor parameter properties) so the class stays
 * erasable-syntax friendly.
 */
export class PhoneOtpError extends Error {
  readonly status: HttpErrorStatus
  readonly code: ApiErrorCode
  readonly retryAfterSeconds: number | undefined

  constructor(
    status: HttpErrorStatus,
    code: ApiErrorCode,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'PhoneOtpError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface PhoneOtpContext {
  db: AppDatabase
  now: () => Date
}

export interface IssueCodeInput {
  phone: string
  purpose: PhoneOtpPurpose
  /** Raw client address; only its hash is persisted. */
  ip: string
  sender: SmsSender | undefined
}

export interface IssuedCode {
  expiresInSeconds: number
  retryAfterSeconds: number
  maxAttempts: number
}

export interface VerifyCodeInput {
  phone: string
  purpose: PhoneOtpPurpose
  code: string
}

export interface PhoneLoginResult {
  userId: string
  displayName: string | null
}

export interface PhoneBindResult {
  alreadyBound: boolean
  maskedPhone: string
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Append an audit row. Call sites only pass non-sensitive facts (event, user id,
 * purpose/outcome); the phone number and the verification code must never reach
 * the audit trail.
 */
export function recordPhoneAudit(
  db: AppDatabase,
  event: string,
  options: {
    actorUserId?: string | null
    targetId?: string | null
    metadata?: Record<string, string>
  } = {},
): void {
  db.insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId: options.actorUserId ?? null,
      event,
      targetId: options.targetId ?? null,
      metadata: options.metadata ? JSON.stringify(options.metadata) : null,
      createdAt: new Date(),
    })
    .run()
}

/* -------------------------------------------------------------------------- */
/* Throttling                                                                 */
/* -------------------------------------------------------------------------- */

function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

/**
 * Fixed-window counter keyed by a SHA-256 of the scope, so no phone number and
 * no IP address is stored in the throttle table. Exceeding the window throws
 * `otp_request_limit` with a `Retry-After` value derived from the clock.
 */
function bumpWindow(
  db: AppDatabase,
  scope: 'phone' | 'ip',
  identifier: string,
  now: Date,
  windowMs: number,
  max: number,
): void {
  const key = hashToken(`otp-window:${scope}:${windowMs}:${identifier}`)
  const startedAt = windowStart(now, windowMs)
  const row = db
    .select()
    .from(phoneOtpRequestCounters)
    .where(eq(phoneOtpRequestCounters.key, key))
    .get()
  const count = row && row.windowStartedAt.getTime() === startedAt.getTime() ? row.count : 0
  if (count >= max) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((startedAt.getTime() + windowMs - now.getTime()) / 1000),
    )
    throw new PhoneOtpError(
      429,
      API_ERROR_CODES.otpRequestLimit,
      '验证码请求过于频繁，请稍后再试',
      retryAfterSeconds,
    )
  }
  db.insert(phoneOtpRequestCounters)
    .values({ key, count: count + 1, windowStartedAt: startedAt })
    .onConflictDoUpdate({
      target: phoneOtpRequestCounters.key,
      set: { count: count + 1, windowStartedAt: startedAt },
    })
    .run()
}

function assertCooldown(db: AppDatabase, phone: string, now: Date): void {
  const latest = db
    .select({ createdAt: phoneVerificationCodes.createdAt })
    .from(phoneVerificationCodes)
    .where(eq(phoneVerificationCodes.phone, phone))
    .orderBy(desc(phoneVerificationCodes.createdAt))
    .get()
  if (!latest) return
  const elapsedMs = now.getTime() - latest.createdAt.getTime()
  // A clock that moved backwards must not lock the resident out.
  if (elapsedMs < 0 || elapsedMs >= PHONE_OTP_RESEND_COOLDOWN_SECONDS * 1000) return
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((PHONE_OTP_RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000),
  )
  throw new PhoneOtpError(
    429,
    API_ERROR_CODES.otpCooldown,
    `请 ${retryAfterSeconds} 秒后再获取验证码`,
    retryAfterSeconds,
  )
}

/* -------------------------------------------------------------------------- */
/* Issue                                                                      */
/* -------------------------------------------------------------------------- */

function randomVerificationCode(): string {
  // Uniform 000000-999999. Not a fixed code, not derived from the phone.
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/**
 * Request a new one-time code.
 *
 * Order matters: the sender check happens first (a production deployment with no
 * provider answers 503 `not_configured` and nothing is stored), then the cheap
 * cooldown read, then the bounded counters. Counters only advance for requests
 * that are actually issued, so a rejected retry cannot be used to amplify the
 * lockout of a victim's phone number.
 */
export async function requestPhoneVerificationCode(
  context: PhoneOtpContext,
  input: IssueCodeInput,
): Promise<IssuedCode> {
  const { db, now } = context
  if (!input.sender) {
    throw new PhoneOtpError(
      503,
      API_ERROR_CODES.notConfigured,
      '短信服务未配置，公网手机号登录未启用',
    )
  }

  const issuedAt = now()
  assertCooldown(db, input.phone, issuedAt)
  bumpWindow(db, 'phone', input.phone, issuedAt, PHONE_OTP_PHONE_HOURLY_WINDOW_MS, PHONE_OTP_PHONE_HOURLY_MAX)
  bumpWindow(db, 'phone', input.phone, issuedAt, PHONE_OTP_PHONE_DAILY_WINDOW_MS, PHONE_OTP_PHONE_DAILY_MAX)
  bumpWindow(db, 'ip', input.ip, issuedAt, PHONE_OTP_PHONE_DAILY_WINDOW_MS, PHONE_OTP_IP_DAILY_MAX)

  // Housekeeping: expired history is useless and must not grow forever.
  db.delete(phoneVerificationCodes)
    .where(lt(phoneVerificationCodes.expiresAt, new Date(issuedAt.getTime() - DAY_MS)))
    .run()
  db.delete(phoneOtpRequestCounters)
    .where(lt(phoneOtpRequestCounters.windowStartedAt, new Date(issuedAt.getTime() - 7 * DAY_MS)))
    .run()

  const code = randomVerificationCode()
  const id = randomUUID()
  const expiresAt = new Date(issuedAt.getTime() + PHONE_OTP_TTL_SECONDS * 1000)

  // Only one code can be live per (phone, purpose): a re-request supersedes the
  // previous one instead of leaving two valid codes around.
  db.update(phoneVerificationCodes)
    .set({ invalidatedAt: issuedAt })
    .where(
      and(
        eq(phoneVerificationCodes.phone, input.phone),
        eq(phoneVerificationCodes.purpose, input.purpose),
        isNull(phoneVerificationCodes.consumedAt),
        isNull(phoneVerificationCodes.invalidatedAt),
      ),
    )
    .run()

  db.insert(phoneVerificationCodes)
    .values({
      id,
      phone: input.phone,
      purpose: input.purpose,
      // Salt with the row id: the hash is useless without this database row.
      codeHash: hashToken(`${id}:${code}`),
      attempts: 0,
      maxAttempts: PHONE_OTP_MAX_ATTEMPTS,
      expiresAt,
      consumedAt: null,
      invalidatedAt: null,
      requestIpHash: hashToken(`otp-ip:${input.ip}`),
      createdAt: issuedAt,
    })
    .run()

  try {
    await input.sender.sendVerificationCode({
      phone: input.phone,
      code,
      purpose: input.purpose,
      expiresInSeconds: PHONE_OTP_TTL_SECONDS,
    })
  } catch (error) {
    // The resident never received a code: invalidate it instead of leaving a
    // live credential they cannot know.
    db.update(phoneVerificationCodes)
      .set({ invalidatedAt: now() })
      .where(eq(phoneVerificationCodes.id, id))
      .run()
    throw new PhoneOtpError(
      503,
      API_ERROR_CODES.smsDeliveryFailed,
      '短信发送失败，请稍后重试',
    )
  }

  return {
    expiresInSeconds: PHONE_OTP_TTL_SECONDS,
    retryAfterSeconds: PHONE_OTP_RESEND_COOLDOWN_SECONDS,
    maxAttempts: PHONE_OTP_MAX_ATTEMPTS,
  }
}

/* -------------------------------------------------------------------------- */
/* Verify                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Verify and atomically consume the live code for `(phone, purpose)`.
 *
 * Wrong guesses increment `attempts` up to `max_attempts` and then invalidate the
 * code. A correct guess performs a single conditional UPDATE, so two concurrent
 * HTTP requests carrying the same code cannot both succeed: the loser sees
 * `changes !== 1` and is rejected.
 */
export function verifyPhoneCode(context: PhoneOtpContext, input: VerifyCodeInput): void {
  const { db, now } = context
  const current = now()
  const record = db
    .select()
    .from(phoneVerificationCodes)
    .where(
      and(
        eq(phoneVerificationCodes.phone, input.phone),
        eq(phoneVerificationCodes.purpose, input.purpose),
        isNull(phoneVerificationCodes.consumedAt),
        isNull(phoneVerificationCodes.invalidatedAt),
      ),
    )
    .orderBy(desc(phoneVerificationCodes.createdAt))
    .get()

  if (!record) {
    throw new PhoneOtpError(400, API_ERROR_CODES.otpInvalid, '验证码无效，请重新获取')
  }
  if (record.expiresAt.getTime() <= current.getTime()) {
    db.update(phoneVerificationCodes)
      .set({ invalidatedAt: current })
      .where(eq(phoneVerificationCodes.id, record.id))
      .run()
    throw new PhoneOtpError(400, API_ERROR_CODES.otpExpired, '验证码已过期，请重新获取')
  }

  const matches = constantTimeTextEqual(record.codeHash, hashToken(`${record.id}:${input.code}`))
  if (!matches) {
    const attempts = record.attempts + 1
    const exceeded = attempts >= record.maxAttempts
    db.update(phoneVerificationCodes)
      .set({ attempts, invalidatedAt: exceeded ? current : null })
      .where(eq(phoneVerificationCodes.id, record.id))
      .run()
    if (exceeded) {
      throw new PhoneOtpError(
        429,
        API_ERROR_CODES.otpAttemptsExceeded,
        '验证码错误次数过多，请重新获取',
      )
    }
    throw new PhoneOtpError(
      400,
      API_ERROR_CODES.otpInvalid,
      `验证码不正确，还可尝试 ${record.maxAttempts - attempts} 次`,
    )
  }

  const consumed = db
    .update(phoneVerificationCodes)
    .set({ consumedAt: current })
    .where(
      and(
        eq(phoneVerificationCodes.id, record.id),
        isNull(phoneVerificationCodes.consumedAt),
        isNull(phoneVerificationCodes.invalidatedAt),
      ),
    )
    .run()
  if (consumed.changes !== 1) {
    throw new PhoneOtpError(400, API_ERROR_CODES.otpInvalid, '验证码已使用，请重新获取')
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /unique/i.test(error.message)
}

/* -------------------------------------------------------------------------- */
/* Bind                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bind `phone` to `userId` after proving control of the number.
 *
 * - the phone already belongs to this user: idempotent refresh;
 * - the phone belongs to another user: hard 409, no merge, no attribution move;
 * - this user already owns a different phone: hard 409 (replacement is a
 *   separate audited operation, not implemented here);
 * - otherwise insert the mapping. Participation/reward rows are never touched:
 *   they stay keyed by the platform UUID, so binding cannot rewrite history.
 */
export function bindVerifiedPhone(
  context: PhoneOtpContext,
  input: { userId: string; phone: string; code: string },
): PhoneBindResult {
  const { db, now } = context
  verifyPhoneCode(context, { phone: input.phone, purpose: 'bind', code: input.code })
  const current = now()

  const byPhone = db
    .select()
    .from(residentPhoneIdentities)
    .where(eq(residentPhoneIdentities.phone, input.phone))
    .get()

  if (byPhone) {
    if (byPhone.userId === input.userId) {
      db.update(residentPhoneIdentities)
        .set({ verifiedAt: current, updatedAt: current })
        .where(eq(residentPhoneIdentities.id, byPhone.id))
        .run()
      recordPhoneAudit(db, 'phone.identity.reverified', {
        actorUserId: input.userId,
        targetId: input.userId,
        metadata: { purpose: 'bind', outcome: 'already_bound' },
      })
      return { alreadyBound: true, maskedPhone: maskMainlandPhone(input.phone) }
    }
    recordPhoneAudit(db, 'phone.identity.conflict', {
      actorUserId: input.userId,
      targetId: input.userId,
      metadata: { purpose: 'bind', outcome: 'phone_owned_by_another_account' },
    })
    throw new PhoneOtpError(
      409,
      API_ERROR_CODES.phoneInUse,
      '该手机号已绑定其他居民账户，暂不支持自助合并，请联系社区运营人员',
    )
  }

  const owned = db
    .select()
    .from(residentPhoneIdentities)
    .where(eq(residentPhoneIdentities.userId, input.userId))
    .get()
  if (owned) {
    recordPhoneAudit(db, 'phone.identity.conflict', {
      actorUserId: input.userId,
      targetId: input.userId,
      metadata: { purpose: 'bind', outcome: 'account_already_has_phone' },
    })
    throw new PhoneOtpError(
      409,
      API_ERROR_CODES.phoneAlreadyBound,
      '当前账户已绑定其他手机号，暂不支持自助更换',
    )
  }

  try {
    db.insert(residentPhoneIdentities)
      .values({
        id: randomUUID(),
        userId: input.userId,
        phone: input.phone,
        verifiedAt: current,
        createdAt: current,
        updatedAt: current,
      })
      .run()
  } catch (error) {
    // Two accounts raced for the same verified phone: the UNIQUE index decides.
    if (isUniqueViolation(error)) {
      recordPhoneAudit(db, 'phone.identity.conflict', {
        actorUserId: input.userId,
        targetId: input.userId,
        metadata: { purpose: 'bind', outcome: 'unique_violation' },
      })
      throw new PhoneOtpError(
        409,
        API_ERROR_CODES.phoneInUse,
        '该手机号已绑定其他居民账户，暂不支持自助合并，请联系社区运营人员',
      )
    }
    throw error
  }

  const user = db.select().from(users).where(eq(users.id, input.userId)).get()
  // Only fill a missing display name; a real name is never overwritten.
  if (user && !user.displayName) {
    db.update(users)
      .set({ displayName: maskMainlandPhone(input.phone), updatedAt: current })
      .where(eq(users.id, input.userId))
      .run()
  }

  recordPhoneAudit(db, 'phone.identity.bound', {
    actorUserId: input.userId,
    targetId: input.userId,
    metadata: { purpose: 'bind', outcome: 'bound' },
  })
  return { alreadyBound: false, maskedPhone: maskMainlandPhone(input.phone) }
}

/* -------------------------------------------------------------------------- */
/* Login                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Exchange phone + code for the platform user that owns the phone.
 *
 * A first-time phone creates exactly one resident account; every later login
 * resolves the same UUID, so participation and reward rows keep their owner. The
 * UNIQUE phone index is the real arbiter when two first-logins race: the loser
 * re-reads the winner's identity instead of creating a second account.
 */
export function loginWithPhone(
  context: PhoneOtpContext,
  input: { phone: string; code: string },
): PhoneLoginResult {
  const { db, now } = context
  verifyPhoneCode(context, { phone: input.phone, purpose: 'login', code: input.code })
  const current = now()

  const identity = db
    .select()
    .from(residentPhoneIdentities)
    .where(eq(residentPhoneIdentities.phone, input.phone))
    .get()

  if (identity) {
    const user = db.select().from(users).where(eq(users.id, identity.userId)).get()
    if (!user) {
      throw new PhoneOtpError(401, API_ERROR_CODES.unauthorized, '账户状态异常，请联系社区运营人员')
    }
    db.update(residentPhoneIdentities)
      .set({ verifiedAt: current, updatedAt: current })
      .where(eq(residentPhoneIdentities.id, identity.id))
      .run()
    return { userId: user.id, displayName: user.displayName }
  }

  const userId = randomUUID()
  const displayName = maskMainlandPhone(input.phone)
  try {
    db.transaction((tx) => {
      tx.insert(users)
        .values({ id: userId, displayName, createdAt: current, updatedAt: current })
        .run()
      tx.insert(residentPhoneIdentities)
        .values({
          id: randomUUID(),
          userId,
          phone: input.phone,
          verifiedAt: current,
          createdAt: current,
          updatedAt: current,
        })
        .run()
    })
    recordPhoneAudit(db, 'phone.identity.created', {
      actorUserId: userId,
      targetId: userId,
      metadata: { purpose: 'login', outcome: 'account_created' },
    })
    return { userId, displayName }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = db
      .select()
      .from(residentPhoneIdentities)
      .where(eq(residentPhoneIdentities.phone, input.phone))
      .get()
    if (!raced) throw error
    const user = db.select().from(users).where(eq(users.id, raced.userId)).get()
    if (!user) {
      throw new PhoneOtpError(401, API_ERROR_CODES.unauthorized, '账户状态异常，请联系社区运营人员')
    }
    return { userId: user.id, displayName: user.displayName }
  }
}
