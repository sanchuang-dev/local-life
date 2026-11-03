import { Space, Typography } from 'antd'
import type { ReactNode } from 'react'

export interface PageHeaderProps {
  title: string
  description: ReactNode
  /** Status tags rendered next to the title (for example 待建设 / 开发预览). */
  status?: ReactNode
  /** Page-level primary actions, right aligned. */
  extra?: ReactNode
}

/**
 * One pinned header for every console page: title, one-line explanation and
 * optional actions. The shell keeps it at the top of the scrolling work area so
 * an operator always knows which page a table belongs to.
 */
export function PageHeader({ title, description, status, extra }: PageHeaderProps) {
  return (
    <header className="page-header">
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
    </header>
  )
}
