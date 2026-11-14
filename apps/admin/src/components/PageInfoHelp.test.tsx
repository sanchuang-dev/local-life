// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Alert, ConfigProvider } from 'antd'
import { PageHeader } from './PageHeader'
import { PageInfoAlert, PageInfoProvider, PageInfoScope } from './PageInfoHelp'

function Fixture({ active = true, secondary = false, info = true }: {
  active?: boolean
  secondary?: boolean
  info?: boolean
}) {
  return (
    <ConfigProvider>
      <PageInfoProvider>
        <PageHeader title="合同规则" description="结算管理" />
        {info ? <PageInfoAlert type="info" showIcon title="规则不可修改" description="需要调整时登记新版本。" /> : null}
        <PageInfoScope active={active}>
          <PageInfoAlert type="info" showIcon title="当前子页说明" description="只显示选中的页面。" />
        </PageInfoScope>
        {secondary ? <PageInfoAlert type="info" title="第二条说明" description="另一条解释。" /> : null}
        <Alert type="warning" showIcon title="请补齐合同" />
        <Alert type="error" showIcon title="加载失败" />
      </PageInfoProvider>
    </ConfigProvider>
  )
}

describe('PageInfoHelp', () => {
  it('moves blue explanatory alerts into a single header help button, keeping warnings and errors visible', async () => {
    render(<Fixture />)
    const help = await screen.findByRole('button', { name: '页面说明' })
    expect(help.closest('.page-header-title')).toBeTruthy()
    expect(screen.queryByText('规则不可修改')).toBeNull()
    expect(screen.getByText('请补齐合同')).toBeTruthy()
    expect(screen.getByText('加载失败')).toBeTruthy()
    fireEvent.click(help)
    expect(await screen.findByText('规则不可修改')).toBeTruthy()
    expect(await screen.findByText('需要调整时登记新版本。')).toBeTruthy()
    expect(await screen.findByText('当前子页说明')).toBeTruthy()
  })

  it('shows no extra icon when there are no blue informational messages', async () => {
    render(<Fixture info={false} active={false} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: '页面说明' })).toBeNull())
  })

  it('excludes kept-alive inactive panel help, then restores it on activation', async () => {
    const view = render(<Fixture active={false} />)
    const help = await screen.findByRole('button', { name: '页面说明' })
    fireEvent.click(help)
    expect(await screen.findByText('规则不可修改')).toBeTruthy()
    expect(screen.queryByText('当前子页说明')).toBeNull()
    view.rerender(<Fixture active />)
    expect(await screen.findByText('当前子页说明')).toBeTruthy()
  })

  it('consolidates multiple messages into one icon', async () => {
    render(<Fixture secondary />)
    expect(await screen.findAllByRole('button', { name: '页面说明' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '页面说明' }))
    expect(await screen.findByText('第二条说明')).toBeTruthy()
  })

  it('offers a local help trigger inside dialogs where the page header is masked', async () => {
    render(
      <ConfigProvider>
        <PageInfoProvider>
          <PageHeader title="订单管理" description="订单审核" />
          <div role="dialog" aria-label="订单详情">
            <PageInfoAlert inline type="info" title="本单只登记意向"
              description="人工核验不代表已付款。" />
          </div>
        </PageInfoProvider>
      </ConfigProvider>,
    )
    const inline = await screen.findByRole('button', { name: '操作说明' })
    expect(inline.closest('[role="dialog"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: '页面说明' })).toBeTruthy()
    fireEvent.click(inline)
    expect(await screen.findByText('本单只登记意向')).toBeTruthy()
    expect(await screen.findByText('人工核验不代表已付款。')).toBeTruthy()
  })

  it('removes the header icon when a conditional info source unmounts', async () => {
    const view = render(<Fixture />)
    expect(await screen.findByRole('button', { name: '页面说明' })).toBeTruthy()
    view.rerender(<Fixture info={false} active={false} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: '页面说明' })).toBeNull())
  })

  it('preserves original informational Alert when rendered outside the shell', () => {
    render(<PageInfoAlert type="info" title="隔离组件说明" description="作为测试兼容显示"/>)
    expect(screen.getByText('隔离组件说明')).toBeTruthy()
  })
})
