import { PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Result,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CreateLocalProductRequest,
  LocalProductDetail,
  LocalProductStatus,
  LocalProductSummary,
  UpdateLocalProductRequest,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import {
  DataPanel,
  type PanelColumn,
  type PanelFilter,
  type PanelQuery,
} from '../shared/components/DataPanel'
import { listAdminCommunities } from '../services/activities'
import type { AuthenticatedSession } from '../services/auth'
import {
  createAdminProduct,
  getAdminProduct,
  listAdminProducts,
  setAdminProductShelf,
  updateAdminProduct,
} from '../services/localCatalog'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import './local-console.css'

/**
 * 商品管理 — the *local* product catalogue (#109).
 *
 * Every row, filter option and price comes from `/admin/catalog/products`; there
 * is no demo catalogue fallback. Prices travel as integer cents in both
 * directions, and the editor is the only place they are converted from/to the
 * yuan value an operator types.
 *
 * `grid_worker` never issues a request: `/admin/*` rejects that role by
 * convention, so the page states the boundary instead of rendering a table that
 * would only ever show an error.
 */

const PRODUCT_STATUS_META: Record<LocalProductStatus, { label: string; color: string }> = {
  on_shelf: { label: '已上架', color: 'green' },
  off_shelf: { label: '已下架', color: 'default' },
}

const STATUS_OPTIONS = (Object.keys(PRODUCT_STATUS_META) as LocalProductStatus[]).map((status) => ({
  label: PRODUCT_STATUS_META[status].label,
  value: status,
}))

/** Structural shape of `authCommunitySchema`; the contracts package exports schemas only. */
type CommunityRef = { id: string; name: string }

interface ProductFilters {
  keyword?: string
  communityId?: string
  status?: LocalProductStatus
}

type ProductSortKey = never

const initialFilters: ProductFilters = {
  keyword: '',
  communityId: undefined,
  status: undefined,
}

/** `1230` → `12.30`; the editor only ever shows the yuan form of a cent amount. */
function centsToYuan(cents: number): number {
  return Math.round(cents) / 100
}

function yuanToCents(yuan: number): number {
  return Math.round(yuan * 100)
}

function formatPrice(cents: number): string {
  return `¥${(Math.round(cents) / 100).toFixed(2)}`
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return DATE_TIME_FORMATTER.format(date).replace(/\//g, '-')
}

function listErrorTitle(error: Error | null): string {
  if (isLocalApiError(error)) {
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return '没有商品管理权限'
  }
  return '商品列表加载失败'
}

interface ProductFormValues {
  communityId: string
  name: string
  summary?: string
  description?: string
  category?: string
  priceYuan: number
  imageUrl?: string
}

export function ProductsPage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="商品管理"
          description="本地商品目录仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有商品管理权限"
            subTitle="该入口仅对管理员与运营员开放；即使直接访问该地址，服务端同样会拒绝网格员的商品目录请求。网格员如需为居民代录订单，请使用移动端工作台。"
          />
        </div>
      </div>
    )
  }

  return <ProductConsole session={session} />
}

