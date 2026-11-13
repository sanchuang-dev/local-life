export interface ResidentProfileViewInput {
  loading: boolean
  saving: boolean
  error: string | null
  hasProfile: boolean
  phoneStatusKnown: boolean
  phoneConfigured: boolean
  maskedPhone: string | null
  changingPhone: boolean
}

export type ResidentProfileStatus = 'loading' | 'error' | 'ready'
export type ResidentPhoneMode = 'bound' | 'bind' | 'change' | 'unavailable' | 'unknown'

export function residentProfileViewState(input: ResidentProfileViewInput): {
  status: ResidentProfileStatus
  phoneMode: ResidentPhoneMode
  saveDisabled: boolean
} {
  const status: ResidentProfileStatus =
    input.loading && !input.hasProfile ? 'loading'
      : input.error && !input.hasProfile ? 'error'
        : 'ready'

  const phoneMode: ResidentPhoneMode =
    input.maskedPhone && !input.changingPhone ? 'bound'
      : !input.phoneStatusKnown ? 'unknown'
        : input.phoneConfigured ? (input.maskedPhone ? 'change' : 'bind')
          : 'unavailable'

  return {
    status,
    phoneMode,
    saveDisabled: status !== 'ready' || input.loading || input.saving,
  }
}
