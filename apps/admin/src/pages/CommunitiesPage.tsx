import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, App as AntdApp, Button, Drawer, Form, Input, Select, Space, Tag, Typography,
} from 'antd'
import { EnvironmentOutlined, PlusOutlined, UserAddOutlined } from '@ant-design/icons'
import type { CommunityLocation } from '@sanchuang-dev/local-life-contracts'
import type { AuthenticatedSession } from '../services/auth'
import {
  adminRequest, listManagedCommunities, listManagedStaff,
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
  const [staffDrawer, setStaffDrawer] = useState<{
    community: ManagedCommunity
    mode: 'grid' | 'operator'
  } | null>(null)
  const [selectedStaffId, setSelectedStaffId] = useState<string | undefined>()
  const [staffSaving, setStaffSaving] = useState(false)
  const [staffError, setStaffError] = useState<string | null>(null)

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
  const gridWorkerFor = (communityId: string) =>
    staff.find((account) =>
      account.role === 'grid_worker' &&
      account.communities.some((community) => community.id === communityId))
  const operatorsFor = (communityId: string) => staff.filter((account) =>
    account.role === 'operator' &&
    account.communities.some((community) => community.id === communityId))

  const columns: PanelColumn<ManagedCommunity, 'name'>[] = [
    { key: 'name', title: '社区名称', dataIndex: 'name', sortKey: 'name', render: (name: string) => <strong>{name}</strong> },
    {
      key: 'address', title: '服务点位置',
      render: (_, community) => community.address || <Typography.Text type="secondary">尚未设置</Typography.Text>,
    },
    {
      key: 'gridWorker', title: '经营网格员',
      render: (_, community) => {
        if (!isAdmin) return <Typography.Text type="secondary">仅管理员可查看</Typography.Text>
        const owner = gridWorkerFor(community.id)
        return owner ? (
          <Tag color={owner.status === 'active' ? 'blue' : 'default'} bordered={false}>
            {owner.displayName || owner.username}
            {owner.status === 'active' ? '' : '（已停用）'}
          </Tag>
        ) : <Typography.Text type="secondary">未分配</Typography.Text>
      },
    },
    {
      key: 'operators', title: '运营员授权',
      render: (_, community) => {
        if (!isAdmin) return <Typography.Text type="secondary">仅管理员可查看</Typography.Text>
        const operators = operatorsFor(community.id)
        return operators.length ? (
          <Space size={4} wrap>
            {operators.map((person) =>
              <Tag key={person.id} bordered={false}>
                {person.displayName || person.username}
                {person.status === 'active' ? '' : '（已停用）'}
              </Tag>)}
          </Space>
        ) : <Typography.Text type="secondary">未授权</Typography.Text>
      },
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

  const openStaffDrawer = (community: ManagedCommunity, mode: 'grid' | 'operator') => {
    const owner = gridWorkerFor(community.id)
    setStaffDrawer({ community, mode })
    setSelectedStaffId(
      mode === 'grid' && owner?.status === 'active' ? owner.id : undefined,
    )
    setStaffError(null)
  }
  const closeStaffDrawer = () => {
    if (staffSaving) return
    setStaffDrawer(null)
    setSelectedStaffId(undefined)
    setStaffError(null)
  }
  const reloadStaff = async () => {
    const result = await listManagedStaff()
    setStaff(result.items)
  }
  const assignGridWorker = async () => {
    if (!staffDrawer || staffDrawer.mode !== 'grid' || !selectedStaffId || staffSaving) return
    setStaffSaving(true)
    setStaffError(null)
    try {
      await adminRequest(
        `/api/admin/communities/${encodeURIComponent(staffDrawer.community.id)}/grid-worker`,
        {
          method: 'PUT',
          headers: { 'x-csrf-token': session.csrfToken },
          body: JSON.stringify({
            staffAccountId: selectedStaffId,
            expectedStaffAccountId: gridWorkerFor(staffDrawer.community.id)?.id ?? null,
          }),
        },
      )
      await reloadStaff()
      setStaffDrawer(null)
      setSelectedStaffId(undefined)
      message.success('经营负责人已更新')
    } catch (cause) {
      setStaffError(cause instanceof Error ? cause.message : '经营负责人保存失败，请重试')
    } finally {
      setStaffSaving(false)
    }
  }
  const requestAssignGridWorker = () => {
    if (!staffDrawer || staffDrawer.mode !== 'grid' || !selectedStaffId) return
    const current = gridWorkerFor(staffDrawer.community.id)
    if (current && current.id !== selectedStaffId) {
      modal.confirm({
        title: '更换经营网格员？',
        content: '旧负责人将立即失去本片区访问权限；历史社区、居民、订单与流水不会转移。',
        okText: '确认更换',
        cancelText: '取消',
        onOk: () => assignGridWorker(),
      })
      return
    }
    void assignGridWorker()
  }
  const removeAssignment = async (staffAccountId: string, success: string) => {
    if (!staffDrawer || staffSaving) return
    setStaffSaving(true)
    setStaffError(null)
    try {
      await adminRequest(
        `/api/admin/communities/${encodeURIComponent(staffDrawer.community.id)}/staff/${encodeURIComponent(staffAccountId)}`,
        { method: 'DELETE', headers: { 'x-csrf-token': session.csrfToken } },
      )
      await reloadStaff()
      setSelectedStaffId(undefined)
      message.success(success)
    } catch (cause) {
      setStaffError(cause instanceof Error ? cause.message : '解除失败，请重试')
    } finally {
      setStaffSaving(false)
    }
  }
  const confirmRemoveGridWorker = (owner: ManagedStaff) => {
    modal.confirm({
      title: '解除经营负责人？',
      content: `${owner.displayName || owner.username} 将立即失去本片区访问权限；历史数据不会改变，片区暂时无负责人。`,
      okText: '解除负责人',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => removeAssignment(owner.id, '经营负责人已解除'),
    })
  }
  const confirmRemoveOperator = (operator: ManagedStaff) => {
    modal.confirm({
      title: '解除运营员授权？',
      content: `${operator.displayName || operator.username} 将失去本社区的管理权限，其他已授权社区不受影响。`,
      okText: '解除授权',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => removeAssignment(operator.id, '运营员授权已解除'),
    })
  }
  const addOperator = async () => {
    if (!staffDrawer || staffDrawer.mode !== 'operator' || !selectedStaffId || staffSaving) return
    setStaffSaving(true)
    setStaffError(null)
    try {
      await adminRequest(
        `/api/admin/communities/${encodeURIComponent(staffDrawer.community.id)}/staff`,
        {
          method: 'POST',
          headers: { 'x-csrf-token': session.csrfToken },
          body: JSON.stringify({ staffAccountId: selectedStaffId }),
        },
      )
      await reloadStaff()
      setSelectedStaffId(undefined)
      message.success('运营员授权已添加')
    } catch (cause) {
      setStaffError(cause instanceof Error ? cause.message : '授权失败，请重试')
    } finally {
      setStaffSaving(false)
    }
  }

  const drawerCommunity = staffDrawer?.community
  const currentGridWorker = drawerCommunity ? gridWorkerFor(drawerCommunity.id) : undefined
  const currentOperators = drawerCommunity ? operatorsFor(drawerCommunity.id) : []
  const availableGridWorkers = staff.filter((person) =>
    person.role === 'grid_worker' &&
    person.status === 'active' &&
    (!person.communities.length ||
      person.communities.some((item) => item.id === drawerCommunity?.id)))
  const availableOperators = staff.filter((person) =>
    person.role === 'operator' &&
    person.status === 'active' &&
    !person.communities.some((item) => item.id === drawerCommunity?.id))

  return (
    <div className="page">
      <PageHeader
        title="社区管理"
        description="社区、服务点、经营网格员与运营员授权；一个片区同一时间只有一名经营网格员。"
      />
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
          { key: 'grid', label: '经营负责人', onClick: () => openStaffDrawer(community, 'grid') },
          { key: 'operators', label: '运营员授权', onClick: () => openStaffDrawer(community, 'operator') },
          { key: 'location', label: '设置位置', onClick: () => { void openPicker('update', community) }, disabled: mapLoading || locationSaving },
        ] : undefined}
        renderCard={(community) => (
          <Space orientation="vertical" size={4}>
            <Typography.Text strong>{community.name}</Typography.Text>
            <Typography.Text type="secondary">{community.address || '尚未设置服务点'}</Typography.Text>
            <Typography.Text type="secondary">
              {isAdmin
                ? `经营网格员：${gridWorkerFor(community.id)?.displayName || gridWorkerFor(community.id)?.username || '未分配'} · 运营员 ${operatorsFor(community.id).length} 位`
                : '已授权社区'}
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
        <Drawer
          title={staffDrawer
            ? `${staffDrawer.mode === 'grid' ? '经营网格员' : '运营员授权'} · ${staffDrawer.community.name}`
            : '社区人员'}
          open={staffDrawer !== null}
          size={460}
          rootClassName="communities-drawer"
          onClose={closeStaffDrawer}
          footer={<Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            {staffDrawer?.mode === 'grid' && currentGridWorker ? (
              <Button danger onClick={() => confirmRemoveGridWorker(currentGridWorker)} disabled={staffSaving}>
                解除负责人
              </Button>
            ) : null}
            <Button onClick={closeStaffDrawer} disabled={staffSaving}>取消</Button>
            {staffDrawer?.mode === 'grid' ? (
              <Button
                type="primary"
                disabled={!selectedStaffId || selectedStaffId === currentGridWorker?.id || staffSaving}
                loading={staffSaving}
                onClick={requestAssignGridWorker}
              >
                保存负责人
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<UserAddOutlined/>}
                disabled={!selectedStaffId || staffSaving}
                loading={staffSaving}
                onClick={() => { void addOperator() }}
              >
                添加授权
              </Button>
            )}
          </Space>}
        >
          {staffError && (
            <Alert type="error" showIcon title="操作未成功" description={staffError} style={{ marginBottom: 16 }}/>
          )}
          {staffDrawer?.mode === 'grid' ? (
            <Space orientation="vertical" size={16} style={{ width: '100%' }}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                一个片区同一时间只有一名经营网格员，一名网格员只能负责一个片区。更换后旧负责人立即失去本片区访问权限；
                历史社区、居民、订单与流水不会转移。
              </Typography.Paragraph>
              <div>
                <Typography.Text strong>当前负责人</Typography.Text>
                <div style={{ marginTop: 6 }}>
                  {currentGridWorker
                    ? `${currentGridWorker.displayName || currentGridWorker.username}（${currentGridWorker.username}）${
                        currentGridWorker.status === 'active' ? '' : ' · 已停用'
                      }`
                    : '暂无经营网格员'}
                </div>
              </div>
              <Select
                style={{ width: '100%' }}
                placeholder="选择经营网格员"
                showSearch
                optionFilterProp="label"
                aria-label="经营网格员"
                value={selectedStaffId}
                onChange={setSelectedStaffId}
                options={availableGridWorkers.map((person) => ({
                  value: person.id,
                  label: `${person.displayName || person.username} · ${person.username}${
                    person.communities.length ? ' · 当前负责人' : ' · 可分配'
                  }`,
                }))}
                notFoundContent="暂无可分配网格员，请先到「系统管理 → 管理员与权限」创建"
              />
            </Space>
          ) : (
            <Space orientation="vertical" size={16} style={{ width: '100%' }}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                运营员可以同时管理多个社区；这里的授权只影响管理范围，不代表经营业绩归属。
              </Typography.Paragraph>
              <div>
                <Typography.Text strong>已授权运营员</Typography.Text>
                <Space orientation="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>
                  {currentOperators.length ? currentOperators.map((person) => (
                    <Space key={person.id} wrap>
                      <Tag bordered={false}>
                        {person.displayName || person.username}
                        {person.status === 'active' ? '' : '（已停用）'}
                      </Tag>
                      <Button
                        type="link"
                        size="small"
                        danger
                        onClick={() => confirmRemoveOperator(person)}
                        disabled={staffSaving}
                      >
                        解除
                      </Button>
                    </Space>
                  )) : <Typography.Text type="secondary">暂无运营员授权</Typography.Text>}
                </Space>
              </div>
              <Select
                style={{ width: '100%' }}
                placeholder="选择运营员"
                showSearch
                optionFilterProp="label"
                aria-label="运营员"
                value={selectedStaffId}
                onChange={setSelectedStaffId}
                options={availableOperators.map((person) => ({
                  value: person.id,
                  label: `${person.displayName || person.username} · ${person.username}`,
                }))}
                notFoundContent="暂无可授权运营员，请先到「系统管理 → 管理员与权限」创建"
              />
            </Space>
          )}
        </Drawer>
      </>}
      <TencentLocationPicker open={mapPicker !== null} apiKey={mapPicker?.key ?? ''}
        appName={mapPicker?.appName ?? ''} initialLocation={mapPicker?.initialLocation}
        onCancel={() => setMapPicker(null)}
        onSelect={(location) => { void acceptMapLocation(location) }}/>
    </div>
  )
}
