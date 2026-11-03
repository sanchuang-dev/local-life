import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import type { AuthenticatedSession } from '../services/auth'
import { fetchHealth, type HealthResponse } from '../services/api'

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'error'; message: string }

const NOT_IMPLEMENTED = [
  '活动发布、三人成团和活动履约',
  '网格员客户跟进与业务受理',
  '商城商品、订单和交易关联',
  '奖励发放、业绩确认与对账',
]

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

export function DashboardPage({ session }: { session: AuthenticatedSession }) {
  const [attempt, setAttempt] = useState(0)
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' })

  const retry = () => {
    setHealth({ kind: 'loading' })
    setAttempt((value) => value + 1)
  }

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal)
      .then((data) => setHealth({ kind: 'ok', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setHealth({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return () => controller.abort()
  }, [attempt])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card size="small" title="当前账户">
            <Typography.Title level={4} style={{ marginTop: 0 }}>
              {session.user.displayName || session.staff.username}
            </Typography.Title>
            <Space wrap>
              <Tag color="green">
                {session.staff.role === 'admin'
                  ? '管理员'
                  : session.staff.role === 'operator'
                    ? '运营员'
                    : '网格员'}
              </Tag>
              <Typography.Text type="secondary">
                {session.staff.communities.length} 个负责社区
              </Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small" title="居民 H5">
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              已接入居民账户状态和微信网页授权入口；现有活动、积分和商品页面继续明确标注演示数据。
            </Typography.Paragraph>
            <Space wrap>
              <Tag color="green">身份已接入</Tag>
              <Typography.Link
                href="https://sanchuang-dev.github.io/local-life/"
                target="_blank"
                rel="noreferrer"
              >
                开发预览
              </Typography.Link>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small" title="身份与权限">
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              用户主键、后台账号、会话、角色和社区范围由 API 与 SQLite 持久化。
            </Typography.Paragraph>
            <Tag color="green">已接入服务端鉴权</Tag>
          </Card>
        </Col>
      </Row>

      <Card
        title="API 健康检查"
        size="small"
        extra={
          <Button size="small" onClick={retry} loading={health.kind === 'loading'}>
            重新检查
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          请求 <Typography.Text code>GET /api/healthz</Typography.Text>
          （开发代理转发到 <Typography.Text code>127.0.0.1:4080/healthz</Typography.Text>
          ）。失败会如实展示，不使用假成功数据。
        </Typography.Paragraph>

        {health.kind === 'loading' && (
          <Space>
            <Spin size="small" />
            <Typography.Text>正在请求本地 API…</Typography.Text>
          </Space>
        )}

        {health.kind === 'error' && (
          <Alert
            type="error"
            showIcon
            title="无法连接本地 API"
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>{health.message}</Typography.Text>
                <Typography.Text type="secondary">
                  请先运行 pnpm dev:api（默认 127.0.0.1:4080），再重新检查。
                </Typography.Text>
              </Space>
            }
          />
        )}

        {health.kind === 'ok' && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Tag color="green">已连通 · {health.data.status}</Tag>
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: 'service', label: '服务', children: health.data.service },
                { key: 'version', label: '版本', children: health.data.version },
                { key: 'uptime', label: '已运行', children: formatUptime(health.data.uptimeSeconds) },
                {
                  key: 'timestamp',
                  label: '响应时间',
                  children: new Date(health.data.timestamp).toLocaleString('zh-CN'),
                },
              ]}
            />
          </Space>
        )}
      </Card>

      <Card size="small" title="后续业务施工">
        <Typography.Paragraph type="secondary">
          本卡只建立可用身份与权限底座，不把未实现的活动、成交、奖励或分账显示成真实业务。
        </Typography.Paragraph>
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          {NOT_IMPLEMENTED.map((item) => (
            <li key={item} style={{ marginBottom: 6 }}>
              <Tag>后续</Tag>
              {item}
            </li>
          ))}
        </ul>
      </Card>
    </Space>
  )
}
