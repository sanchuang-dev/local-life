import { PageInfoAlert } from '../components/PageInfoHelp'
import { useEffect, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Result,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { TencentLocationPicker } from '../components/TencentLocationPicker'
import type { AuthenticatedSession } from '../services/auth'
import type { TencentMapConfigStatus, CommunityLocation } from '@sanchuang-dev/local-life-contracts'
import {
  readTencentMapPicker,
  readTencentMapSettings,
  saveTencentMapKey,
  setTencentMapEnabled,
} from '../services/tencent-map'

function asMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : '操作失败，请重试'
}

export function TencentMapSettingsPage() {
  const { session } = useAdminAuth()
  if (session.staff.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="腾讯地图" description="社区地址地图选点的 Key 维护，仅对管理员开放。" />
        <Result status="403" title="没有配置权限" subTitle="只有管理员可以管理腾讯地图配置。" />
      </div>
    )
  }
  return <TencentMapConsole session={session} />
}

function TencentMapConsole({ session }: { session: AuthenticatedSession }) {
  const { message, modal } = AntdApp.useApp()
  const [data, setData] = useState<TencentMapConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [draftKey, setDraftKey] = useState('')
  const [draftAppName, setDraftAppName] = useState('默认应用')
  const [saving, setSaving] = useState(false)
  const [editingError, setEditingError] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const [previewKey, setPreviewKey] = useState<{ key: string; appName: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    readTencentMapSettings(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setData(result)
      setError(null)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(asMessage(cause))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [refreshCount])

  function openEditor() {
    setDraftKey('')
    setDraftAppName(data?.appName || '默认应用')
    setEditingError(null)
    setEditorOpen(true)
  }

  async function submitSave() {
    if (saving || !draftKey.trim()) return
    setSaving(true)
    setEditingError(null)
    try {
      const next = await saveTencentMapKey(draftKey.trim(), draftAppName.trim(), session.csrfToken)
      setData(next)
      setDraftKey('')
      setEditorOpen(false)
      message.success('腾讯地图 Key 已保存并启用')
    } catch (cause) {
      setEditingError(asMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  function confirmSave() {
    if (!data?.configured) {
      void submitSave()
      return
    }
    modal.confirm({
      title: '确认更换腾讯地图 Key？',
      content: '保存后立即使用新 Key 进行社区地图选点；旧 Key 将被替换。请确认新 Key 已在腾讯控制台设置允许的域名。',
      okText: '确认更换',
      onOk: submitSave,
    })
  }

  function confirmToggle(enabled: boolean) {
    modal.confirm({
      title: enabled ? '启用腾讯地图选点？' : '停用腾讯地图选点？',
      content: enabled
        ? '启用后，管理员可使用保存的 Key 选择社区位置。'
        : '停用只影响新的地图选点操作，不删除已保存的社区地址和坐标。',
      okText: enabled ? '启用' : '确认停用',
      onOk: async () => {
        setChanging(true)
        try {
          const next = await setTencentMapEnabled(enabled, session.csrfToken)
          setData(next)
          message.success(enabled ? '腾讯地图已启用' : '腾讯地图已停用')
        } catch (cause) {
          message.error(asMessage(cause))
        } finally {
          setChanging(false)
        }
      },
    })
  }

  async function testPicker() {
    setPreviewLoading(true)
    try {
      const result = await readTencentMapPicker()
      if (!result.available) {
        message.warning('请先保存并启用 Key')
        return
      }
      setPreviewKey({ key: result.key, appName: result.appName })
    } catch (cause) {
      message.error(asMessage(cause))
    } finally {
      setPreviewLoading(false)
    }
  }

  function previewSelected(location: CommunityLocation) {
    setPreviewKey(null)
    message.success(`已收到地图选点：${location.address}（仅测试，未修改任何社区）`)
  }

  return (
    <div className="page">
      <PageHeader
        title="腾讯地图"
        description="配置社区地址选点服务；更新后立即生效，无需服务器重启。"
        status={data ? <Tag color={data.enabled ? 'green' : 'default'}>{data.enabled ? '已启用' : data.configured ? '已停用' : '未配置'}</Tag> : null}
        extra={<Button onClick={() => setRefreshCount((n) => n + 1)} loading={loading}>刷新状态</Button>}
      />
      <div className="page-stack">
        {error && <Alert type="error" showIcon title="读取配置失败" description={error} />}
        <Card title="社区地图选点" size="small" style={{ maxWidth: 960 }}>
          {loading && !data ? <Space><Spin size="small" />正在读取配置…</Space> : null}
          {data && (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Descriptions
                size="small"
                column={{ xs: 1, sm: 2 }}
                items={[
                  { key: 'state', label: '状态', children: data.enabled ? '已配置并启用' : data.configured ? '已保存，当前停用' : '尚未配置' },
                  { key: 'key', label: 'Key', children: data.keyHint ? <Typography.Text code>{data.keyHint}</Typography.Text> : '未设置' },
                  { key: 'appName', label: '腾讯应用名称', children: data.appName || '—' },
                  { key: 'updated', label: '最后修改', children: data.updatedAt ? new Date(data.updatedAt).toLocaleString('zh-CN') : '—' },
                  { key: 'source', label: '配置来源', children: '管理后台数据库' },
                ]}
              />
              <PageInfoAlert
                type="info"
                showIcon
                title="保存不等于已验证"
                description="腾讯地图 Key 是浏览器使用的标识。保存后请点击「测试地图选点」确认腾讯地图能正常加载、搜索并回传位置；请在腾讯控制台限制使用来源。"
              />
              <Space wrap>
                <Button type="primary" onClick={openEditor}>{data.configured ? '更换 Key' : '配置 Key'}</Button>
                {data.configured && (
                  <Button onClick={() => confirmToggle(!data.enabled)} loading={changing}>
                    {data.enabled ? '停用' : '启用'}
                  </Button>
                )}
                <Button onClick={() => { void testPicker() }} loading={previewLoading} disabled={!data.enabled}>测试地图选点</Button>
              </Space>
              <Typography.Text type="secondary">
                在 <a href="https://lbs.qq.com/dev/console/key/manage" target="_blank" rel="noopener noreferrer">腾讯位置服务控制台</a>创建 Key。
                实际坐标保存在社区数据里；修改或停用 Key 不会删除已有位置。
              </Typography.Text>
            </Space>
          )}
        </Card>
      </div>
      <Drawer
        title={data?.configured ? '更换腾讯地图 Key' : '配置腾讯地图 Key'}
        width="min(440px, 100vw)"
        open={editorOpen}
        destroyOnHidden
        onClose={() => { if (!saving) { setDraftKey(''); setEditorOpen(false) } }}
        footer={<Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button disabled={saving} onClick={() => { setDraftKey(''); setEditorOpen(false) }}>取消</Button>
          <Button type="primary" loading={saving} onClick={confirmSave} disabled={!draftKey.trim() || !draftAppName.trim()}>保存并启用</Button>
        </Space>}
      >
        {editingError && <Alert type="error" showIcon message="保存失败" description={editingError} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={confirmSave}>
          <Form.Item label="腾讯位置服务 Key" required extra="输入后保存；刷新页面不会再次回显完整 Key。">
            <Input.Password
              aria-label="腾讯位置服务 Key"
              autoComplete="off"
              value={draftKey}
              onChange={(event) => setDraftKey(event.target.value)}
              placeholder="粘贴在腾讯位置服务创建的 Key"
              maxLength={128}
            />
          </Form.Item>
          <Form.Item label="所属应用名称" required extra="腾讯控制台「添加 Key 到应用」中的应用名称；不是 Key 名称。">
            <Input
              aria-label="腾讯地图应用名称"
              value={draftAppName}
              onChange={(event) => setDraftAppName(event.target.value)}
              placeholder="例如：默认应用"
              maxLength={64}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            请确认该 Key 已在腾讯控制台配置合法域名。这里不需要填写微信 AppID 或 AppSecret。
          </Typography.Paragraph>
        </Form>
      </Drawer>
      <TencentLocationPicker
        open={previewKey !== null}
        apiKey={previewKey?.key ?? ''}
        appName={previewKey?.appName ?? ''}
        onCancel={() => setPreviewKey(null)}
        onSelect={previewSelected}
      />
    </div>
  )
}
