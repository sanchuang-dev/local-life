import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(join(import.meta.dirname, 'DataPanel.css'), 'utf8')

describe('DataPanel structural footer', () => {
  it('keeps a single pagination footer inside the panel at normal and narrow widths', () => {
    expect(styles).toMatch(/\.data-panel-footer\s*\{[^}]*display: flex;[^}]*flex: 0 0 auto;[^}]*justify-content: flex-end;[^}]*padding: 12px 16px;/)
    expect(styles).toMatch(/\.data-panel-footer \.ant-pagination\s*\{\s*margin: 0;/)
    expect(styles).toMatch(/@media \(max-width: 700px\)[\s\S]*?\.data-panel-footer\s*\{\s*padding: 12px;/)
    expect(styles).not.toContain('.data-panel-pagination')
    expect(styles).not.toContain('.ant-table-pagination')
  })

  it('uses the same default DataPanel mode in all nine admin list instances', () => {
    const pages = [
      'ActivitiesPage', 'OrdersPage', 'UsersPage', 'ProductsPage',
      'ExternalOffersPage', 'CrmPage', 'LedgerPage', 'ComponentPreviewPage',
    ]
    const total = pages.reduce((count, name) => {
      const file = readFileSync(join(import.meta.dirname, '../../pages', name + '.tsx'), 'utf8')
      expect(file).not.toMatch(/fillRemainingHeight=\{|rowActionMode=/)
      return count + (file.match(/<DataPanel</g) || []).length
    }, 0)
    expect(total).toBe(9)
  })

  it('supports CRM keep-alive tabs without clipping the footer', () => {
    expect(styles).toMatch(/\.page-stack > \.crm-subview:not\(\[hidden\]\)/)
    expect(styles).toMatch(/\.crm-list-layout > \.ant-space-item:has\(> \.data-panel--fill\)/)
  })

  it('fills residual workspace without magic viewport offsets and leaves footer outside scrolling', () => {
    expect(styles).toMatch(/\.app-content > \.page:has\(\.data-panel--fill\)/)
    // A DataPanel lives inside .page-stack on Activities but directly
    // under .page on Users. Both must receive an actual flex allocation.
    expect(styles).toMatch(/\.page-stack > \.data-panel--fill,\s*\.app-content > \.page > \.data-panel--fill\s*\{\s*flex: 1 1 auto;\s*min-height: 0;/)
    expect(styles).toMatch(/\.data-panel-body\s*\{\s*flex: 1 1 auto;\s*min-height: 0;/)
    expect(styles).toMatch(/\.data-panel--fill \.data-panel-body > \.ant-table-wrapper/)
    // Ant Design 6 uses .ant-spin for Table's outer loading wrapper.
    // Missing its flex constraint leaves .ant-table-body full-height and unscrollable.
    expect(styles).toMatch(/\.data-panel--fill \.data-panel-body \.ant-table-wrapper > \.ant-spin,/)

    expect(styles).toMatch(/\.data-panel--fill \.data-panel-body \.ant-table-body\s*\{[^}]*flex: 1 1 auto;[^}]*overflow-y: auto !important;/)
    expect(styles).toMatch(/\.data-panel--fill \.data-panel-cards\s*\{[^}]*overflow-y: auto;/)
    expect(styles).toMatch(/@media \(max-width: 700px\), \(max-height: 559px\)/)
  })
})
