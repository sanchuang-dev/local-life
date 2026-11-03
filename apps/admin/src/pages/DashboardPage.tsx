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
import { PageHeader } from '../components/PageHeader'
import { fetchHealth, type HealthResponse } from '../services/api'

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'error'; message: string }

const NOT_IMPLEMENTED = [
  '统一身份、角色与路由守卫（依赖 #58，尚未合并）',
  '活动、客户、商城、订单与对账业务模块',
  '面向业务列表的服务端分页与查询接口',
  '微信 OAuth、真实支付与订单回流',
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
    <div className="page">
      <PageHeader
        title="经营工作台"
        description="本地生活管理后台的统一工作面。以下只展示当前真实可用的工程能力，业务模块接入后会替换对应待建设状态。"
        status={<Tag color="green">API 健康检查已接入</Tag>}
      />

      <div className="page-stack">
        <Alert
          type="info"
          showIcon
          title="这是管理台基础框架，不是已上线的业务系统"
          description="活动、客户、订单、业绩等模块尚未实现；左侧导航中的对应页面会明确显示待建设状态，不展示虚构经营数据。"
        />

        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Card size="small" title="居民 H5（已评审演示）">
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                现有移动端页面原样保留在 <Typography.Text code>apps/web</Typography.Text>，
                视觉与路由未重画；管理台外壳不修改 H5。
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
            <Card size="small" title="管理台框架">
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                统一侧栏、工作页签、主题 token 与页面版心已接入；DataPanel 列表组件由 LL-UI-002
                提供。
              </Typography.Paragraph>
              <Space wrap>
                <Tag color="gold">业务模块待建设</Tag>
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

          {health.kind === 'loading' ? (
            <Space>
              <Spin size="small" />
              <Typography.Text>正在请求本地 API…</Typography.Text>
            </Space>
          ) : null}

          {health.kind === 'error' ? (
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
          ) : null}

          {health.kind === 'ok' ? (
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
          ) : null}
        </Card>

        <Card size="small" title="本阶段明确未实现">
          <ul className="pending-scope-list">
            {NOT_IMPLEMENTED.map((item) => (
              <li key={item}>
                <Tag>未实现</Tag>
                {item}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
