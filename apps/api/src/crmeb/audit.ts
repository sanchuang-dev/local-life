import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

/** Accepts either the database or a transaction so audits stay atomic. */
export interface CrmebAuditWriter {
  insert: AppDatabase['insert']
}

export interface CrmebAuditInput {
  actorUserId: string | null
  event: string
  targetId: string | null
  metadata?: Record<string, string>
}

/**
 * Writes an append-only audit row. Metadata must never contain credentials,
 * CRMEB tokens, full phone numbers or upstream payloads.
 */
export function writeCrmebAudit(writer: CrmebAuditWriter, input: CrmebAuditInput): void {
  writer
    .insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId: input.actorUserId,
      event: input.event,
      targetId: input.targetId,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: new Date(),
    })
    .run()
}
