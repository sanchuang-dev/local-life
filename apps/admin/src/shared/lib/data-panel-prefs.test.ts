import { afterEach, describe, expect, it } from 'vitest'
import {
  getPanelPreference,
  resetPanelPreferences,
  setPanelPreference,
} from './data-panel-prefs'

afterEach(() => {
  resetPanelPreferences()
})

describe('data panel preference store', () => {
  it('isolates column/density/view preferences by panel id', () => {
    setPanelPreference('residents', { view: 'card', density: 'small', visibleKeys: ['name'] })
    setPanelPreference('orders', { density: 'large' })

    expect(getPanelPreference('residents')).toEqual({
      view: 'card',
      density: 'small',
      visibleKeys: ['name'],
    })
    expect(getPanelPreference('orders')).toEqual({ density: 'large' })
  })

  it('persists only versioned UI preferences to localStorage', () => {
    setPanelPreference('component-preview', { visibleKeys: ['name', 'status'] })

    const raw = window.localStorage.getItem('ll:data-panel-prefs')
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw ?? '{}') as {
      version: number
      panels: Record<string, unknown>
    }
    expect(stored.version).toBe(1)
    expect(stored.panels['component-preview']).toEqual({ visibleKeys: ['name', 'status'] })
  })

  it('sanitizes untrusted values before writing them', () => {
    setPanelPreference('bad-panel', {
      view: 'grid',
      density: 'xxl',
      visibleKeys: ['name', 42],
    } as never)

    expect(getPanelPreference('bad-panel')).toEqual({ visibleKeys: ['name'] })
  })

  it('resets memory and storage for the next operator or test', () => {
    setPanelPreference('residents', { view: 'card' })
    resetPanelPreferences()

    expect(getPanelPreference('residents')).toBeUndefined()
    expect(window.localStorage.getItem('ll:data-panel-prefs')).toBeNull()
  })
})
