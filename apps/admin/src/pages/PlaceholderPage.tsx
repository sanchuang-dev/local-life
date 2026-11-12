import { Button, Card, Result, Tag } from 'antd'
import { useNavigate } from 'react-router'
import { PageHeader } from '../components/PageHeader'

export interface PlaceholderPageProps {
  title: string
  description: string
  planned: readonly string[]
}

/**
 * Every module without real code renders this explicit state. There is
 * deliberately no sample table, fake count or mock success path.
 */
export function PlaceholderPage({ title, description, planned }: PlaceholderPageProps) {
  const navigate = useNavigate()

  return (
    <div className="page">
      <PageHeader
        title={title}
        description={description}
        status={<Tag>待建设</Tag>}
      />
      <div className="page-stack">
        <Card>
          <Result
            status="info"
            title="该模块尚未实现"
            subTitle="本卡只交付可复用的管理台基础框架；业务功能由对应 MVP 任务卡实现并单独验收。"
          />

          {planned.length > 0 ? (
            <div className="pending-scope">
              <h3 className="pending-scope-title">后续范围（尚未实现）</h3>
              <ul className="pending-scope-list">
                {planned.map((item) => (
                  <li key={item}>
                    <Tag>待办</Tag>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Button onClick={() => navigate('/')}>返回经营工作台</Button>
        </Card>
      </div>
    </div>
  )
}
