// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from './PageHeader'

/**
 * `subnav` is an optional slot: existing callers must render byte-for-byte the
 * same header, and the caller (not the header) owns whatever state drives it.
 */
describe('PageHeader', () => {
  it('keeps the existing header layout when no subnav is provided', () => {
    const { container } = render(<PageHeader title="客户与业务单" description="说明文字" />)

    expect(screen.getByRole('heading', { name: '客户与业务单' })).toBeTruthy()
    expect(screen.getByText('说明文字')).toBeTruthy()
    expect(container.querySelector('.page-header-subnav')).toBeNull()
    expect(container.querySelector('.page-header-with-subnav')).toBeNull()
  })

  it('renders a caller-owned subnav on its own row below the title', () => {
    const { container } = render(
      <PageHeader
        title="客户与业务单"
        description="说明文字"
        status={<span>真实数据</span>}
        extra={<button type="button">刷新</button>}
        subnav={
          <nav aria-label="二级导航">
            <a href="/customers?view=orders">业务受理单</a>
          </nav>
        }
      />,
    )

    const header = container.querySelector('header.page-header')
    expect(header?.classList.contains('page-header-with-subnav')).toBe(true)
    const subnav = container.querySelector('.page-header-subnav')
    expect(subnav).toBeTruthy()
    expect(subnav?.querySelector('[aria-label="二级导航"]')).toBeTruthy()
    // The slot is a sibling row, not part of the title/description block.
    expect(subnav?.contains(screen.getByRole('heading', { name: '客户与业务单' }))).toBe(false)
    expect(subnav?.contains(screen.getByText('说明文字'))).toBe(false)
  })
})
