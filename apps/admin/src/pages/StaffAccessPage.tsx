import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, App as AntdApp, Button, Drawer, Form, Input, Result, Select, Space, Tag, Typography,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { AuthenticatedSession } from '../services/auth'
import {
  adminRequest, listManagedCommunities, listManagedStaff, STAFF_ROLE_LABELS,
  type ManagedCommunity, type ManagedStaff,
} from '../services/community-admin'
import { PageHeader } from '../components/PageHeader'
import { DataPanel, type PanelColumn, type PanelQuery } from '../shared/components/DataPanel'
import './communities.css'

interface Props { session: AuthenticatedSession }
interface AccountFilters { keyword: string; role?: string; status?: string }
interface AccountFormValues {
  username: string
  displayName: string
  password: string
  role: 'operator' | 'grid_worker'
  communityIds: string[]
  userId?: string
}
const STAFF_FORM_ID = 'll-create-backoffice-account-form'

export function StaffAccessPage({ session }: Props) {
  const { modal, message } = AntdApp.useApp()
  const [form] = Form.useForm<AccountFormValues>()
  const [staff, setStaff] = useState<ManagedStaff[]>([])
  const [communities, setCommunities] = useState<ManagedCommunity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState<PanelQuery<AccountFilters, 'username'>>({
    filters: { keyword: '' }, page: 1, pageSize: 20,
  })
  const [createOpen, setCreateOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const [detail, setDetail] = useState<ManagedStaff | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [accounts, scope] = await Promise.all([listManagedStaff(), listManagedCommunities()])
      setStaff(accounts.items)
      setCommunities(scope.items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '后台账户读取失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { if (session.staff.role === 'admin') void refresh() }, [session.staff.role])

  const filtered = useMemo(() => {
    const keyword = query.filters.keyword.trim().toLowerCase()
    const result = staff.filter((item) =>
      (!keyword || [item.username, item.displayName ?? ''].some((value) => value.toLowerCase().includes(keyword))) &&
      (!query.filters.role || item.role === query.filters.role) &&
      (!query.filters.status || item.status === query.filters.status))
    result.sort((a, b) => a.username.localeCompare(b.username))
    if (query.sort?.order === 'desc') result.reverse()
    return result
  }, [staff, query.filters.keyword, query.filters.role, query.filters.status, query.sort?.order])
  const rows = filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
  const columns: PanelColumn<ManagedStaff, 'username'>[] = [
    { key: 'username', title: '登录账号', dataIndex: 'username', sortKey: 'username',
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    { key: 'name', title: '显示名称', render: (_, person) => person.displayName || '—' },
    { key: 'role', title: '角色', render: (_, person) =>
      <Tag color={person.role === 'grid_worker' ? 'blue' : 'green'}>{STAFF_ROLE_LABELS[person.role]}</Tag> },
    { key: 'scope', title: '社区授权', render: (_, person) => person.role === 'admin'
      ? <Typography.Text type="secondary">全局管理</Typography.Text>
      : person.communities.length ? person.communities.map((item) => item.name).join('、') : '未分配' },
    { key: 'status', title: '状态', render: (_, person) =>
      <Tag color={person.status === 'active' ? 'success' : 'default'}>
        {person.status === 'active' ? '正常' : '停用'}
      </Tag> },
  ]

  const discard = () => {
    form.resetFields()
    setCreateError(null)
    setCreateOpen(false)
  }
  const closeCreate = () => {
    if (savingRef.current) return
    const values = form.getFieldsValue() as Partial<AccountFormValues>
    const dirty = form.isFieldsTouched() || Object.values(values).some((value) =>
      Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0)
    if (!dirty) { discard(); return }
    modal.confirm({
      title: '放弃已填写的账户信息？',
      content: '本次填写的账号资料将被清空，不会创建账户。',
      okText: '放弃并关闭', cancelText: '继续填写', onOk: discard,
    })
  }
  const createStaff = async (values: AccountFormValues) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setCreateError(null)
    try {
      await adminRequest('/api/admin/staff', {
        method: 'POST', headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify(values),
      })
      discard()
      message.success('后台账户已创建')
      await refresh()
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : '创建账户失败，请重试')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (session.staff.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="管理员与权限" description="后台账号及社区授权仅平台管理员可管理"/>
        <Result status="403" title="没有账号管理权限" subTitle="社区运营员和网格员只能访问已授权的业务功能。"/>
      </div>
    )
  }
  return (
    <div className="page">
      <PageHeader title="管理员与权限" description="管理后台账号及其角色、社区授权" />
      {error && <Alert type="error" showIcon title="账户目录读取失败" description={error}/>}
      <DataPanel<ManagedStaff, AccountFilters, 'username'>
        id="system-staff-access" label="后台账号列表" rowKey={(item) => item.id}
        query={query} onQueryChange={setQuery} initialFilters={{ keyword: '' }}
        data={{ rows, total: filtered.length, loading, ...(error ? { error: new Error(error) } : {}) }}
        filters={[
          { key: 'keyword', kind: 'text', label: '关键词', placeholder: '账号 / 姓名', width: 240 },
          { key: 'role', kind: 'select', label: '角色', width: 160, options: [
            { value: 'admin', label: '管理员' },
            { value: 'operator', label: '运营员' },
            { value: 'grid_worker', label: '网格员' },
          ] },
          { key: 'status', kind: 'status', label: '状态', options: [
            { value: 'active', label: '正常' }, { value: 'disabled', label: '停用' },
          ] },
        ]}
        columns={columns} onRefresh={() => void refresh()}
        toolbarExtra={<Button ref={createButtonRef} type="primary" icon={<PlusOutlined/>}
          disabled={!communities.length} onClick={() => { setCreateError(null); setCreateOpen(true) }}>
          新增账户
        </Button>}
        rowActions={(item) => [
          { key: 'detail', label: '查看', onClick: () => setDetail(item) },
        ]}
        renderCard={(item) => <Space orientation="vertical" size={4}>
          <Typography.Text strong>{item.displayName || item.username}</Typography.Text>
          <Typography.Text>{item.username} · {STAFF_ROLE_LABELS[item.role]}</Typography.Text>
          <Typography.Text type="secondary">{item.role === 'admin' ? '全部社区' : item.communities.map((c) => c.name).join('、') || '未分配社区'}</Typography.Text>
        </Space>}
      />
      <Drawer open={createOpen} title="新增后台账户" size={540} rootClassName="communities-drawer"
        onClose={closeCreate} afterOpenChange={(open) => {
          if (!open) createButtonRef.current?.focus({ preventScroll: true })
        }}
        footer={<Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button disabled={saving} onClick={closeCreate}>取消</Button>
          <Button type="primary" htmlType="submit" form={STAFF_FORM_ID} loading={saving}>创建账户</Button>
        </Space>}>
        <Form<AccountFormValues> form={form} id={STAFF_FORM_ID} layout="vertical" onFinish={createStaff}>
          {createError && <Alert type="error" showIcon title="创建账户失败" description={createError} style={{ marginBottom: 16 }}/>}
          <Form.Item name="username" label="登录账号" normalize={(value: string) => value?.trim()} rules={[
            { required: true, message: '请填写登录账号' },
            { pattern: /^[a-zA-Z0-9._-]{3,32}$/, message: '3-32 位字母、数字、点、下划线或短横线' },
          ]}>
            <Input placeholder="3-32 位字母、数字、点、下划线或短横线" autoFocus/>
          </Form.Item>
          <Form.Item name="displayName" label="姓名 / 显示名称" rules={[
            { required: true, whitespace: true, message: '请填写姓名' },
            { min: 1, max: 40, message: '姓名长度需为 1-40 个字符' },
          ]}>
            <Input placeholder="工作人员姓名"/>
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[
            { required: true, message: '请填写初始密码' },
            { min: 12, max: 128, message: '初始密码长度需为 12-128 位' },
          ]}>
            <Input.Password placeholder="至少 12 位，创建后请安全告知本人"/>
          </Form.Item>
          <Form.Item name="userId" normalize={(value: string) => value?.trim() || undefined}
            label="关联已有居民账户（可选）"
            tooltip="仅能关联已完成微信授权且尚无后台身份的居民用户。"
            rules={[{ pattern: /^[0-9a-f-]{36}$/i, message: '请输入完整的平台用户 UUID' }]}>
            <Input placeholder="留空则创建独立后台账户"/>
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select placeholder="选择角色" options={[
              { value: 'grid_worker', label: '网格员' }, { value: 'operator', label: '运营员' },
            ]}/>
          </Form.Item>
          <Form.Item name="communityIds" label="初始授权社区"
            rules={[{ required: true, type: 'array', min: 1, message: '请选择至少一个负责社区' }]}>
            <Select mode="multiple" allowClear placeholder="选择一个或多个社区"
              options={communities.map((item) => ({ value: item.id, label: item.name }))}/>
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            以后需要追加社区，可到「社区管理」中关联已有账号。角色与状态目前只读，不提供未经服务端支持的编辑操作。
          </Typography.Text>
        </Form>
      </Drawer>
      <Drawer open={detail !== null} title="后台账号详情" size={440}
        onClose={() => setDetail(null)} rootClassName="communities-drawer">
        {detail && <Space orientation="vertical">
          <Typography.Text strong>{detail.displayName || detail.username}</Typography.Text>
          <Typography.Text>登录账号：{detail.username}</Typography.Text>
          <Typography.Text>角色：{STAFF_ROLE_LABELS[detail.role]}</Typography.Text>
          <Typography.Text>状态：{detail.status === 'active' ? '正常' : '已停用'}</Typography.Text>
          <Typography.Text>授权社区：{detail.role === 'admin' ? '全局管理' : detail.communities.map((c) => c.name).join('、') || '未分配'}</Typography.Text>
        </Space>}
      </Drawer>
    </div>
  )
}
