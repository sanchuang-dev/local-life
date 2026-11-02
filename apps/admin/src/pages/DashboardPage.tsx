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
import { fetchHealth, type HealthResponse } from '../services/api'

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'error'; message: string }

const NOT_IMPLEMENTED = [
  '管理员登录、角色与权限',
  '内容 / 活动 / 用户 CRUD',
  'SQLite + Drizzle 业务数据库',
  '微信 OAuth、真实支付与订单',
]

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

export function DashboardPage() {
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
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col xs={24} md={8}>
          <Card size="small" title="居民 H5（已评审演示）">
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              现有移动端页面原样迁入 <Typography.Text code>apps/web</Typography.Text>，视觉与路由未重画。
            </Typography.Paragraph>
            <Space wrap>
              <Tag color="green">保留</Tag>
              <Typography.Link
                href="https://sanchuang-dev.github.io/local-life/"
                target="_blank"
                rel="noreferrer"
              >
                开发预览
              </Typography.Link>
              <Typography.Text type="secondary">本地：pnpm dev:web</Typography.Text>
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small" title="共享契约">
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              <Typography.Text code>packages/contracts</Typography.Text> 提供 zod schema 与类型，
              API 与管理台共用，不复制 DTO。
            </Typography.Paragraph>
            <Tag color="blue">已接入健康检查契约</Tag>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small" title="管理台">
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              当前页面仅为可运行的空布局，没有任何已实现的业务模块。
            </Typography.Paragraph>
            <Space>
              <Tag color="gold">未接入登录</Tag>
              <Tag>无业务数据</Tag>
            </Space>
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
              <Space orientation="vertical" size={4}>
                <Typography.Text>{health.message}</Typography.Text>
                <Typography.Text type="secondary">
                  请先运行 pnpm dev:api（默认 127.0.0.1:4080），再重新检查。
                </Typography.Text>
              </Space>
            }
          />
        )}

        {health.kind === 'ok' && (
          <Space orientation="vertical" size={8} style={{ width: '100%' }}>
            <Tag color="green">已连通 · {health.data.status}</Tag>
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: 'service', label: '服务', children: health.data.service },
                { key: 'version', label: '版本', children: health.data.version },
                {
                  key: 'uptime',
                  label: '已运行',
                  children: formatUptime(health.data.uptimeSeconds),
                },
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

      <Card size="small" title="本阶段明确未实现">
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          {NOT_IMPLEMENTED.map((item) => (
            <li key={item} style={{ marginBottom: 6 }}>
              <Tag>未实现</Tag>
              {item}
            </li>
          ))}
        </ul>
      </Card>
    </Space>
  )
}
