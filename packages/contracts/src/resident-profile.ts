import { z } from 'zod'

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

export const RESIDENT_PROFILE_ROUTES = {
  profile: '/resident/profile',
} as const

/** Resident-editable contact address. Empty input means clear the address. */
export const residentContactAddressInputSchema = z.preprocess(
  (value) => typeof value === 'string' ? (value.trim() || null) : value,
  z.string().max(200).nullable(),
)

/** Contact data is not an authenticated phone identity; duplicate numbers are allowed. */
export const residentContactPhoneInputSchema = z.preprocess(
  (value) => typeof value === 'string' ? (value.trim() || null) : value,
  z.string().regex(/^1\d{10}$/).nullable(),
)

export const updateResidentProfileRequestSchema = z.strictObject({
  contactAddress: residentContactAddressInputSchema,
  contactPhone: residentContactPhoneInputSchema.optional(),
})
export type UpdateResidentProfileRequest = z.infer<typeof updateResidentProfileRequestSchema>

export const residentProfileResponseSchema = z.strictObject({
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
  wechat: z.strictObject({
    nickname: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    profileUpdatedAt: isoTimestamp.nullable(),
  }).nullable(),
  /** Verified phone identity only; never a free-text/unverified contact number. */
  phone: z.strictObject({
    maskedPhone: z.string().nullable(),
  }),
  contactPhone: z.string().regex(/^1\d{10}$/).nullable(),
  contactAddress: z.string().max(200).nullable(),
  updatedAt: isoTimestamp.nullable(),
})
export type ResidentProfileResponse = z.infer<typeof residentProfileResponseSchema>
