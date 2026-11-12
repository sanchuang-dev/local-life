import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  crmebIdentityBindResponseSchema,
  crmebIdentityRevokeResponseSchema,
  crmebIdentityStatusResponseSchema,
  type CrmebIdentityBindRequest,
  type CrmebIdentityBindResponse,
  type CrmebIdentityRevokeResponse,
  type CrmebIdentityStatusResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { crmebIdentities, users } from '../db/schema.js'
import { writeCrmebAudit } from './audit.js'
import { CrmebDomainError } from './errors.js'

function toIso(value: Date): string {
  return value.toISOString()
}

/**
 * Staff-only, explicitly audited binding of a platform user UUID to a CRMEB uid.
 *
 * There is no trustworthy CRMEB-side proof: outapi only issues application-level
 * tokens (no user assertion), and `/api/remote_register` can forge any uid, so it
 * is never used. `manual_verified` is therefore the only accepted method and the
 * note is admin-only.
 */
export function bindCrmebIdentity(
  db: AppDatabase,
  actorUserId: string,
  input: CrmebIdentityBindRequest,
): CrmebIdentityBindResponse {
  const platformUser = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.platformUserId))
    .get()
  if (!platformUser) {
    throw new CrmebDomainError(404, API_ERROR_CODES.notFound, '要绑定的居民账户不存在')
  }
  const existing = db
    .select()
    .from(crmebIdentities)
    .where(eq(crmebIdentities.platformUserId, input.platformUserId))
    .get()
  if (existing?.status === 'active') {
    throw new CrmebDomainError(409, API_ERROR_CODES.conflict, '该居民已绑定 CRMEB 账号')
  }
  const uidConflict = db
    .select({ id: crmebIdentities.id })
    .from(crmebIdentities)
    .where(eq(crmebIdentities.crmebUid, input.crmebUid))
    .get()
  if (uidConflict && uidConflict.id !== existing?.id) {
    throw new CrmebDomainError(409, API_ERROR_CODES.conflict, '该 CRMEB uid 已绑定其他居民')
  }

  const now = new Date()
  if (existing) {
    // Rebinding is explicit: only a revoked row can be reactivated, and the
    // event records both the old and the new CRMEB uid for audit.
    db.transaction((tx) => {
      tx.update(crmebIdentities)
        .set({
          crmebUid: input.crmebUid,
          status: 'active',
          verificationMethod: input.verificationMethod,
          verificationNote: input.note ?? null,
          createdByUserId: actorUserId,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(eq(crmebIdentities.id, existing.id))
        .run()
      writeCrmebAudit(tx, {
        actorUserId,
        event: 'crmeb.identity.rebound',
        targetId: input.platformUserId,
        metadata: {
          previousCrmebUid: String(existing.crmebUid),
          crmebUid: String(input.crmebUid),
          verificationMethod: input.verificationMethod,
        },
      })
    })
    return crmebIdentityBindResponseSchema.parse({
      identity: {
        id: existing.id,
        platformUserId: input.platformUserId,
        crmebUid: input.crmebUid,
        status: 'active',
        verificationMethod: input.verificationMethod,
        verifiedAt: toIso(now),
        createdAt: toIso(existing.createdAt),
      },
    })
  }

  const identityId = randomUUID()
  db.transaction((tx) => {
    tx.insert(crmebIdentities)
      .values({
        id: identityId,
        platformUserId: input.platformUserId,
        crmebUid: input.crmebUid,
        status: 'active',
        verificationMethod: input.verificationMethod,
        verificationNote: input.note ?? null,
        createdByUserId: actorUserId,
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    writeCrmebAudit(tx, {
      actorUserId,
      event: 'crmeb.identity.bound',
      targetId: input.platformUserId,
      metadata: {
        crmebUid: String(input.crmebUid),
        verificationMethod: input.verificationMethod,
      },
    })
  })

  return crmebIdentityBindResponseSchema.parse({
    identity: {
      id: identityId,
      platformUserId: input.platformUserId,
      crmebUid: input.crmebUid,
      status: 'active',
      verificationMethod: input.verificationMethod,
      verifiedAt: toIso(now),
      createdAt: toIso(now),
    },
  })
}

/**
 * Admin-only, audited revocation. The row is kept (never deleted) so the prior
 * mapping and its audit trail remain; a later explicit bind reactivates it.
 */
export function revokeCrmebIdentity(
  db: AppDatabase,
  actorUserId: string,
  platformUserId: string,
): CrmebIdentityRevokeResponse {
  const existing = db
    .select()
    .from(crmebIdentities)
    .where(eq(crmebIdentities.platformUserId, platformUserId))
    .get()
  if (!existing) {
    throw new CrmebDomainError(404, API_ERROR_CODES.notFound, '该居民没有可撤销的 CRMEB 绑定')
  }
  const now = new Date()
  db.transaction((tx) => {
    tx.update(crmebIdentities)
      .set({ status: 'revoked', updatedAt: now })
      .where(eq(crmebIdentities.id, existing.id))
      .run()
    writeCrmebAudit(tx, {
      actorUserId,
      event: 'crmeb.identity.revoked',
      targetId: platformUserId,
      metadata: { previousCrmebUid: String(existing.crmebUid) },
    })
  })
  return crmebIdentityRevokeResponseSchema.parse({
    identity: {
      id: existing.id,
      platformUserId,
      crmebUid: existing.crmebUid,
      status: 'revoked',
      verificationMethod: existing.verificationMethod,
      verifiedAt: toIso(existing.verifiedAt),
      createdAt: toIso(existing.createdAt),
    },
  })
}

/**
 * Resident-visible binding state. A revoked mapping is reported as not linked:
 * the platform must explicitly state that no real CRMEB identity is attached.
 */
export function getResidentCrmebIdentity(
  db: AppDatabase,
  platformUserId: string,
): CrmebIdentityStatusResponse {
  const identity = db
    .select({
      status: crmebIdentities.status,
      verificationMethod: crmebIdentities.verificationMethod,
      verifiedAt: crmebIdentities.verifiedAt,
    })
    .from(crmebIdentities)
    .where(
      and(
        eq(crmebIdentities.platformUserId, platformUserId),
        eq(crmebIdentities.status, 'active'),
      ),
    )
    .get()

  if (!identity) return crmebIdentityStatusResponseSchema.parse({ linked: false })
  return crmebIdentityStatusResponseSchema.parse({
    linked: true,
    identity: {
      status: identity.status,
      verificationMethod: identity.verificationMethod,
      verifiedAt: toIso(identity.verifiedAt),
    },
  })
}
