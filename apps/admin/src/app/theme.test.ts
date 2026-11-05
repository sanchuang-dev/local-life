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

  it('does not share one colour between colorInfo and colorSuccess', () => {
    expect(adminTheme.token?.colorInfo).not.toBe(adminTheme.token?.colorSuccess)
    expect(adminTheme.token?.colorInfo).not.toBe('#138b79')
  })

  it('derives distinct info/success surface and text tokens', () => {
    const derived = theme.getDesignToken(adminTheme)
    expect(derived.colorInfoBg).not.toBe(derived.colorSuccessBg)
    expect(derived.colorInfoBorder).not.toBe(derived.colorSuccessBorder)
    expect(derived.colorInfoText).not.toBe(derived.colorSuccessText)
    // Warning/Error remain the unmistakable Ant Design gold/red roles.
    expect(derived.colorWarning).not.toBe(derived.colorInfo)
    expect(derived.colorError).not.toBe(derived.colorSuccess)
  })
})
