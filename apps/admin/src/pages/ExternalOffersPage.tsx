import { useCallback, useEffect, useState } from 'react'
import {
  Alert, App as AntdApp, Button, Form, Input, InputNumber, Modal,
  Result, Space, Switch, Table, Tag, Typography, type TableProps,
} from 'antd'
import {
  createExternalOfferRequestSchema, type ExternalOffer, type CreateExternalOfferRequest,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { createAdminOffer, listAdminOffers, updateAdminOffer } from '../services/externalOffers'
import { describeLocalError } from '../services/localApi'
import './local-console.css'

interface OfferForm {
  title: string
  platform: string
  category: string
  description?: string
  url: string
  sortOrder: number
  enabled: boolean
  expiresAt?: string
}

function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function payloadOf(row: ExternalOffer): CreateExternalOfferRequest {
  return {
    title: row.title, platform: row.platform, category: row.category,
    description: row.description, url: row.url, sortOrder: row.sortOrder,
    enabled: row.enabled, expiresAt: row.expiresAt,
  }
}

/** Editor for third-party promotion *links*, not stock, coupons or fulfillment. */
export function ExternalOffersPage() {
  const { session } = useAdminAuth()
  const { message, modal } = AntdApp.useApp()
  const [form] = Form.useForm<OfferForm>()
  const [rows, setRows] = useState<ExternalOffer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ExternalOffer | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await listAdminOffers())
      setError(null)
    } catch (cause) {
      setError(describeLocalError(cause, '优惠活动读取失败'))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  if (session.staff.role === 'grid_worker') {
    return <Result status="403" title="无权管理精选优惠" subTitle="仅管理员和运营员可维护第三方活动链接。" />
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ title: '', platform: '', category: '', description: '', url: '', sortOrder: 0, enabled: false, expiresAt: '' })
    setEditorOpen(true)
  }
  const openEdit = (offer: ExternalOffer) => {
    setEditing(offer)
    form.setFieldsValue({
      ...payloadOf(offer), description: offer.description ?? '',
      expiresAt: toLocalInput(offer.expiresAt),
    })
    setEditorOpen(true)
  }
  const toPayload = (values: OfferForm): CreateExternalOfferRequest => {
    const expiresAt = values.expiresAt ? new Date(values.expiresAt) : null
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error('截止时间格式不正确')
    return createExternalOfferRequestSchema.parse({
      title: values.title, platform: values.platform, category: values.category,
      description: values.description?.trim() || null, url: values.url,
      sortOrder: values.sortOrder, enabled: values.enabled,
      expiresAt: expiresAt?.toISOString() ?? null,
    })
  }

  const save = async (values: OfferForm) => {
    setSaving(true)
    try {
      const body = toPayload(values)
      if (editing) {
        await updateAdminOffer(session.csrfToken, editing.id, { ...body, expectedUpdatedAt: editing.updatedAt })
      } else {
        await createAdminOffer(session.csrfToken, body)
      }
      setEditorOpen(false)
      message.success('已保存优惠活动')
      await refresh()
    } catch (cause) {
      message.error(describeLocalError(cause, '保存失败，请检查字段与链接'))
    } finally {
      setSaving(false)
    }
  }

  const changeVisibility = (offer: ExternalOffer, enabled: boolean) => {
    modal.confirm({
      title: enabled ? '确认该第三方链接已实际验证？' : '下架这条优惠活动？',
      content: enabled
        ? '启用后居民将直接看到活动。请先确认链接在目标手机及微信内可达，且活动仍有效。'
        : '下架后将立即从居民端列表隐藏，不影响历史管理记录。',
      okText: enabled ? '已核实，启用' : '确认下架',
      cancelText: '取消',
      onOk: async () => {
        try {
          await updateAdminOffer(session.csrfToken, offer.id, {
            ...payloadOf(offer), enabled, expectedUpdatedAt: offer.updatedAt,
          })
          message.success(enabled ? '已启用' : '已下架')
          await refresh()
        } catch (cause) {
          message.error(describeLocalError(cause, '操作失败'))
          throw cause
        }
      },
    })
  }

  const columns: TableProps<ExternalOffer>['columns'] = [
    {
      title: '活动 / 实际平台', key: 'title',
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{row.title}</Typography.Text>
          <Typography.Text type="secondary">{row.platform} · {row.category}</Typography.Text>
          <a href={row.url} target="_blank" rel="noopener noreferrer">核对外部页面 ↗</a>
        </Space>
      ),
    },
    { title: '排序', dataIndex: 'sortOrder', width: 72 },
    {
      title: '截止', key: 'expiresAt', width: 160,
      render: (_, row) => row.expiresAt ? new Date(row.expiresAt).toLocaleString('zh-CN') : '未设置',
    },
    {
      title: '状态', key: 'status', width: 110,
      render: (_, row) => {
        const expired = Boolean(row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())
        return <Tag color={expired ? 'orange' : row.enabled ? 'green' : 'default'}>
          {expired ? '已过期' : row.enabled ? '已启用' : '已下架'}
        </Tag>
      },
    },
    {
      title: '操作', key: 'actions', width: 140,
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => openEdit(row)}>编辑</Button>
          <Switch size="small" checked={row.enabled} aria-label={row.enabled ? '下架优惠' : '启用优惠'}
            onChange={(enabled) => changeVisibility(row, enabled)} />
        </Space>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader title="精选优惠" description="编辑第三方活动链接；本站不发券、不代下单，也不保证第三方优惠可领取。" />
      <div className="page-stack">
        <Alert type="info" showIcon message="新增活动默认下架"
          description="请在目标手机与微信内核验链接、活动名称和有效期，再明确启用。普通 H5 链接不能保证自动打开小程序或 App。" />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <Button onClick={() => void refresh()} loading={loading}>刷新列表</Button>
          <Button type="primary" onClick={openCreate}>新增优惠活动</Button>
        </div>
        {error && <Alert type="error" showIcon message={error} />}
        <Table<ExternalOffer> rowKey="id" size="middle" dataSource={rows} columns={columns}
          loading={loading} pagination={{ pageSize: 10 }} scroll={{ x: 660 }}
          locale={{ emptyText: '暂无第三方优惠。请先新增并核实真实链接。' }} />
      </div>
      <Modal title={editing ? '编辑第三方优惠' : '新增第三方优惠'}
        open={editorOpen} onCancel={() => setEditorOpen(false)}
        onOk={() => void form.submit()} okText="保存" confirmLoading={saving}
        destroyOnHidden>
        <Form<OfferForm> form={form} layout="vertical" onFinish={(v) => void save(v)}>
          <Form.Item name="title" label="活动标题" rules={[{ required: true, max: 80 }]}>
            <Input maxLength={80} placeholder="以第三方实际活动名称为准" />
          </Form.Item>
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="platform" label="平台/品牌" rules={[{ required: true }]}>
              <Input maxLength={40} placeholder="例如：美团" />
            </Form.Item>
            <Form.Item name="category" label="分类" rules={[{ required: true }]}>
              <Input maxLength={40} placeholder="例如：外卖" />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="简短说明">
            <Input.TextArea maxLength={300} showCount rows={2} placeholder="说明实际领取限制，不承诺固定面额" />
          </Form.Item>
          <Form.Item name="url" label="外部 HTTPS 网页地址" rules={[{ required: true }]}>
            <Input maxLength={2048} placeholder="https://...（不支持小程序路径和 App Scheme）" />
          </Form.Item>
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="sortOrder" label="排序（小号在前）" rules={[{ required: true }]}>
              <InputNumber min={0} max={10000} precision={0} />
            </Form.Item>
            <Form.Item name="expiresAt" label="活动截止（可不填）">
              <Input type="datetime-local" />
            </Form.Item>
          </Space>
          <Form.Item name="enabled" label="公开展示" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="下架" />
          </Form.Item>
          <Typography.Text type="secondary">
            仅已启用、未过期活动会公开展示。保存不会触发任何订单、券码或积分行为。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  )
}
