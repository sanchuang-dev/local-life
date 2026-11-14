import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(import.meta.dirname, 'sidebar.css'), 'utf8')

function rule(selector) {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start).split('}')[0]
}

describe('sidebar scroll layout', () => {
  it('locks brand and search while only the navigation scrolls', () => {
    expect(rule('.app-sider')).toContain('overflow: hidden')
    expect(rule('.app-sider > .ant-layout-sider-children')).toContain('flex-direction: column')
    expect(rule('.app-sidebar-nav')).toContain('overflow-y: auto')
    expect(rule('.app-sidebar-nav')).toContain('min-height: 0')
    expect(rule('.app-brand')).toContain('flex: 0 0 52px')
    expect(rule('.app-sidebar-search')).toContain('flex: 0 0 38px')
    expect(rule('.app-sidebar-drawer')).toContain('flex-direction: column')
  })
})
