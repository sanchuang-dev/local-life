import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Form, Input, Row, Select, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { AuthenticatedSession } from '../services/auth'

interface Community {
  id: string
  name: string
}

interface StaffAccount {
  id: string
  username: string
  displayName: string | null
  role: 'admin' | 'operator' | 'grid_worker'
  status: 'active' | 'disabled'
  communities: Community[]
}

interface Resident {
  id: string
  displayName: string | null
  createdAt: string
}

interface UsersPageProps {
  session: AuthenticatedSession
}

const ROLE_LABELS = {
  admin: '管理员',
  operator: '运营员',
  grid_worker: '网格员',
} as const

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'object' &&
      payload.error !== null &&
      'message' in payload.error
        ? String(payload.error.message)
        : `请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  return payload as T
}

export function UsersPage({ session }: UsersPageProps) {
  const [communityForm] = Form.useForm<{ name: string }>()
  const [staffForm] = Form.useForm<{
    username: string
    displayName: string
    password: string
    role: 'operator' | 'grid_worker'
    userId?: string
    communityIds: string[]
  }>()
  const [communities, setCommunities] = useState<Community[]>([])
  const [staff, setStaff] = useState<StaffAccount[]>([])
  const [residents, setResidents] = useState<Resident[]>([])
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | undefined>(
    session.staff.communities[0]?.id,
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isAdmin = session.staff.role === 'admin'

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const communityResult = await apiRequest<{ items: Community[] }>('/api/admin/communities')
      setCommunities(communityResult.items)
      if (!selectedCommunityId && communityResult.items[0]) {
        setSelectedCommunityId(communityResult.items[0].id)
      }
      if (isAdmin) {
        const staffResult = await apiRequest<{ items: StaffAccount[] }>('/api/admin/staff')
        setStaff(staffResult.items)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取账户和社区信息')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
    // This screen loads once per authenticated staff session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedCommunityId) {
      setResidents([])
      return
    }
    let active = true
    apiRequest<{ items: Resident[] }>(
      `/api/crm/residents?communityId=${encodeURIComponent(selectedCommunityId)}`,
    )
      .then((result) => {
        if (active) setResidents(result.items)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '无法读取社区居民')
      })
    return () => {
      active = false
    }
  }, [selectedCommunityId])

  async function createCommunity(values: { name: string }) {
    setSaving(true)
    setError(null)
    try {
      await apiRequest<Community>('/api/admin/communities', {
        method: 'POST',
        headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify(values),
      })
      communityForm.resetFields()
      await loadData()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建社区失败')
    } finally {
      setSaving(false)
    }
  }

  async function createStaff(values: {
    username: string
    displayName: string
    password: string
    role: 'operator' | 'grid_worker'
    userId?: string
    communityIds: string[]
  }) {
    setSaving(true)
    setError(null)
    try {
      await apiRequest<StaffAccount>('/api/admin/staff', {
        method: 'POST',
        headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify(values),
      })
      staffForm.resetFields()
      await loadData()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建后台账户失败')
    } finally {
      setSaving(false)
    }
  }

  const staffColumns: ColumnsType<StaffAccount> = useMemo(
    () => [
      { title: '登录账号', dataIndex: 'username', key: 'username' },
      { title: '姓名', dataIndex: 'displayName', key: 'displayName', render: (value: string | null) => value || '—' },
      {
        title: '角色',
        dataIndex: 'role',
        key: 'role',
        render: (role: StaffAccount['role']) => <Tag color={role === 'grid_worker' ? 'blue' : 'green'}>{ROLE_LABELS[role]}</Tag>,
      },
      {
        title: '负责社区',
        dataIndex: 'communities',
        key: 'communities',
        render: (items: Community[]) => items.map((item) => item.name).join('、'),
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        render: (status: StaffAccount['status']) => <Tag color={status === 'active' ? 'success' : 'default'}>{status === 'active' ? '正常' : '已停用'}</Tag>,
      },
    ],
    [],
  )

  const residentColumns: ColumnsType<Resident> = useMemo(
    () => [
      { title: '居民', dataIndex: 'displayName', key: 'displayName', render: (value: string | null) => value || '微信用户' },
      { title: '平台用户 ID', dataIndex: 'id', key: 'id', render: (value: string) => <Typography.Text code copyable>{value}</Typography.Text> },
      { title: '加入时间', dataIndex: 'createdAt', key: 'createdAt', render: (value: string) => new Date(value).toLocaleString('zh-CN') },
    ],
    [],
  )

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} />}
      <Card
        size="small"
        title="社区范围"
        extra={<Button size="small" onClick={() => void loadData()} loading={loading}>刷新</Button>}
      >
        <Space wrap>
          <Typography.Text type="secondary">当前账户可访问的社区：</Typography.Text>
          <Select
            style={{ minWidth: 220 }}
            value={selectedCommunityId}
            placeholder="选择社区"
            options={communities.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setSelectedCommunityId}
          />
          <Tag color={isAdmin ? 'green' : 'blue'}>{ROLE_LABELS[session.staff.role]}</Tag>
          {!isAdmin && <Typography.Text type="secondary">仅显示管理员分配给你的社区范围。</Typography.Text>}
        </Space>
      </Card>

      {isAdmin && (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={9}>
            <Card size="small" title="创建社区">
              <Form form={communityForm} layout="vertical" onFinish={createCommunity}>
                <Form.Item name="name" label="社区名称" rules={[{ required: true, min: 2, max: 60 }]}>
                  <Input placeholder="例如：幸福社区" maxLength={60} />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={saving}>创建社区</Button>
              </Form>
            </Card>
          </Col>
          <Col xs={24} xl={15}>
            <Card size="small" title="创建运营员 / 网格员">
              <Form form={staffForm} layout="vertical" onFinish={createStaff}>
                <Row gutter={12}>
                  <Col xs={24} md={12}>
                    <Form.Item name="username" label="登录账号" rules={[{ required: true, pattern: /^[a-zA-Z0-9._-]{3,32}$/ }]}>
                      <Input placeholder="3-32 位字母、数字、点、下划线或短横线" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="displayName" label="姓名 / 显示名称" rules={[{ required: true, min: 1, max: 40 }]}>
                      <Input placeholder="工作人员姓名" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 12, max: 128 }]}>
                      <Input.Password placeholder="至少 12 位，创建后请安全告知本人" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item
                      name="userId"
                      normalize={(value: string) => value.trim() || undefined}
                      label="关联已有居民账户（可选）"
                      tooltip="填写已完成微信授权的居民平台用户 ID，可让居民身份与网格员/运营员身份属于同一平台账户。"
                      rules={[{ pattern: /^[0-9a-f-]{36}$/i, message: '请输入完整的平台用户 UUID' }]}
                    >
                      <Input placeholder="留空则创建独立后台账户" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="role" label="角色" rules={[{ required: true }]}>
                      <Select
                        options={[
                          { value: 'grid_worker', label: '网格员' },
                          { value: 'operator', label: '运营员' },
                        ]}
                        placeholder="选择角色"
                      />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item name="communityIds" label="负责社区" rules={[{ required: true, type: 'array', min: 1 }]}>
                      <Select
                        mode="multiple"
                        allowClear
                        placeholder="选择一个或多个社区"
                        options={communities.map((item) => ({ value: item.id, label: item.name }))}
                      />
                    </Form.Item>
                  </Col>
                </Row>
                <Button type="primary" htmlType="submit" loading={saving} disabled={communities.length === 0}>
                  创建账户
                </Button>
              </Form>
            </Card>
          </Col>
        </Row>
      )}

      {isAdmin && (
        <Card size="small" title="后台账户">
          <Table
            rowKey="id"
            size="small"
            loading={loading}
            columns={staffColumns}
            dataSource={staff}
            pagination={{ pageSize: 8 }}
            scroll={{ x: 680 }}
          />
        </Card>
      )}

      <Card size="small" title={selectedCommunityId ? '社区居民' : '社区居民'} extra={<Tag>{residents.length} 条（最多展示 100 条）</Tag>}>
        {selectedCommunityId ? (
          <Table
            rowKey="id"
            size="small"
            loading={loading}
            columns={residentColumns}
            dataSource={residents}
            pagination={{ pageSize: 10 }}
            scroll={{ x: 520 }}
            locale={{ emptyText: '该社区暂时没有已关联的居民账户' }}
          />
        ) : (
          <Typography.Text type="secondary">请先选择社区；管理员可以先创建社区并分配网格员。</Typography.Text>
        )}
      </Card>
    </Space>
  )
}
