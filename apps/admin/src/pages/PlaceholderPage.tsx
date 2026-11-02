import { Button, Card, Result, Space, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router'

export interface PlaceholderPageProps {
  title: string
  description: string
  planned: string[]
}

/**
 * Every module outside the engineering slice renders this explicit state.
 * There is deliberately no sample table, fake count or mock success path.
 */
export function PlaceholderPage({ title, description, planned }: PlaceholderPageProps) {
  const navigate = useNavigate()

  return (
    <Card>
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          <Tag>未实现</Tag>
        </Space>
        <Typography.Text type="secondary">{description}</Typography.Text>

        <Result
          status="info"
          title="该模块尚未实现"
          subTitle="本卡只交付可运行的工程基座；登录、权限和业务功能需后续独立 Issue 与验收。"
        />

        {planned.length > 0 && (
          <div>
            <Typography.Title level={5}>后续范围（尚未实现）</Typography.Title>
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {planned.map((item) => (
                <li key={item} style={{ marginBottom: 6 }}>
                  <Tag>待办</Tag>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button onClick={() => navigate('/')}>返回总览</Button>
      </Space>
    </Card>
  )
}
