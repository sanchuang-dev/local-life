import { PageInfoAlert } from '../components/PageInfoHelp'
import { useCallback, useEffect, useState } from 'react'
import {
  Alert, App as AntdApp, Button, Form, Input, InputNumber, Modal,
  Result, Space, Switch, Table, Tag, Typography,
} from 'antd'
import {
  createExternalOfferRequestSchema, type ExternalOffer, type CreateExternalOfferRequest,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { DataPanel, type PanelColumn, type PanelFilter, type PanelQuery } from '../shared/components/DataPanel'
import { createAdminOffer, importAdminOffers, listAdminOffers, updateAdminOffer } from '../services/externalOffers'
import { describeLocalError } from '../services/localApi'
import { downloadExternalOffersTemplate, previewExternalOffersExcel, type PreviewOfferRow } from '../utils/externalOffersExcel'
import './local-console.css'

interface OfferFilters {
  keyword: string
  status?: 'enabled' | 'disabled' | 'expired'
}

// The existing API returns a complete list. Query and paging are page-owned,
// not invented inside DataPanel or presented as server-side search.
type OfferSortKey = never
const initialFilters: OfferFilters = { keyword: '', status: undefined }
const offerFilters: readonly PanelFilter<OfferFilters>[] = [
  { key: 'keyword', label: '活动检索', kind: 'text', placeholder: '活动名、平台或分类' },
  { key: 'status', label: '状态', kind: 'status', options: [
    { label: '已启用', value: 'enabled' },
    { label: '已下架', value: 'disabled' },
    { label: '已过期', value: 'expired' },
  ] },
]

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
  const [query, setQuery] = useState<PanelQuery<OfferFilters, OfferSortKey>>({
    filters: initialFilters, page: 1, pageSize: 10,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ExternalOffer | null>(null)
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [preview, setPreview] = useState<PreviewOfferRow[] | null>(null)

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
  useEffect(() => {
    if (session.staff.role === 'grid_worker') return
    void refresh()
  }, [refresh, session.staff.role])

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

  const previewFile = async (file: File | undefined) => {
    setPreview(null)
    if (!file) return
    setParsing(true)
    try {
      setPreview(await previewExternalOffersExcel(file))
    } catch (cause) {
      message.error(describeLocalError(cause, 'Excel 文件解析失败'))
    } finally {
      setParsing(false)
    }
  }

  const submitImport = () => {
    const valid = preview?.filter((entry) => entry.item).map((entry) => entry.item!) ?? []
    const invalid = preview?.filter((entry) => entry.error).length ?? 0
    if (!valid.length) return
    modal.confirm({
      title: '确认批量导入 ' + valid.length + ' 条优惠？',
      content: invalid
        ? '将跳过 ' + invalid + ' 条无效数据。全部导入为下架草稿；确认后仍须逐条检查外部页面并手动启用。'
        : '全部导入为下架草稿；确认后仍须逐条检查外部页面并手动启用。',
      okText: '导入有效项（默认下架）',
      cancelText: '取消',
      onOk: async () => {
        setImporting(true)
        try {
          const result = await importAdminOffers(session.csrfToken, valid)
          message.success('新增草稿 ' + result.imported + ' 条，去重跳过 ' + result.skipped + ' 条')
          setImportOpen(false)
          setPreview(null)
          await refresh()
        } catch (cause) {
          message.error(describeLocalError(cause, '导入失败'))
          throw cause
        } finally {
          setImporting(false)
        }
      },
    })
  }

  const columns: readonly PanelColumn<ExternalOffer, OfferSortKey>[] = [
    {
      title: '活动 / 实际平台', key: 'title', hideable: false,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{row.title}</Typography.Text>
          <Typography.Text type="secondary">{row.platform} · {row.category}</Typography.Text>
          <a href={row.url} target="_blank" rel="noopener noreferrer">核对外部页面 ↗</a>
        </Space>
      ),
    },
    { key: 'sortOrder', title: '排序', dataIndex: 'sortOrder', width: 72 },
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
  ]

  // The panel owns presentation preferences only. The API has no pagination
  // endpoint, so the page filters and slices the complete admin list itself.
  const keyword = query.filters.keyword.trim().toLocaleLowerCase()
  const filteredRows = rows.filter((row) => {
    const expired = Boolean(row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())
    const status = query.filters.status
    if (status === 'expired' && !expired) return false
    if (status === 'enabled' && (!row.enabled || expired)) return false
    if (status === 'disabled' && (row.enabled || expired)) return false
    return !keyword || [row.title, row.platform, row.category, row.description ?? '']
      .some((value) => value.toLocaleLowerCase().includes(keyword))
  })
  const pageRows = filteredRows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)

  return (
    <div className="page">
      <PageHeader title="精选优惠" description="编辑第三方活动链接；本站不发券、不代下单，也不保证第三方优惠可领取。" />
      <div className="page-stack">
        <PageInfoAlert type="info" showIcon message="新增活动默认下架"
          description="请在目标手机与微信内核验链接、活动名称和有效期，再明确启用。普通 H5 链接不能保证自动打开小程序或 App。" />
        <DataPanel<ExternalOffer, OfferFilters, OfferSortKey>
          id="external-offers"
          label="精选优惠列表"
          rowKey={(row) => row.id}
          query={query}
          onQueryChange={setQuery}
          initialFilters={initialFilters}
          data={{
            rows: pageRows, total: filteredRows.length, loading,
            error: error ? new Error(error) : undefined,
          }}
          filters={offerFilters}
          columns={columns}
          onRefresh={() => void refresh()}
          errorTitle="优惠活动读取失败"
          emptyText={rows.length === 0 ? '暂无第三方优惠。请先新增并核实真实链接。' : undefined}
          toolbarExtra={
            <Space wrap>
              <Button type="primary" onClick={openCreate}>新增优惠活动</Button>
              <Button onClick={downloadExternalOffersTemplate}>下载Excel模板</Button>
              <Button onClick={() => { setPreview(null); setImportOpen(true) }}>Excel批量导入</Button>
            </Space>
          }
          rowActions={(row) => [
            { key: 'edit', label: '编辑', disabled: saving || importing, onClick: () => openEdit(row) },
            {
              key: 'visibility', label: row.enabled ? '下架' : '启用',
              danger: row.enabled, disabled: saving || importing,
              onClick: () => changeVisibility(row, !row.enabled),
            },
          ]}
        />
      </div>
      <Modal title="Excel 批量导入" open={importOpen}
        onCancel={() => { if (!parsing && !importing) setImportOpen(false) }}
        footer={[
          <Button key="cancel" onClick={() => setImportOpen(false)} disabled={importing}>关闭</Button>,
          <Button key="submit" type="primary" loading={importing} disabled={parsing || !preview?.some((r) => r.item)}
            onClick={submitImport}>导入有效项（默认下架）</Button>,
        ]}
        width={850} destroyOnHidden>
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Alert type="warning" showIcon
            message="不自动发布任何优惠"
            description="使用模板第一张「导入数据」，一次最多100条。仅完整 HTTPS 链接可导入；HTTP、tbopen:// 和小程序相对路径会被标红并跳过。真实活动还需微信真机核验。" />
          <input aria-label="选择Excel文件" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={parsing || importing}
            onChange={(event) => void previewFile(event.target.files?.[0])} />
          {parsing && <Typography.Text>正在解析 Excel…</Typography.Text>}
          {preview && (
            <>
              <Typography.Text>
                共 {preview.length} 条，格式有效 {preview.filter((r) => r.item).length} 条，
                待修正 {preview.filter((r) => r.error).length} 条。
                语法有效不代表活动链接已验证。
              </Typography.Text>
              <Table<PreviewOfferRow> size="small" rowKey="rowNumber"
                dataSource={preview} pagination={{ pageSize: 8 }}
                scroll={{ x: 700 }} columns={[
                  { title: 'Excel行', dataIndex: 'rowNumber', width: 80 },
                  { title: '活动', dataIndex: 'title', ellipsis: true },
                  { title: '检查结果', width: 300, render: (_, row) =>
                    row.error ? <Tag color="red">{row.error}</Tag>
                      : <Tag color="orange">格式有效 · 导入后下架</Tag> },
                ]} />
            </>
          )}
        </Space>
      </Modal>
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
