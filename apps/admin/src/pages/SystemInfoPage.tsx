import { useEffect, useState } from 'react'
import { Alert, Button, Card, Descriptions, Space, Spin, Tag, Typography } from 'antd'
import { PageHeader } from '../components/PageHeader'
import { fetchHealth, type HealthResponse } from '../services/api'

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthResponse }
  | { kind: 'error'; message: string }

export function SystemInfoPage() {
  const [attempt, setAttempt] = useState(0)
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setHealth({ kind: 'loading' })
    fetchHealth(controller.signal)
      .then((data) => setHealth({ kind: 'ok', data }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setHealth({
            kind: 'error',
            message: cause instanceof Error ? cause.message : 'API 暂时无法访问',
          })
        }
      })
    return () => controller.abort()
  }, [attempt])

  return (
    <div className="page">
      <PageHeader title="系统信息" description="只读诊断：当前 API 连接情况。" />
      <Card
        title="API 健康检查"
        size="small"
        extra={
          <Button size="small" loading={health.kind === 'loading'} onClick={() => setAttempt((n) => n + 1)}>
            重新检查
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          请求当前站点同源 <Typography.Text code>GET /api/healthz</Typography.Text>。
        </Typography.Paragraph>
        {health.kind === 'loading' ? <Space><Spin size="small" />正在检查…</Space> : null}
        {health.kind === 'error' ? (
          <Alert type="error" showIcon title="API 不可用" description={health.message} />
        ) : null}
        {health.kind === 'ok' ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Tag color="green">已连通 · {health.data.status}</Tag>
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2 }}
              items={[
                { key: 'service', label: '服务', children: health.data.service },
                { key: 'version', label: '版本', children: health.data.version },
                { key: 'uptime', label: '已运行（秒）', children: health.data.uptimeSeconds },
                { key: 'time', label: '响应时间', children: new Date(health.data.timestamp).toLocaleString('zh-CN') },
              ]}
            />
          </Space>
        ) : null}
      </Card>
    </div>
  )
}
