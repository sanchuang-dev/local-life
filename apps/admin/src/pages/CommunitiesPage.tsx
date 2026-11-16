import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, App as AntdApp, Button, Drawer, Form, Input, Select, Space, Tag, Typography,
} from 'antd'
import { EnvironmentOutlined, PlusOutlined, UserAddOutlined } from '@ant-design/icons'
import type { CommunityLocation } from '@sanchuang-dev/local-life-contracts'
import type { AuthenticatedSession } from '../services/auth'
import {
  adminRequest, listManagedCommunities, listManagedStaff, STAFF_ROLE_LABELS,
  type ManagedCommunity, type ManagedStaff,
} from '../services/community-admin'
import { PageHeader } from '../components/PageHeader'
import { TencentLocationPicker } from '../components/TencentLocationPicker'
import {
  DataPanel, type PanelColumn, type PanelQuery,
} from '../shared/components/DataPanel'
import './communities.css'

interface Props { session: AuthenticatedSession }
interface CommunityFilters { keyword: string }
interface CommunityFormValues { name: string }
const CREATE_FORM_ID = 'll-create-community-form'

export function CommunitiesPage({ session }: Props) {
  const { message, modal } = AntdApp.useApp()
  const isAdmin = session.staff.role === 'admin'
  const [communities, setCommunities] = useState<ManagedCommunity[]>([])
  const [staff, setStaff] = useState<ManagedStaff[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refreshSequence = useRef(0)
  const [query, setQuery] = useState<PanelQuery<CommunityFilters, 'name'>>({
    filters: { keyword: '' }, page: 1, pageSize: 20,
  })
  const [communityForm] = Form.useForm<CommunityFormValues>()
  const [createOpen, setCreateOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const [draftLocation, setDraftLocation] = useState<CommunityLocation | null>(null)
  const [mapPicker, setMapPicker] = useState<{
    key: string
    appName: string
    mode: 'create' | 'update'
    communityId?: string
    initialLocation?: CommunityLocation
  } | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [locationSaving, setLocationSaving] = useState(false)
  const [linkCommunity, setLinkCommunity] = useState<ManagedCommunity | null>(null)
  const [linkStaffId, setLinkStaffId] = useState<string | undefined>()
  const [linkSaving, setLinkSaving] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    setLoading(true)
    setError(null)
    try {
      const [scope, accounts] = await Promise.all([
        listManagedCommunities(),
        isAdmin ? listManagedStaff() : Promise.resolve({ items: [] as ManagedStaff[] }),
      ])
      // The account may have changed role while an older request was pending.
      if (sequence !== refreshSequence.current) return
      setCommunities(scope.items)
      setStaff(accounts.items)
    } catch (cause) {
      if (sequence === refreshSequence.current) {
        setError(cause instanceof Error ? cause.message : '社区资料读取失败')
      }
    } finally {
      if (sequence === refreshSequence.current) setLoading(false)
    }
  }, [isAdmin])
  useEffect(() => {
    void refresh()
    return () => { refreshSequence.current += 1 }
  }, [refresh])

  const filtered = useMemo(() => {
    const keyword = query.filters.keyword.trim().toLowerCase()
    const result = communities.filter((item) =>
      !keyword || [item.name, item.address ?? ''].some((value) => value.toLowerCase().includes(keyword)))
    return query.sort?.order === 'desc' ? [...result].sort((a, b) => b.name.localeCompare(a.name, 'zh')) :
      [...result].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }, [communities, query.filters.keyword, query.sort?.order])
  const rows = filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
  const relatedStaff = (communityId: string) => staff.filter((account) =>
    account.role !== 'admin' && account.communities.some((community) => community.id === communityId))

  const columns: PanelColumn<ManagedCommunity, 'name'>[] = [
    { key: 'name', title: '社区名称', dataIndex: 'name', sortKey: 'name', render: (name: string) => <strong>{name}</strong> },
    {
      key: 'address', title: '服务点位置',
      render: (_, community) => community.address || <Typography.Text type="secondary">尚未设置</Typography.Text>,
    },
    {
      key: 'staff', title: '关联工作人员',
      render: (_, community) => isAdmin ? (
        <Space size={4} wrap>
          {relatedStaff(community.id).length
            ? relatedStaff(community.id).map((person) =>
              <Tag key={person.id} bordered={false}>
                {person.displayName || person.username} · {STAFF_ROLE_LABELS[person.role]}
              </Tag>)
            : <Typography.Text type="secondary">未关联</Typography.Text>}
        </Space>
      ) : <Typography.Text type="secondary">仅管理员可查看</Typography.Text>,
    },
  ]

  const openPicker = async (mode: 'create' | 'update', community?: ManagedCommunity) => {
    if (mapLoading) return
    setMapLoading(true)
    try {
      const config = await adminRequest<{ available: boolean; key?: string; appName?: string }>(
        '/api/admin/map-picker-config',
      )
      if (!config.available || !config.key || !config.appName) {
        throw new Error('请先在「系统管理 → 第三方配置」设置并启用腾讯地图 Key')
      }
      const currentLocation = community?.latitudeGcj02 != null && community.longitudeGcj02 != null
        ? {
          address: community.address || community.name,
          latitude: community.latitudeGcj02, longitude: community.longitudeGcj02,
        } : undefined
      setMapPicker({
        key: config.key, appName: config.appName, mode,
        ...(community ? { communityId: community.id } : {}),
        ...(mode === 'create' && draftLocation ? { initialLocation: draftLocation } : {}),
        ...(mode === 'update' && currentLocation ? { initialLocation: currentLocation } : {}),
      })
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '无法打开地图选点')
    } finally {
      setMapLoading(false)
    }
  }
  const acceptMapLocation = async (location: CommunityLocation) => {
    const target = mapPicker
    setMapPicker(null)
    if (!target) return
    if (target.mode === 'create') { setDraftLocation(location); return }
    if (!target.communityId) return
    setLocationSaving(true)
    try {
      await adminRequest(`/api/admin/communities/${encodeURIComponent(target.communityId)}/location`, {
        method: 'PATCH', headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify(location),
      })
      const result = await listManagedCommunities()
      setCommunities(result.items)
      message.success('社区位置已保存')
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '社区位置保存失败')
    } finally {
      setLocationSaving(false)
    }
  }

  const closeCreate = () => {
    if (savingRef.current) return
    const discard = () => {
      communityForm.resetFields()
      setDraftLocation(null)
      setCreateError(null)
      setCreateOpen(false)
    }
    if (!draftLocation && !communityForm.isFieldsTouched() && !communityForm.getFieldValue('name')) {
      discard()
      return
    }
    modal.confirm({
      title: '放弃已填写的社区信息？',
      content: '本次填写的资料将被清空，不会创建社区。',
      okText: '放弃并关闭', cancelText: '继续填写', onOk: discard,
    })
  }
  const createCommunity = async (values: CommunityFormValues) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setCreateError(null)
    try {
      await adminRequest('/api/admin/communities', {
        method: 'POST', headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ name: values.name, ...(draftLocation ? { location: draftLocation } : {}) }),
      })
      communityForm.resetFields()
      setDraftLocation(null)
      setCreateOpen(false)
      message.success('社区已创建')
      await refresh()
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : '创建社区失败，请重试')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const openLink = (community: ManagedCommunity) => {
    setLinkCommunity(community)
    setLinkStaffId(undefined)
    setLinkError(null)
  }
  const availableStaff = staff.filter((person) =>
    person.role !== 'admin' && person.status === 'active' &&
    !person.communities.some((item) => item.id === linkCommunity?.id))
  const linkExistingStaff = async () => {
    if (!linkCommunity || !linkStaffId || linkSaving) return
    setLinkSaving(true)
    setLinkError(null)
    try {
      await adminRequest(`/api/admin/communities/${encodeURIComponent(linkCommunity.id)}/staff`, {
        method: 'POST', headers: { 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ staffAccountId: linkStaffId }),
      })
      const result = await listManagedStaff()
      setStaff(result.items)
      setLinkCommunity(null)
      message.success('社区关联已建立')
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : '关联失败，请重试')
    } finally {
      setLinkSaving(false)
    }
  }

  return (
    <div className="page">
      <PageHeader title="社区管理" description="社区、服务点与关联工作人员" />
      {error && <Alert type="error" showIcon title="读取社区失败" description={error} />}
      <DataPanel<ManagedCommunity, CommunityFilters, 'name'>
        id="communities" label="社区列表" rowKey={(item) => item.id}
        query={query} onQueryChange={setQuery} initialFilters={{ keyword: '' }}
        data={{ rows, total: filtered.length, loading, ...(error ? { error: new Error(error) } : {}) }}
        filters={[{ key: 'keyword', label: '关键词', kind: 'text', placeholder: '搜索社区名称 / 地址', width: 260 }]}
        columns={columns} onRefresh={() => void refresh()}
        toolbarExtra={isAdmin ? (
          <Button ref={createButtonRef} type="primary" icon={<PlusOutlined/>}
            onClick={() => { setCreateError(null); setCreateOpen(true) }}>新建社区</Button>
        ) : undefined}
        rowActions={isAdmin ? (community) => [
          { key: 'location', label: '设置位置', onClick: () => { void openPicker('update', community) }, disabled: mapLoading || locationSaving },
          { key: 'staff', label: '关联人员', onClick: () => openLink(community) },
        ] : undefined}
        renderCard={(community) => (
          <Space orientation="vertical" size={4}>
            <Typography.Text strong>{community.name}</Typography.Text>
            <Typography.Text type="secondary">{community.address || '尚未设置服务点'}</Typography.Text>
            <Typography.Text type="secondary">
              {isAdmin ? `已关联 ${relatedStaff(community.id).length} 位工作人员` : '已授权社区'}
            </Typography.Text>
          </Space>
        )}
      />
      {isAdmin && <>
        <Drawer title="新建社区" size={420} open={createOpen} rootClassName="communities-drawer"
          onClose={closeCreate} afterOpenChange={(open) => {
            if (!open) createButtonRef.current?.focus({ preventScroll: true })
          }}
          footer={<Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={closeCreate} disabled={saving}>取消</Button>
            <Button type="primary" loading={saving} htmlType="submit" form={CREATE_FORM_ID}>创建社区</Button>
          </Space>}>
          <Form form={communityForm} id={CREATE_FORM_ID} layout="vertical" onFinish={createCommunity}>
            {createError && <Alert type="error" showIcon title="创建社区失败" description={createError} style={{ marginBottom: 16 }}/>}
            <Form.Item name="name" label="社区名称" rules={[
              { required: true, message: '请填写社区名称' },
              { validator: async (_rule, value: string | undefined) => {
                const name = (value ?? '').trim()
                if (name.length < 2 || name.length > 60) throw new Error('社区名称长度需为 2-60 个字符')
              } },
            ]}>
              <Input placeholder="例如：幸福社区" maxLength={60} autoFocus/>
            </Form.Item>
            <Form.Item label="社区服务点位置（可稍后补录）">
              <Space orientation="vertical">
                <Button icon={<EnvironmentOutlined/>} loading={mapLoading}
                  onClick={() => { void openPicker('create') }}>在腾讯地图上选点</Button>
                {draftLocation && <Tag color="success">已选择：{draftLocation.address}</Tag>}
              </Space>
            </Form.Item>
          </Form>
        </Drawer>
        <Drawer title={linkCommunity ? `关联工作人员 · ${linkCommunity.name}` : '关联工作人员'}
          open={linkCommunity !== null} size={440} rootClassName="communities-drawer"
          onClose={() => { if (!linkSaving) setLinkCommunity(null) }}
          footer={<Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setLinkCommunity(null)} disabled={linkSaving}>取消</Button>
            <Button type="primary" icon={<UserAddOutlined/>} disabled={!linkStaffId || linkSaving}
              loading={linkSaving} onClick={() => { void linkExistingStaff() }}>建立关联</Button>
          </Space>}>
          {linkError && <Alert type="error" showIcon title="关联失败" description={linkError} style={{ marginBottom: 16 }}/>}
          <Typography.Paragraph type="secondary">
            从系统管理中已创建的运营员或网格员选择。平台管理员拥有全局权限，无需关联。
          </Typography.Paragraph>
          <Select style={{ width: '100%' }} placeholder="选择已有工作人员"
            showSearch optionFilterProp="label" value={linkStaffId} onChange={setLinkStaffId}
            options={availableStaff.map((person) => ({
              value: person.id,
              label: `${person.displayName || person.username} · ${STAFF_ROLE_LABELS[person.role]} · ${person.username}`,
            }))}
            notFoundContent="暂无可关联账号，请先到「系统管理 → 管理员与权限」创建"/>
        </Drawer>
      </>}
      <TencentLocationPicker open={mapPicker !== null} apiKey={mapPicker?.key ?? ''}
        appName={mapPicker?.appName ?? ''} initialLocation={mapPicker?.initialLocation}
        onCancel={() => setMapPicker(null)}
        onSelect={(location) => { void acceptMapLocation(location) }}/>
    </div>
  )
}
