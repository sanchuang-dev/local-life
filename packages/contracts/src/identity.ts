import { z } from 'zod'

/**
 * Shared identity primitives (#153 LL-USER-001).
 *
 * `staffRoleSchema` and `authCommunitySchema` used to be declared directly in
 * `index.ts`. They are moved here so a domain module can import them without
 * creating an `index.ts -> module -> index.ts` circular import (ESM would hit a
 * temporal-dead-zone error while evaluating the module). `index.ts` re-exports
 * both, so the public package surface is unchanged.
 */

/** Back-office roles. A resident account has no role at all (`null`). */
export const staffRoleSchema = z.enum(['admin', 'operator', 'grid_worker'])
export type StaffRole = z.infer<typeof staffRoleSchema>

/** Minimal community reference shared by every assignment/authorization DTO. */
export const authCommunitySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
})
