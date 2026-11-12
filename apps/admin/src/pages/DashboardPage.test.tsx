// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { mockHealthFetch, renderAdmin, setViewportWidth } from '../test/render-admin'
import { resetWorkTabs } from '../shared/lib/work-tabs'

function cardByTitle(title: string): HTMLElement {
  const card = screen.getByText(title).closest('.ant-card')
  if (!card) throw new Error(`card ${title} not found`)
  return card as HTMLElement
}

// LL-UI-005 / ADM-001: the two workbench cards share one flex row whose
// columns stretch, and each Card fills its column — equal height on desktop,
// natural stacking on narrow screens, never a hard-coded pixel height.
describe('DashboardPage card alignment', () => {
  beforeEach(() => {
    setViewportWidth(1024)
    mockHealthFetch()
  })

  afterEach(() => {
    resetWorkTabs()
    vi.unstubAllGlobals()
    setViewportWidth(1024)
  })

  it('lays the identity and start cards in one stretching row at full column height', async () => {
    renderAdmin('/')

    await screen.findByText('当前工作身份')
    const identityCard = cardByTitle('当前工作身份')
    const startCard = cardByTitle('开始工作')

    expect(identityCard.style.height).toBe('100%')
    expect(startCard.style.height).toBe('100%')
    expect(identityCard.style.height).not.toMatch(/px$/)

    const identityRow = identityCard.closest('.ant-row')
    expect(identityRow).not.toBeNull()
    expect(identityRow).toBe(startCard.closest('.ant-row'))
    expect(identityRow?.className).toContain('ant-row-stretch')

    // The verified-identity feedback uses the semantic Success token, not an
    // ad-hoc preset green, so Tag/Alert share one semantic palette.
    const statusTag = screen.getByText('已验证身份')
    expect(statusTag.className).toContain('ant-tag-success')

    // Both columns keep the responsive span contract: full width on xs, half on md+.
    for (const card of [identityCard, startCard]) {
      const col = card.closest('.ant-col')
      expect(col?.className).toContain('ant-col-xs-24')
      expect(col?.className).toContain('ant-col-md-12')
    }
  })
})
