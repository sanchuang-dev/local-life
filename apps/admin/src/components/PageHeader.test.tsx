// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Tabs } from 'antd'
import { PageHeader } from './PageHeader'

/**
 * The header ships without any secondary navigation by default; pages that
 * need one opt in through the `subnav` slot without forking the component.
 */
describe('PageHeader', () => {
  it('renders title, description, status and extra without a subnav slot', () => {
    const { container } = render(
      <PageHeader
        title="经营工作台"
        description="只读概览"
        status={<span>真实数据</span>}
        extra={<button type="button">导出</button>}
      />,
    )

    expect(screen.getByRole('heading', { name: '经营工作台' })).toBeTruthy()
    expect(screen.getByText('只读概览')).toBeTruthy()
    expect(screen.getByText('真实数据')).toBeTruthy()
    expect(screen.getByRole('button', { name: '导出' })).toBeTruthy()
    expect(container.querySelector('.page-header-subnav')).toBeNull()
    expect(container.querySelector('header')?.className).toBe('page-header')
  })

  it('pins an optional subnav inside the header below the description', () => {
    const { container } = render(
      <PageHeader
        title="客户与业务单"
        description="CRM"
        subnav={
          <Tabs
            activeKey="leads"
            items={[
              { key: 'leads', label: '客户线索' },
              { key: 'orders', label: '业务受理单' },
            ]}
          />
        }
      />,
    )

    const header = container.querySelector('header')
    expect(header?.className).toBe('page-header page-header-with-subnav')
    const subnav = header?.querySelector('.page-header-subnav')
    expect(subnav).toBeTruthy()
    // The antd Tabs keeps its accessible tablist/tab roles inside the slot.
    expect(subnav?.querySelector('[role="tablist"]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '客户线索' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '业务受理单' })).toBeTruthy()
    // The subnav row comes after the title/description block in the header.
    const main = header?.querySelector('.page-header-main')
    expect(main && subnav && main.compareDocumentPosition(subnav)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
})
