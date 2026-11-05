import { theme } from 'antd'
import { describe, expect, it } from 'vitest'
import { adminTheme } from './theme'

const tokens = theme.getDesignToken(adminTheme)

function rgb(hex: string) {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return {
    red: (value >> 16) & 0xff,
    green: (value >> 8) & 0xff,
    blue: value & 0xff,
  }
}

describe('adminTheme semantic colours', () => {
  it('keeps the Local Life brand teal for primary actions and links', () => {
    expect(adminTheme.token?.colorPrimary).toBe('#116d63')
    expect(adminTheme.token?.colorLink).toBe('#116d63')
  })

  it('separates Info from Success in seeds and in Ant Design derived tokens', () => {
    expect(tokens.colorInfo).not.toBe(tokens.colorSuccess)
    // Alert/Tag read these derived map tokens, so background/border must differ
    // too — otherwise Info still looks like a success state in practice.
    expect(tokens.colorInfoBg).not.toBe(tokens.colorSuccessBg)
    expect(tokens.colorInfoBorder).not.toBe(tokens.colorSuccessBorder)
    expect(tokens.colorInfoText).not.toBe(tokens.colorSuccessText)
  })

  it('keeps Info blue and Success in the brand teal family', () => {
    const info = rgb(tokens.colorInfo)
    const success = rgb(tokens.colorSuccess)
    expect(info.blue).toBeGreaterThan(info.green)
    expect(success.green).toBeGreaterThan(success.blue)
    expect(tokens.colorSuccess).toBe('#138b79')
  })

  it('does not re-skin Alert or Tag through component-level overrides', () => {
    const componentOverrides = adminTheme.components ?? {}
    expect(componentOverrides).not.toHaveProperty('Alert')
    expect(componentOverrides).not.toHaveProperty('Tag')
  })
})
