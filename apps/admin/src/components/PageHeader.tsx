import { Space, Typography } from 'antd'
import type { ReactNode } from 'react'

export interface PageHeaderProps {
  title: string
  description: ReactNode
  /** Status tags rendered next to the title (for example 待建设 / 开发预览). */
  status?: ReactNode
  /** Page-level primary actions, right aligned. */
  extra?: ReactNode
  /**
   * Optional page-level secondary navigation (for example antd Tabs used as a
   * nav bar), pinned to the header's bottom edge. The header never owns the
   * state behind this slot; callers keep it in the URL or local state.
   */
  subnav?: ReactNode
}

/**
 * One pinned header for every console page: title, one-line explanation and
 * optional actions. The shell keeps it at the top of the scrolling work area so
 * an operator always knows which page a table belongs to.
 */
export function PageHeader({ title, description, status, extra, subnav }: PageHeaderProps) {
  return (
    <header className={subnav ? 'page-header page-header-with-subnav' : 'page-header'}>
      <div className="page-header-main">
        <div className="page-header-title">
          <Typography.Title level={2}>{title}</Typography.Title>
          {status}
        </div>
        <Typography.Text type="secondary" className="page-header-description">
          {description}
        </Typography.Text>
      </div>
      {extra ? <Space className="page-header-extra">{extra}</Space> : null}
      {subnav ? <div className="page-header-subnav">{subnav}</div> : null}
    </header>
  )
}
