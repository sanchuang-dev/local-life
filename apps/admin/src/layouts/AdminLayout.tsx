import {
  BellOutlined,
  DashboardOutlined,
  FileTextOutlined,
  LogoutOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { Alert, Button, Layout, Menu, Tag, Typography } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router'
import type { AuthenticatedSession } from '../services/auth'

const { Content, Header, Sider } = Layout

const NAV_ITEMS = [
  { key: '/', icon: <DashboardOutlined />, label: '总览' },
  { key: '/content', icon: <FileTextOutlined />, label: '内容管理' },
  { key: '/activities', icon: <BellOutlined />, label: '活动管理' },
  { key: '/users', icon: <TeamOutlined />, label: '账户与社区' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
]

const ROLE_LABELS = {
  admin: '管理员',
  operator: '运营员',
  grid_worker: '网格员',
} as const

interface AdminLayoutProps {
  session: AuthenticatedSession
  busy: boolean
  error: string | null
  onLogout: () => Promise<void>
}

export function AdminLayout({ session, busy, error, onLogout }: AdminLayoutProps) {
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
            运营管理后台
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
            gap: 16,
            paddingInline: 24,
          }}
        >
          <Typography.Text strong>本地生活 · 运营工作台</Typography.Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Typography.Text>{session.user.displayName || session.staff.username}</Typography.Text>
            <Tag color="green">{ROLE_LABELS[session.staff.role]}</Tag>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              loading={busy}
              onClick={() => void onLogout()}
            >
              退出
            </Button>
          </div>
        </Header>
        <Content style={{ padding: 24 }}>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="身份与权限已接入"
            description="后台请求由服务端验证会话和社区范围；活动、客户跟进、订单等业务模块仍按独立任务卡逐步交付。"
          />
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
