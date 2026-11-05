import { Button, Card, Col, Row, Space, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'

const ROLE_LABELS = {
  admin: '管理员',
  operator: '运营员',
  grid_worker: '网格员',
} as const

/** Real staff context only; business metrics will arrive with their own API. */
export function DashboardPage() {
  const { session } = useAdminAuth()
  const navigate = useNavigate()
  const communities = session.staff.communities

  return (
    <div className="page">
      <PageHeader
        title="经营工作台"
        description="从社区与账号管理开始；活动、订单及业绩将在对应业务功能接入后展示。"
        status={<Tag color="success">已验证身份</Tag>}
      />
      <div className="page-stack">
        {/*
         * align="stretch" + Card height:100% keep same-row cards equal height
         * with content top-aligned; on narrow screens each Col spans 24 and
         * the cards stack at their natural height — no fixed heights.
         */}
        <Row gutter={[16, 16]} align="stretch">
          <Col xs={24} md={12}>
            <Card size="small" title="当前工作身份" style={{ height: '100%' }}>
              <Typography.Title level={4} style={{ marginTop: 0 }}>
                {session.user.displayName || session.staff.username}
              </Typography.Title>
              <Space wrap>
                <Tag color="green">{ROLE_LABELS[session.staff.role]}</Tag>
                <Typography.Text type="secondary">
                  {session.staff.role === 'admin'
                    ? '可管理全部社区'
                    : `获授权社区：${communities.length} 个`}
                </Typography.Text>
              </Space>
              {session.staff.role !== 'admin' && communities.length > 0 ? (
                <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                  {communities.map((item) => item.name).join('、')}
                </Typography.Paragraph>
              ) : null}
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card size="small" title="开始工作" style={{ height: '100%' }}>
              <Typography.Paragraph>
                管理社区、网格员账户及授权范围内的居民信息。
              </Typography.Paragraph>
              <Button type="primary" onClick={() => navigate('/communities')}>
                进入账户与社区
              </Button>
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                活动、商品、订单、结算功能尚未接入真实服务。
              </Typography.Paragraph>
            </Card>
          </Col>
        </Row>
        <Card size="small" title="本阶段业务进展">
          <Typography.Text type="secondary">
            身份和社区权限可用；三人成团、广电手机卡/电视业务受理、
            商城交易和业绩对账尚待实施。此处不展示虚构销售数字。
          </Typography.Text>
        </Card>
      </div>
    </div>
  )
}
