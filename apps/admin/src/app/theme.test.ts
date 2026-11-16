import { theme } from 'antd'
import { describe, expect, it } from 'vitest'
import { adminTheme } from './theme'

// LL-UI-005 / ADM-003: Info and Success must be distinguishable semantic
// roles while the brand primary stays the Local Life teal.
describe('adminTheme semantic tokens', () => {
  it('keeps the Local Life brand teal on primary and link', () => {
    expect(adminTheme.token?.colorPrimary).toBe('#116d63')
    expect(adminTheme.token?.colorLink).toBe('#116d63')
  })

  it('uses a clean mint scale for all Ant Design primary selected backgrounds', () => {
    const derived = theme.getDesignToken(adminTheme)
    // Select uses these aliases for selected and selected+hover option states.
    // Pagination's page-size chooser uses Select, so it must not inherit gray.
    expect(derived.colorPrimaryBg).toBe('#e8f6f0')
    expect(derived.colorPrimaryBgHover).toBe('#d6eee4')
    expect(derived.colorPrimaryBorder).toBe('#b4ddce')
    expect(derived.colorPrimaryBorderHover).toBe('#8bc9b5')
    expect(derived.controlItemBgActive).toBe(derived.colorPrimaryBg)
    expect(derived.controlItemBgActiveHover).toBe(derived.colorPrimaryBgHover)
    expect(adminTheme.components?.Menu?.itemSelectedBg).toBe(derived.colorPrimaryBg)
    expect(derived.colorPrimaryBg).not.toBe('#a3adaa')
    expect(derived.colorSuccessBg).not.toBe(derived.colorPrimaryBg)
  })

  it('does not share one colour between colorInfo and colorSuccess', () => {
    expect(adminTheme.token?.colorInfo).not.toBe(adminTheme.token?.colorSuccess)
    expect(adminTheme.token?.colorInfo).not.toBe('#138b79')
  })

  it('keeps success statuses on a clean green surface, not the muddy derived gray', () => {
    const derived = theme.getDesignToken(adminTheme)
    // These aliases feed Ant Design 6 filled/outlined Tag, Alert and status styles.
    expect(derived.colorSuccess).toBe('#187d4d')
    expect(derived.colorSuccessBg).toBe('#e9f8ee')
    expect(derived.colorSuccessBgHover).toBe('#d5f0df')
    expect(derived.colorSuccessBorder).toBe('#a6dcba')
    expect(derived.colorSuccessBorderHover).toBe('#83c9a0')
    expect(derived.colorSuccessText).toBe('#187d4d')
    expect(derived.colorInfoBg).not.toBe(derived.colorSuccessBg)
    expect(derived.colorInfoBorder).not.toBe(derived.colorSuccessBorder)
    expect(derived.colorInfoText).not.toBe(derived.colorSuccessText)
    // Warning/Error remain the unmistakable Ant Design gold/red roles.
    expect(derived.colorWarning).not.toBe(derived.colorInfo)
    expect(derived.colorError).not.toBe(derived.colorSuccess)
  })
})
