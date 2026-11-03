import { useSyncExternalStore } from 'react'
import {
  sanitizePanelPreferences,
  type DataPanelPreference,
} from './data-panel-state'

/**
 * Per-panel browser preferences (columns, density, view), persisted in
 * localStorage and keyed by the panel's stable `id`.
 *
 * No query state, cached rows, or business data ever goes here: LL-UI-003 owns
 * server/query state. A tiny external store keeps this dependency-free instead
 * of introducing a global state library for one preference map.
 */
const STORAGE_KEY = 'll:data-panel-prefs'
const STORAGE_VERSION = 1

type PanelPreferences = Record<string, DataPanelPreference>

const listeners = new Set<() => void>()

function loadPreferences(): PanelPreferences {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    if (record.version !== STORAGE_VERSION) return {}
    return sanitizePanelPreferences(record.panels)
  } catch {
    // Storage may be unavailable (private mode, quota, blocked upgrade).
    return {}
  }
}

let state: PanelPreferences = loadPreferences()

function persist() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, panels: state }),
    )
  } catch {
    // In-memory preferences still work for this page load.
  }
}

function emit() {
  persist()
  for (const listener of listeners) listener()
}

export function getPanelPreference(id: string): DataPanelPreference | undefined {
  return state[id]
}

export function setPanelPreference(id: string, value: DataPanelPreference): void {
  state = sanitizePanelPreferences({ ...state, [id]: value })
  emit()
}

export function resetPanelPreferences(): void {
  state = {}
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore: the in-memory store is already reset
    }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return state
}

/** Reads one panel's preferences; re-renders only when the shared map changes. */
export function usePanelPreference(id: string): DataPanelPreference | undefined {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return preferences[id]
}
