import { useEffect, useMemo, useRef, useState } from 'react'
import { PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { AuthenticatedSession } from '../services/auth'
import './users.css'

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

interface StaffFormValues {
  username: string
  displayName: string
  password: string
  role: 'operator' | 'grid_worker'
  userId?: string
  communityIds: string[]
}

const ROLE_LABELS = {
  admin: '管理员',
  operator: '运营员',
  grid_worker: '网格员',
} as const

const COMMUNITY_DRAWER_SIZE = 420
const STAFF_DRAWER_SIZE = 640

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

function describeError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

/**
 * Community/account administration (#91).
 *
 * Existing data is the primary content: communities stay in the scope picker,
 * staff and residents stay in their tables. The two write operations that
 * really exist on the API live in Drawers so their forms no longer take over
 * the working area. Nothing here invents edit/disable/delete operations — the
 * server only exposes creation today.
 */
export function UsersPage({ session }: UsersPageProps) {
  const { message, modal } = AntdApp.useApp()
  const [communityForm] = Form.useForm<{ name: string }>()
  const [staffForm] = Form.useForm<StaffFormValues>()
  const communityTriggerRef = useRef<HTMLButtonElement>(null)
  const staffTriggerRef = useRef<HTMLButtonElement>(null)
  const [communities, setCommunities] = useState<Community[]>([])
  const [staff, setStaff] = useState<StaffAccount[]>([])
  const [residents, setResidents] = useState<Resident[]>([])
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | undefined>(
    session.staff.communities[0]?.id,
  )
  const [communitiesLoading, setCommunitiesLoading] = useState(true)
  const [staffLoading, setStaffLoading] = useState(false)
  const [residentsLoading, setResidentsLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [communityDrawerOpen, setCommunityDrawerOpen] = useState(false)
  const [staffDrawerOpen, setStaffDrawerOpen] = useState(false)
  const [communitySaving, setCommunitySaving] = useState(false)
  const [staffSaving, setStaffSaving] = useState(false)
  const [communitySubmitError, setCommunitySubmitError] = useState<string | null>(null)
  const [staffSubmitError, setStaffSubmitError] = useState<string | null>(null)
  // Guards synchronous double clicks that can land before `saving` re-renders.
  const communitySubmitting = useRef(false)
  const staffSubmitting = useRef(false)
  const isAdmin = session.staff.role === 'admin'

  async function fetchCommunities(): Promise<Community[]> {
    const result = await apiRequest<{ items: Community[] }>('/api/admin/communities')
    return result.items
  }

  async function fetchStaff(): Promise<StaffAccount[]> {
    const result = await apiRequest<{ items: StaffAccount[] }>('/api/admin/staff')
    return result.items
  }

  function applyCommunities(items: Community[]) {
    setCommunities(items)
    setSelectedCommunityId((current) =>
      current && items.some((item) => item.id === current) ? current : items[0]?.id,
    )
  }

  async function loadData() {
    setCommunitiesLoading(true)
    setStaffLoading(isAdmin)
    setPageError(null)
    try {
      applyCommunities(await fetchCommunities())
      if (isAdmin) setStaff(await fetchStaff())
    } catch (cause) {
      setPageError(describeError(cause, '无法读取账户和社区信息'))
    } finally {
      setCommunitiesLoading(false)
      setStaffLoading(false)
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
    setResidentsLoading(true)
    apiRequest<{ items: Resident[] }>(
      `/api/crm/residents?communityId=${encodeURIComponent(selectedCommunityId)}`,
    )
      .then((result) => {
        if (active) setResidents(result.items)
      })
      .catch((cause: unknown) => {
        if (active) setPageError(describeError(cause, '无法读取社区居民'))
      })
      .finally(() => {
        if (active) setResidentsLoading(false)
      })
    return () => {
      active = false
    }
  }, [selectedCommunityId])

  function openCommunityDrawer() {
    if (!isAdmin) return
    setCommunitySubmitError(null)
    setCommunityDrawerOpen(true)
  }

  function openStaffDrawer() {
    if (!isAdmin) return
    setStaffSubmitError(null)
    setStaffDrawerOpen(true)
  }

  function returnFocusToCommunityTrigger() {
    // A confirming modal can finish its own focus restore after the Drawer has
    // gone; run at the end of the frame so the trigger keeps keyboard focus.
    // preventScroll keeps the list where the operator left it.
    window.setTimeout(() => communityTriggerRef.current?.focus({ preventScroll: true }), 80)
  }

  function returnFocusToStaffTrigger() {
    window.setTimeout(() => staffTriggerRef.current?.focus({ preventScroll: true }), 80)
  }

  function requestCloseCommunityDrawer() {
    if (communitySaving) return
    if (!communityForm.isFieldsTouched()) {
      setCommunityDrawerOpen(false)
      return
    }
    modal.confirm({
      title: '放弃未保存的内容？',
      content: '关闭后，已填写的社区信息不会保存。',
      okText: '放弃并关闭',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: () => setCommunityDrawerOpen(false),
      afterClose: returnFocusToCommunityTrigger,
    })
  }

  function requestCloseStaffDrawer() {
    if (staffSaving) return
    if (!staffForm.isFieldsTouched()) {
      setStaffDrawerOpen(false)
      return
    }
    modal.confirm({
      title: '放弃未保存的内容？',
      content: '关闭后，已填写的后台账户信息不会保存。',
      okText: '放弃并关闭',
      cancelText: '继续编辑',
      okButtonProps: { danger: true },
      onOk: () => setStaffDrawerOpen(false),
      afterClose: returnFocusToStaffTrigger,
    })
  }

  function handleCommunityDrawerAfterOpenChange(open: boolean) {
    if (open) return
    communityForm.resetFields()
    setCommunitySubmitError(null)
    returnFocusToCommunityTrigger()
  }

  function handleStaffDrawerAfterOpenChange(open: boolean) {
    if (open) return
    staffForm.resetFields()
    setStaffSubmitError(null)
    returnFocusToStaffTrigger()
  }

  async function refreshCommunitiesAfterCreate(createdId: string) {
    setCommunitiesLoading(true)
    try {
      const items = await fetchCommunities()
      setCommunities(items)
      setSelectedCommunityId((current) => {
        if (current && items.some((item) => item.id === current)) return current
        if (items.some((item) => item.id === createdId)) return createdId
        return items[0]?.id
      })
    } catch (cause) {
      // The create succeeded; only the follow-up read failed. Keep the previous
      // selection instead of inventing a row, and ask for an explicit refresh.
      setPageError(describeError(cause, '社区已创建，但刷新社区列表失败，请点击刷新重试'))
    } finally {
      setCommunitiesLoading(false)
    }
  }

  async function refreshStaffAfterCreate() {
    setStaffLoading(true)
    try {
      setStaff(await fetchStaff())
    } catch (cause) {
      setPageError(describeError(cause, '账户已创建，但刷新后台账户列表失败，请点击刷新重试'))
    } finally {
      setStaffLoading(false)
    }
  }

  async function createCommunity(values: { name: string }) {
    if (!isAdmin || communitySubmitting.current) return
    // The server stores the trimmed name; validate and send the same value so
    // surrounding spaces cannot slip past the client into a generic 400.
    const name = values.name.trim()
    communitySubmitting.current = true
    setCommunitySaving(true)
    setCommunitySubmitError(null)
    try {
      const created = await apiRequest<Community>('/api/admin/communities', {
        method: 'POST',
        headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ name }),
      })
      // Close first so the page never hides a successful create behind a stale
      // form error; the list is refreshed right after. The new community is
      // selected only after the re-read confirms it, so a failed refresh cannot
      // leave the picker showing an id that is not in its options.
      setCommunityDrawerOpen(false)
      message.success(`社区「${created.name}」已创建`)
      await refreshCommunitiesAfterCreate(created.id)
    } catch (cause) {
      setCommunitySubmitError(describeError(cause, '创建社区失败'))
    } finally {
      communitySubmitting.current = false
      setCommunitySaving(false)
    }
  }

  async function createStaff(values: StaffFormValues) {
    if (!isAdmin || staffSubmitting.current) return
    staffSubmitting.current = true
    setStaffSaving(true)
    setStaffSubmitError(null)
    try {
      const created = await apiRequest<StaffAccount>('/api/admin/staff', {
        method: 'POST',
        headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify(values),
      })
      setStaffDrawerOpen(false)
      message.success(`后台账户「${created.username}」已创建`)
      await refreshStaffAfterCreate()
    } catch (cause) {
      setStaffSubmitError(describeError(cause, '创建后台账户失败'))
    } finally {
      staffSubmitting.current = false
      setStaffSaving(false)
    }
  }

  const staffColumns: ColumnsType<StaffAccount> = useMemo(
    () => [
      { title: '登录账号', dataIndex: 'username', key: 'username' },
      {
        title: '姓名',
        dataIndex: 'displayName',
        key: 'displayName',
        render: (value: string | null) => value || '—',
      },
      {
        title: '角色',
        dataIndex: 'role',
        key: 'role',
        render: (role: StaffAccount['role']) => (
          <Tag color={role === 'grid_worker' ? 'blue' : 'green'}>{ROLE_LABELS[role]}</Tag>
        ),
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
        render: (status: StaffAccount['status']) => (
          <Tag color={status === 'active' ? 'success' : 'default'}>
            {status === 'active' ? '正常' : '已停用'}
          </Tag>
        ),
      },
    ],
    [],
  )

  const residentColumns: ColumnsType<Resident> = useMemo(
    () => [
      {
        title: '居民',
        dataIndex: 'displayName',
        key: 'displayName',
        render: (value: string | null) => value || '微信用户',
      },
      {
        title: '平台用户 ID',
        dataIndex: 'id',
        key: 'id',
        render: (value: string) => (
          <Typography.Text code copyable>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: '加入时间',
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (value: string) => new Date(value).toLocaleString('zh-CN'),
      },
    ],
    [],
  )

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }} className="users-page">
      {pageError && (
        <Alert type="error" showIcon title={pageError} closable onClose={() => setPageError(null)} />
      )}

      <Card
        size="small"
        title="社区范围"
        extra={
          <Space wrap>
            <Button size="small" onClick={() => void loadData()} loading={communitiesLoading}>
              刷新
            </Button>
            {isAdmin && (
              <Button
                ref={communityTriggerRef}
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                onClick={openCommunityDrawer}
              >
                新建社区
              </Button>
            )}
          </Space>
        }
      >
        <Space wrap>
          <Typography.Text type="secondary">当前账户可访问的社区：</Typography.Text>
          <Select
            style={{ minWidth: 220 }}
            value={selectedCommunityId}
            placeholder="选择社区"
            options={communities.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setSelectedCommunityId}
            loading={communitiesLoading}
          />
          <Tag color={isAdmin ? 'green' : 'blue'}>{ROLE_LABELS[session.staff.role]}</Tag>
          <Typography.Text type="secondary">{`共 ${communities.length} 个社区`}</Typography.Text>
          {!isAdmin && (
            <Typography.Text type="secondary">仅显示管理员分配给你的社区范围。</Typography.Text>
          )}
        </Space>
      </Card>

      {isAdmin && (
        <Card
          size="small"
          title="后台账户"
          extra={
            <Button
              ref={staffTriggerRef}
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={openStaffDrawer}
            >
              新增账户
            </Button>
          }
        >
          <Table
            rowKey="id"
            size="small"
            loading={staffLoading}
            columns={staffColumns}
            dataSource={staff}
            pagination={{ pageSize: 8 }}
            scroll={{ x: 680 }}
            locale={{ emptyText: '还没有后台账户' }}
          />
        </Card>
      )}

      <Card
        size="small"
        title="社区居民"
        extra={<Tag>{residents.length} 条（最多展示 100 条）</Tag>}
      >
        {selectedCommunityId ? (
          <Table
            rowKey="id"
            size="small"
            loading={residentsLoading}
            columns={residentColumns}
            dataSource={residents}
            pagination={{ pageSize: 10 }}
            scroll={{ x: 520 }}
            locale={{ emptyText: '该社区暂时没有已关联的居民账户' }}
          />
        ) : (
          <Typography.Text type="secondary">
            请先选择社区；管理员可以先创建社区并分配网格员。
          </Typography.Text>
        )}
      </Card>

      {isAdmin && (
        <>
          <Drawer
            title="新建社区"
            size={COMMUNITY_DRAWER_SIZE}
            open={communityDrawerOpen}
            onClose={requestCloseCommunityDrawer}
            rootClassName="users-drawer"
            destroyOnHidden
            focusable={{ focusTriggerAfterClose: false }}
            afterOpenChange={handleCommunityDrawerAfterOpenChange}
            footer={
              <div className="users-drawer-footer">
                <Button onClick={requestCloseCommunityDrawer} disabled={communitySaving}>
                  取消
                </Button>
                <Button
                  type="primary"
                  loading={communitySaving}
                  onClick={() => communityForm.submit()}
                >
                  创建社区
                </Button>
              </div>
            }
          >
            {communitySubmitError ? (
              <Alert
                className="users-drawer-error"
                type="error"
                showIcon
                title="创建社区失败"
                description={communitySubmitError}
              />
            ) : null}
            <Form form={communityForm} layout="vertical" onFinish={createCommunity}>
              <Form.Item
                name="name"
                label="社区名称"
                rules={[
                  {
                    validator: (_, value: string | undefined) => {
                      const name = (value ?? '').trim()
                      if (!name) return Promise.reject(new Error('请填写社区名称'))
                      if (name.length < 2 || name.length > 60) {
                        return Promise.reject(new Error('社区名称需为 2-60 个字符'))
                      }
                      return Promise.resolve()
                    },
                  },
                ]}
              >
                <Input placeholder="例如：幸福社区" maxLength={60} autoFocus />
              </Form.Item>
            </Form>
          </Drawer>

          <Drawer
            title="新增后台账户"
            size={STAFF_DRAWER_SIZE}
            open={staffDrawerOpen}
            onClose={requestCloseStaffDrawer}
            rootClassName="users-drawer"
            destroyOnHidden
            focusable={{ focusTriggerAfterClose: false }}
            afterOpenChange={handleStaffDrawerAfterOpenChange}
            footer={
              <div className="users-drawer-footer">
                <Button onClick={requestCloseStaffDrawer} disabled={staffSaving}>
                  取消
                </Button>
                <Button
                  type="primary"
                  loading={staffSaving}
                  disabled={communities.length === 0}
                  onClick={() => staffForm.submit()}
                >
                  创建账户
                </Button>
              </div>
            }
          >
            {staffSubmitError ? (
              <Alert
                className="users-drawer-error"
                type="error"
                showIcon
                title="创建后台账户失败"
                description={staffSubmitError}
              />
            ) : null}
            {communities.length === 0 ? (
              <Alert
                className="users-drawer-hint"
                type="warning"
                showIcon
                title="请先创建社区"
                description="后台账户必须至少负责一个社区；创建社区后即可继续新增账户。"
              />
            ) : null}
            <Form form={staffForm} layout="vertical" onFinish={createStaff}>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="username"
                    label="登录账号"
                    rules={[
                      { required: true, message: '请填写登录账号' },
                      {
                        pattern: /^[a-zA-Z0-9._-]{3,32}$/,
                        message: '登录账号需为 3-32 位字母、数字、点、下划线或短横线',
                      },
                    ]}
                  >
                    <Input placeholder="3-32 位字母、数字、点、下划线或短横线" autoFocus />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="displayName"
                    label="姓名 / 显示名称"
                    rules={[
                      { required: true, whitespace: true, message: '请填写姓名' },
                      { min: 1, max: 40, message: '姓名需为 1-40 个字符' },
                    ]}
                  >
                    <Input placeholder="工作人员姓名" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="password"
                    label="初始密码"
                    rules={[
                      { required: true, message: '请设置初始密码' },
                      { min: 12, max: 128, message: '初始密码需为 12-128 位' },
                    ]}
                  >
                    <Input.Password placeholder="至少 12 位，创建后请安全告知本人" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="userId"
                    normalize={(value: string) => value.trim() || undefined}
                    label="关联已有居民账户（可选）"
                    tooltip="填写已完成微信授权的居民平台用户 ID，可让居民身份与网格员/运营员身份属于同一平台账户。"
                    rules={[
                      {
                        pattern: /^[0-9a-f-]{36}$/i,
                        message: '请输入完整的平台用户 UUID',
                      },
                    ]}
                  >
                    <Input placeholder="留空则创建独立后台账户" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="role"
                    label="角色"
                    rules={[{ required: true, message: '请选择角色' }]}
                  >
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
                  <Form.Item
                    name="communityIds"
                    label="负责社区"
                    rules={[
                      { required: true, type: 'array', min: 1, message: '请至少选择一个社区' },
                    ]}
                  >
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="选择一个或多个社区"
                      options={communities.map((item) => ({ value: item.id, label: item.name }))}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Drawer>
        </>
      )}
    </Space>
  )
}
