import { afterEach, describe, expect, it } from 'vitest'
import {
  addWorkTab,
  closeOtherWorkTabs,
  closeWorkTab,
  getWorkTabsSnapshot,
  resetWorkTabs,
  sanitizeWorkTabs,
} from './work-tabs'

afterEach(() => {
  resetWorkTabs()
})

describe('work tab storage', () => {
  it('always anchors the strip on the workbench and deduplicates routes', () => {
    expect(sanitizeWorkTabs(['/orders', '/orders', 42, '', '/customers'])).toEqual([
      '/',
      '/orders',
      '/customers',
    ])
    expect(sanitizeWorkTabs('nope')).toEqual(['/'])
    expect(sanitizeWorkTabs(['https://evil.example'])).toEqual(['/'])
  })

  it('bounds restored tabs so corrupted storage cannot grow forever', () => {
    const many = Array.from({ length: 40 }, (_, index) => `/panel-${index}`)
    expect(sanitizeWorkTabs(many)).toHaveLength(12)
  })

  it('opens and closes tabs without ever closing the workbench', () => {
    addWorkTab('/orders')
    addWorkTab('/orders')
    addWorkTab('/customers')

    expect(getWorkTabsSnapshot()).toEqual(['/', '/orders', '/customers'])

    closeWorkTab('/')
    expect(getWorkTabsSnapshot()).toEqual(['/', '/orders', '/customers'])

    closeWorkTab('/orders')
    expect(getWorkTabsSnapshot()).toEqual(['/', '/customers'])
  })

  it('keeps only the workbench and the current page when closing others', () => {
    addWorkTab('/orders')
    addWorkTab('/customers')
    addWorkTab('/products')

    closeOtherWorkTabs('/customers')

    expect(getWorkTabsSnapshot()).toEqual(['/', '/customers'])
  })

  it('persists a versioned snapshot in sessionStorage', () => {
    addWorkTab('/orders')

    const raw = window.sessionStorage.getItem('ll:work-tabs')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw ?? '{}')).toEqual({ version: 1, tabs: ['/', '/orders'] })
  })

  it('resets both memory and storage for the next operator/test', () => {
    addWorkTab('/orders')
    resetWorkTabs()

    expect(getWorkTabsSnapshot()).toEqual(['/'])
    expect(window.sessionStorage.getItem('ll:work-tabs')).toBeNull()
  })
})
