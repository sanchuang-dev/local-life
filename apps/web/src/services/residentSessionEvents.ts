/** Signal issued only after HTTP 401 from an authenticated resident operation. */
export const RESIDENT_SESSION_EXPIRED_EVENT = 'local-life:resident-session-expired'

export function reportResidentSessionExpired() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(RESIDENT_SESSION_EXPIRED_EVENT))
  }
}