function ProductConsole({ session }: { session: AuthenticatedSession }) {
  const { message, modal } = AntdApp.useApp()
  const [form] = Form.useForm<ProductFormValues>()
  const isAdmin = session.staff.role === 'admin'
  const assigned = session.staff.communities

  const [query, setQuery] = useState<PanelQuery<ProductFilters, ProductSortKey>>(() => ({
    filters: { ...initialFilters, communityId: isAdmin ? undefined : assigned[0]?.id },
    page: 1,
    pageSize: 20,
  }))
  const [rows, setRows] = useState<LocalProductSummary[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<Error | null>(null)
  const [listToken, setListToken] = useState(0)

  const [communities, setCommunities] = useState<readonly CommunityRef[]>([])
  const [communitiesLoading, setCommunitiesLoading] = useState(true)
  const [communitiesError, setCommunitiesError] = useState<string | null>(null)
  const [communitiesToken, setCommunitiesToken] = useState(0)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create')
  const [editingProduct, setEditingProduct] = useState<LocalProductDetail | null>(null)
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [shelfBusyId, setShelfBusyId] = useState<string | null>(null)
  const editorRequestRef = useRef(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setCommunitiesLoading(true)
    setCommunitiesError(null)
    listAdminCommunities(controller.signal)
      .then((items) => {
        if (active) setCommunities(items)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setCommunities([])
        setCommunitiesError(describeLocalError(cause, '无法读取社区列表'))
      })
      .finally(() => {
        if (active) setCommunitiesLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [communitiesToken])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setListLoading(true)
    setListError(null)
    listAdminProducts(
      {
        page: query.page,
        pageSize: query.pageSize,
        communityId: query.filters.communityId,
        status: query.filters.status,
        keyword: query.filters.keyword?.trim() || undefined,
      },
      controller.signal,
    )
      .then((result) => {
        if (!active) return
        setRows(result.items)
        setTotal(result.total)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setRows([])
        setTotal(0)
        setListError(cause instanceof Error ? cause : new Error('商品列表加载失败'))
      })
      .finally(() => {
        if (active) setListLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [query, listToken])

  const communityOptions = useMemo(
    () => communities.map((item) => ({ label: item.name, value: item.id })),
    [communities],
  )

  const refreshList = () => setListToken((value) => value + 1)

  const applyQuery = (next: PanelQuery<ProductFilters, ProductSortKey>): boolean => {
    const communityId = next.filters.communityId
    if (communityId && !isAdmin && !assigned.some((item) => item.id === communityId)) {
      message.error('只能查看管理员分配给当前账号的社区。')
      return false
    }
    setQuery(next)
    return true
  }

  // Runs after the drawer's Form is mounted (the Drawer destroys its children on
  // close), so the reset and the default community never touch a detached Form.
  useEffect(() => {
    if (!editorOpen || editorMode !== 'create') return
    const defaultCommunity = isAdmin ? communities[0]?.id : assigned[0]?.id
    form.resetFields()
    form.setFieldsValue({
      ...(defaultCommunity ? { communityId: defaultCommunity } : {}),
    })
    // Only the create drawer opening (or its community options arriving) should
    // touch the form; an operator's typing must survive unrelated rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpen, editorMode, communities])

  // An edit drawer fills its fields exactly once, when the detail arrives.
  useEffect(() => {
    if (!editorOpen || editorMode !== 'edit' || !editingProduct) return
    form.setFieldsValue({
      communityId: editingProduct.community.id,
      name: editingProduct.name,
      summary: editingProduct.summary ?? '',
      description: editingProduct.description ?? '',
      category: editingProduct.category ?? '',
      priceYuan: centsToYuan(editingProduct.priceCents),
      imageUrl: editingProduct.imageUrl ?? '',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpen, editorMode, editingProduct])

  const openCreate = () => {
    editorRequestRef.current += 1
    setEditorMode('create')
    setEditingProduct(null)
    setEditorError(null)
    setEditorOpen(true)
  }

  const openEdit = async (row: LocalProductSummary) => {
    const requestId = editorRequestRef.current + 1
    editorRequestRef.current = requestId
    setEditorMode('edit')
    setEditorOpen(true)
    setEditorError(null)
    setEditorLoading(true)
    setEditingProduct(null)
    try {
      const detail = await getAdminProduct(row.id)
      if (editorRequestRef.current !== requestId) return
      setEditingProduct(detail)
    } catch (cause: unknown) {
      if (editorRequestRef.current !== requestId) return
      setEditorError(describeLocalError(cause, '无法读取商品详情'))
    } finally {
      if (editorRequestRef.current === requestId) setEditorLoading(false)
    }
  }

  const closeEditor = () => {
    editorRequestRef.current += 1
    setEditorOpen(false)
    setEditorLoading(false)
  }

  const submitEditor = async (values: ProductFormValues) => {
    setSaving(true)
    setEditorError(null)
    const textOrNull = (value: string | undefined): string | null => {
      const trimmed = value?.trim() ?? ''
      return trimmed.length > 0 ? trimmed : null
    }
    try {
      if (editorMode === 'create') {
        const summary = textOrNull(values.summary)
        const description = textOrNull(values.description)
        const category = textOrNull(values.category)
        const imageUrl = textOrNull(values.imageUrl)
        const payload: CreateLocalProductRequest = {
          communityId: values.communityId,
          name: values.name.trim(),
          priceCents: yuanToCents(values.priceYuan),
          ...(summary ? { summary } : {}),
          ...(description ? { description } : {}),
          ...(category ? { category } : {}),
          ...(imageUrl ? { imageUrl } : {}),
        }
        const created = await createAdminProduct(session.csrfToken, payload)
        message.success(
          `已创建商品「${created.name}」，当前为${PRODUCT_STATUS_META[created.status].label}。`,
        )
      } else if (editingProduct) {
        const payload: UpdateLocalProductRequest = {
          expectedUpdatedAt: editingProduct.updatedAt,
          name: values.name.trim(),
          summary: textOrNull(values.summary),
          description: textOrNull(values.description),
          category: textOrNull(values.category),
          priceCents: yuanToCents(values.priceYuan),
          imageUrl: textOrNull(values.imageUrl),
        }
        const updated = await updateAdminProduct(session.csrfToken, editingProduct.id, payload)
        message.success(`已保存商品「${updated.name}」。`)
      }
      setEditorOpen(false)
      refreshList()
    } catch (cause: unknown) {
      setEditorError(describeLocalError(cause, '保存商品失败'))
      if (isLocalApiError(cause) && cause.status === 409) {
        // Reload so the next attempt carries the current expectedUpdatedAt token.
        refreshList()
      }
    } finally {
      setSaving(false)
    }
  }

  const changeShelf = (row: LocalProductSummary) => {
    const nextStatus: LocalProductStatus = row.status === 'on_shelf' ? 'off_shelf' : 'on_shelf'
    modal.confirm({
      title: nextStatus === 'on_shelf' ? '上架该商品？' : '下架该商品？',
      content: (
        <div className="local-confirm-body">
          <p>商品：{row.name}</p>
          <p>
            {nextStatus === 'on_shelf'
              ? '上架后居民 H5「惠生活」会读取到该商品并可登记订单。'
              : '下架后居民 H5 不再展示该商品，也不能再登记新订单；已登记订单的价格快照不受影响。'}
          </p>
        </div>
      ),
      okText: nextStatus === 'on_shelf' ? '确认上架' : '确认下架',
      cancelText: '取消',
      okButtonProps: nextStatus === 'off_shelf' ? { danger: true } : undefined,
      onOk: async () => {
        setShelfBusyId(row.id)
        setActionError(null)
        try {
          const updated = await setAdminProductShelf(
            session.csrfToken,
            row.id,
            row.updatedAt,
            nextStatus,
          )
          message.success(updated.status === 'on_shelf' ? '已上架该商品。' : '已下架该商品。')
          refreshList()
        } catch (cause: unknown) {
          setActionError(describeLocalError(cause, '上下架失败'))
          if (isLocalApiError(cause) && cause.status === 409) refreshList()
        } finally {
          setShelfBusyId(null)
        }
      },
    })
  }

  const columns: readonly PanelColumn<LocalProductSummary, ProductSortKey>[] = [
    {
      key: 'name',
      title: '商品名称',
      hideable: false,
      render: (_value, row) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong>{row.name}</Typography.Text>
          {row.summary ? <Typography.Text type="secondary">{row.summary}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      key: 'community',
      title: '社区',
      render: (_value, row) => row.community.name,
    },
    {
      key: 'category',
      title: '分类',
      render: (_value, row) => row.category ?? '未分类',
    },
    {
      key: 'priceCents',
      title: '单价',
      render: (_value, row) => formatPrice(row.priceCents),
    },
    {
      key: 'status',
      title: '状态',
      render: (_value, row) => (
        <Tag color={PRODUCT_STATUS_META[row.status].color}>
          {PRODUCT_STATUS_META[row.status].label}
        </Tag>
      ),
    },
    {
      key: 'updatedAt',
      title: '最后更新',
      render: (_value, row) => formatDateTime(row.updatedAt),
    },
  ]

  const filters: readonly PanelFilter<ProductFilters>[] = [
    { key: 'keyword', label: '关键词', kind: 'text', placeholder: '商品名称或简介' },
    { key: 'communityId', label: '社区', kind: 'select', options: communityOptions },
    { key: 'status', label: '状态', kind: 'select', options: STATUS_OPTIONS },
  ]

  const createDisabled = communitiesLoading || communities.length === 0

  return (
    <div className="page">
      <PageHeader
        title="商品管理"
        description="维护本社区本地商品：创建、编辑、上架与下架。居民 H5「惠生活」读取同一份上架目录，价格以整数分保存并在居民登记订单时冻结快照。"
        status={<Tag color="green">真实数据</Tag>}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={createDisabled}
            onClick={openCreate}
          >
            新建商品
          </Button>
        }
      />

      <div className="page-stack">
        {!isAdmin ? (
          <Alert
            type="info"
            showIcon
            title="运营员视图"
            description={
              assigned.length > 0
                ? `仅能查看与操作管理员分配的社区（${assigned
                    .map((item) => item.name)
                    .join('、')}）；服务端同样会校验社区范围。`
                : '当前账号尚未被分配社区，暂时无法创建或查看商品，请联系管理员。'
            }
          />
        ) : null}

        {communitiesError ? (
          <Alert
            type="warning"
            showIcon
            title="社区列表加载失败"
            description={communitiesError}
            action={
              <Button size="small" onClick={() => setCommunitiesToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null}

        {actionError ? (
          <Alert
            type="error"
            showIcon
            closable
            title="操作未成功"
            description={actionError}
            onClose={() => setActionError(null)}
          />
        ) : null}

        <DataPanel<LocalProductSummary, ProductFilters, ProductSortKey>
          id="local-products"
          label="本地商品列表"
          rowKey={(row) => row.id}
          query={query}
          onQueryChange={applyQuery}
          initialFilters={initialFilters}
          data={{ rows, total, loading: listLoading, error: listError ?? undefined }}
          filters={filters}
          columns={columns}
          onRefresh={refreshList}
          errorTitle={listErrorTitle(listError)}
          emptyText={
            <div className="local-empty">
              <p>还没有本地商品。</p>
              <p className="local-empty-hint">
                创建商品并上架后，居民 H5「惠生活」即可读取到真实目录。
              </p>
            </div>
          }
          rowActions={(row) => [
            { key: 'edit', label: '编辑', onClick: () => void openEdit(row) },
            {
              key: 'shelf',
              label:
                shelfBusyId === row.id ? '处理中…' : row.status === 'on_shelf' ? '下架' : '上架',
              danger: row.status === 'on_shelf',
              disabled: shelfBusyId !== null,
              onClick: () => changeShelf(row),
            },
          ]}
          renderCard={(row) => (
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text strong>{row.name}</Typography.Text>
                <Tag color={PRODUCT_STATUS_META[row.status].color}>
                  {PRODUCT_STATUS_META[row.status].label}
                </Tag>
              </Space>
              <Typography.Text type="secondary">
                {row.community.name} · {row.category ?? '未分类'} · {formatPrice(row.priceCents)}
              </Typography.Text>
              {row.summary ? (
                <Typography.Text type="secondary">{row.summary}</Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                更新 {formatDateTime(row.updatedAt)}
              </Typography.Text>
            </Space>
          )}
        />
      </div>

      <Drawer
        title={editorMode === 'create' ? '新建本地商品' : '编辑本地商品'}
        size={520}
        open={editorOpen}
        onClose={closeEditor}
        rootClassName="local-drawer"
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={closeEditor}>取消</Button>
            <Button
              type="primary"
              loading={saving}
              disabled={editorMode === 'edit' && !editingProduct}
              onClick={() => form.submit()}
            >
              {editorMode === 'create' ? '创建商品' : '保存修改'}
            </Button>
          </Space>
        }
      >
        {editorLoading ? (
          <div className="local-drawer-loading">
            <Spin />
          </div>
        ) : (
          <>
            {editorError ? (
              <Alert
                className="local-form-error"
                type="error"
                showIcon
                title={editorMode === 'create' ? '创建失败' : '保存失败'}
                description={editorError}
              />
            ) : null}

            {editorMode === 'edit' && !editingProduct ? (
              <Alert
                type="warning"
                showIcon
                title="商品详情未能读取"
                description="当前无法编辑该商品，请关闭后重试。"
              />
            ) : null}

            {editingProduct ? (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="商品 ID">{editingProduct.id}</Descriptions.Item>
                <Descriptions.Item label="当前状态">
                  <Tag color={PRODUCT_STATUS_META[editingProduct.status].color}>
                    {PRODUCT_STATUS_META[editingProduct.status].label}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="最后更新">
                  {formatDateTime(editingProduct.updatedAt)}
                </Descriptions.Item>
              </Descriptions>
            ) : null}

            <Form<ProductFormValues>
              form={form}
              layout="vertical"
              className="local-form"
              onFinish={submitEditor}
              disabled={editorMode === 'edit' && !editingProduct}
            >
              <Form.Item
                name="communityId"
                label="所属社区"
                rules={[{ required: true, message: '请选择所属社区' }]}
                extra={
                  editorMode === 'edit'
                    ? '商品创建后归属社区不可修改；如需在其他社区上架，请新建商品。'
                    : undefined
                }
              >
                <Select
                  options={
                    isAdmin
                      ? communityOptions
                      : communityOptions.filter((option) =>
                          assigned.some((item) => item.id === option.value),
                        )
                  }
                  placeholder="选择社区"
                  disabled={editorMode === 'edit' || communitiesLoading}
                  notFoundContent={communitiesLoading ? '社区读取中…' : '没有可用社区'}
                />
              </Form.Item>

              <Form.Item
                name="name"
                label="商品名称"
                rules={[
                  { required: true, whitespace: true, message: '请填写商品名称' },
                  { max: 60, message: '商品名称最多 60 个字符' },
                ]}
              >
                <Input placeholder="例如：社区助农蔬菜包" />
              </Form.Item>

              <Form.Item
                name="summary"
                label="一句话简介"
                rules={[{ max: 120, message: '简介最多 120 个字符' }]}
              >
                <Input placeholder="展示在居民端商品卡片上" />
              </Form.Item>

              <Form.Item
                name="priceYuan"
                label="单价（元）"
                rules={[
                  { required: true, message: '请填写单价' },
                  { type: 'number', min: 0, max: 100_000, message: '单价需在 0 到 100000 元之间' },
                ]}
                extra="按元录入，保存时换算为整数分；居民登记订单时服务端冻结该价格快照。"
              >
                <InputNumber
                  min={0}
                  max={100_000}
                  step={0.01}
                  precision={2}
                  style={{ width: '100%' }}
                  placeholder="0.00"
                />
              </Form.Item>

              <Form.Item
                name="category"
                label="分类"
                rules={[{ max: 40, message: '分类最多 40 个字符' }]}
              >
                <Input placeholder="例如：蔬菜、水果、日用品" />
              </Form.Item>

              <Form.Item
                name="imageUrl"
                label="图片地址"
                rules={[
                  { max: 500, message: '图片地址最多 500 个字符' },
                  { pattern: /^https?:\/\/.+/u, message: '请填写 http(s) 开头的图片地址' },
                ]}
                extra="留空表示不展示图片；居民端图片加载失败时显示占位而不是破图。"
              >
                <Input placeholder="https://…" />
              </Form.Item>

              <Form.Item name="description" label="商品说明" rules={[{ max: 1000 }]}>
                <Input.TextArea
                  rows={4}
                  maxLength={1000}
                  showCount
                  placeholder="纯文本说明，居民端按文本展示，不会渲染 HTML。"
                />
              </Form.Item>
            </Form>
          </>
        )}
      </Drawer>
    </div>
  )
}

/** Exposed for the page test: the yuan↔cent conversion must not lose a cent. */
export const productPriceHelpers = { centsToYuan, yuanToCents }
