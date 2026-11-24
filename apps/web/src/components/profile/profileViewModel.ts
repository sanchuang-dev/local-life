export interface ResidentProfileViewInput {
  loading: boolean
  saving: boolean
  error: string | null
  hasProfile: boolean
}

export type ResidentProfileStatus = 'loading' | 'error' | 'ready'

export function residentProfileViewState(input: ResidentProfileViewInput): {
  status: ResidentProfileStatus
  saveDisabled: boolean
} {
  const status: ResidentProfileStatus =
    input.loading && !input.hasProfile ? 'loading'
      : input.error && !input.hasProfile ? 'error'
        : 'ready'
  return { status, saveDisabled: status !== 'ready' || input.loading || input.saving }
}
