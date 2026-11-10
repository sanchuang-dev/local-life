import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Avatar,
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import { EnvironmentOutlined, PlusOutlined, UserAddOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import {
  CRM_ROUTES,
  residentDirectoryResponseSchema,
  type ResidentDirectoryEntry,
  type CommunityLocation,
} from '@sanchuang-dev/local-life-contracts'
import type { AuthenticatedSession } from '../services/auth'
import { TencentLocationPicker } from '../components/TencentLocationPicker'
import './users.css'

interface Community {
  id: string
  name: string
  address?: string | null
  latitudeGcj02?: number | null
  longitudeGcj02?: number | null
}

interface StaffAccount {
  id: string
  username: string
  displayName: string | null
  role: 'admin' | 'operator' | 'grid_worker'
  status: 'active' | 'disabled'
  communities: Community[]
}

interface UsersPageProps {
  session: AuthenticatedSession
}

interface CommunityFormValues {
  name: string
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

const COMMUNITY_FORM_ID = 'll-ui-007-create-community-form'
const STAFF_FORM_ID = 'll-ui-007-create-staff-form'

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
  const { modal, message } = AntdApp.useApp()
  const [communityForm] = Form.useForm<CommunityFormValues>()
  const [staffForm] = Form.useForm<StaffFormValues>()
  const [communities, setCommunities] = useState<Community[]>([])
  const [staff, setStaff] = useState<StaffAccount[]>([])
  const [residents, setResidents] = useState<ResidentDirectoryEntry[]>([])
  const [residentTotal, setResidentTotal] = useState(0)
  const [residentPage, setResidentPage] = useState(1)
  const [residentPageSize, setResidentPageSize] = useState(20)
  const [residentSearchDraft, setResidentSearchDraft] = useState('')
  const [residentKeyword, setResidentKeyword] = useState('')
  const [residentReload, setResidentReload] = useState(0)
  const [residentLoading, setResidentLoading] = useState(false)
  const [residentError, setResidentError] = useState<string | null>(null)
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | undefined>(
    session.staff.communities[0]?.id,
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [communityDrawerOpen, setCommunityDrawerOpen] = useState(false)
  const [staffDrawerOpen, setStaffDrawerOpen] = useState(false)
  const [communityError, setCommunityError] = useState<string | null>(null)
  const [draftLocation, setDraftLocation] = useState<CommunityLocation | null>(null)
  const [mapPicker, setMapPicker] = useState<{
    key: string
    mode: 'create' | 'update'
    communityId?: string
    initialLocation?: CommunityLocation
  } | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [locationSaving, setLocationSaving] = useState(false)
  const [staffError, setStaffError] = useState<string | null>(null)
  // Ref-guarded so a fast double click can never fire the same POST twice,
  // even before React flushes the disabled/loading state to the button.
  const savingRef = useRef(false)
  const communityButtonRef = useRef<HTMLButtonElement>(null)
  const staffButtonRef = useRef<HTMLButtonElement>(null)
  const isAdmin = session.staff.role === 'admin'

  /**
   * Re-reads only the community list. Keeping the current selection when it is
   * still valid means creating a community never moves the resident table or
   * the scroll position the operator was working in.
   */
  async function refreshCommunities() {
    const result = await apiRequest<{ items: Community[] }>('/api/admin/communities')
    setCommunities(result.items)
    setSelectedCommunityId((previous) => {
      if (previous && result.items.some((item) => item.id === previous)) return previous
      return result.items[0]?.id
    })
  }

  async function refreshStaff() {
    const result = await apiRequest<{ items: StaffAccount[] }>('/api/admin/staff')
    setStaff(result.items)
  }

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      await refreshCommunities()
      if (isAdmin) await refreshStaff()
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
      setResidentTotal(0)
      setResidentLoading(false)
      setResidentError(null)
      return
    }
    let active = true
    const controller = new AbortController()
    setResidentLoading(true)
    setResidentError(null)
    // Never show another community/page's old rows while this request loads.
    setResidents([])

    const params = new URLSearchParams({
      communityId: selectedCommunityId,
      page: String(residentPage),
      pageSize: String(residentPageSize),
    })
    if (residentKeyword) params.set('keyword', residentKeyword)
    void apiRequest<unknown>(`/api${CRM_ROUTES.residentList}?${params.toString()}`, {
      signal: controller.signal,
    }).then((raw) => {
      if (!active) return
      const result = residentDirectoryResponseSchema.parse(raw)
      setResidents(result.items)
      setResidentTotal(result.total)
      // When entries are removed concurrently, restore a valid page.
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize))
      if (residentPage > lastPage) setResidentPage(lastPage)
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return
      setResidentTotal(0)
      setResidentError(cause instanceof Error ? cause.message : '无法读取社区居民')
    }).finally(() => {
      if (active) setResidentLoading(false)
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [selectedCommunityId, residentPage, residentPageSize, residentKeyword, residentReload])

  function changeResidentCommunity(communityId: string) {
    setSelectedCommunityId(communityId)
    setResidentPage(1)
    setResidentKeyword('')
    setResidentSearchDraft('')
    setResidentTotal(0)
    setResidents([])
    setResidentError(null)
  }

  function searchResidents(value: string) {
    const keyword = value.trim()
    setResidentSearchDraft(keyword)
    setResidentPage(1)
    if (residentKeyword === keyword) setResidentReload((previous) => previous + 1)
    else setResidentKeyword(keyword)
  }

  function openCommunityDrawer() {
    setCommunityError(null)
    setDraftLocation(null)
    setCommunityDrawerOpen(true)
  }

  async function openMapPicker(mode: 'create' | 'update') {
    if (mapLoading) return
    const selectedCommunity = mode === 'update'
      ? communities.find((item) => item.id === selectedCommunityId)
      : null
    if (mode === 'update' && !selectedCommunity) return
    setMapLoading(true)
    try {
      const config = await apiRequest<{ available: boolean; key?: string }>('/api/admin/map-picker-config')
      if (!config.available || !config.key) {
        throw new Error('腾讯地图尚未配置，请先在 API 服务设置 TENCENT_MAP_PICKER_KEY')
      }
      const initialLocation = mode === 'create'
        ? draftLocation ?? undefined
        : selectedCommunity?.latitudeGcj02 != null && selectedCommunity.longitudeGcj02 != null
          ? {
              address: selectedCommunity.address || selectedCommunity.name,
              latitude: selectedCommunity.latitudeGcj02,
              longitude: selectedCommunity.longitudeGcj02,
            }
          : undefined
      setMapPicker({
        key: config.key,
        mode,
        ...(selectedCommunity ? { communityId: selectedCommunity.id } : {}),
        ...(initialLocation ? { initialLocation } : {}),
      })
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '无法打开腾讯地图')
    } finally {
      setMapLoading(false)
    }
  }

  async function acceptMapLocation(location: CommunityLocation) {
    const target = mapPicker
    setMapPicker(null)
    if (!target) return
    if (target.mode === 'create') {
      setDraftLocation(location)
      return
    }
    if (!target.communityId) return
    setLocationSaving(true)
    try {
      await apiRequest(`/api/admin/communities/${encodeURIComponent(target.communityId)}/location`, {
        method: 'PATCH',
        headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify(location),
      })
      await refreshCommunities()
      message.success('社区位置已保存')
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '社区位置保存失败')
    } finally {
      setLocationSaving(false)
    }
  }

  function openStaffDrawer() {
    setStaffError(null)
    setStaffDrawerOpen(true)
  }

  /**
   * A form counts as dirty once any registered field holds typed content, even
   * if the user never blurred it (rc-field-form marks touched on change, but
   * values are the ground truth for "would closing lose input?").
   */
  function hasDraftValues(values: object): boolean {
    return Object.values(values).some((value) => {
      if (Array.isArray(value)) return value.length > 0
      return typeof value === 'string' && value.trim().length > 0
    })
  }

  /**
   * Dirty-guarded close shared by the X button, mask click and 取消: only a
   * form with real edits asks for confirmation, so a clean close never nags
   * and an accidental click can never silently drop typed input. Closing
   * never submits; submission only happens through the footer submit button.
   */
  function requestCloseCommunityDrawer() {
    if (savingRef.current) return
    if (!draftLocation && !communityForm.isFieldsTouched() && !hasDraftValues(communityForm.getFieldsValue())) {
      setCommunityDrawerOpen(false)
      return
    }
    modal.confirm({
      title: '放弃已填写的社区信息？',
      content: '抽屉关闭后，本次填写的内容将被清空，且不会创建社区。',
      okText: '放弃并关闭',
      cancelText: '继续填写',
      onOk: () => {
        communityForm.resetFields()
        setDraftLocation(null)
        setCommunityError(null)
        setCommunityDrawerOpen(false)
      },
    })
  }

  function requestCloseStaffDrawer() {
    if (savingRef.current) return
    if (!staffForm.isFieldsTouched() && !hasDraftValues(staffForm.getFieldsValue())) {
      setStaffDrawerOpen(false)
      return
    }
    modal.confirm({
      title: '放弃已填写的账户信息？',
      content: '抽屉关闭后，本次填写的内容将被清空，且不会创建后台账户。',
      okText: '放弃并关闭',
      cancelText: '继续填写',
      onOk: () => {
        staffForm.resetFields()
        setStaffError(null)
        setStaffDrawerOpen(false)
      },
    })
  }

  async function createCommunity(values: CommunityFormValues) {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setCommunityError(null)
    try {
      await apiRequest<Community>('/api/admin/communities', {
        method: 'POST',
        headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ ...values, ...(draftLocation ? { location: draftLocation } : {}) }),
      })
    } catch (cause) {
      // 失败：提示留在抽屉内，输入保留，操作者可以修正后重试。
      setCommunityError(cause instanceof Error ? cause.message : '创建社区失败')
      return
    } finally {
      savingRef.current = false
      setSaving(false)
    }
    communityForm.resetFields()
    setDraftLocation(null)
    setCommunityDrawerOpen(false)
    message.success('社区已创建')
    // Only the community list changed; staff and resident context stay put.
    try {
      await refreshCommunities()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `社区已创建，但列表刷新失败：${cause.message}`
          : '社区已创建，但列表刷新失败，请手动刷新',
      )
    }
  }

  async function createStaff(values: StaffFormValues) {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setStaffError(null)
    try {
      await apiRequest<StaffAccount>('/api/admin/staff', {
        method: 'POST',
        headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify(values),
      })
    } catch (cause) {
      setStaffError(cause instanceof Error ? cause.message : '创建后台账户失败')
      return
    } finally {
      savingRef.current = false
      setSaving(false)
    }
    staffForm.resetFields()
    setStaffDrawerOpen(false)
    message.success('后台账户已创建')
    // Only the account list changed; the selected community and residents stay.
    try {
      await refreshStaff()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `后台账户已创建，但列表刷新失败：${cause.message}`
          : '后台账户已创建，但列表刷新失败，请手动刷新',
      )
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

  const residentColumns: ColumnsType<ResidentDirectoryEntry> = useMemo(
    () => [
      {
        title: '居民',
        key: 'resident',
        render: (_value: unknown, resident: ResidentDirectoryEntry) => (
          <Space size={8}>
            <Avatar src={resident.wechatAvatarUrl || undefined}>
              {resident.displayName.slice(0, 1)}
            </Avatar>
            <div>
              <Typography.Text strong>{resident.displayName}</Typography.Text>
              {resident.wechatNickname?.trim() && resident.localDisplayName?.trim()
                && resident.wechatNickname.trim() !== resident.localDisplayName.trim() ? (
                  <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    本地：{resident.localDisplayName}
                  </Typography.Text></div>
                ) : null}
            </div>
          </Space>
        ),
      },
      {
        title: '微信资料',
        key: 'wechatProfile',
        render: (_value: unknown, resident: ResidentDirectoryEntry) => (
          <Tag color={resident.profileAuthorizedAt ? 'green' : 'default'}>
            {resident.profileAuthorizedAt ? '已授权' : '未授权'}
          </Tag>
        ),
      },
      { title: '平台用户 ID', dataIndex: 'id', key: 'id', render: (value: string) => <Typography.Text code copyable>{value}</Typography.Text> },
      { title: '加入社区', dataIndex: 'joinedAt', key: 'joinedAt', render: (value: string) => new Date(value).toLocaleString('zh-CN') },
      { title: '注册时间', dataIndex: 'createdAt', key: 'createdAt', render: (value: string) => new Date(value).toLocaleString('zh-CN') },
    ],
    [],
  )

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {error && <Alert type="error" showIcon message={error} />}
      <Card
        size="small"
        title="社区范围"
        extra={
          <Space wrap className="users-page-actions">
            {isAdmin && (
              <>
                <Button
                  ref={communityButtonRef}
                  type="primary"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={openCommunityDrawer}
                >
                  新建社区
                </Button>
                <Button
                  ref={staffButtonRef}
                  size="small"
                  icon={<UserAddOutlined />}
                  onClick={openStaffDrawer}
                  disabled={communities.length === 0}
                  title={communities.length === 0 ? '请先创建社区，再分配后台账户' : undefined}
                >
                  新增账户
                </Button>
              </>
            )}
            <Button size="small" onClick={() => { void loadData(); setResidentReload((n) => n + 1) }} loading={loading}>刷新</Button>
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
            onChange={changeResidentCommunity}
          />
          {isAdmin && selectedCommunityId && (
            <Button
              size="small"
              icon={<EnvironmentOutlined />}
              onClick={() => { void openMapPicker('update') }}
              loading={mapLoading || locationSaving}
            >
              {communities.find((item) => item.id === selectedCommunityId)?.latitudeGcj02 == null
                ? '设置社区位置'
                : '修改社区位置'}
            </Button>
          )}
          <Tag color={isAdmin ? 'green' : 'blue'}>{ROLE_LABELS[session.staff.role]}</Tag>
          {!isAdmin && <Typography.Text type="secondary">仅显示管理员分配给你的社区范围。</Typography.Text>}
        </Space>
        {communities.find((item) => item.id === selectedCommunityId)?.address && (
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
            社区服务点：{communities.find((item) => item.id === selectedCommunityId)?.address}
          </Typography.Paragraph>
        )}
      </Card>

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

      <Card size="small" title="社区居民" extra={<Tag>{residentTotal} 位居民</Tag>}>
        {selectedCommunityId ? (
          <>
            <Space wrap style={{ width: '100%', marginBottom: 12 }}>
              <Input.Search
                aria-label="搜索居民"
                placeholder="搜索微信昵称、本地名称或平台 UUID"
                value={residentSearchDraft}
                onChange={(event) => {
                  setResidentSearchDraft(event.target.value)
                  if (!event.target.value && residentKeyword) searchResidents('')
                }}
                onSearch={searchResidents}
                allowClear
                maxLength={80}
                enterButton="搜索"
                style={{ width: 'min(100%, 380px)' }}
              />
            </Space>
            {residentError && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 12 }}
                message="居民目录加载失败"
                description={residentError}
                action={<Button size="small" onClick={() => setResidentReload((n) => n + 1)}>重试</Button>}
              />
            )}
            <Table
              rowKey="id"
              size="small"
              loading={loading || residentLoading}
              columns={residentColumns}
              dataSource={residents}
              pagination={{
                current: residentPage,
                pageSize: residentPageSize,
                total: residentTotal,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50'],
                showTotal: (total) => `共 ${total} 位居民`,
                onChange: (page, size) => {
                  setResidentPage(size !== residentPageSize ? 1 : page)
                  setResidentPageSize(size)
                },
              }}
              scroll={{ x: 790 }}
              locale={{
                emptyText: residentKeyword ? '没有找到匹配的居民' : '该社区暂时没有已关联的居民账户',
              }}
            />
          </>
        ) : (
          <Typography.Text type="secondary">请先选择社区；管理员可以先创建社区并分配网格员。</Typography.Text>
        )}
      </Card>

      {isAdmin && (
        <Drawer
          title="新建社区"
          size={400}
          open={communityDrawerOpen}
          onClose={requestCloseCommunityDrawer}
          rootClassName="users-drawer"
          afterOpenChange={(open) => {
            // 焦点回到触发按钮；preventScroll 保证关闭抽屉不会把页面拉回顶部，
            // 列表上下文与滚动位置仍然属于操作者。
            if (!open) communityButtonRef.current?.focus({ preventScroll: true })
          }}
          footer={
            <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button onClick={requestCloseCommunityDrawer} disabled={saving}>取消</Button>
              <Button type="primary" htmlType="submit" form={COMMUNITY_FORM_ID} loading={saving}>
                创建社区
              </Button>
            </Space>
          }
        >
          <Form<CommunityFormValues>
            id={COMMUNITY_FORM_ID}
            form={communityForm}
            layout="vertical"
            onFinish={createCommunity}
          >
            {communityError && (
              <Alert
                style={{ marginBottom: 16 }}
                type="error"
                showIcon
                message="创建社区失败"
                description={communityError}
              />
            )}
            <Form.Item
              name="name"
              label="社区名称"
              rules={[
                { required: true, whitespace: true, message: '请填写社区名称' },
                {
                  // The API trims before enforcing 2-60, so validate the trimmed value.
                  validator: async (_rule, value: string | undefined) => {
                    const trimmed = (value ?? '').trim()
                    if (trimmed.length < 2 || trimmed.length > 60) {
                      throw new Error('社区名称长度需为 2-60 个字符')
                    }
                  },
                },
              ]}
            >
              <Input placeholder="例如：幸福社区" maxLength={60} autoFocus />
            </Form.Item>
            <Form.Item label="社区服务点位置（可稍后补录）">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Button
                  icon={<EnvironmentOutlined />}
                  onClick={() => { void openMapPicker('create') }}
                  loading={mapLoading}
                >
                  在腾讯地图上选点
                </Button>
                {draftLocation && (
                  <Alert
                    type="success"
                    showIcon
                    message="已选择位置"
                    description={draftLocation.address}
                  />
                )}
              </Space>
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              创建后可分配运营员或网格员，社区位置也可随时修改；不会因此改变居民归属。
            </Typography.Text>
          </Form>
        </Drawer>
      )}

      <TencentLocationPicker
        open={mapPicker !== null}
        apiKey={mapPicker?.key ?? ''}
        initialLocation={mapPicker?.initialLocation}
        onCancel={() => setMapPicker(null)}
        onSelect={(location) => { void acceptMapLocation(location) }}
      />

      {isAdmin && (
        <Drawer
          title="新增后台账户（运营员 / 网格员）"
          size={560}
          open={staffDrawerOpen}
          onClose={requestCloseStaffDrawer}
          rootClassName="users-drawer"
          afterOpenChange={(open) => {
            if (!open) staffButtonRef.current?.focus({ preventScroll: true })
          }}
          footer={
            <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button onClick={requestCloseStaffDrawer} disabled={saving}>取消</Button>
              <Button type="primary" htmlType="submit" form={STAFF_FORM_ID} loading={saving}>
                创建账户
              </Button>
            </Space>
          }
        >
          <Form<StaffFormValues>
            id={STAFF_FORM_ID}
            form={staffForm}
            layout="vertical"
            onFinish={createStaff}
          >
            {staffError && (
              <Alert
                style={{ marginBottom: 16 }}
                type="error"
                showIcon
                message="创建后台账户失败"
                description={staffError}
              />
            )}
            <Form.Item
              name="username"
              label="登录账号"
              normalize={(value: string) => value?.trim()}
              rules={[
                { required: true, message: '请填写登录账号' },
                { pattern: /^[a-zA-Z0-9._-]{3,32}$/, message: '3-32 位字母、数字、点、下划线或短横线' },
              ]}
            >
              <Input
                placeholder="3-32 位字母、数字、点、下划线或短横线"
                autoFocus
              />
            </Form.Item>
            <Form.Item
              name="displayName"
              label="姓名 / 显示名称"
              rules={[
                { required: true, whitespace: true, message: '请填写姓名' },
                { min: 1, max: 40, message: '姓名长度需为 1-40 个字符' },
              ]}
            >
              <Input placeholder="工作人员姓名" />
            </Form.Item>
            <Form.Item
              name="password"
              label="初始密码"
              rules={[
                { required: true, message: '请填写初始密码' },
                { min: 12, max: 128, message: '初始密码长度需为 12-128 位' },
              ]}
            >
              <Input.Password placeholder="至少 12 位，创建后请安全告知本人" />
            </Form.Item>
            <Form.Item
              name="userId"
              normalize={(value: string) => value?.trim() || undefined}
              label="关联已有居民账户（可选）"
              tooltip="填写已完成微信授权的居民平台用户 ID，可让居民身份与网格员/运营员身份属于同一平台账户。"
              rules={[{ pattern: /^[0-9a-f-]{36}$/i, message: '请输入完整的平台用户 UUID' }]}
            >
              <Input placeholder="留空则创建独立后台账户" />
            </Form.Item>
            <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
              <Select
                options={[
                  { value: 'grid_worker', label: '网格员' },
                  { value: 'operator', label: '运营员' },
                ]}
                placeholder="选择角色"
              />
            </Form.Item>
            <Form.Item
              name="communityIds"
              label="负责社区"
              rules={[{ required: true, type: 'array', min: 1, message: '请选择至少一个负责社区' }]}
            >
              <Select
                mode="multiple"
                allowClear
                placeholder="选择一个或多个社区"
                options={communities.map((item) => ({ value: item.id, label: item.name }))}
              />
            </Form.Item>
          </Form>
        </Drawer>
      )}
    </Space>
  )
}
