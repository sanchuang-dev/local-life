import { useSyncExternalStore } from 'react'

/**
 * Open work tabs, persisted in sessionStorage.
 *
 * Tabs are display state only: the URL remains the source of truth for the
 * current page. sessionStorage keeps the strip for a reload but does not leak
 * one operator's tabs to the next browser session. No router state lives here.
 */
const STORAGE_KEY = 'll:work-tabs'
const STORAGE_VERSION = 1
const MAX_TABS = 12

const DEFAULT_TABS: readonly string[] = ['/']
const listeners = new Set<() => void>()

function isRouteKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= 120 &&
    /^\/[a-z0-9/_-]*$/i.test(value)
  )
}

/** Bounds and de-duplicates whatever browser storage hands back. */
export function sanitizeWorkTabs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : []
  const tabs = [...new Set(raw.filter(isRouteKey))].slice(0, MAX_TABS)
  return tabs.includes('/') ? tabs : ['/', ...tabs].slice(0, MAX_TABS)
}

function loadTabs(): readonly string[] {
  if (typeof window === 'undefined') return DEFAULT_TABS
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_TABS
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_TABS
    const record = parsed as Record<string, unknown>
    if (record.version !== STORAGE_VERSION) return DEFAULT_TABS
    return sanitizeWorkTabs(record.tabs)
  } catch {
    // Storage may be unavailable (private mode, quota); tabs stay in memory.
    return DEFAULT_TABS
  }
}

let openTabs: readonly string[] = loadTabs()

function persist() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, tabs: openTabs }),
    )
  } catch {
    // In-memory tabs still work for this session.
  }
}

function emit() {
  persist()
  for (const listener of listeners) listener()
}

export function getWorkTabsSnapshot(): readonly string[] {
  return openTabs
}

export function subscribeWorkTabs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function addWorkTab(key: string): void {
  if (!isRouteKey(key) || openTabs.includes(key)) return
  openTabs = [...openTabs, key].slice(0, MAX_TABS)
  emit()
}

export function closeWorkTab(key: string): void {
  if (key === '/' || !openTabs.includes(key)) return
  openTabs = openTabs.filter((tab) => tab !== key)
  emit()
}

/** Keeps 经营工作台 and the current page; every other tab is closed. */
export function closeOtherWorkTabs(activeKey: string): void {
  const kept = ['/', ...(activeKey !== '/' && openTabs.includes(activeKey) ? [activeKey] : [])]
  if (kept.length === openTabs.length && kept.every((tab, index) => tab === openTabs[index])) {
    return
  }
  openTabs = kept
  emit()
}

export function resetWorkTabs(): void {
  openTabs = DEFAULT_TABS
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore: the in-memory store is already reset
    }
  }
  for (const listener of listeners) listener()
}

export function useWorkTabs(): readonly string[] {
  return useSyncExternalStore(subscribeWorkTabs, getWorkTabsSnapshot, getWorkTabsSnapshot)
}
