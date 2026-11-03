import { Button, Card, Result } from 'antd'
import { useNavigate } from 'react-router'
import { PageHeader } from '../components/PageHeader'

/** Unknown admin URL: no menu entry, no work tab, no invented module. */
export function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <div className="page">
      <PageHeader title="页面不存在" description="该管理台地址没有对应模块，可能来自已失效的收藏或旧链接。" />
      <div className="page-stack">
        <Card>
          <Result
            status="404"
            title="页面不存在"
            subTitle="请从左侧导航进入当前已实现的页面。"
            extra={<Button onClick={() => navigate('/')}>返回经营工作台</Button>}
          />
        </Card>
      </div>
    </div>
  )
}
