import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd'

interface LoginValues {
  username: string
  password: string
}

interface LoginPageProps {
  busy: boolean
  error: string | null
  onLogin: (values: LoginValues) => Promise<void>
}

export function LoginPage({ busy, error, onLogin }: LoginPageProps) {
  const [form] = Form.useForm<LoginValues>()
  const [submitting, setSubmitting] = useState(false)

  async function submit(values: LoginValues) {
    setSubmitting(true)
    try {
      await onLogin(values)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: '#f4f7f5',
      }}
    >
      <Card style={{ width: '100%', maxWidth: 400 }} styles={{ body: { padding: 32 } }}>
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary">SANCHUANG · LOCAL LIFE</Typography.Text>
          <Typography.Title level={3} style={{ margin: 0 }}>
            本地生活运营后台
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            请使用管理员或网格员账户登录。
          </Typography.Paragraph>
          {error && <Alert type="error" showIcon message={error} />}
          <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
            <Form.Item
              name="username"
              label="登录账号"
              rules={[{ required: true, message: '请输入登录账号' }]}
            >
              <Input autoComplete="username" size="large" placeholder="管理员 / 网格员账号" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                autoComplete="current-password"
                size="large"
                placeholder="请输入密码"
                onPressEnter={() => void form.submit()}
              />
            </Form.Item>
            <Button
              htmlType="submit"
              type="primary"
              size="large"
              block
              loading={busy || submitting}
            >
              登录
            </Button>
          </Form>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            账户由系统管理员创建；暂不支持自行注册。
          </Typography.Text>
        </Space>
      </Card>
    </div>
  )
}
