import {
  BellOutlined,
  DashboardOutlined,
  FileTextOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Alert, Layout, Menu, Tag, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router'

const { Content, Header, Sider } = Layout

const NAV_ITEMS = [
  { key: '/', icon: <DashboardOutlined />, label: '总览' },
  { key: '/content', icon: <FileTextOutlined />, label: '内容管理' },
  { key: '/activities', icon: <BellOutlined />, label: '活动管理' },
  { key: '/users', icon: <TeamOutlined />, label: '用户与权限' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
]

export function AdminLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const selectedKey =
    NAV_ITEMS.find(
      (item) => item.key !== '/' && location.pathname.startsWith(item.key),
    )?.key ?? '/'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={232} style={{ borderRight: '1px solid #e6ebe7' }}>
        <div style={{ padding: '20px 20px 12px' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            三创 · 本地生活
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            管理台 · 工程预览
          </Typography.Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#ffffff',
            borderBottom: '1px solid #e6ebe7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 24,
          }}
        >
          <Typography.Text strong>管理台工程基座</Typography.Text>
          <Tag color="gold">未接入登录</Tag>
        </Header>
        <Content style={{ padding: 24 }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="这是工程基座预览，不是可用管理系统"
            description="登录、权限、内容与用户 CRUD 均未实现；除总览中的真实 API 健康检查外，页面不会伪造业务数据或成功状态。"
          />
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
